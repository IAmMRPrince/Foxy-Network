// ==============================================================================
// Foxy Network - dVPN Client Proxy
// Starts a local HTTP CONNECT & SOCKS5 Proxy on 127.0.0.1:1080
// Encrypts and tunnels outbound traffic through decentralized Foxy donor nodes
// ==============================================================================

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { CryptoTunnel } from './crypto-tunnel.js';

const PROXY_PORT = parseInt(process.env.FOXY_VPN_LOCAL_PORT || '1080', 10);
const GATEWAY_TUNNEL_URL = process.env.FOXY_GATEWAY_TUNNEL_URL || 'ws://127.0.0.1:8081';
const SHARED_SECRET = process.env.FOXY_CLUSTER_SECRET || 'foxy-depin-cluster-shared-secret-v1';

export class FoxyVpnClient {
  constructor(options = {}) {
    this.port = options.port || PROXY_PORT;
    this.gatewayUrl = options.gatewayUrl || GATEWAY_TUNNEL_URL;
    this.sharedSecret = options.sharedSecret || SHARED_SECRET;
    this.ws = null;
    this.server = null;
    this.sessions = new Map(); // sessionId -> { clientSocket, sessionKey }
    this.stats = {
      bytesEncrypted: 0,
      bytesDecrypted: 0,
      activeConnections: 0,
      totalSessions: 0
    };
  }

  async start() {
    await this.connectToGateway();
    this.startLocalProxy();
  }

  connectToGateway() {
    return new Promise((resolve) => {
      console.log(`[dVPN Client 🔒] Conectando con la red Foxy en ${this.gatewayUrl}...`);
      this.ws = new WebSocket(this.gatewayUrl);

      this.ws.on('open', () => {
        console.log(`[dVPN Client 🔒] ✅ Conectado a la red de túneles dVPN.`);
        // Register as VPN client
        this.ws.send(JSON.stringify({
          type: 'VPN_CLIENT_REGISTER',
          clientId: `vpn-client-${crypto.randomBytes(4).toString('hex')}`
        }));
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleGatewayMessage(msg);
        } catch (e) {
          // Ignore malformed
        }
      });

      this.ws.on('close', () => {
        console.log(`[dVPN Client 🔒] Conexión de túnel cerrada. Reintentando en 3s...`);
        setTimeout(() => this.connectToGateway(), 3000);
      });

      this.ws.on('error', (err) => {
        console.error(`[dVPN Client 🔒] Error de WebSocket: ${err.message}`);
      });
    });
  }

  handleGatewayMessage(msg) {
    const session = this.sessions.get(msg.sessionId);
    if (!session) return;

    if (msg.type === 'VPN_CONNECTED') {
      if (session.onConnected) session.onConnected();
    } else if (msg.type === 'VPN_DATA_STREAM') {
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
      if (session.clientSocket && !session.clientSocket.destroyed) {
        session.clientSocket.end();
      }
      this.sessions.delete(msg.sessionId);
      this.stats.activeConnections = this.sessions.size;
    }
  }

  startLocalProxy() {
    this.server = http.createServer((req, res) => {
      // Standard HTTP forward proxy fallback
      const url = new URL(req.url);
      const targetHost = url.hostname;
      const targetPort = url.port || 80;

      const sessionId = crypto.randomUUID();
      const sessionKey = CryptoTunnel.deriveKey(this.sharedSecret, sessionId);

      this.stats.totalSessions++;
      this.stats.activeConnections++;

      this.sessions.set(sessionId, {
        clientSocket: res.socket,
        sessionKey
      });

      // Send connect request through encrypted tunnel
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'VPN_REQUEST_CONNECT',
          sessionId,
          targetHost,
          targetPort
        }));

        // Send raw request
        const rawReq = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`;
        const encData = CryptoTunnel.encrypt(Buffer.from(rawReq), sessionKey);
        this.stats.bytesEncrypted += rawReq.length;

        this.ws.send(JSON.stringify({
          type: 'VPN_CLIENT_DATA',
          sessionId,
          payload: encData
        }));
      } else {
        res.writeHead(502);
        res.end('Foxy dVPN: Red no disponible.');
      }
    });

    // Handle HTTPS CONNECT tunnel (Used by browsers for encrypted SSL/TLS traffic)
    this.server.on('connect', (req, clientSocket, head) => {
      const [targetHost, targetPortStr] = req.url.split(':');
      const targetPort = parseInt(targetPortStr || '443', 10);
      const sessionId = crypto.randomUUID();
      const sessionKey = CryptoTunnel.deriveKey(this.sharedSecret, sessionId);

      this.stats.totalSessions++;
      this.stats.activeConnections++;

      const sessionObj = {
        clientSocket,
        sessionKey,
        onConnected: () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Foxy-dVPN-Encrypted-Relay\r\n\r\n');
          if (head && head.length > 0) {
            const encHead = CryptoTunnel.encrypt(head, sessionKey);
            this.stats.bytesEncrypted += head.length;
            this.ws.send(JSON.stringify({
              type: 'VPN_CLIENT_DATA',
              sessionId,
              payload: encHead
            }));
          }
        }
      };

      this.sessions.set(sessionId, sessionObj);

      clientSocket.on('data', (chunk) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const encrypted = CryptoTunnel.encrypt(chunk, sessionKey);
          this.stats.bytesEncrypted += chunk.length;
          this.ws.send(JSON.stringify({
            type: 'VPN_CLIENT_DATA',
            sessionId,
            payload: encrypted
          }));
        }
      });

      clientSocket.on('end', () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'VPN_CLIENT_CLOSE', sessionId }));
        }
        this.sessions.delete(sessionId);
        this.stats.activeConnections = this.sessions.size;
      });

      clientSocket.on('error', () => {
        this.sessions.delete(sessionId);
        this.stats.activeConnections = this.sessions.size;
      });

      // Request tunnel connection
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'VPN_REQUEST_CONNECT',
          sessionId,
          targetHost,
          targetPort
        }));
      } else {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      }
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`
🛡️ ========================================================
       FOXY NETWORK — DECENTRALIZED ENCRYPTED VPN (dVPN)
========================================================
  Proxy Local Activo: http://127.0.0.1:${this.port}
  Cifrado de Túnel:  AES-256-GCM con rotación por sesión
  Política:          Zero-Logs (Sin registro de destino)
  Recompensas:       2.00 $FOXY por MB transferido al donante

  Uso rápido:
    curl -x http://127.0.0.1:${this.port} https://api.ipify.org
    O configura el proxy de tu navegador en 127.0.0.1:${this.port}
========================================================
`);
    });
  }

  stop() {
    if (this.server) this.server.close();
    if (this.ws) this.ws.close();
    this.sessions.clear();
  }
}

// Standalone execution if run directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('client.js')) {
  const client = new FoxyVpnClient();
  client.start();
}
