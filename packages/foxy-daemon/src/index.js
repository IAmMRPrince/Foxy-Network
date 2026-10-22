import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WorkloadEngine } from './workload-engine.js';
import { WalletManager } from './wallet-manager.js';
import { VpnRelay } from '../../foxy-vpn/src/relay.js';
import { issueSubdomainToken } from '../../foxy-security/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_HTML = path.resolve(__dirname, '..', 'public', 'index.html');

// Cache of cryptographic capability tokens (subdomain -> JWT token)
const tokensMap = new Map();

const DAEMON_PORT = parseInt(process.env.FOXY_DAEMON_PORT || '4040', 10);
const GATEWAY_TUNNEL_URL = process.env.FOXY_GATEWAY_TUNNEL_URL || 'ws://127.0.0.1:8081';
const CONTROLLER_URL = process.env.FOXY_CONTROLLER_URL || 'http://127.0.0.1:4000';
const CLUSTER_SECRET = process.env.FOXY_CLUSTER_SECRET || 'foxy-depin-cluster-shared-secret-v1';

// Initialize the Workload Engine, Web3 Wallet Manager, and dVPN Exit Relay
const engine = new WorkloadEngine();
const walletManager = new WalletManager();
const vpnRelay = new VpnRelay(CLUSTER_SECRET);

// Configuration & Donor State
const state = {
  nodeId: `node-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`,
  name: `Donante-${os.hostname()}`,
  isDonating: true,
  quota: {
    maxCpuCores: Math.min(2, os.cpus().length),
    maxRamMb: 2048,
    maxStorageGb: 10
  },
  subdomain: 'foxy-demo-app',
  tunnelStatus: 'DISCONNECTED', // DISCONNECTED | CONNECTING | CONNECTED
  tunnelSocket: null,
  wallet: walletManager.getPublicProfile(),
  vpn: {
    enabled: true,
    totalBytesRouted: 0,
    activeSessions: 0
  },
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
}

// -------------------------------------------------------------
// 2. Reverse Tunnel Client (Connects to Ingress Gateway)
// -------------------------------------------------------------
function connectToTunnelGateway() {
  if (!state.isDonating) {
    if (state.tunnelSocket) {
      state.tunnelSocket.close();
      state.tunnelSocket = null;
    }
    state.tunnelStatus = 'DISCONNECTED';
    return;
  }

  state.tunnelStatus = 'CONNECTING';
  addLog(`Iniciando conexión de túnel inverso a ${GATEWAY_TUNNEL_URL}...`);

  const ws = new WebSocket(GATEWAY_TUNNEL_URL);
  state.tunnelSocket = ws;

  ws.on('open', () => {
    state.tunnelStatus = 'CONNECTED';
    addLog(`✅ Túnel WebSocket conectado. Registrando subdominios y dVPN...`, 'success');

    // Register primary subdomain
    registerTunnelForSubdomain(state.subdomain);

    // Register any other active workloads
    for (const w of engine.workloads.values()) {
      if (w.subdomain && w.subdomain !== state.subdomain && w.status === 'RUNNING') {
        registerTunnelForSubdomain(w.subdomain);
      }
    }

    // Register as dVPN Exit Relay if enabled
    if (state.vpn.enabled) {
      ws.send(JSON.stringify({
        type: 'REGISTER_VPN_RELAY',
        nodeId: state.nodeId
      }));
      addLog(`🛡️ Modo dVPN activo: Nodo disponible como túnel de salida cifrado.`, 'success');
    }
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'TUNNEL_READY') {
        addLog(`🎉 Túnel activo para [${msg.subdomain}]. Tráfico redirigido al servicio local correspondiente.`, 'success');
      }

      if (msg.type === 'SECURITY_ERROR') {
        addLog(`🛡️ Rechazado por Gateway de Seguridad: ${msg.message}`, 'error');
      }

      // dVPN Egress Traffic Handling
      if (msg.type === 'VPN_REQUEST_CONNECT') {
        if (!state.vpn.enabled) {
          ws.send(JSON.stringify({
            type: 'VPN_ERROR',
            sessionId: msg.sessionId,
            error: 'dVPN Exit Relay deshabilitado temporalmente en este nodo donante'
          }));
          return;
        }

        state.vpn.activeSessions++;
        addLog(`🔒 dVPN: Enrutando conexión cifrada [${msg.sessionId.slice(0, 8)}...] hacia ${msg.targetHost}:${msg.targetPort}`);

        vpnRelay.handleConnect(msg.sessionId, msg.targetHost, msg.targetPort, (frame) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(frame));
          }
        });
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
        addLog(`Petición entrante por túnel: ${method} ${url} [Subdominio: ${subdomain}]`);

        // Forward to the appropriate workload based on subdomain
        forwardToWorkload(requestId, method, url, headers, body, isBase64, subdomain);
      }
    } catch (err) {
      addLog(`Error procesando mensaje de túnel: ${err.message}`, 'error');
    }
  });

  ws.on('close', () => {
    state.tunnelStatus = 'DISCONNECTED';
    state.tunnelSocket = null;
    addLog(`🔌 Túnel desconectado. Reintentando en 4 segundos...`, 'warning');
    if (state.isDonating) {
      setTimeout(connectToTunnelGateway, 4000);
    }
  });

  ws.on('error', (err) => {
    addLog(`Fallo de conexión en el túnel: ${err.message}`, 'error');
  });
}

function registerTunnelForSubdomain(subdomain, customToken = null) {
  if (state.tunnelSocket && state.tunnelSocket.readyState === WebSocket.OPEN) {
    let token = customToken || tokensMap.get(subdomain);
    if (!token) {
      token = issueSubdomainToken({ nodeId: state.nodeId, subdomain });
      tokensMap.set(subdomain, token);
    }

    state.tunnelSocket.send(JSON.stringify({
      type: 'REGISTER_TUNNEL',
      nodeId: state.nodeId,
      subdomain,
      authToken: token,
      specs: {
        cores: os.cpus().length,
        totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
        platform: os.platform(),
        runtime: engine.runtime.type
      }
    }));
  }
}

function forwardToWorkload(requestId, method, url, incomingHeaders, body, isBase64, subdomain) {
  // Find which workload matches this subdomain
  let targetPort = null;
  const match = Array.from(engine.workloads.values()).find(
    w => w.subdomain === subdomain && w.status === 'RUNNING'
  );

  if (match) {
    targetPort = match.port;
  } else {
    // Fallback to first available running workload
    const fallback = Array.from(engine.workloads.values()).find(w => w.status === 'RUNNING');
    if (fallback) targetPort = fallback.port;
  }

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
async function registerWithController() {
  try {
    const payload = JSON.stringify({
      nodeId: state.nodeId,
      name: state.name,
      walletAddress: walletManager.getActiveAddress(),
      specs: {
        cores: os.cpus().length,
        totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
        platform: os.platform(),
        runtime: engine.runtime
      },
      quota: state.quota
    });

    const res = await fetch(`${CONTROLLER_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });

    if (res.ok) {
      const data = await res.json();
      if (data.authToken) {
        tokensMap.set(state.subdomain, data.authToken);
      }
      addLog(`Registrado exitosamente en Foxy Controller (${CONTROLLER_URL}) [Token JWT guardado]`, 'success');
    }
  } catch (err) {
    // Retry during next heartbeat
  }
}

async function sendHeartbeat() {
  if (!state.isDonating) return;

  try {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memUsage = Math.round((totalMem - freeMem) / 1024 / 1024);

    state.vpn.totalBytesRouted = vpnRelay.totalBytesRouted;
    state.vpn.activeSessions = vpnRelay.activeSessions.size;

    const payload = JSON.stringify({
      nodeId: state.nodeId,
      walletAddress: walletManager.getActiveAddress(),
      telemetry: {
        cpuUsagePercent: Math.floor(10 + Math.random() * 20),
        ramUsedMb: memUsage,
        requestsHandled: state.stats.requestsHandled,
        bytesServed: state.stats.bytesServed,
        vpnBytesServed: vpnRelay.totalBytesRouted
      },
      activeWorkloads: engine.listWorkloads()
    });

    const res = await fetch(`${CONTROLLER_URL}/api/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });

    if (res.status === 404) {
      await registerWithController();
      return;
    }

    if (res.ok) {
      const data = await res.json();
      if (data.rewards) {
        state.rewards = data.rewards;
      }
      if (data.pendingCommands && data.pendingCommands.length > 0) {
        for (const cmd of data.pendingCommands) {
          if (cmd.type === 'DEPLOY_WORKLOAD') {
            await handleDeployCommand(cmd);
          }
        }
      }
    }
  } catch (err) {
    // Silent catch
  }
}

async function handleDeployCommand(cmd) {
  addLog(`📦 Recibida orden de despliegue del controlador: [${cmd.subdomain}]`, 'success');
  try {
    if (cmd.authToken) {
      tokensMap.set(cmd.subdomain, cmd.authToken);
    }

    const workload = await engine.spawnWorkload({
      id: cmd.deploymentId,
      name: cmd.config?.appName || cmd.subdomain,
      type: cmd.config?.type || 'static',
      subdomain: cmd.subdomain,
      image: cmd.config?.image,
      quota: state.quota
    });

    addLog(`Despliegue activo en puerto :${workload.port}. Registrando túnel con token criptográfico...`, 'success');
    registerTunnelForSubdomain(cmd.subdomain, cmd.authToken);
  } catch (err) {
    addLog(`Error desplegando orden: ${err.message}`, 'error');
  }
}

setInterval(sendHeartbeat, 5000);

// -------------------------------------------------------------
// 4. Local Web UI Dashboard for the Donor (http://localhost:4040)
// -------------------------------------------------------------
const dashboardServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API State endpoint
  if (url.pathname === '/api/state') {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      nodeId: state.nodeId,
      name: state.name,
      isDonating: state.isDonating,
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
      runtime: engine.runtime,
      workloads: engine.listWorkloads(),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpuCores: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'Generic CPU',
        totalRamMb: Math.round(totalMem / 1024 / 1024),
        freeRamMb: Math.round(freeMem / 1024 / 1024)
      },
      logs: state.recentLogs
    }));
    return;
  }

  // Set Custom MetaMask / Web3 Address
  if (req.method === 'POST' && url.pathname === '/api/wallet/custom-address') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { address } = JSON.parse(body);
        const result = walletManager.setCustomPayoutAddress(address);
        state.wallet = walletManager.getPublicProfile();
        addLog(`🦊 Dirección de cobro de recompensas $FOXY actualizada: ${state.wallet.activePayoutAddress}`, 'success');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Export Web3 Wallet Credentials (for MetaMask import)
  if (req.method === 'GET' && url.pathname === '/api/wallet/export') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(walletManager.exportCredentials(), null, 2));
    return;
  }

  // Toggle dVPN Exit Relay
  if (req.method === 'POST' && url.pathname === '/api/vpn/toggle') {
    state.vpn.enabled = !state.vpn.enabled;
    addLog(`🛡️ Modo dVPN ${state.vpn.enabled ? 'HABILITADO' : 'DESHABILITADO'} por el usuario.`);
    if (state.vpn.enabled && state.tunnelSocket && state.tunnelSocket.readyState === WebSocket.OPEN) {
      state.tunnelSocket.send(JSON.stringify({
        type: 'REGISTER_VPN_RELAY',
        nodeId: state.nodeId
      }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      vpn: {
        enabled: state.vpn.enabled,
        totalBytesRouted: vpnRelay.totalBytesRouted,
        activeSessions: vpnRelay.activeSessions.size
      }
    }));
    return;
  }

  // Claim Rewards API
  if (req.method === 'POST' && url.pathname === '/api/claim-rewards') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const targetWallet = payload.walletAddress || walletManager.getActiveAddress();
        const resClaim = await fetch(`${CONTROLLER_URL}/api/ledger/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeId: state.nodeId,
            walletAddress: targetWallet
          })
        });

        const claimData = await resClaim.json();
        if (claimData.success) {
          addLog(`💰 ¡Recompensas reclamadas con éxito! Transferidos ${claimData.amount} $FOXY a ${claimData.receipt.to}`, 'success');
          state.rewards.balance = 0;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(claimData));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: claimData.error || 'Error al reclamar' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Workloads list API
  if (req.method === 'GET' && url.pathname === '/api/workloads') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      runtime: engine.runtime,
      workloads: engine.listWorkloads()
    }, null, 2));
    return;
  }

  // Workload spawn API
  if (req.method === 'POST' && url.pathname === '/api/workloads/spawn') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const config = JSON.parse(body);
        const workload = await engine.spawnWorkload({
          ...config,
          id: config.id || `app-${Math.random().toString(36).slice(2, 7)}`,
          quota: state.quota
        });
        registerTunnelForSubdomain(workload.subdomain);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, workload }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Workload stop API
  if (req.method === 'POST' && url.pathname === '/api/workloads/stop') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const stopped = engine.stopWorkload(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Toggle donation API
  if (req.method === 'POST' && url.pathname === '/api/toggle-donation') {
    state.isDonating = !state.isDonating;
    addLog(`Donación de recursos ${state.isDonating ? 'ACTIVADA' : 'PAUSADA'} por el usuario.`);
    if (state.isDonating) {
      connectToTunnelGateway();
    } else if (state.tunnelSocket) {
      state.tunnelSocket.close();
      state.tunnelSocket = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, isDonating: state.isDonating }));
    return;
  }

  // Update primary subdomain API
  if (req.method === 'POST' && url.pathname === '/api/update-subdomain') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { subdomain } = JSON.parse(body);
        if (subdomain) {
          state.subdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
          addLog(`Subdominio principal actualizado a [${state.subdomain}]. Registrando...`);
          registerTunnelForSubdomain(state.subdomain);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, subdomain: state.subdomain }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve Dashboard HTML
  serveDashboardHtml(res);
});

function serveDashboardHtml(res) {
  try {
    const html = fs.readFileSync(PUBLIC_HTML, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error loading dashboard UI: ' + err.message);
  }
}

// -------------------------------------------------------------
// 5. Start Daemon Servers & Background Connections
// -------------------------------------------------------------
dashboardServer.listen(DAEMON_PORT, async () => {
  addLog(`🦊 Foxy Daemon Dashboard listo en http://localhost:${DAEMON_PORT}`, 'success');
  await initializeBaseWorkload();
  connectToTunnelGateway();
  registerWithController();
});
