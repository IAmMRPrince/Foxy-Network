import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { CryptoTunnel } from '../packages/foxy-vpn/src/crypto-tunnel.js';
import { VpnRelay, isPublicAddress } from '../packages/foxy-vpn/src/relay.js';

test('only public addresses are considered routable', () => {
  for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1',
    '::ffff:127.0.0.1', '::ffff:192.168.0.1', '::ffff:7f00:1', 'not-an-ip', '']) {
    assert.equal(isPublicAddress(addr), false, addr);
  }
  for (const addr of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(addr), true, addr);
  }
});

test('both sides derive the same key; an observer of the public keys cannot', () => {
  const client = CryptoTunnel.createEphemeralKeyPair();
  const relay = CryptoTunnel.createEphemeralKeyPair();
  const k1 = CryptoTunnel.deriveSessionKey(client.privateKey, relay.publicKey, 'session-1');
  const k2 = CryptoTunnel.deriveSessionKey(relay.privateKey, client.publicKey, 'session-1');
  assert.deepEqual(k1, k2);
  assert.equal(k1.length, 32);

  // Same keys, different session id -> different key
  assert.notDeepEqual(CryptoTunnel.deriveSessionKey(client.privateKey, relay.publicKey, 'session-2'), k1);

  const frame = CryptoTunnel.encrypt(Buffer.from('secret payload'), k1);
  assert.equal(CryptoTunnel.decrypt(frame, k2).toString(), 'secret payload');

  // A third party who saw both public keys and the session id cannot decrypt
  const eve = CryptoTunnel.createEphemeralKeyPair();
  const eveKey = CryptoTunnel.deriveSessionKey(eve.privateKey, relay.publicKey, 'session-1');
  assert.throws(() => CryptoTunnel.decrypt(frame, eveKey));

  // Tampered ciphertext is rejected
  const tampered = { ...frame, data: Buffer.from('garbage-garbage').toString('base64') };
  assert.throws(() => CryptoTunnel.decrypt(tampered, k2));
  assert.throws(() => CryptoTunnel.deriveSessionKey(client.privateKey, 'short', 's'));
});

function connect(relay, { host, port, sessionId = crypto.randomUUID() }) {
  const client = CryptoTunnel.createEphemeralKeyPair();
  const frames = [];
  let wake = () => {};
  const next = async (type) => {
    for (;;) {
      const i = frames.findIndex(f => f.type === type || f.type === 'VPN_ERROR');
      if (i >= 0) return frames.splice(i, 1)[0];
      await new Promise(r => { wake = r; });
    }
  };
  const done = relay.handleConnect(sessionId, host, port, client.publicKey, (f) => { frames.push(f); wake(); });
  return { client, sessionId, next, done };
}

test('the exit relay refuses private destinations and non-web ports', async () => {
  const relay = new VpnRelay();
  const cases = [
    ['127.0.0.1', 80], ['localhost', 443], ['192.168.1.1', 80], ['169.254.169.254', 80], ['[::1]', 443],
    ['10.0.0.5', 8080],
    ['8.8.8.8', 22], ['8.8.8.8', 25], ['8.8.8.8', 4040], ['8.8.8.8', 3306], ['8.8.8.8', 'abc']
  ];
  for (const [host, port] of cases) {
    const session = connect(relay, { host, port });
    await session.done;
    const frame = await session.next('VPN_CONNECTED');
    assert.equal(frame.type, 'VPN_ERROR', `${host}:${port} must be refused`);
  }
  assert.equal(relay.activeSessions.size, 0);
});

test('a hostname that resolves to a private address is refused (DNS rebinding)', async () => {
  const mixed = new VpnRelay({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(mixed.resolvePublicTarget('evil.example'));
  const internal = new VpnRelay({ lookup: async () => [{ address: '10.0.0.8', family: 4 }] });
  await assert.rejects(internal.resolvePublicTarget('intranet.example'));
  const ok = new VpnRelay({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(await ok.resolvePublicTarget('example.com'), '93.184.216.34');
});

test('data flows encrypted in both directions through the relay', async (t) => {
  // Local echo server standing in for "the internet": the test relay maps the
  // public test address to it, while the real address checks stay in place.
  const echo = net.createServer((s) => s.on('data', d => s.write(Buffer.concat([Buffer.from('echo:'), d]))));
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  t.after(() => echo.close());

  class TestRelay extends VpnRelay {
    async resolvePublicTarget(host) {
      await super.resolvePublicTarget(host); // still enforces the firewall
      return '127.0.0.1';
    }
  }
  const relay = new TestRelay({ allowedPorts: [echo.address().port] });
  t.after(() => relay.destroy());

  const session = connect(relay, { host: '93.184.216.34', port: echo.address().port });
  await session.done;
  const connected = await session.next('VPN_CONNECTED');
  assert.equal(connected.type, 'VPN_CONNECTED');
  const key = CryptoTunnel.deriveSessionKey(session.client.privateKey, connected.relayPublicKey, session.sessionId);

  assert.equal(relay.handleData(session.sessionId, CryptoTunnel.encrypt(Buffer.from('hello'), key)), true);
  const data = await session.next('VPN_DATA_STREAM');
  assert.equal(CryptoTunnel.decrypt(data.payload, key).toString(), 'echo:hello');
  // The frame on the wire is not the plaintext
  assert.ok(!Buffer.from(data.payload.data, 'base64').toString().includes('hello'));

  // A frame encrypted with any other key is dropped
  assert.equal(relay.handleData(session.sessionId, CryptoTunnel.encrypt(Buffer.from('x'), crypto.randomBytes(32))), false);

  // Reusing a live session id is refused
  const dup = connect(relay, { host: '93.184.216.34', port: echo.address().port, sessionId: session.sessionId });
  await dup.done;
  assert.equal((await dup.next('VPN_CONNECTED')).type, 'VPN_ERROR');
});
