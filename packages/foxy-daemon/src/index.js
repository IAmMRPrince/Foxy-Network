// ==============================================================================
// Foxy Network - Donor daemon
// Runs on the donor's machine: local dashboard, reverse tunnel, dVPN exit relay,
// compute jobs and the link with Foxy Finance.
// ==============================================================================

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WorkloadEngine } from './workload-engine.js';
import { WalletManager } from './wallet-manager.js';
import { runJob } from './job-runner.js';
import { VpnRelay } from '../../foxy-vpn/src/relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_HTML = path.resolve(__dirname, '..', 'public', 'index.html');

const DAEMON_PORT = parseInt(process.env.FOXY_DAEMON_PORT || '4040', 10);
// The dashboard can export the wallet's private key: it listens on loopback only.
const DAEMON_HOST = process.env.FOXY_DAEMON_HOST || '127.0.0.1';
const GATEWAY_TUNNEL_URL = process.env.FOXY_GATEWAY_TUNNEL_URL || 'ws://127.0.0.1:8081';
const CONTROLLER_URL = (process.env.FOXY_CONTROLLER_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const MAX_BODY_BYTES = 64 * 1024;
const DEVICE_CLASSES = ['IOT', 'MOBILE', 'SBC', 'PC', 'SERVER'];

const walletManager = new WalletManager();
const STATE_DIR = walletManager.storageDir;
const engine = new WorkloadEngine({ dataDir: STATE_DIR });
const vpnRelay = new VpnRelay();

// Subdomain capability tokens issued by the controller (subdomain -> JWT)
const tokensMap = new Map();

// -------------------------------------------------------------
// 0. Persistent node identity + local session token
// -------------------------------------------------------------
const IDENTITY_FILE = path.join(STATE_DIR, 'node.json');

function loadIdentity() {
  try {
    const saved = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8'));
    if (saved.nodeId) return saved;
  } catch {
    // First run
  }
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'host';
  return { nodeId: `node-${host}-${crypto.randomBytes(3).toString('hex')}`, nodeToken: null };
}

function saveIdentity() {
  try {
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error(`[Daemon] No se pudo guardar la identidad del nodo: ${err.message}`);
  }
}

const identity = loadIdentity();

// Required on every API call that changes state or reveals secrets. It is
// handed to the dashboard page and saved (0600) for local tools.
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
try {
  fs.writeFileSync(path.join(STATE_DIR, 'daemon-token'), SESSION_TOKEN, { encoding: 'utf-8', mode: 0o600 });
} catch {
  // Dashboard still works; only local tools lose access
}

/** Best guess of the kind of hardware, used for Foxy Finance benefits. */
function detectDeviceClass() {
  const declared = (process.env.FOXY_DEVICE_CLASS || '').toUpperCase();
  if (DEVICE_CLASSES.includes(declared)) return declared;
  if (os.platform() === 'android' || process.env.TERMUX_VERSION) return 'MOBILE';
  const ramMb = os.totalmem() / 1024 / 1024;
  if (os.platform() === 'linux' && /^arm/.test(os.arch()) && ramMb <= 8800) return 'SBC';
  return 'PC';
}

function localSpecs() {
  return {
    cores: os.cpus().length,
    totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
    platform: os.platform(),
    arch: os.arch(),
    runtime: engine.runtime.type
  };
}

// Configuration & Donor State
const state = {
  nodeId: identity.nodeId,
  name: `Donante-${os.hostname()}`,
  isDonating: true,
  deviceClass: detectDeviceClass(),
  quota: {
    maxCpuCores: Math.min(2, os.cpus().length),
    maxRamMb: 2048,
    maxStorageGb: 10
  },
  subdomain: (process.env.FOXY_SUBDOMAIN || 'foxy-demo-app').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'foxy-demo-app',
  registered: false,
  tunnelStatus: 'DISCONNECTED', // DISCONNECTED | CONNECTING | CONNECTED
  tunnelSocket: null,
  wallet: walletManager.getPublicProfile(),
  vpn: {
    enabled: process.env.FOXY_VPN_RELAY !== 'off',
    totalBytesRouted: 0,
    activeSessions: 0
  },
  jobs: {
    enabled: process.env.FOXY_COMPUTE_JOBS !== 'off',
    completed: 0,
    failed: 0,
    running: 0
  },
  foxyFinance: { linked: false, linkedAt: null, deviceClass: null, uptimeRatio24h: 0 },
  stats: {
    requestsHandled: 0,
    bytesServed: 0,
    startTime: Date.now()
  },
  rewards: {
    balance: 0,
    lifetimeEarnings: 0,
    tier: 'STANDARD',
    epochsSettled: 0,
    recentPayouts: []
  },
  recentLogs: []
};

function addLog(message, type = 'info') {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toLocaleTimeString(),
    message,
    type
  };
  state.recentLogs.unshift(entry);
  if (state.recentLogs.length > 50) state.recentLogs.pop();
  console.log(`[Daemon ${entry.timestamp}] ${message}`);
}

/** Authenticated call to the controller as this node. */
async function controllerPost(route, body = {}) {
  const res = await fetch(`${CONTROLLER_URL}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(identity.nodeToken ? { Authorization: `Bearer ${identity.nodeToken}` } : {})
    },
    body: JSON.stringify({ nodeId: state.nodeId, ...body }),
    signal: AbortSignal.timeout(10000)
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, ok: res.ok, data };
}

// -------------------------------------------------------------
// 1. Initial Workload Setup
// -------------------------------------------------------------
async function initializeBaseWorkload() {
  addLog(`Motor de ejecución detectado: ${engine.runtime.name}`, 'success');
  try {
    await engine.spawnWorkload({
      id: 'demo-app',
      name: 'Foxy Cloud Demo App',
      type: 'static',
      subdomain: state.subdomain,
      quota: state.quota
    });
    addLog(`Carga base 'demo-app' lista para recibir tráfico.`, 'success');
  } catch (err) {
    addLog(`Error al inicializar carga base: ${err.message}`, 'error');
  }

  // Operator's node only: publish the Foxy Finance SaaS under the .fox domains.
  if (process.env.FOXY_HOST_FINANCE === '1') {
    try {
      const financePort = parseInt(process.env.FOXY_FINANCE_PORT || '8000', 10);
      await engine.attachFoxyFinance({
        port: financePort,
        appDir: process.env.FOXY_FINANCE_DIR || null,
        foxDomain: 'https://www.foxyfinance.fox',
        quota: state.quota
      });
      addLog(`🌐 FOXY FINANCE publicado como [foxy-finance] (-> 127.0.0.1:${financePort})`, 'success');
    } catch (err) {
      addLog(`No se pudo publicar FOXY FINANCE: ${err.message}`, 'error');
    }
  }
}

// -------------------------------------------------------------
// 2. Reverse Tunnel Client (Connects to Ingress Gateway)
// -------------------------------------------------------------
function tunnelOpen() {
  return state.tunnelSocket && state.tunnelSocket.readyState === WebSocket.OPEN;
}

function tunnelSend(message) {
  if (tunnelOpen()) state.tunnelSocket.send(JSON.stringify(message));
}

function registerVpnRelay() {
  if (state.vpn.enabled && identity.nodeToken) {
    tunnelSend({ type: 'REGISTER_VPN_RELAY', nodeId: state.nodeId, nodeToken: identity.nodeToken });
  }
}

function connectToTunnelGateway() {
  if (!state.isDonating) {
    if (state.tunnelSocket) {
      state.tunnelSocket.close();
      state.tunnelSocket = null;
    }
    state.tunnelStatus = 'DISCONNECTED';
    return;
  }
  if (state.tunnelSocket) return; // already connecting or connected

  state.tunnelStatus = 'CONNECTING';
  addLog(`Iniciando conexión de túnel inverso a ${GATEWAY_TUNNEL_URL}...`);

  const ws = new WebSocket(GATEWAY_TUNNEL_URL);
  state.tunnelSocket = ws;

  ws.on('open', () => {
    state.tunnelStatus = 'CONNECTED';
    addLog(`✅ Túnel WebSocket conectado. Registrando subdominios y dVPN...`, 'success');
    registerAllTunnels();
    registerVpnRelay();
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'TUNNEL_READY') {
        addLog(`🎉 Túnel activo para [${msg.subdomain}].`, 'success');
      }

      if (msg.type === 'VPN_RELAY_ACK') {
        addLog(`🛡️ Modo dVPN activo: nodo disponible como salida cifrada.`, 'success');
      }

      if (msg.type === 'SECURITY_ERROR') {
        addLog(`🛡️ Rechazado por el Gateway: ${msg.message}`, 'error');
        // A rejected token may simply have expired: drop it so a fresh one is requested.
        if (msg.subdomain) tokensMap.delete(msg.subdomain);
      }

      // dVPN egress traffic
      if (msg.type === 'VPN_REQUEST_CONNECT') {
        const reply = (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
        if (!state.vpn.enabled) {
          reply({ type: 'VPN_ERROR', sessionId: msg.sessionId, error: 'dVPN Exit Relay deshabilitado en este nodo donante' });
          return;
        }
        // Zero-logs: destinations are never written to the log.
        await vpnRelay.handleConnect(msg.sessionId, msg.targetHost, msg.targetPort, msg.clientPublicKey, reply);
        state.vpn.activeSessions = vpnRelay.activeSessions.size;
        return;
      }

      if (msg.type === 'VPN_CLIENT_DATA') {
        vpnRelay.handleData(msg.sessionId, msg.payload);
        return;
      }

      if (msg.type === 'VPN_CLIENT_CLOSE') {
        vpnRelay.closeSession(msg.sessionId);
        state.vpn.activeSessions = vpnRelay.activeSessions.size;
        return;
      }

      if (msg.type === 'HTTP_REQUEST') {
        const { requestId, method, url, headers, body, isBase64, subdomain } = msg;
        state.stats.requestsHandled++;
        forwardToWorkload(requestId, method, url, headers, body, isBase64, subdomain);
      }
    } catch (err) {
      addLog(`Error procesando mensaje de túnel: ${err.message}`, 'error');
    }
  });

  ws.on('close', () => {
    if (state.tunnelSocket === ws) state.tunnelSocket = null;
    state.tunnelStatus = 'DISCONNECTED';
    vpnRelay.destroy();
    if (state.isDonating) {
      addLog(`🔌 Túnel desconectado. Reintentando en 4 segundos...`, 'warning');
      setTimeout(connectToTunnelGateway, 4000);
    }
  });

  ws.on('error', (err) => {
    addLog(`Fallo de conexión en el túnel: ${err.message}`, 'error');
  });
}

/** Asks the controller for the right to serve `subdomain`. */
async function getSubdomainToken(subdomain) {
  if (tokensMap.has(subdomain)) return tokensMap.get(subdomain);
  if (!identity.nodeToken) return null;
  const { ok, status, data } = await controllerPost('/api/auth/token', { subdomain });
  if (!ok) {
    addLog(`El controlador no autorizó el subdominio [${subdomain}]: ${data.error || status}`, 'error');
    return null;
  }
  tokensMap.set(subdomain, data.token);
  return data.token;
}

async function registerTunnelForSubdomain(subdomain, customToken = null) {
  if (!tunnelOpen()) return false;
  if (customToken) tokensMap.set(subdomain, customToken);
  let token = null;
  try {
    token = await getSubdomainToken(subdomain);
  } catch {
    // Controller unreachable: retried on the next heartbeat
  }
  if (!token) return false;
  tunnelSend({ type: 'REGISTER_TUNNEL', nodeId: state.nodeId, subdomain, authToken: token, specs: localSpecs() });
  return true;
}

async function registerAllTunnels() {
  const subdomains = new Set([state.subdomain]);
  for (const w of engine.workloads.values()) {
    if (w.subdomain && w.status === 'RUNNING') subdomains.add(w.subdomain);
  }
  for (const sub of subdomains) await registerTunnelForSubdomain(sub);
}

function forwardToWorkload(requestId, method, url, incomingHeaders, body, isBase64, subdomain) {
  // Find which workload matches this subdomain
  // Only the workload bound to this exact subdomain may answer.
  let targetPort = null;
  const match = Array.from(engine.workloads.values()).find(
    w => w.subdomain === subdomain && w.status === 'RUNNING'
  );

  if (match) targetPort = match.port;

  if (!targetPort) {
    if (state.tunnelSocket && state.tunnelSocket.readyState === WebSocket.OPEN) {
      state.tunnelSocket.send(JSON.stringify({
        type: 'HTTP_RESPONSE',
        requestId,
        statusCode: 503,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Foxy Daemon: No active workloads available on this node',
        isBase64: false
      }));
    }
    return;
  }

  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: url,
    method: method,
    headers: { ...incomingHeaders, host: `127.0.0.1:${targetPort}` }
  };

  const localReq = http.request(options, (localRes) => {
    const chunks = [];
    localRes.on('data', chunk => chunks.push(chunk));
    localRes.on('end', () => {
      const respBuffer = Buffer.concat(chunks);
      state.stats.bytesServed += respBuffer.length;

      if (state.tunnelSocket && state.tunnelSocket.readyState === WebSocket.OPEN) {
        state.tunnelSocket.send(JSON.stringify({
          type: 'HTTP_RESPONSE',
          requestId,
          statusCode: localRes.statusCode,
          headers: localRes.headers,
          body: respBuffer.toString('base64'),
          isBase64: true
        }));
      }
    });
  });

  localReq.on('error', (err) => {
    addLog(`Error comunicando con servicio en puerto :${targetPort}: ${err.message}`, 'error');
    if (state.tunnelSocket && state.tunnelSocket.readyState === WebSocket.OPEN) {
      state.tunnelSocket.send(JSON.stringify({
        type: 'HTTP_RESPONSE',
        requestId,
        statusCode: 502,
        headers: { 'Content-Type': 'text/plain' },
        body: `Foxy Daemon: 502 Bad Gateway - Servicio local en :${targetPort} inalcanzable`,
        isBase64: false
      }));
    }
  });

  if (body) {
    localReq.write(Buffer.from(body, isBase64 ? 'base64' : 'utf-8'));
  }
  localReq.end();
}

// -------------------------------------------------------------
// 3. Controller Registration & Heartbeat
// -------------------------------------------------------------
let registering = null;

function registerWithController() {
  if (!registering) {
    registering = doRegister().finally(() => { registering = null; });
  }
  return registering;
}

async function doRegister() {
  try {
    let { ok, status, data } = await controllerPost('/api/nodes/register', {
      name: state.name,
      subdomain: state.subdomain,
      walletAddress: walletManager.getActiveAddress(),
      specs: localSpecs(),
      quota: state.quota,
      deviceClass: state.deviceClass,
      acceptsJobs: state.jobs.enabled
    });

    if (status === 401) {
      // Our id is taken and we cannot prove it is ours (lost or foreign token).
      addLog('El controlador no reconoce la identidad de este nodo. Generando una nueva.', 'warning');
      const fresh = `node-${crypto.randomBytes(6).toString('hex')}`;
      identity.nodeId = fresh;
      identity.nodeToken = null;
      state.nodeId = fresh;
      saveIdentity();
      return;
    }
    if (!ok) return;

    identity.nodeToken = data.nodeToken;
    saveIdentity();
    state.registered = true;

    if (data.subdomain && data.subdomain !== state.subdomain) {
      addLog(`El subdominio [${state.subdomain}] ya está en uso. Asignado [${data.subdomain}].`, 'warning');
      const base = engine.workloads.get('demo-app');
      if (base) base.subdomain = data.subdomain;
      state.subdomain = data.subdomain;
    }
    if (data.authToken) tokensMap.set(state.subdomain, data.authToken);

    addLog(`Registrado en Foxy Controller (${CONTROLLER_URL}) como [${state.nodeId}]`, 'success');
    await registerAllTunnels();
    registerVpnRelay();
  } catch (err) {
    // Controller unreachable: retried on the next heartbeat
  }
}

/** CPU load as a percentage of all cores (1-minute average; 0 on Windows). */
function cpuUsagePercent() {
  const load = os.loadavg()[0];
  return Math.max(0, Math.min(100, Math.round((load / os.cpus().length) * 100)));
}

async function sendHeartbeat() {
  if (!state.isDonating) return;
  if (!state.registered || !identity.nodeToken) {
    await registerWithController();
    return;
  }

  try {
    state.vpn.totalBytesRouted = vpnRelay.totalBytesRouted;
    state.vpn.activeSessions = vpnRelay.activeSessions.size;

    const { ok, status, data } = await controllerPost('/api/nodes/heartbeat', {
      walletAddress: walletManager.getActiveAddress(),
      telemetry: {
        cpuUsagePercent: cpuUsagePercent(),
        ramUsedMb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        requestsHandled: state.stats.requestsHandled,
        bytesServed: state.stats.bytesServed,
        vpnBytesServed: vpnRelay.totalBytesRouted
      },
      activeWorkloads: engine.listWorkloads().map(w => ({ id: w.id, status: w.status, subdomain: w.subdomain }))
    });

    if (status === 404 || status === 401) {
      state.registered = false;
      await registerWithController();
      return;
    }
    if (!ok) return;

    if (data.rewards) state.rewards = data.rewards;
    if (data.foxyFinance) state.foxyFinance = data.foxyFinance;

    for (const cmd of data.pendingCommands || []) {
      if (cmd.type === 'DEPLOY_WORKLOAD') {
        await handleDeployCommand(cmd);
      } else if (cmd.type === 'RUN_JOB') {
        handleJobCommand(cmd); // runs in the background
      }
    }
  } catch (err) {
    // Controller unreachable: next heartbeat retries
  }
}

async function handleDeployCommand(cmd) {
  addLog(`📦 Recibida orden de despliegue del controlador: [${cmd.subdomain}]`, 'success');
  try {
    const workload = await engine.spawnWorkload({
      id: cmd.deploymentId,
      name: cmd.config?.appName || cmd.subdomain,
      type: cmd.config?.type || 'static',
      subdomain: cmd.subdomain,
      image: cmd.config?.image,
      quota: state.quota
    });

    addLog(`Despliegue activo en puerto :${workload.port}. Registrando túnel...`, 'success');
    await registerTunnelForSubdomain(workload.subdomain, cmd.authToken || null);
  } catch (err) {
    addLog(`Error desplegando orden: ${err.message}`, 'error');
  }
}

async function handleJobCommand(cmd) {
  if (!state.jobs.enabled) return;
  state.jobs.running++;
  let report;
  try {
    const { result, durationMs } = await runJob(cmd.jobType, cmd.params);
    report = { jobId: cmd.jobId, result, durationMs };
    state.jobs.completed++;
    addLog(`🧮 Trabajo de cómputo completado: ${cmd.jobType} (${durationMs} ms)`, 'success');
  } catch (err) {
    report = { jobId: cmd.jobId, error: err.message };
    state.jobs.failed++;
    addLog(`Trabajo de cómputo rechazado o fallido (${cmd.jobType}): ${err.message}`, 'error');
  } finally {
    state.jobs.running--;
  }
  try {
    await controllerPost('/api/nodes/jobs/result', report);
  } catch {
    // The controller will time the attempt out and reassign it
  }
}

setInterval(sendHeartbeat, 5000);

// -------------------------------------------------------------
// 4. Local Web UI Dashboard for the Donor (http://localhost:4040)
// -------------------------------------------------------------
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Rejects requests that reached us through another hostname (DNS rebinding). */
function hostAllowed(req) {
  const header = (req.headers.host || '').toLowerCase();
  const hostname = header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0];
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return DAEMON_HOST !== '127.0.0.1' && hostname === DAEMON_HOST.toLowerCase();
}

function tokenValid(req) {
  const provided = req.headers['x-foxy-token'];
  if (typeof provided !== 'string' || provided.length !== SESSION_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SESSION_TOKEN));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Cuerpo de la petición demasiado grande'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
  });
}

const dashboardServer = http.createServer(async (req, res) => {
  // No CORS headers on purpose: only the dashboard served from this same
  // origin may talk to this API.
  const json = (status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(data));
  };

  if (!hostAllowed(req)) return json(403, { error: 'Host no permitido' });

  let url;
  try {
    url = new URL(req.url, 'http://daemon.local');
  } catch {
    return json(400, { error: 'URL inválida' });
  }

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return json(405, { error: 'Método no permitido' });
    return serveDashboardHtml(res);
  }

  // Every API call needs the session token, including reads.
  if (!tokenValid(req)) return json(401, { error: 'Token de sesión local requerido' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(200, {
        nodeId: state.nodeId,
        name: state.name,
        isDonating: state.isDonating,
        registered: state.registered,
        subdomain: state.subdomain,
        tunnelStatus: state.tunnelStatus,
        quota: state.quota,
        stats: state.stats,
        rewards: state.rewards,
        wallet: walletManager.getPublicProfile(),
        vpn: {
          enabled: state.vpn.enabled,
          totalBytesRouted: vpnRelay.totalBytesRouted,
          activeSessions: vpnRelay.activeSessions.size
        },
        jobs: state.jobs,
        foxyFinance: { ...state.foxyFinance, localDeviceClass: state.deviceClass },
        runtime: engine.runtime,
        workloads: engine.listWorkloads(),
        system: {
          platform: os.platform(),
          arch: os.arch(),
          cpuCores: os.cpus().length,
          cpuModel: os.cpus()[0]?.model || 'Generic CPU',
          totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
          freeRamMb: Math.round(os.freemem() / 1024 / 1024)
        },
        logs: state.recentLogs
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/workloads') {
      return json(200, { runtime: engine.runtime, workloads: engine.listWorkloads() });
    }

    if (req.method !== 'POST') return json(405, { error: 'Método no permitido' });
    const body = await readJsonBody(req);

    switch (url.pathname) {
      // Set custom MetaMask / Web3 payout address
      case '/api/wallet/custom-address': {
        const result = walletManager.setCustomPayoutAddress(body.address);
        state.wallet = walletManager.getPublicProfile();
        addLog(`🦊 Dirección de cobro de recompensas $FOXY actualizada: ${state.wallet.activePayoutAddress}`, 'success');
        return json(200, result);
      }

      // Export wallet credentials (for MetaMask import)
      case '/api/wallet/export': {
        if (body.confirm !== 'EXPORT') return json(400, { error: 'Confirmación requerida' });
        addLog('🔑 Credenciales de la billetera exportadas desde el panel local.', 'warning');
        return json(200, walletManager.exportCredentials());
      }

      case '/api/vpn/toggle': {
        state.vpn.enabled = !state.vpn.enabled;
        addLog(`🛡️ Modo dVPN ${state.vpn.enabled ? 'HABILITADO' : 'DESHABILITADO'} por el usuario.`);
        if (state.vpn.enabled) registerVpnRelay();
        else vpnRelay.destroy();
        return json(200, {
          success: true,
          vpn: {
            enabled: state.vpn.enabled,
            totalBytesRouted: vpnRelay.totalBytesRouted,
            activeSessions: vpnRelay.activeSessions.size
          }
        });
      }

      case '/api/claim-rewards': {
        const { ok, data } = await controllerPost('/api/ledger/claim', {
          walletAddress: body.walletAddress || walletManager.getActiveAddress()
        });
        if (!ok || !data.success) return json(400, { error: data.error || 'Error al reclamar' });
        addLog(`💰 Voucher de ${data.amount} $FOXY firmado para ${data.receipt.to} (${data.receipt.settlement})`, 'success');
        state.rewards.balance = 0;
        return json(200, data);
      }

      // Foxy Finance: one-time code the donor types into their Finance account
      case '/api/finance/link-code': {
        const { ok, data } = await controllerPost('/api/nodes/link-code');
        if (!ok) return json(502, { error: data.error || 'No se pudo generar el código' });
        addLog('🔗 Código de vinculación con Foxy Finance generado (válido 10 minutos).', 'success');
        return json(200, data);
      }

      case '/api/finance/unlink': {
        const { ok, data } = await controllerPost('/api/nodes/unlink');
        if (!ok) return json(502, { error: data.error || 'No se pudo desvincular' });
        state.foxyFinance.linked = false;
        addLog('🔗 Nodo desvinculado de Foxy Finance.', 'warning');
        return json(200, data);
      }

      case '/api/finance/pay': {
        const { ok, data } = await controllerPost('/api/nodes/pay-with-foxy', { planId: String(body.planId || '') });
        if (!ok) return json(400, { error: data.error || 'No se pudo procesar el pago' });
        state.rewards.balance = data.balance;
        addLog(`🔥 Pagado el plan ${data.payment.planId} con ${data.payment.amountFoxy} $FOXY (quemados).`, 'success');
        return json(200, data);
      }

      case '/api/jobs/toggle': {
        state.jobs.enabled = !state.jobs.enabled;
        state.registered = false; // re-register so the controller learns the new preference
        addLog(`🧮 Trabajos de cómputo ${state.jobs.enabled ? 'HABILITADOS' : 'DESHABILITADOS'} por el usuario.`);
        return json(200, { success: true, enabled: state.jobs.enabled });
      }

      case '/api/workloads/spawn': {
        // Only these fields are accepted from the dashboard.
        const workload = await engine.spawnWorkload({
          id: `app-${crypto.randomBytes(4).toString('hex')}`,
          type: body.type,
          name: body.name,
          subdomain: body.subdomain,
          image: body.image,
          quota: state.quota
        });
        const tunneled = await registerTunnelForSubdomain(workload.subdomain);
        return json(201, {
          success: true,
          tunneled,
          workload: { id: workload.id, name: workload.name, type: workload.type, subdomain: workload.subdomain, port: workload.port, status: workload.status }
        });
      }

      case '/api/workloads/stop':
        return json(200, { success: engine.stopWorkload(String(body.id || '')) });

      case '/api/toggle-donation': {
        state.isDonating = !state.isDonating;
        addLog(`Donación de recursos ${state.isDonating ? 'ACTIVADA' : 'PAUSADA'} por el usuario.`);
        connectToTunnelGateway();
        return json(200, { success: true, isDonating: state.isDonating });
      }

      case '/api/update-subdomain': {
        const subdomain = String(body.subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
        if (!subdomain) return json(400, { error: 'Subdominio inválido' });
        const base = engine.workloads.get('demo-app');
        const previous = state.subdomain;
        state.subdomain = subdomain;
        if (base) base.subdomain = subdomain;
        if (!(await registerTunnelForSubdomain(subdomain))) {
          state.subdomain = previous;
          if (base) base.subdomain = previous;
          return json(409, { error: 'El subdominio no está disponible' });
        }
        addLog(`Subdominio principal actualizado a [${subdomain}].`);
        return json(200, { success: true, subdomain });
      }

      default:
        return json(404, { error: 'No encontrado' });
    }
  } catch (err) {
    return json(400, { error: err.message });
  }
});

function serveDashboardHtml(res) {
  try {
    const html = fs.readFileSync(PUBLIC_HTML, 'utf-8').replace('__FOXY_SESSION_TOKEN__', SESSION_TOKEN);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error loading dashboard UI: ' + err.message);
  }
}

// -------------------------------------------------------------
// 5. Start Daemon Servers & Background Connections
// -------------------------------------------------------------
dashboardServer.listen(DAEMON_PORT, DAEMON_HOST, async () => {
  addLog(`🦊 Foxy Daemon Dashboard listo en http://localhost:${DAEMON_PORT}`, 'success');
  if (DAEMON_HOST !== '127.0.0.1') {
    addLog(`⚠️ El panel escucha en ${DAEMON_HOST}: cualquiera que llegue a ese puerto verá la página con el token de sesión.`, 'warning');
  }
  await initializeBaseWorkload();
  await registerWithController();
  connectToTunnelGateway();
});

function shutdown() {
  for (const w of engine.workloads.values()) engine.stopWorkload(w.id);
  vpnRelay.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
