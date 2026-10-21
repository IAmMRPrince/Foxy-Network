import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { issueSubdomainToken } from '../../foxy-security/src/index.js';
import { FoxyLedger, TOKENOMICS_CONFIG } from './ledger.js';

const CONTROLLER_PORT = parseInt(process.env.FOXY_CONTROLLER_PORT || '4000', 10);

// In-memory registry & Tokenomics Ledger
const nodes = new Map();
const deployments = new Map();
const ledger = new FoxyLedger();

// Periodic node health pruner (marks nodes offline if no heartbeat in 20s)
setInterval(() => {
  const now = Date.now();
  for (const [nodeId, node] of nodes.entries()) {
    if (now - node.lastHeartbeat > 20000 && node.status === 'ONLINE') {
      node.status = 'OFFLINE';
      console.log(`[Controller] ⚠️ Node ${nodeId} timed out (marked OFFLINE)`);
      // Trigger failover for assigned deployments
      rebalanceDeploymentsForFailedNode(nodeId);
    }
  }
}, 5000);

function rebalanceDeploymentsForFailedNode(failedNodeId) {
  for (const [depId, dep] of deployments.entries()) {
    if (dep.assignedNodeId === failedNodeId) {
      console.log(`[Controller] 🔄 Re-scheduling deployment [${dep.subdomain}] from failed node ${failedNodeId}`);
      // Find new available online node
      const availableNode = Array.from(nodes.values()).find(n => n.status === 'ONLINE' && n.id !== failedNodeId);
      if (availableNode) {
        dep.assignedNodeId = availableNode.id;
        dep.status = 'REASSIGNED';
        console.log(`[Controller] ✅ Deployment [${dep.subdomain}] re-assigned to node ${availableNode.id}`);
      } else {
        dep.status = 'PENDING_NODE';
        dep.assignedNodeId = null;
        console.log(`[Controller] ⏳ No online nodes available to host [${dep.subdomain}]`);
      }
    }
  }
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // JSON helper
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  };

  // Read JSON body helper
  const readJson = (callback) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        callback(null, parsed);
      } catch (e) {
        callback(e);
      }
    });
  };

  // --- API Routes ---

  // 1. Node Registration
  if (req.method === 'POST' && pathname === '/api/nodes/register') {
    readJson((err, data) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      const nodeId = data.nodeId || `node-${randomUUID().slice(0, 8)}`;
      const primarySubdomain = (data.subdomain || 'foxy-demo-app').toLowerCase();

      // Issue signed capability token for primary subdomain
      const initialToken = issueSubdomainToken({ nodeId, subdomain: primarySubdomain });

      const nodeRecord = {
        id: nodeId,
        name: data.name || `Donor Node ${nodeId.slice(-4)}`,
        specs: data.specs || {},
        quota: data.quota || { maxCpuCores: 2, maxRamMb: 2048, maxStorageGb: 10 },
        status: 'ONLINE',
        registeredAt: new Date().toISOString(),
        lastHeartbeat: Date.now(),
        telemetry: data.telemetry || {},
        authToken: initialToken
      };

      nodes.set(nodeId, nodeRecord);
      console.log(`[Controller Security 🛡️] 🔑 Registered donor node [${nodeId}] and issued JWT token for [${primarySubdomain}]`);
      sendJson(200, { success: true, node: nodeRecord, authToken: initialToken });
    });
    return;
  }

  // 2. Token Issuance Endpoint (Capability Claim)
  if (req.method === 'POST' && pathname === '/api/auth/token') {
    readJson((err, data) => {
      if (err || !data.subdomain) return sendJson(400, { error: 'Subdomain is required' });
      const cleanSub = data.subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const token = issueSubdomainToken({
        nodeId: data.nodeId || '*',
        subdomain: cleanSub
      });
      console.log(`[Controller Security 🛡️] 🎫 Issued new subdomain capability token for [${cleanSub}]`);
      sendJson(200, { success: true, subdomain: cleanSub, token });
    });
    return;
  }

  // 3. Node Heartbeat
  if (req.method === 'POST' && pathname === '/api/nodes/heartbeat') {
    readJson((err, data) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      const { nodeId, telemetry, activeWorkloads } = data;
      const node = nodes.get(nodeId);
      if (!node) {
        return sendJson(404, { error: 'Node not registered' });
      }

      const now = Date.now();
      const deltaSecs = Math.max(1, Math.min(10, Math.round((now - (node.lastHeartbeat || (now - 5000))) / 1000)));
      const currentBytes = telemetry?.bytesServed || 0;
      const prevBytes = node.telemetry?.bytesServed || 0;
      const deltaBytes = Math.max(0, currentBytes - prevBytes);

      // Record verifiable proof of uptime & bandwidth into ledger
      ledger.recordActivity(nodeId, {
        uptimeDeltaSeconds: deltaSecs,
        bytesDelta: deltaBytes,
        specs: node.specs || {}
      });

      node.status = 'ONLINE';
      node.lastHeartbeat = now;
      if (telemetry) node.telemetry = telemetry;
      if (activeWorkloads) node.activeWorkloads = activeWorkloads;

      const account = ledger.getAccount(nodeId);

      // Check if there are pending deployments for this node
      const pendingForThis = Array.from(deployments.values()).filter(d => d.assignedNodeId === nodeId && d.status !== 'RUNNING');

      sendJson(200, {
        status: 'ACK',
        epoch: ledger.currentEpoch,
        rewards: {
          balance: account.balance,
          lifetimeEarnings: account.lifetimeEarnings,
          tier: account.tier,
          epochsSettled: account.epochsSettled,
          recentPayouts: account.recentPayouts.slice(0, 3)
        },
        pendingCommands: pendingForThis.map(d => ({
          type: 'DEPLOY_WORKLOAD',
          deploymentId: d.id,
          subdomain: d.subdomain,
          authToken: d.authToken,
          config: d.config
        }))
      });
    });
    return;
  }

  // 4. List Nodes
  if (req.method === 'GET' && pathname === '/api/nodes') {
    sendJson(200, {
      count: nodes.size,
      onlineCount: Array.from(nodes.values()).filter(n => n.status === 'ONLINE').length,
      nodes: Array.from(nodes.values())
    });
    return;
  }

  // 5. Create Deployment (Developer submits an application)
  if (req.method === 'POST' && pathname === '/api/deployments') {
    readJson((err, data) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      const { appName, subdomain, config } = data;
      if (!subdomain) return sendJson(400, { error: 'Subdomain is required' });

      const cleanSub = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');

      // Select candidate online node with lowest load
      const onlineNodes = Array.from(nodes.values()).filter(n => n.status === 'ONLINE');
      const assignedNode = onlineNodes[0] || null;

      // Issue signed capability token for this deployment
      const depToken = issueSubdomainToken({
        nodeId: assignedNode ? assignedNode.id : '*',
        subdomain: cleanSub
      });

      const depId = `dep-${randomUUID().slice(0, 8)}`;
      const deploymentRecord = {
        id: depId,
        appName: appName || cleanSub,
        subdomain: cleanSub,
        assignedNodeId: assignedNode ? assignedNode.id : null,
        authToken: depToken,
        status: assignedNode ? 'ASSIGNED' : 'PENDING_NODE',
        config: config || { port: 3000, type: 'web-server' },
        createdAt: new Date().toISOString()
      };

      deployments.set(depId, deploymentRecord);
      console.log(`[Controller Security 🛡️] 🚀 Deployment created with signed JWT: [${cleanSub}] -> Node: ${assignedNode?.id || 'Queued'}`);
      sendJson(201, { success: true, deployment: deploymentRecord });
    });
    return;
  }

  // 5. List Deployments
  if (req.method === 'GET' && pathname === '/api/deployments') {
    sendJson(200, {
      count: deployments.size,
      deployments: Array.from(deployments.values())
    });
    return;
  }

  // 6. Tokenomics Ledger Endpoints
  if (req.method === 'GET' && pathname === '/api/ledger/leaderboard') {
    sendJson(200, {
      symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
      currentEpoch: ledger.currentEpoch,
      networkTotalMinted: ledger.networkTotalMinted,
      config: TOKENOMICS_CONFIG,
      leaderboard: ledger.getLeaderboard()
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/ledger/account/')) {
    const targetNodeId = pathname.replace('/api/ledger/account/', '');
    const account = ledger.getAccount(targetNodeId);
    sendJson(200, {
      symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
      currentEpoch: ledger.currentEpoch,
      account
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ledger/claim') {
    readJson((err, data) => {
      if (err || !data.nodeId) return sendJson(400, { error: 'nodeId is required' });
      const result = ledger.claimRewards(data.nodeId, data.walletAddress);
      if (!result.success) {
        return sendJson(400, { error: result.error });
      }
      console.log(`[Tokenomics 💰] Claim processed for node ${data.nodeId}: ${result.amount} $FOXY sent to ${data.walletAddress || 'default'}`);
      sendJson(200, result);
    });
    return;
  }

  // 7. Controller Dashboard
  if (req.method === 'GET' && pathname === '/') {
    serveControllerDashboard(req, res);
    return;
  }

  sendJson(404, { error: 'Not Found' });
});

function serveControllerDashboard(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const nodeList = Array.from(nodes.values());
  const depList = Array.from(deployments.values());

  res.end(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>🦊 Foxy Network — Control Plane & Orchestrator</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #131927;
      --border: #1f2a40;
      --accent: #ff6b35;
      --text: #e8ecf4;
      --text-muted: #8292ab;
      --green: #10b981;
      --red: #ef4444;
      --amber: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 2.5rem;
    }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; }
    h1 { font-size: 1.8rem; font-weight: 700; }
    .accent { color: var(--accent); }
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; }
    .stat-title { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.35rem; }
    .stat-val { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
    .section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 2rem; }
    .section h2 { font-size: 1.2rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); font-size: 0.85rem; }
    .badge { padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
    .badge-online { background: rgba(16, 185, 129, 0.15); color: var(--green); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-offline { background: rgba(239, 68, 68, 0.15); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.3); }
    .btn { background: var(--accent); color: #fff; border: none; padding: 0.6rem 1.2rem; border-radius: 6px; font-weight: 600; cursor: pointer; }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🦊 Foxy Network — <span class="accent">Control Plane</span></h1>
      <p style="color:var(--text-muted); font-size:0.95rem">Orquestador de Nodos Donantes y Gestión de Cargas Descentralizadas</p>
    </div>
    <div>
      <span class="badge badge-online">● Orquestador Activo (Puerto ${CONTROLLER_PORT})</span>
    </div>
  </header>

  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-title">Nodos Registrados</div>
      <div class="stat-val">${nodeList.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Nodos en Línea</div>
      <div class="stat-val" style="color:var(--green)">${nodeList.filter(n => n.status === 'ONLINE').length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Despliegues Activos</div>
      <div class="stat-val">${depList.length}</div>
    </div>
  </div>

  <div class="section">
    <h2>Nodos Donantes de Cómputo</h2>
    ${nodeList.length === 0 ? '<p style="color:var(--text-muted)">No hay nodos donantes registrados todavía. Ejecuta <code>npm --workspace=foxy-daemon start</code></p>' : `
      <table>
        <thead>
          <tr>
            <th>ID Nodo</th>
            <th>Nombre</th>
            <th>Estado</th>
            <th>CPU Asignable</th>
            <th>RAM Asignable</th>
            <th>CPU Actual</th>
            <th>RAM Actual</th>
          </tr>
        </thead>
        <tbody>
          ${nodeList.map(n => `
            <tr>
              <td><code>${n.id}</code></td>
              <td><strong>${n.name}</strong></td>
              <td><span class="badge ${n.status === 'ONLINE' ? 'badge-online' : 'badge-offline'}">${n.status}</span></td>
              <td>${n.quota?.maxCpuCores || 2} núcleos</td>
              <td>${(n.quota?.maxRamMb / 1024).toFixed(1) || 2} GB</td>
              <td>${n.telemetry?.cpuUsagePercent ? n.telemetry.cpuUsagePercent + '%' : '—'}</td>
              <td>${n.telemetry?.ramUsedMb ? n.telemetry.ramUsedMb + ' MB' : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  </div>

  <div class="section">
    <h2>Despliegues en la Red</h2>
    ${depList.length === 0 ? '<p style="color:var(--text-muted)">No hay despliegues creados. Usa la API <code>POST /api/deployments</code> para solicitar alojamiento.</p>' : `
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>App</th>
            <th>Subdominio</th>
            <th>Nodo Asignado</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${depList.map(d => `
            <tr>
              <td><code>${d.id}</code></td>
              <td><strong>${d.appName}</strong></td>
              <td><code>${d.subdomain}</code></td>
              <td><code>${d.assignedNodeId || 'En cola'}</code></td>
              <td><span class="badge badge-online">${d.status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  </div>
</body>
</html>
  `);
}

server.listen(CONTROLLER_PORT, () => {
  console.log(`[Foxy Controller] Control Plane listening on http://localhost:${CONTROLLER_PORT}`);
});
