import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { verifySubdomainToken, verifyNodeToken } from '../../foxy-security/src/index.js';
import { resolveFoxDomain, loadDomainMappings, ensureFoxSslCredentials } from './domains.js';

const HTTP_PORT = parseInt(process.env.FOXY_GATEWAY_HTTP_PORT || '8080', 10);
const TUNNEL_PORT = parseInt(process.env.FOXY_GATEWAY_TUNNEL_PORT || '8081', 10);
// HTTPS ingress for the .fox domains. Set FOXY_GATEWAY_HTTPS_PORT=off to disable it.
const HTTPS_PORT_RAW = process.env.FOXY_GATEWAY_HTTPS_PORT || '8443';
const HTTPS_PORT = HTTPS_PORT_RAW === 'off' ? null : parseInt(HTTPS_PORT_RAW, 10);

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
const TUNNEL_HOST = process.env.FOXY_GATEWAY_HOST || '0.0.0.0';
const wss = new WebSocketServer({ port: TUNNEL_PORT, host: TUNNEL_HOST, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  // One daemon connection can serve several subdomains
  const registeredSubdomains = new Set();
  let boundNodeId = null;

  console.log(`[Gateway Tunnel] New incoming connection from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // --- dVPN PROTOCOL HANDLING ---
      if (msg.type === 'REGISTER_VPN_RELAY') {
        // Only nodes holding an identity token issued by the controller may
        // offer themselves as exit relays.
        const relayAuth = verifyNodeToken(msg.nodeToken, msg.nodeId);
        if (!relayAuth.valid) {
          ws.send(JSON.stringify({
            type: 'SECURITY_ERROR',
            message: `Registro de repetidor dVPN denegado: ${relayAuth.error}`
          }));
          return;
        }
        boundNodeId = relayAuth.payload.sub;
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
        const { sessionId, targetHost, targetPort, clientPublicKey } = msg;
        if (typeof sessionId !== 'string' || !sessionId || vpnSessions.has(sessionId)) {
          ws.send(JSON.stringify({ type: 'VPN_ERROR', sessionId, error: 'Sesión inválida o duplicada' }));
          return;
        }
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
        // Forward only the known fields: nothing else from the client reaches the relay.
        selectedRelay.ws.send(JSON.stringify({
          type: 'VPN_REQUEST_CONNECT', sessionId, targetHost, targetPort, clientPublicKey
        }));
        return;
      }

      // Each frame is accepted only from the peer that owns that side of the
      // session, so one connection cannot inject data into another's session.
      if (msg.type === 'VPN_CONNECTED') {
        const session = vpnSessions.get(msg.sessionId);
        if (session && session.relayWs === ws && session.clientWs.readyState === 1) {
          session.clientWs.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === 'VPN_CLIENT_DATA') {
        const session = vpnSessions.get(msg.sessionId);
        if (session && session.clientWs === ws && session.relayWs.readyState === 1) {
          session.relayWs.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === 'VPN_DATA_STREAM') {
        const session = vpnSessions.get(msg.sessionId);
        if (session && session.relayWs === ws && session.clientWs.readyState === 1) {
          session.clientWs.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === 'VPN_CLIENT_CLOSE' || msg.type === 'VPN_CLOSED' || msg.type === 'VPN_ERROR') {
        const session = vpnSessions.get(msg.sessionId);
        if (session) {
          if (msg.type === 'VPN_CLIENT_CLOSE' && session.clientWs === ws) {
            if (session.relayWs.readyState === 1) session.relayWs.send(JSON.stringify(msg));
            vpnSessions.delete(msg.sessionId);
          } else if (msg.type !== 'VPN_CLIENT_CLOSE' && session.relayWs === ws) {
            if (session.clientWs.readyState === 1) session.clientWs.send(JSON.stringify(msg));
            vpnSessions.delete(msg.sessionId);
          }
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

        // The token names the node it was issued to ('*' = any node).
        const tokenNode = authCheck.payload.nodeId;
        if (tokenNode && tokenNode !== '*' && tokenNode !== nodeId) {
          ws.send(JSON.stringify({
            type: 'SECURITY_ERROR',
            subdomain: cleanSubdomain,
            message: 'Registro de túnel denegado: el token pertenece a otro nodo'
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

        // Only the tunnel that received the request may answer it.
        if (!pending || pending.tunnelWs !== ws) {
          return;
        }

        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);

        const tunnel = activeTunnels.get(pending.subdomain);
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
      if (sess.clientWs === ws) {
        if (sess.relayWs.readyState === 1) sess.relayWs.send(JSON.stringify({ type: 'VPN_CLIENT_CLOSE', sessionId: sId }));
        vpnSessions.delete(sId);
      } else if (sess.relayWs === ws) {
        if (sess.clientWs.readyState === 1) sess.clientWs.send(JSON.stringify({ type: 'VPN_CLOSED', sessionId: sId }));
        vpnSessions.delete(sId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Gateway Tunnel] Error on node ${boundNodeId}:`, err.message);
  });
});

console.log(`[Foxy Gateway] Tunnel WebSocket listening on ws://${TUNNEL_HOST}:${TUNNEL_PORT}`);

// -------------------------------------------------------------
// 2. Public Ingress HTTP Server (Receives external traffic)
// -------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Subdomains are [a-z0-9-] only, whatever source they come from, so they are
// safe to echo back in HTML error pages.
function extractSubdomain(req) {
  const raw = extractRawSubdomain(req);
  if (!raw) return null;
  const clean = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
  return clean || null;
}

function extractRawSubdomain(req) {
  // 1. Direct header
  if (req.headers['x-foxy-subdomain']) {
    return req.headers['x-foxy-subdomain'];
  }

  // 2. Explicit path prefix: /t/:subdomain/... or /app/:subdomain/...
  //    (first, so links from the portal work under any hostname)
  const match = req.url.match(/^\/(?:app|t)\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (match) {
    req.originalUrl = req.url;
    req.url = match[2] || '/';
    return match[1];
  }

  const host = (req.headers.host || '').split(':')[0].toLowerCase();

  // 3. Decentralized .fox domains (www.foxyfinance.fox, <app>.foxynetwork.fox...)
  const fox = resolveFoxDomain(host);
  if (fox.matched) {
    return fox.target === '__portal__' ? null : fox.target;
  }

  // 4. Host header: tenant.domain.com or tenant.localhost:8080
  //    An IP address has no subdomain ("127.0.0.1" is not tenant "127").
  const isIpHost = /^\d+(\.\d+){3}$/.test(host) || (req.headers.host || '').startsWith('[');
  const parts = host.split('.');
  if (!isIpHost && parts.length >= 2) {
    const candidate = parts[0];
    if (candidate !== 'www' && candidate !== 'localhost' && candidate !== 'foxy') {
      return candidate;
    }
  }

  return null;
}

function handleIngressRequest(req, res) {
  // CORS for open distributed access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Gateway status and API
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
        foxDomainUrl: foxUrlFor(subdomain)
      });
    }
    res.end(JSON.stringify({
      status: 'online',
      activeTunnelsCount: activeTunnels.size,
      tunnels: tunnelsList,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      foxDomains: listFoxDomains()
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

  // If no specific subdomain is targeted, serve Gateway Portal landing page
  if (!subdomain) {
    serveGatewayPortal(req, res);
    return;
  }

  // Check if tunnel exists for this subdomain
  const tunnel = activeTunnels.get(subdomain);
  if (!tunnel || tunnel.ws.readyState !== 1) {
    serveNodeOffline(res, subdomain);
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

    pendingRequests.set(requestId, { req, res, timer, tunnelWs: tunnel.ws, subdomain });

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

/** Public URL of a tunnel under the .fox namespace. */
function foxUrlFor(subdomain) {
  const scheme = HTTPS_PORT ? 'https' : 'http';
  const port = HTTPS_PORT ? (HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`) : `:${HTTP_PORT}`;
  const named = Object.entries(loadDomainMappings()).find(([, info]) => info.target === subdomain);
  return `${scheme}://${named ? named[0] : `${subdomain}.foxynetwork.fox`}${port}`;
}

function listFoxDomains() {
  return Object.entries(loadDomainMappings()).map(([domain, info]) => ({
    domain,
    url: foxUrlFor(info.target === '__portal__' ? '__portal__' : info.target).replace(/\/\/[^:/]+/, `//${domain}`),
    target: info.target,
    name: info.name,
    online: info.target === '__portal__' || activeTunnels.has(info.target)
  }));
}

function serveGatewayPortal(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const tunnels = Array.from(activeTunnels.entries());

  res.end(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>🦊 Foxy Network — Ingress Gateway</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #151d30;
      --border: #232f4e;
      --accent: #ff6b35;
      --accent-glow: rgba(255, 107, 53, 0.25);
      --text: #f0f4fc;
      --text-muted: #8ba0c8;
      --success: #10b981;
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
    .header { text-align: center; margin-bottom: 2.5rem; max-width: 700px; }
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
    .grid { width: 100%; max-width: 900px; display: grid; gap: 1.5rem; }
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
      padding: 4px 10px;
      border-radius: 6px;
      transition: background 0.2s;
    }
    a.link-btn:hover { background: rgba(255, 107, 53, 0.25); }
    .empty-state { text-align: center; padding: 2rem; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">
      <span class="badge-dot"></span> Ingress Gateway Operativo
    </div>
    <h1>🦊 Foxy <span class="accent">Network</span></h1>
    <p class="subtitle">Pasarela de Entrada & Túnel Inverso Descentralizado</p>
  </div>

  <div class="grid">
    <div class="card">
      <h2><span>🌐 Dominios <code>.fox</code></span></h2>
      <table>
        <thead><tr><th>Dominio</th><th>Aplicación</th><th>Estado</th></tr></thead>
        <tbody>
          ${listFoxDomains().map(d => `
            <tr>
              <td><a class="link-btn" href="${escapeHtml(d.url)}">${escapeHtml(d.domain)}</a></td>
              <td>${escapeHtml(d.name)} <code>${escapeHtml(d.target)}</code></td>
              <td>${d.online ? '<span style="color:#3fb950;font-weight:700">● ONLINE</span>' : '<span style="color:#e3b341;font-weight:700">● SIN NODO</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="font-size:0.85rem; margin-top:0.75rem">Para abrirlos en tu navegador: <code>foxy domains setup</code> (registra los dominios en tu equipo) o usa el proxy <code>foxy vpn connect</code>.</p>
    </div>

    <div class="card">
      <h2>
        Servidores Activos en Nodos Donantes
        <span style="font-size:0.9rem; color:var(--text-muted)">${tunnels.length} conectados</span>
      </h2>
      ${tunnels.length === 0 ? `
        <div class="empty-state">
          <p>No hay nodos donantes conectados actualmente.</p>
          <p style="font-size:0.9rem; margin-top:0.5rem">Inicia el daemon <code>foxy-daemon</code> en tu equipo para exponer un servidor.</p>
        </div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>Subdominio / Ruta</th>
              <th>ID Nodo</th>
              <th>Peticiones</th>
              <th>Tráfico</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${tunnels.map(([sub, t]) => `
              <tr>
                <td><strong>${sub}</strong></td>
                <td><code>${escapeHtml(t.nodeId)}</code></td>
                <td>${t.requestCount}</td>
                <td>${(t.bytesTransferred / 1024).toFixed(1)} KB</td>
                <td><a class="link-btn" href="/t/${sub}/" target="_blank">Abrir Servidor ↗</a></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <div class="card" style="font-size:0.9rem; color:var(--text-muted); line-height:1.6">
      <h3 style="color:var(--text); margin-bottom:0.5rem">¿Cómo acceder a una aplicación alojada?</h3>
      <p>1. <strong>Por ruta:</strong> <code>http://localhost:${HTTP_PORT}/t/&lt;subdominio&gt;/</code></p>
      <p>2. <strong>Por cabecera:</strong> Enviar <code>X-Foxy-Subdomain: &lt;subdominio&gt;</code> a <code>http://localhost:${HTTP_PORT}</code></p>
      <p>3. <strong>Por subdominio DNS:</strong> Configurar <code>&lt;subdominio&gt;.localhost:${HTTP_PORT}</code></p>
    </div>
  </div>
</body>
</html>
  `);
}

function serveNodeOffline(res, subdomain) {
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <div style="font-family:system-ui,sans-serif;padding:3rem;text-align:center;background:#0d1117;color:#f0f6fc;min-height:100vh">
      <h1 style="color:#e3b341">503 Nodo No Disponible</h1>
      <p>No hay ningún nodo donante activo en Foxy Network sirviendo el subdominio <strong>${subdomain}</strong>.</p>
      <p style="color:#8b949e;margin-top:1rem">El nodo puede haberse desconectado o el contenedor aún se está desplegando.</p>
      <a href="/" style="display:inline-block;margin-top:1.5rem;color:#ff6b35;text-decoration:none">← Volver al Portal de Foxy Network</a>
    </div>
  `);
}

const HTTP_HOST = process.env.FOXY_GATEWAY_HOST || '0.0.0.0';
const httpServer = http.createServer(handleIngressRequest);
httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[Foxy Gateway] Public HTTP Ingress listening on http://localhost:${HTTP_PORT}`);
});

// HTTPS ingress for the .fox domains, with a locally generated certificate
if (HTTPS_PORT) {
  try {
    const sslCreds = ensureFoxSslCredentials();
    const tlsOptions = { key: sslCreds.key, cert: sslCreds.cert };
    const httpsServer = https.createServer(tlsOptions, handleIngressRequest);
    httpsServer.on('error', (err) => console.warn(`[Foxy Gateway] ⚠️ HTTPS :${HTTPS_PORT} no disponible: ${err.message}`));
    httpsServer.listen(HTTPS_PORT, HTTP_HOST, () => {
      console.log(`[Foxy Gateway] 🔒 HTTPS Ingress (.fox) listening on https://localhost:${HTTPS_PORT}`);
    });

    // Opt-in: also bind 80/443 so .fox URLs work without a port (needs privileges)
    if (process.env.FOXY_BIND_STANDARD_PORTS === 'true') {
      const port80 = http.createServer(handleIngressRequest);
      port80.on('error', (err) => console.warn(`[Foxy Gateway] ⚠️ Puerto 80 no disponible: ${err.message}`));
      port80.listen(80, HTTP_HOST, () => console.log('[Foxy Gateway] 🌐 Puerto 80 activo'));
      const port443 = https.createServer(tlsOptions, handleIngressRequest);
      port443.on('error', (err) => console.warn(`[Foxy Gateway] ⚠️ Puerto 443 no disponible: ${err.message}`));
      port443.listen(443, HTTP_HOST, () => console.log('[Foxy Gateway] 🔒 Puerto 443 activo'));
    }
  } catch (err) {
    console.warn(`[Foxy Gateway] ⚠️ No se pudo iniciar HTTPS: ${err.message}`);
  }
}
