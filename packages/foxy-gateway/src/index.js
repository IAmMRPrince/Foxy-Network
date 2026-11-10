import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { verifySubdomainToken } from '../../foxy-security/src/index.js';
import {
  resolveFoxDomain,
  loadDomainMappings,
  ensureFoxSslCredentials
} from './domains.js';

const HTTP_PORT = parseInt(process.env.FOXY_GATEWAY_HTTP_PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.FOXY_GATEWAY_HTTPS_PORT || '8443', 10);
const TUNNEL_PORT = parseInt(process.env.FOXY_GATEWAY_TUNNEL_PORT || '8081', 10);

// Active tunnels: subdomain -> { ws, nodeId, connectedAt, specs, requestCount, bytesTransferred }
const activeTunnels = new Map();
// Pending HTTP requests: requestId -> { req, res, timer }
const pendingRequests = new Map();

// Active dVPN relays: nodeId -> { ws, nodeId, connectedAt, sessions: 0, bytesRouted: 0 }
const activeVpnRelays = new Map();
// Active dVPN sessions: sessionId -> { clientWs, relayWs, nodeId }
const vpnSessions = new Map();

// -------------------------------------------------------------
// 1. WebSocket Tunnel Server (Accepts connections from Daemons & dVPN Clients)
// -------------------------------------------------------------
const wss = new WebSocketServer({ port: TUNNEL_PORT });

wss.on('connection', (ws, req) => {
  const registeredSubdomains = new Set();
  let boundNodeId = null;

  console.log(`[Gateway Tunnel] New incoming connection from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // --- dVPN PROTOCOL HANDLING ---
      if (msg.type === 'REGISTER_VPN_RELAY') {
        const { nodeId } = msg;
        boundNodeId = nodeId || boundNodeId || `node-${randomUUID().slice(0, 8)}`;
        activeVpnRelays.set(boundNodeId, {
          ws,
          nodeId: boundNodeId,
          connectedAt: new Date().toISOString(),
          sessions: 0,
          bytesRouted: 0
        });
        console.log(`[Gateway dVPN 🛡️] 🌐 Nodo donante [${boundNodeId}] registrado como repetidor Exit dVPN`);
        ws.send(JSON.stringify({ type: 'VPN_RELAY_ACK', nodeId: boundNodeId }));
        return;
      }

      if (msg.type === 'VPN_CLIENT_REGISTER') {
        console.log(`[Gateway dVPN 🛡️] 🔒 Cliente dVPN [${msg.clientId}] conectado.`);
        return;
      }

      if (msg.type === 'VPN_REQUEST_CONNECT') {
        const { sessionId, targetHost, targetPort } = msg;
        const availableRelays = Array.from(activeVpnRelays.values()).filter(r => r.ws.readyState === 1);
        if (availableRelays.length === 0) {
          ws.send(JSON.stringify({
            type: 'VPN_ERROR',
            sessionId,
            error: 'No hay repetidores dVPN disponibles en la red Foxy'
          }));
          return;
        }

        const selectedRelay = availableRelays[Math.floor(Math.random() * availableRelays.length)];
        selectedRelay.sessions++;
        vpnSessions.set(sessionId, { clientWs: ws, relayWs: selectedRelay.ws, nodeId: selectedRelay.nodeId });
        selectedRelay.ws.send(JSON.stringify(msg));
        return;
      }

      if (msg.type === 'VPN_CONNECTED') {
        const session = vpnSessions.get(msg.sessionId);
        if (session && session.clientWs.readyState === 1) {
          session.clientWs.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === 'VPN_CLIENT_DATA') {
        const session = vpnSessions.get(msg.sessionId);
        if (session && session.relayWs.readyState === 1) {
          session.relayWs.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === 'VPN_DATA_STREAM') {
        const session = vpnSessions.get(msg.sessionId);
        if (session && session.clientWs.readyState === 1) {
          session.clientWs.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === 'VPN_CLIENT_CLOSE' || msg.type === 'VPN_CLOSED' || msg.type === 'VPN_ERROR') {
        const session = vpnSessions.get(msg.sessionId);
        if (session) {
          if (msg.type === 'VPN_CLIENT_CLOSE' && session.relayWs.readyState === 1) {
            session.relayWs.send(JSON.stringify(msg));
          } else if ((msg.type === 'VPN_CLOSED' || msg.type === 'VPN_ERROR') && session.clientWs.readyState === 1) {
            session.clientWs.send(JSON.stringify(msg));
          }
          vpnSessions.delete(msg.sessionId);
        }
        return;
      }

      // --- STANDARD HTTP REVERSE TUNNEL HANDLING ---
      if (msg.type === 'REGISTER_TUNNEL') {
        const { subdomain, nodeId, specs, authToken } = msg;
        if (!subdomain) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Subdomain is required' }));
          return;
        }

        const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');

        // Cryptographic capability verification
        const authCheck = verifySubdomainToken(authToken, cleanSubdomain);
        if (!authCheck.valid) {
          console.warn(`[Gateway Security 🛡️] ❌ RECHAZADO: Intento no autorizado de registrar [${cleanSubdomain}] desde nodo ${nodeId || 'desconocido'}. Motivo: ${authCheck.error}`);
          ws.send(JSON.stringify({
            type: 'SECURITY_ERROR',
            subdomain: cleanSubdomain,
            message: `Registro de túnel denegado por seguridad: ${authCheck.error}`
          }));
          return;
        }

        registeredSubdomains.add(cleanSubdomain);
        boundNodeId = nodeId || boundNodeId || `node-${randomUUID().slice(0, 8)}`;
        console.log(`[Gateway Security 🛡️] 🔒 Token criptográfico JWT verificado exitosamente para [${cleanSubdomain}] (Nodo: ${boundNodeId})`);

        activeTunnels.set(cleanSubdomain, {
          ws,
          nodeId: boundNodeId,
          connectedAt: new Date().toISOString(),
          specs: specs || {},
          requestCount: 0,
          bytesTransferred: 0
        });

        console.log(`[Gateway Tunnel] ✅ Tunnel established for [${cleanSubdomain}] from node ${boundNodeId}`);

        ws.send(JSON.stringify({
          type: 'TUNNEL_READY',
          subdomain: cleanSubdomain,
          gatewayHttpPort: HTTP_PORT,
          gatewayHttpsPort: HTTPS_PORT,
          message: `Reverse tunnel established. Traffic for '${cleanSubdomain}' will route here.`
        }));
      }

      if (msg.type === 'HTTP_RESPONSE') {
        const { requestId, statusCode, headers, body } = msg;
        const pending = pendingRequests.get(requestId);

        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);

        const targetSub = pending.subdomain || Array.from(registeredSubdomains)[0];
        const tunnel = activeTunnels.get(targetSub);
        if (tunnel) {
          tunnel.requestCount++;
        }

        const safeHeaders = headers || {};
        delete safeHeaders['transfer-encoding'];

        pending.res.writeHead(statusCode || 200, safeHeaders);

        if (body) {
          const bodyBuffer = Buffer.from(body, msg.isBase64 ? 'base64' : 'utf-8');
          if (tunnel) tunnel.bytesTransferred += bodyBuffer.length;
          pending.res.end(bodyBuffer);
        } else {
          pending.res.end();
        }
      }

      if (msg.type === 'HEARTBEAT') {
        ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK', timestamp: Date.now() }));
      }
    } catch (err) {
      console.error('[Gateway Tunnel] Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    for (const sub of registeredSubdomains) {
      if (activeTunnels.get(sub)?.ws === ws) {
        activeTunnels.delete(sub);
        console.log(`[Gateway Tunnel] 🔌 Tunnel closed for [${sub}] (Node: ${boundNodeId})`);
      }
    }
    if (boundNodeId && activeVpnRelays.has(boundNodeId) && activeVpnRelays.get(boundNodeId).ws === ws) {
      activeVpnRelays.delete(boundNodeId);
      console.log(`[Gateway dVPN 🛡️] 🔌 dVPN Relay desconectado: ${boundNodeId}`);
    }
    for (const [sId, sess] of vpnSessions.entries()) {
      if (sess.clientWs === ws || sess.relayWs === ws) {
        vpnSessions.delete(sId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Gateway Tunnel] Error on node ${boundNodeId}:`, err.message);
  });
});

console.log(`[Foxy Gateway] Tunnel WebSocket listening on ws://0.0.0.0:${TUNNEL_PORT}`);

// -------------------------------------------------------------
// 2. Public Ingress HTTP & HTTPS Server (Receives external traffic & .fox domains)
// -------------------------------------------------------------
function extractSubdomain(req) {
  // 1. Direct header override
  if (req.headers['x-foxy-subdomain']) {
    return req.headers['x-foxy-subdomain'].toLowerCase();
  }

  // 2. Explicit path prefix (/t/:subdomain/... or /app/:subdomain/...) takes priority
  //    so links from www.foxynetwork.fox portal (/t/foxy-finance/) route to the app
  const match = req.url.match(/^\/(?:app|t)\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (match) {
    const subdomain = match[1].toLowerCase();
    req.originalUrl = req.url;
    req.url = match[2] || '/';
    return subdomain;
  }

  // 3. Decentralized .fox Domain Resolution (www.foxyfianance.fox, www.foxynetwork.fox, etc.)
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
  const foxResolution = resolveFoxDomain(hostHeader);
  if (foxResolution.matched) {
    if (foxResolution.target === '__portal__') {
      return null; // Serve Foxy Network Portal
    }
    // Check if the mapped target or fallback foxy-finance alias is active
    if (activeTunnels.has(foxResolution.target)) {
      return foxResolution.target;
    }
    if (foxResolution.target === 'foxy-finance' && activeTunnels.has('foxyfianance')) {
      return 'foxyfianance';
    }
    return foxResolution.target;
  }

  // 4. Standard Host header: tenant.domain.com or tenant.localhost:8080
  const parts = hostHeader.split('.');
  if (parts.length >= 2) {
    const candidate = parts[0];
    if (candidate !== 'www' && candidate !== 'localhost' && candidate !== 'foxy' && !/^\d+$/.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function handleIngressRequest(req, res) {
  // CORS for open distributed access
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Gateway status, tunnels & .fox domains API
  if (req.url === '/__foxy/status' || req.url === '/api/tunnels' || req.url === '/api/domains') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const tunnelsList = [];
    for (const [subdomain, data] of activeTunnels.entries()) {
      tunnelsList.push({
        subdomain,
        nodeId: data.nodeId,
        connectedAt: data.connectedAt,
        specs: data.specs,
        requestCount: data.requestCount,
        bytesTransferred: data.bytesTransferred,
        directUrl: `http://localhost:${HTTP_PORT}/t/${subdomain}/`,
        foxDomainUrl: subdomain === 'foxy-finance' || subdomain === 'foxyfianance'
          ? 'https://www.foxyfianance.fox'
          : `https://${subdomain}.foxynetwork.fox`
      });
    }
    const domainMappings = loadDomainMappings();
    res.end(JSON.stringify({
      status: 'online',
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      activeTunnelsCount: activeTunnels.size,
      tunnels: tunnelsList,
      foxDomains: Object.entries(domainMappings).map(([domain, info]) => ({
        domain,
        url: `https://${domain}`,
        target: info.target,
        name: info.name,
        online: info.target === '__portal__' ? true : (activeTunnels.has(info.target) || activeTunnels.has('foxy-finance'))
      }))
    }, null, 2));
    return;
  }

  // dVPN Status API
  if (req.url === '/api/vpn/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      activeRelaysCount: activeVpnRelays.size,
      activeSessionsCount: vpnSessions.size,
      relays: Array.from(activeVpnRelays.keys())
    }, null, 2));
    return;
  }

  const subdomain = extractSubdomain(req);

  // If no specific subdomain is targeted (e.g. www.foxynetwork.fox), serve Gateway Portal landing page
  if (!subdomain) {
    serveGatewayPortal(req, res);
    return;
  }

  // Check if tunnel exists for this subdomain
  const tunnel = activeTunnels.get(subdomain);
  if (!tunnel || tunnel.ws.readyState !== 1) {
    serveNodeOffline(req, res, subdomain);
    return;
  }

  // Forward request through reverse tunnel
  const requestId = randomUUID();
  const chunks = [];

  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    const isBase64 = bodyBuffer.length > 0;
    const body = isBase64 ? bodyBuffer.toString('base64') : '';

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      res.writeHead(504, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="font-family:system-ui,sans-serif;padding:3rem;text-align:center;background:#0d1117;color:#f0f6fc;min-height:100vh">
          <h1 style="color:#f85149">504 Gateway Timeout</h1>
          <p>El nodo donante para <strong>${subdomain}</strong> tardó demasiado en responder.</p>
          <p style="color:#8b949e">Foxy Network DePIN Ingress Gateway</p>
        </div>
      `);
    }, 15000);

    pendingRequests.set(requestId, { req, res, timer, subdomain });

    // Send payload to daemon
    tunnel.ws.send(JSON.stringify({
      type: 'HTTP_REQUEST',
      requestId,
      subdomain,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      isBase64
    }));
  });
}

function serveGatewayPortal(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const tunnels = Array.from(activeTunnels.entries());
  const financeOnline = activeTunnels.has('foxy-finance') || activeTunnels.has('foxyfianance');
  const currentHost = req.headers.host || `localhost:${HTTP_PORT}`;

  res.end(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>🦊 Foxy Network (www.foxynetwork.fox) — DePIN Ingress Gateway</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #151d30;
      --border: #232f4e;
      --accent: #ff6b35;
      --accent-glow: rgba(255, 107, 53, 0.25);
      --cyan: #00f2fe;
      --text: #f0f4fc;
      --text-muted: #8ba0c8;
      --success: #10b981;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1a233a, var(--bg) 70%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1.5rem;
    }
    .header { text-align: center; margin-bottom: 2.5rem; max-width: 780px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 0.85rem;
      color: var(--accent);
      margin-bottom: 1rem;
    }
    .badge-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
    h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 0.5rem; }
    .accent { color: var(--accent); }
    p.subtitle { color: var(--text-muted); font-size: 1.1rem; }
    .grid { width: 100%; max-width: 960px; display: grid; gap: 1.5rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    }
    .card h2 { font-size: 1.25rem; margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
    a.link-btn {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
      background: rgba(255, 107, 53, 0.1);
      padding: 5px 12px;
      border-radius: 6px;
      transition: background 0.2s;
      display: inline-block;
    }
    a.link-btn:hover { background: rgba(255, 107, 53, 0.25); }
    .domain-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(0, 242, 254, 0.1);
      border: 1px solid rgba(0, 242, 254, 0.3);
      color: var(--cyan);
      padding: 4px 10px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.9rem;
    }
    .empty-state { text-align: center; padding: 2rem; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">
      <span class="badge-dot"></span> Dominio Activo: ${currentHost} (TLD Descentralizado .fox)
    </div>
    <h1>🦊 Foxy <span class="accent">Network</span></h1>
    <p class="subtitle">Pasarela de Entrada, DNS Descentralizado <code>.fox</code> & Túnel Inverso DePIN</p>
  </div>

  <div class="grid">
    <!-- Dominios Oficiales .fox Alojados -->
    <div class="card" style="border-color: rgba(0, 242, 254, 0.35);">
      <h2>
        <span>🌐 Dominios Oficiales <code>.fox</code> Alojados en Foxy Network</span>
        <span style="font-size:0.85rem; color:var(--success)">● DNS & SSL Activos</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Dominio Web3 / DePIN</th>
            <th>Aplicación Destino</th>
            <th>Túnel / Nodo</th>
            <th>Estado</th>
            <th>Acceso</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><span class="domain-pill">https://www.foxynetwork.fox</span></td>
            <td><strong>Foxy Network Portal & Gateway</strong></td>
            <td><code>__portal__</code></td>
            <td><span style="color:var(--success);font-weight:700">● ONLINE</span></td>
            <td><a class="link-btn" href="https://www.foxynetwork.fox" target="_blank">Visitar ↗</a></td>
          </tr>
          <tr>
            <td><span class="domain-pill">https://www.foxyfianance.fox</span></td>
            <td><strong>FOXY FINANCE SaaS (Quant & DePIN)</strong></td>
            <td><code>foxy-finance</code></td>
            <td>
              ${financeOnline
                ? '<span style="color:var(--success);font-weight:700">● ONLINE</span>'
                : '<span style="color:var(--warning);font-weight:700">● CONECTANDO NODO</span>'}
            </td>
            <td>
              <a class="link-btn" href="https://www.foxyfianance.fox" target="_blank">Abrir Dominio ↗</a>
              <a class="link-btn" style="margin-left:6px" href="/t/foxy-finance/" target="_blank">Ruta Directa ↗</a>
            </td>
          </tr>
          <tr>
            <td><span class="domain-pill">https://www.foxyfinance.fox</span></td>
            <td><strong>FOXY FINANCE SaaS (Alias Canónico)</strong></td>
            <td><code>foxy-finance</code></td>
            <td>
              ${financeOnline
                ? '<span style="color:var(--success);font-weight:700">● ONLINE</span>'
                : '<span style="color:var(--warning);font-weight:700">● CONECTANDO NODO</span>'}
            </td>
            <td><a class="link-btn" href="https://www.foxyfinance.fox" target="_blank">Abrir Dominio ↗</a></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>
        Servidores Activos en Nodos Donantes
        <span style="font-size:0.9rem; color:var(--text-muted)">${tunnels.length} túneles conectados</span>
      </h2>
      ${tunnels.length === 0 ? `
        <div class="empty-state">
          <p>No hay nodos donantes conectados actualmente.</p>
          <p style="font-size:0.9rem; margin-top:0.5rem">Inicia el daemon <code>foxy-daemon</code> en tu equipo para exponer los servidores.</p>
        </div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>Subdominio / Túnel</th>
              <th>Dominio .fox</th>
              <th>ID Nodo</th>
              <th>Peticiones</th>
              <th>Tráfico</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${tunnels.map(([sub, t]) => {
              const foxHost = (sub === 'foxy-finance' || sub === 'foxyfianance')
                ? 'https://www.foxyfianance.fox'
                : `https://${sub}.foxynetwork.fox`;
              return `
                <tr>
                  <td><strong>${sub}</strong></td>
                  <td><code>${foxHost}</code></td>
                  <td><code>${t.nodeId}</code></td>
                  <td>${t.requestCount}</td>
                  <td>${(t.bytesTransferred / 1024).toFixed(1)} KB</td>
                  <td><a class="link-btn" href="/t/${sub}/" target="_blank">Abrir Servidor ↗</a></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>

    <div class="card" style="font-size:0.9rem; color:var(--text-muted); line-height:1.6">
      <h3 style="color:var(--text); margin-bottom:0.5rem">¿Cómo resolver dominios <code>.fox</code> en tu navegador?</h3>
      <p>1. <strong>Automático con dVPN Foxy:</strong> Conecta el proxy en <code>127.0.0.1:1080</code> (<code>foxy vpn connect</code>) y navega directamente a <code>https://www.foxyfianance.fox</code> o <code>http://www.foxynetwork.fox</code>.</p>
      <p>2. <strong>En cualquier navegador del sistema (sin proxy):</strong> Ejecuta <code>node packages/foxy-cli/bin/foxy.js domains setup</code> para registrar los dominios <code>.fox</code> y el certificado raíz local.</p>
      <p>3. <strong>Por ruta de pasarela:</strong> <code>http://localhost:${HTTP_PORT}/t/foxy-finance/</code></p>
    </div>
  </div>
</body>
</html>
  `);
}

function serveNodeOffline(req, res, subdomain) {
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <div style="font-family:system-ui,sans-serif;padding:3rem;text-align:center;background:#0d1117;color:#f0f6fc;min-height:100vh">
      <h1 style="color:#e3b341">503 Nodo No Disponible (${req.headers.host || subdomain})</h1>
      <p>No hay ningún nodo donante activo en Foxy Network sirviendo la aplicación <strong>${subdomain}</strong>.</p>
      <p style="color:#8b949e;margin-top:1rem">El nodo donante puede haberse desconectado o FOXY FINANCE aún está iniciando en el puerto 8000.</p>
      <a href="/" style="display:inline-block;margin-top:1.5rem;color:#ff6b35;text-decoration:none">← Volver al Portal de Foxy Network (www.foxynetwork.fox)</a>
    </div>
  `);
}

// Start HTTP Ingress on HTTP_PORT (8080)
const httpServer = http.createServer(handleIngressRequest);
httpServer.listen(HTTP_PORT, () => {
  console.log(`[Foxy Gateway] Public HTTP Ingress listening on http://localhost:${HTTP_PORT}`);
  console.log(`[Foxy Gateway] 🌐 Hosting Domains: http://www.foxynetwork.fox:${HTTP_PORT} & http://www.foxyfianance.fox:${HTTP_PORT}`);
});

// Start HTTPS Ingress on HTTPS_PORT (8443) for https://www.foxyfianance.fox and https://www.foxynetwork.fox
try {
  const sslCreds = ensureFoxSslCredentials();
  const httpsServer = https.createServer({ key: sslCreds.key, cert: sslCreds.cert }, handleIngressRequest);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`[Foxy Gateway] 🔒 Public HTTPS Ingress listening on https://localhost:${HTTPS_PORT}`);
    console.log(`[Foxy Gateway] 🦊 SSL Domains ready: https://www.foxyfianance.fox & https://www.foxynetwork.fox`);
  });

  // Optional: Also bind standard ports 80 and 443 if available & permitted by OS so URLs work without :8080/:8443
  if (process.env.FOXY_BIND_STANDARD_PORTS !== 'false') {
    const port80Server = http.createServer(handleIngressRequest);
    port80Server.on('error', () => { /* Port 80 in use or requires elevation, ignore cleanly */ });
    port80Server.listen(80, () => {
      console.log(`[Foxy Gateway] 🌐 Standard HTTP port 80 bound -> http://www.foxynetwork.fox & http://www.foxyfianance.fox`);
    });

    const port443Server = https.createServer({ key: sslCreds.key, cert: sslCreds.cert }, handleIngressRequest);
    port443Server.on('error', () => { /* Port 443 in use or requires elevation, ignore cleanly */ });
    port443Server.listen(443, () => {
      console.log(`[Foxy Gateway] 🔒 Standard HTTPS port 443 bound -> https://www.foxyfianance.fox & https://www.foxynetwork.fox`);
    });
  }
} catch (err) {
  console.warn(`[Foxy Gateway] ⚠️ Could not start HTTPS server on port ${HTTPS_PORT}: ${err.message}`);
}
