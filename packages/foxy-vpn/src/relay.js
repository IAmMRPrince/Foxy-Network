// ==============================================================================
// Foxy Network - dVPN Donor Exit Relay
// Encrypted egress gateway running on donor nodes, with a destination firewall
// that protects the donor's own machine and local network.
// ==============================================================================

import net from 'node:net';
import dns from 'node:dns/promises';
import { CryptoTunnel } from './crypto-tunnel.js';

// Only web traffic leaves through a donor's connection.
export const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443];

const MAX_SESSIONS = 64;
const IDLE_TIMEOUT_MS = 30000;

// Destinations a donor must never reach on behalf of a stranger: loopback,
// private LANs, link-local (cloud metadata), CGNAT, multicast and reserved.
const blockedNets = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
]) {
  blockedNets.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 127],        // :: and ::1
  ['64:ff9b::', 96],  // NAT64
  ['fc00::', 7],      // unique local
  ['fe80::', 10],     // link-local
  ['ff00::', 8],      // multicast
  ['2001:db8::', 32]  // documentation
]) {
  blockedNets.addSubnet(addr, prefix, 'ipv6');
}

/** True when `address` is a public, routable IP address. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blockedNets.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) must be judged as IPv4
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !blockedNets.check(mapped[1], 'ipv4');
    if (address.toLowerCase().startsWith('::ffff:')) return false;
    return !blockedNets.check(address, 'ipv6');
  }
  return false;
}

export class VpnRelay {
  constructor(options = {}) {
    this.allowedPorts = new Set(options.allowedPorts || DEFAULT_ALLOWED_PORTS);
    this.lookup = options.lookup || ((host) => dns.lookup(host, { all: true, verbatim: true }));
    this.activeSessions = new Map(); // sessionId -> { socket, sessionKey, targetHost, targetPort, bytesIn, bytesOut }
    this.totalBytesRouted = 0;
  }

  isPortAllowed(port) {
    const numPort = Number(port);
    return Number.isInteger(numPort) && this.allowedPorts.has(numPort);
  }

  /**
   * Resolves the destination ONCE and returns a public IP to connect to.
   * Connecting to the resolved IP (not the hostname) prevents DNS rebinding.
   */
  async resolvePublicTarget(host) {
    if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
      throw new Error('Host de destino inválido');
    }
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) {
      if (!isPublicAddress(bare)) throw new Error('Destino en red privada o reservada bloqueado');
      return bare;
    }
    const records = await this.lookup(bare);
    const list = Array.isArray(records) ? records : [records];
    if (list.length === 0) throw new Error('No se pudo resolver el host de destino');
    // Refuse if ANY record points inside: a mixed answer is a rebinding attempt.
    if (list.some(r => !isPublicAddress(r.address))) {
      throw new Error('Destino en red privada o reservada bloqueado');
    }
    return list[0].address;
  }

  /**
   * Opens an encrypted TCP stream to a remote host on behalf of a VPN client.
   * `clientPublicKey` is the client's ephemeral X25519 key.
   */
  async handleConnect(sessionId, targetHost, targetPort, clientPublicKey, sendCallback) {
    const fail = (error) => sendCallback({ type: 'VPN_ERROR', sessionId, error });

    if (typeof sessionId !== 'string' || !sessionId || this.activeSessions.has(sessionId)) {
      return fail('Sesión inválida o duplicada');
    }
    if (this.activeSessions.size >= MAX_SESSIONS) {
      return fail('El nodo donante alcanzó su límite de sesiones dVPN');
    }
    if (!this.isPortAllowed(targetPort)) {
      return fail(`Puerto de destino :${targetPort} bloqueado por la política de seguridad del donante`);
    }

    let sessionKey;
    let relayPublicKey;
    let address;
    try {
      const pair = CryptoTunnel.createEphemeralKeyPair();
      relayPublicKey = pair.publicKey;
      sessionKey = CryptoTunnel.deriveSessionKey(pair.privateKey, clientPublicKey, sessionId);
      address = await this.resolvePublicTarget(targetHost);
    } catch (err) {
      return fail(err.message);
    }

    const session = {
      socket: null,
      sessionKey,
      targetHost,
      targetPort: Number(targetPort),
      bytesIn: 0,
      bytesOut: 0,
      createdAt: Date.now()
    };
    this.activeSessions.set(sessionId, session);

    const socket = net.createConnection({ host: address, port: Number(targetPort) }, () => {
      sendCallback({ type: 'VPN_CONNECTED', sessionId, relayPublicKey });
    });
    session.socket = socket;

    socket.on('data', (chunk) => {
      this.totalBytesRouted += chunk.length;
      session.bytesIn += chunk.length;
      sendCallback({
        type: 'VPN_DATA_STREAM',
        sessionId,
        payload: CryptoTunnel.encrypt(chunk, sessionKey)
      });
    });

    socket.on('end', () => {
      sendCallback({ type: 'VPN_CLOSED', sessionId });
      this.activeSessions.delete(sessionId);
    });

    socket.on('error', (err) => {
      fail(err.message);
      this.activeSessions.delete(sessionId);
    });

    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      socket.destroy();
      sendCallback({ type: 'VPN_CLOSED', sessionId });
      this.activeSessions.delete(sessionId);
    });
  }

  /** Handles an encrypted frame from the client destined for the target host */
  handleData(sessionId, encryptedPayload) {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.socket || session.socket.destroyed) {
      return false;
    }

    try {
      const decrypted = CryptoTunnel.decrypt(encryptedPayload, session.sessionKey);
      this.totalBytesRouted += decrypted.length;
      session.bytesOut += decrypted.length;
      session.socket.write(decrypted);
      return true;
    } catch (err) {
      console.error(`[VPN Relay] Failed to decrypt client frame: ${err.message}`);
      return false;
    }
  }

  closeSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      if (session.socket) session.socket.destroy();
      this.activeSessions.delete(sessionId);
    }
  }

  destroy() {
    for (const session of this.activeSessions.values()) {
      if (session.socket) session.socket.destroy();
    }
    this.activeSessions.clear();
  }
}
