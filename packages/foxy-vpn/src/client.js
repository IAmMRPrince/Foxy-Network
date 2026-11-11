// ==============================================================================
// Foxy Network - dVPN Client Proxy
// Starts a local HTTP / HTTP CONNECT proxy on 127.0.0.1:1080
// Encrypts and tunnels outbound traffic through decentralized Foxy donor nodes
// ==============================================================================

import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { CryptoTunnel } from './crypto-tunnel.js';

const PROXY_PORT = parseInt(process.env.FOXY_VPN_LOCAL_PORT || '1080', 10);
const GATEWAY_TUNNEL_URL = process.env.FOXY_GATEWAY_TUNNEL_URL || 'ws://127.0.0.1:8081';
const CONNECT_TIMEOUT_MS = 15000;
// .fox names are not real DNS: the proxy sends them straight to the Foxy gateway.
const FOX_GATEWAY_HOST = process.env.FOXY_GATEWAY_INGRESS_HOST || '127.0.0.1';
const GATEWAY_HTTP_PORT = parseInt(process.env.FOXY_GATEWAY_HTTP_PORT || '8080', 10);
const GATEWAY_HTTPS_PORT = parseInt(process.env.FOXY_GATEWAY_HTTPS_PORT || '8443', 10) || 8443;

function isFoxDomain(hostname) {
  return typeof hostname === 'string' && hostname.toLowerCase().trim().endsWith('.fox');
}

export class FoxyVpnClient {
  constructor(options = {}) {
    this.port = options.port ?? PROXY_PORT;
    this.gatewayUrl = options.gatewayUrl || GATEWAY_TUNNEL_URL;
    this.foxGateway = {
      host: options.foxGatewayHost || FOX_GATEWAY_HOST,
      httpPort: options.foxHttpPort || GATEWAY_HTTP_PORT,
      httpsPort: options.foxHttpsPort || GATEWAY_HTTPS_PORT
    };
    this.ws = null;
    this.server = null;
    this.stopped = false;
    this.sessions = new Map(); // sessionId -> { clientSocket, privateKey, sessionKey, onConnected, timer }
    this.stats = {
      bytesEncrypted: 0,
      bytesDecrypted: 0,
      activeConnections: 0,
      totalSessions: 0
    };
  }

  async start() {
    await this.connectToGateway();
    await this.startLocalProxy();
  }

  connectToGateway() {
    return new Promise((resolve) => {
      console.log(`[dVPN Client 🔒] Conectando con la red Foxy en ${this.gatewayUrl}...`);
      this.ws = new WebSocket(this.gatewayUrl);

      this.ws.on('open', () => {
        console.log(`[dVPN Client 🔒] ✅ Conectado a la red de túneles dVPN.`);
        this.ws.send(JSON.stringify({
          type: 'VPN_CLIENT_REGISTER',
          clientId: `vpn-client-${crypto.randomBytes(4).toString('hex')}`
        }));
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          this.handleGatewayMessage(JSON.parse(data.toString()));
        } catch (e) {
          // Ignore malformed
        }
      });

      this.ws.on('close', () => {
        // Sessions cannot survive a gateway reconnect: their relay is gone.
        for (const sessionId of Array.from(this.sessions.keys())) this.endSession(sessionId);
        if (this.stopped) return;
        console.log(`[dVPN Client 🔒] Conexión de túnel cerrada. Reintentando en 3s...`);
        setTimeout(() => { if (!this.stopped) this.connectToGateway(); }, 3000);
      });

      this.ws.on('error', (err) => {
        console.error(`[dVPN Client 🔒] Error de WebSocket: ${err.message}`);
      });
    });
  }

  isOnline() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    if (session.clientSocket && !session.clientSocket.destroyed) session.clientSocket.end();
    this.sessions.delete(sessionId);
    this.stats.activeConnections = this.sessions.size;
  }

  /** Opens a tunnel session. `onConnected` runs once the session key is agreed. */
  openSession(clientSocket, targetHost, targetPort, onConnected) {
    const sessionId = crypto.randomUUID();
    const { privateKey, publicKey } = CryptoTunnel.createEphemeralKeyPair();

    this.stats.totalSessions++;
    this.sessions.set(sessionId, {
      clientSocket,
      privateKey,
      sessionKey: null,
      onConnected,
      timer: setTimeout(() => this.endSession(sessionId), CONNECT_TIMEOUT_MS)
    });
    this.stats.activeConnections = this.sessions.size;

    this.ws.send(JSON.stringify({
      type: 'VPN_REQUEST_CONNECT',
      sessionId,
      targetHost,
      targetPort,
      clientPublicKey: publicKey
    }));
    return sessionId;
  }

  sendEncrypted(sessionId, buffer) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.sessionKey || !this.isOnline()) return false;
    this.stats.bytesEncrypted += buffer.length;
    this.ws.send(JSON.stringify({
      type: 'VPN_CLIENT_DATA',
      sessionId,
      payload: CryptoTunnel.encrypt(buffer, session.sessionKey)
    }));
    return true;
  }

  closeRemote(sessionId) {
    if (this.isOnline()) {
      this.ws.send(JSON.stringify({ type: 'VPN_CLIENT_CLOSE', sessionId }));
    }
    this.endSession(sessionId);
  }

  handleGatewayMessage(msg) {
    const session = this.sessions.get(msg.sessionId);
    if (!session) return;

    if (msg.type === 'VPN_CONNECTED') {
      try {
        session.sessionKey = CryptoTunnel.deriveSessionKey(session.privateKey, msg.relayPublicKey, msg.sessionId);
        session.privateKey = null;
      } catch (err) {
        console.error(`[dVPN Client 🔒] Intercambio de claves fallido: ${err.message}`);
        this.closeRemote(msg.sessionId);
        return;
      }
      clearTimeout(session.timer);
      if (session.onConnected) session.onConnected();
    } else if (msg.type === 'VPN_DATA_STREAM') {
      if (!session.sessionKey) return;
      try {
        const decrypted = CryptoTunnel.decrypt(msg.payload, session.sessionKey);
        this.stats.bytesDecrypted += decrypted.length;
        if (session.clientSocket && !session.clientSocket.destroyed) {
          session.clientSocket.write(decrypted);
        }
      } catch (err) {
        console.error(`[dVPN Client 🔒] Error descifrando paquete: ${err.message}`);
      }
    } else if (msg.type === 'VPN_CLOSED' || msg.type === 'VPN_ERROR') {
      if (msg.type === 'VPN_ERROR' && !session.sessionKey && session.clientSocket && !session.clientSocket.destroyed) {
        session.clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
      this.endSession(msg.sessionId);
    }
  }

  startLocalProxy() {
    // Plain HTTP forward proxy: the request is replayed through the tunnel and
    // the raw response is written back on the client's socket.
    this.server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url);
      } catch {
        res.writeHead(400);
        res.end('Foxy dVPN: URL de proxy inválida.');
        return;
      }
      if (url.protocol === 'http:' && isFoxDomain(url.hostname)) {
        const proxyReq = http.request({
          hostname: this.foxGateway.host,
          port: this.foxGateway.httpPort,
          path: url.pathname + url.search,
          method: req.method,
          headers: { ...req.headers, host: url.hostname }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
          res.writeHead(502);
          res.end(`Foxy DNS (.fox): no se pudo conectar con el gateway (${err.message})`);
        });
        req.pipe(proxyReq);
        return;
      }
      if (url.protocol !== 'http:' || !this.isOnline()) {
        res.writeHead(502);
        res.end('Foxy dVPN: Red no disponible.');
        return;
      }

      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = { ...req.headers, host: url.host, connection: 'close' };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];
        const head = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
          Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n') +
          '\r\n\r\n';

        const socket = res.socket;
        const sessionId = this.openSession(socket, url.hostname, parseInt(url.port || '80', 10), () => {
          this.sendEncrypted(sessionId, Buffer.concat([Buffer.from(head), body]));
        });
        socket.on('close', () => this.closeRemote(sessionId));
      });
    });

    // HTTPS CONNECT tunnel (used by browsers for TLS traffic)
    this.server.on('connect', (req, clientSocket, head) => {
      const sep = req.url.lastIndexOf(':');
      const targetHost = sep > 0 ? req.url.slice(0, sep) : req.url;
      const targetPort = parseInt(sep > 0 ? req.url.slice(sep + 1) : '443', 10);

      if (isFoxDomain(targetHost)) {
        const { host, httpPort, httpsPort } = this.foxGateway;
        const gwPort = (targetPort === 80 || targetPort === httpPort) ? httpPort : httpsPort;
        const gwSocket = net.connect(gwPort, host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Foxy-DNS-Gateway\r\n\r\n');
          if (head && head.length > 0) gwSocket.write(head);
          gwSocket.pipe(clientSocket);
          clientSocket.pipe(gwSocket);
        });
        gwSocket.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
        clientSocket.on('error', () => gwSocket.destroy());
        return;
      }

      if (!this.isOnline()) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }

      const sessionId = this.openSession(clientSocket, targetHost, targetPort, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Foxy-dVPN\r\n\r\n');
        if (head && head.length > 0) this.sendEncrypted(sessionId, head);
        clientSocket.on('data', (chunk) => this.sendEncrypted(sessionId, chunk));
      });

      clientSocket.on('end', () => this.closeRemote(sessionId));
      clientSocket.on('error', () => this.closeRemote(sessionId));
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        console.log(`
🛡️ ========================================================
       FOXY NETWORK — DECENTRALIZED ENCRYPTED VPN (dVPN)
========================================================
  Proxy HTTP local:  http://127.0.0.1:${this.port}
  Cifrado de túnel:  X25519 + AES-256-GCM (clave efímera por sesión)

  Uso rápido:
    curl -x http://127.0.0.1:${this.port} https://api.ipify.org
    O configura el proxy HTTP de tu navegador en 127.0.0.1:${this.port}
========================================================
`);
        resolve();
      });
    });
  }

  stop() {
    this.stopped = true;
    if (this.server) this.server.close();
    if (this.ws) this.ws.close();
    for (const sessionId of Array.from(this.sessions.keys())) this.endSession(sessionId);
  }
}

// Standalone execution if run directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new FoxyVpnClient();
  client.start();
}
