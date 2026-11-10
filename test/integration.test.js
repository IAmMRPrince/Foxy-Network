// Full stack: real gateway, controller and daemon processes on random ports,
// each with its own state directory, driven the way a user and Foxy Finance would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { FoxyNetworkClient } from '../packages/foxy-finance-workload/src/network-client.js';
import { FoxyVpnClient } from '../packages/foxy-vpn/src/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

test('full stack', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-it-'));
  const daemonCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-it-daemon-'));
  const [gwHttp, gwWs, ctrl, daemonPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);

  const env = {
    PATH: process.env.PATH,
    FOXY_STATE_DIR: stateDir,
    FOXY_NETWORK_SECRET: 'it-network-secret',
    FOXY_ADMIN_KEY: 'it-admin',
    FOXY_FINANCE_API_SECRET: 'it-partner',
    FOXY_GATEWAY_HTTP_PORT: String(gwHttp),
    FOXY_GATEWAY_TUNNEL_PORT: String(gwWs),
    FOXY_GATEWAY_HOST: '127.0.0.1',
    FOXY_GATEWAY_TUNNEL_URL: `ws://127.0.0.1:${gwWs}`,
    FOXY_CONTROLLER_PORT: String(ctrl),
    FOXY_CONTROLLER_HOST: '127.0.0.1',
    FOXY_CONTROLLER_URL: `http://127.0.0.1:${ctrl}`,
    FOXY_DAEMON_PORT: String(daemonPort),
    FOXY_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
    FOXY_GATEWAY_URL: `http://127.0.0.1:${gwHttp}`
  };

  const procs = [];
  const logs = [];
  const start = (name, file, cwd = ROOT) => {
    const child = spawn(process.execPath, [path.join(ROOT, file)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs.push(`[${name}] ${d}`));
    child.stderr.on('data', d => logs.push(`[${name} ERR] ${d}`));
    procs.push(child);
  };
  t.after(() => {
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(daemonCwd, { recursive: true, force: true });
  });

  start('gateway', 'packages/foxy-gateway/src/index.js');
  start('controller', 'packages/foxy-controller/src/index.js');
  start('daemon', 'packages/foxy-daemon/src/index.js', daemonCwd);

  const daemon = `http://127.0.0.1:${daemonPort}`;
  const controller = `http://127.0.0.1:${ctrl}`;
  const gateway = `http://127.0.0.1:${gwHttp}`;

  try {
    const tokenFile = path.join(daemonCwd, '.foxy', 'daemon-token');
    const token = await waitFor(() => fs.readFileSync(tokenFile, 'utf-8'), { label: 'daemon token' });
    const api = async (route, { method = 'GET', body, headers = {} } = {}) => {
      const res = await fetch(daemon + route, {
        method,
        headers: { 'X-Foxy-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: res.status, data: await res.json(), headers: res.headers };
    };

    const state = await waitFor(async () => {
      const s = (await api('/api/state')).data;
      return s.registered && s.tunnelStatus === 'CONNECTED' ? s : null;
    }, { label: 'daemon registered and tunnelled' });

    await t.test('secrets are not left where git would pick them up', () => {
      assert.ok(!fs.existsSync(path.join(ROOT, '.foxy-network-secret')));
      const wallet = fs.statSync(path.join(daemonCwd, '.foxy', 'wallet.json'));
      if (process.platform !== 'win32') assert.equal(wallet.mode & 0o077, 0, 'wallet file is private');
    });

    await t.test('the local dashboard API is closed to other websites', async () => {
      // No token: nothing, not even the state
      for (const route of ['/api/state', '/api/workloads']) {
        assert.equal((await fetch(daemon + route)).status, 401, route);
      }
      const exported = await fetch(daemon + '/api/wallet/export');
      assert.equal(exported.status, 401);
      assert.ok(!(await exported.text()).includes('privateKey'));
      for (const route of ['/api/wallet/export', '/api/workloads/spawn', '/api/claim-rewards', '/api/toggle-donation', '/api/finance/link-code']) {
        const res = await fetch(daemon + route, { method: 'POST', body: '{}' });
        assert.equal(res.status, 401, route);
      }
      // No CORS grant for any origin
      const pre = await fetch(daemon + '/api/wallet/export', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      assert.equal(pre.headers.get('access-control-allow-origin'), null);
      const withOrigin = await api('/api/state', { headers: { Origin: 'https://evil.example' } });
      assert.equal(withOrigin.headers.get('access-control-allow-origin'), null);

      // DNS rebinding: a request that arrives under another hostname is refused,
      // even for the page that carries the token.
      const rebound = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: daemonPort, path: '/', headers: { Host: 'evil.example' } }, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(rebound.status, 403);
      assert.ok(!rebound.body.includes(token));

      // The real page does carry the token, and forbids framing
      const page = await fetch(daemon + '/');
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.ok((await page.text()).includes(token));
    });

    await t.test('the daemon is not reachable from other machines', () => {
      const lines = logs.join('');
      assert.ok(!lines.includes('0.0.0.0:' + daemonPort));
      // Bound to loopback: connecting via a non-loopback local address must fail
      const addrs = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal);
      if (addrs.length === 0) return;
      return new Promise((resolve) => {
        const s = net.createConnection({ host: addrs[0].address, port: daemonPort });
        s.setTimeout(1500, () => { s.destroy(); resolve(); });
        s.on('connect', () => { s.destroy(); assert.fail('daemon accepted a connection on a LAN address'); });
        s.on('error', () => resolve());
      });
    });

    await t.test('wallet export needs the token and an explicit confirmation', async () => {
      assert.equal((await api('/api/wallet/export', { method: 'POST', body: {} })).status, 400);
      const ok = await api('/api/wallet/export', { method: 'POST', body: { confirm: 'EXPORT' } });
      assert.equal(ok.status, 200);
      assert.match(ok.data.privateKey, /^0x[0-9a-f]{64}$/);
    });

    await t.test('workloads cannot be used to run commands', async () => {
      const marker = path.join(daemonCwd, 'pwned');
      const attempts = [
        { type: 'docker', name: 'x', subdomain: 'x1', image: `nginx; touch ${marker}` },
        { type: 'docker', name: 'x', subdomain: 'x2', image: `$(touch ${marker})` },
        { type: 'docker', name: 'x', subdomain: 'x3', image: '--privileged' },
        { type: 'python', name: 'x', subdomain: 'x4', scriptPath: '/etc/passwd', staticDir: '/' },
        { type: 'bash', name: 'x', subdomain: 'x5' }
      ];
      for (const body of attempts.slice(0, 3).concat(attempts.slice(4))) {
        const res = await api('/api/workloads/spawn', { method: 'POST', body });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.ok(!fs.existsSync(marker));

      // A normal workload works and is reachable through the gateway
      const res = await api('/api/workloads/spawn', { method: 'POST', body: { type: 'static', name: '<b>Mi App</b>', subdomain: 'mi-app' } });
      assert.equal(res.status, 201);
      assert.equal(res.data.tunneled, true);
      const page = await waitFor(async () => {
        const r = await fetch(`${gateway}/t/mi-app/`);
        return r.status === 200 ? r.text() : null;
      }, { label: 'workload through gateway' });
      assert.ok(page.includes('Mi App'));
      assert.ok(!page.includes('<b>Mi App</b>'), 'name is escaped');

      // The python workload serves only its own private folder, never a caller-chosen path
      const py = await api('/api/workloads/spawn', { method: 'POST', body: attempts[3] });
      if (py.status === 201) {
        const body = await waitFor(async () => {
          const r = await fetch(`${gateway}/t/x4/`);
          return r.status === 200 ? r.text() : null;
        }, { label: 'python workload' });
        assert.ok(!body.includes('root:'));
        assert.equal((await fetch(`${gateway}/t/x4/etc/passwd`)).status, 404);
      }
    });

    await t.test('the gateway serves only authorized tunnels', async () => {
      const home = await fetch(`${gateway}/t/${state.subdomain}/`);
      assert.equal(home.status, 200);
      // Unknown subdomain: an error page, with the name sanitized
      const res = await fetch(`${gateway}/`, { headers: { 'X-Foxy-Subdomain': '<script>alert(1)</script>' } });
      assert.ok(!(await res.text()).includes('<script>alert(1)'));

      // A stranger cannot register a tunnel or a VPN relay without a valid token
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${gwWs}`);
      const replies = [];
      await new Promise(r => ws.on('open', r));
      ws.on('message', d => replies.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: 'REGISTER_TUNNEL', nodeId: 'evil', subdomain: state.subdomain, authToken: 'a.b.c' }));
      ws.send(JSON.stringify({ type: 'REGISTER_VPN_RELAY', nodeId: 'evil' }));
      await waitFor(() => replies.length >= 2, { label: 'gateway replies' });
      assert.ok(replies.every(r => r.type === 'SECURITY_ERROR'));
      ws.close();
      // The real tunnel still answers
      assert.equal((await fetch(`${gateway}/t/${state.subdomain}/`)).status, 200);
    });

    await t.test('the dVPN cannot be used to reach the donor machine or its network', async () => {
      const vpn = new FoxyVpnClient({ port: 0, gatewayUrl: `ws://127.0.0.1:${gwWs}` });
      await vpn.start();
      try {
        const viaProxy = (target) => new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: vpn.port, method: 'CONNECT', path: target });
          req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
          req.on('error', reject);
          req.end();
        });
        // The donor's own dashboard, the controller, and a LAN address
        assert.equal(await viaProxy(`127.0.0.1:${daemonPort}`), 502);
        assert.equal(await viaProxy(`localhost:${ctrl}`), 502);
        assert.equal(await viaProxy('192.168.1.1:80'), 502);
        assert.equal(await viaProxy('169.254.169.254:80'), 502);
        assert.equal(await viaProxy('127.0.0.1:443'), 502);
      } finally {
        vpn.stop();
      }
    });

    const finance = new FoxyNetworkClient({ baseUrl: controller, secret: 'it-partner' });

    await t.test('Foxy Finance: link the node, read benefits, run verified compute', async () => {
      const code = await api('/api/finance/link-code', { method: 'POST', body: {} });
      assert.equal(code.status, 200);
      const linked = await finance.redeemLinkCode(code.data.code, 'ff-user-7');
      assert.equal(linked.nodeId, state.nodeId);

      const benefits = await finance.getUserBenefits('ff-user-7');
      assert.equal(benefits.linkedNodes, 1);
      assert.equal(benefits.nodes[0].online, true);
      assert.ok(['PC', 'SBC', 'MOBILE'].includes(benefits.nodes[0].deviceClass));

      await waitFor(async () => (await api('/api/state')).data.foxyFinance.linked, { label: 'daemon sees the link' });

      // A real job, executed by the real daemon in a worker thread
      const job = await finance.runJob('monte_carlo_gbm', { paths: 20000, steps: 20, sigma: 0.5, seed: 11 }, { timeoutMs: 30000, intervalMs: 500 });
      assert.equal(job.status, 'COMPLETED');
      assert.ok(job.result.valueAtRisk95 > 0 && job.result.cvar99 >= job.result.valueAtRisk99);
      assert.equal(job.attempts[0].nodeId, state.nodeId);
      assert.equal(job.attempts[0].paidComputeUnits, job.computeUnits);

      // Latency probe: destinations inside the donor's network are refused by the node
      const probe = await finance.runJob('latency_probe', { targets: [{ host: 'localhost', port: 443 }] }, { timeoutMs: 30000, intervalMs: 500 });
      assert.equal(probe.status, 'COMPLETED');
      assert.equal(probe.attempts[0].result.targets[0].reachable, false);

      const s = (await api('/api/state')).data;
      assert.ok(s.jobs.completed >= 2);
    });

    await t.test('Python client speaks the same protocol', { skip: (() => { try { execFileSync('python3', ['--version']); return false; } catch { return 'python3 not available'; } })() }, () => {
      const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'integrations', 'python'))})
from foxy_network_client import FoxyNetworkClient, FoxyNetworkError
c = FoxyNetworkClient(${JSON.stringify(controller)}, "it-partner")
net = c.get_network()
job = c.run_job("sha256_benchmark", {"iterations": 3000, "seed": 9}, timeout=30, replicas=1)
ben = c.get_user_benefits("ff-user-7")
bad = FoxyNetworkClient(${JSON.stringify(controller)}, "wrong")
try:
    bad.get_network(); rejected = False
except FoxyNetworkError as e:
    rejected = e.status == 401
print(json.dumps({"types": len(net["jobTypes"]), "status": job["status"], "digest": job["result"]["digest"], "linked": ben["linkedNodes"], "rejected": rejected}))
`;
      const out = JSON.parse(execFileSync('python3', ['-I', '-c', script], { encoding: 'utf-8', timeout: 60000 }));
      assert.deepEqual({ ...out, digest: undefined }, { types: 4, status: 'COMPLETED', digest: undefined, linked: 1, rejected: true });
      assert.match(out.digest, /^[0-9a-f]{64}$/);
    });

    await t.test('CLI works against the running stack', () => {
      const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'packages/foxy-cli/bin/foxy.js'), ...args], { env, cwd: daemonCwd, encoding: 'utf-8', timeout: 60000 });
      assert.match(cli('status'), /Nodos donantes:\s+1 online/);
      assert.match(cli('finance', 'status'), /Nodos vinculados a cuentas: 1/);
      assert.match(cli('finance', 'dispatch', 'matrix_benchmark'), /Estado:\s+COMPLETED/);
      assert.match(cli('link'), /[A-Z2-9]{5}-[A-Z2-9]{5}/);
      assert.match(cli('deploy', 'cli-app'), /Despliegue registrado/);
    });

    await t.test('the daemon keeps its identity across restarts', async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(daemonCwd, '.foxy', 'node.json'), 'utf-8'));
      assert.equal(saved.nodeId, state.nodeId);
      assert.ok(saved.nodeToken);
      const daemonProc = procs[2];
      daemonProc.kill('SIGTERM');
      await new Promise(r => daemonProc.once('exit', r));
      start('daemon2', 'packages/foxy-daemon/src/index.js', daemonCwd);
      const token2 = await waitFor(() => { const v = fs.readFileSync(tokenFile, 'utf-8'); return v !== token ? v : null; }, { label: 'new session token' });
      const again = await waitFor(async () => {
        const r = await fetch(daemon + '/api/state', { headers: { 'X-Foxy-Token': token2 } });
        const s = await r.json();
        return s.registered ? s : null;
      }, { label: 'daemon re-registered' });
      assert.equal(again.nodeId, state.nodeId);
      // The old session token died with the old process
      assert.equal((await fetch(daemon + '/api/state', { headers: { 'X-Foxy-Token': token } })).status, 401);
      // Still linked: the link belongs to the node identity
      assert.equal((await finance.getUserBenefits('ff-user-7')).linkedNodes, 1);
    });
  } catch (err) {
    console.error(logs.join('').slice(-4000));
    throw err;
  }
});
