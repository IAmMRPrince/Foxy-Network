// ==============================================================================
// Foxy Network - Controller (control plane)
//
// Who may call what:
//   * Public (no auth, read-only):  node list, leaderboard, premium overview.
//   * Donor nodes (Bearer node token): heartbeat, claim, subdomain tokens,
//     link codes, job results.
//   * Operator (X-Foxy-Admin-Key):  deployments, simulated subscriptions.
//   * Partner / Foxy Finance (HMAC-signed requests): /api/partner/v1/*
// ==============================================================================

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import {
  issueSubdomainToken,
  issueNodeToken,
  verifyNodeToken,
  verifyRequestSignature,
  loadOrCreateSecret,
  safeEqual
} from '../../foxy-security/src/index.js';
import { JOB_TYPES } from '../../foxy-jobs/src/index.js';
import { FoxyLedger, TOKENOMICS_CONFIG } from './ledger.js';
import { PremiumEngine } from './premium-tiers.js';
import { FinanceBridge, BENEFIT_MATRIX, DEVICE_CLASSES, ELIGIBILITY, effectiveDeviceClass } from './finance-bridge.js';
import { StateStore } from './state-store.js';

const MAX_BODY_BYTES = 1024 * 1024;
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NODE_TIMEOUT_MS = 20000;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cleanText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, max);
}

function cleanSpecs(specs = {}) {
  const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Number(v))) : 0);
  return {
    cores: num(specs.cores, 1024),
    totalRamMb: num(specs.totalRamMb, 16 * 1024 * 1024),
    platform: cleanText(specs.platform, 20),
    arch: cleanText(specs.arch, 20),
    runtime: cleanText(typeof specs.runtime === 'object' ? specs.runtime?.type : specs.runtime, 30)
  };
}

/**
 * Builds a controller. Everything it needs is passed in, so tests can run one
 * on a random port with its own state.
 */
export function createController(options = {}) {
  const port = options.port ?? parseInt(process.env.FOXY_CONTROLLER_PORT || '4000', 10);
  const host = options.host ?? process.env.FOXY_CONTROLLER_HOST ?? '0.0.0.0';
  const networkSecret = options.networkSecret || null; // null -> foxy-security default
  const adminKey = options.adminKey || loadOrCreateSecret('admin-key', { envVar: 'FOXY_ADMIN_KEY' });
  const partnerKeyId = options.partnerKeyId || process.env.FOXY_FINANCE_KEY_ID || 'foxy-finance';
  const partnerSecret = options.partnerSecret || loadOrCreateSecret('finance-api-secret', { envVar: 'FOXY_FINANCE_API_SECRET' });
  const corsOrigin = options.corsOrigin ?? process.env.FOXY_CORS_ORIGIN ?? '*';

  const store = options.store || new StateStore('controller-state.json', { enabled: options.persist !== false });
  const saved = store.load();
  const markDirty = () => store.markDirty();

  // Live registry (rebuilt from heartbeats) + persisted ledger / links / owners
  const nodes = new Map();
  const deployments = new Map();
  const subdomainOwners = new Map(Object.entries(saved.subdomainOwners || {})); // subdomain -> nodeId
  const ledger = new FoxyLedger({
    oracleWallet: options.oracleWallet || null,
    snapshot: saved.ledger || null,
    onChange: markDirty,
    autoSettle: options.autoSettle !== false
  });
  const premiumEngine = new PremiumEngine();
  const bridge = new FinanceBridge({
    nodes,
    ledger,
    snapshot: saved.bridge || null,
    onChange: markDirty,
    onJobSettled: (job) => {
      if (job.status !== 'COMPLETED') return;
      const paidNodes = job.attempts.filter(a => a.paidComputeUnits).length;
      premiumEngine.recordFoxyFinanceCompute({
        jobId: job.id,
        workloadName: job.type,
        computeUnits: job.computeUnits * paidNodes,
        billingUsd: job.billingUsd,
        timestamp: new Date().toISOString()
      });
      premiumEngine.updateTokenValuation(ledger.networkTotalMinted);
      console.log(`[Foxy Finance 📈] Trabajo ${job.id} (${job.type}) completado por ${paidNodes} nodo(s)`);
    }
  });

  store.register('ledger', () => ledger.serialize());
  store.register('bridge', () => bridge.serialize());
  store.register('subdomainOwners', () => Object.fromEntries(subdomainOwners));
  store.startAutoFlush();

  const timers = [];

  // Marks nodes offline when heartbeats stop, and fails deployments over.
  timers.push(setInterval(() => {
    const now = Date.now();
    for (const [nodeId, node] of nodes.entries()) {
      if (now - node.lastHeartbeat > NODE_TIMEOUT_MS && node.status === 'ONLINE') {
        node.status = 'OFFLINE';
        console.log(`[Controller] ⚠️ Node ${nodeId} timed out (marked OFFLINE)`);
        rebalanceDeploymentsForFailedNode(nodeId);
      }
    }
  }, 5000));
  timers.push(setInterval(() => bridge.expireAttempts(), 10000));
  for (const t of timers) t.unref();

  function claimSubdomain(subdomain, nodeId) {
    const owner = subdomainOwners.get(subdomain);
    if (owner && owner !== nodeId) return false;
    if (!owner) {
      subdomainOwners.set(subdomain, nodeId);
      markDirty();
    }
    return true;
  }

  function assignDeployment(dep, node) {
    dep.assignedNodeId = node.id;
    dep.authToken = issueSubdomainToken({ nodeId: node.id, subdomain: dep.subdomain, secret: networkSecret });
    // Deployment subdomains follow the deployment from node to node.
    subdomainOwners.set(dep.subdomain, node.id);
    markDirty();
  }

  function rebalanceDeploymentsForFailedNode(failedNodeId) {
    for (const dep of deployments.values()) {
      if (dep.assignedNodeId !== failedNodeId) continue;
      const availableNode = Array.from(nodes.values()).find(n => n.status === 'ONLINE' && n.id !== failedNodeId);
      if (availableNode) {
        assignDeployment(dep, availableNode);
        dep.status = 'REASSIGNED';
        console.log(`[Controller] ✅ Deployment [${dep.subdomain}] re-assigned to node ${availableNode.id}`);
      } else {
        dep.status = 'PENDING_NODE';
        dep.assignedNodeId = null;
        console.log(`[Controller] ⏳ No online nodes available to host [${dep.subdomain}]`);
      }
    }
  }

  /** What anyone may see about a node: never tokens. */
  function publicNode(node) {
    return {
      id: node.id,
      name: node.name,
      status: node.status,
      specs: node.specs,
      quota: node.quota,
      deviceClass: effectiveDeviceClass(node.deviceClass, node.specs),
      registeredAt: node.registeredAt,
      lastHeartbeat: node.lastHeartbeat,
      telemetry: node.telemetry
    };
  }

  const server = http.createServer((req, res) => {
    // CORS: authentication is by header (never cookies), so a wildcard origin
    // only exposes what is already public.
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Foxy-Admin-Key, X-Foxy-Key-Id, X-Foxy-Timestamp, X-Foxy-Signature');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://controller.local');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const pathname = url.pathname;

    const sendJson = (statusCode, data) => {
      if (res.headersSent) return;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    };

    /** Reads the raw body (size-limited) and parses it as JSON. */
    const readBody = () => new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('Payload too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', reject);
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          const data = raw ? JSON.parse(raw) : {};
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
          resolve({ raw, data });
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
        }
      });
    });

    const bearer = () => {
      const header = req.headers.authorization || '';
      return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    };

    /** Returns the authenticated node id, or answers 401 and returns null. */
    const requireNode = (claimedNodeId) => {
      const check = verifyNodeToken(bearer(), claimedNodeId || null, networkSecret);
      if (!check.valid) {
        sendJson(401, { error: `Node authentication failed: ${check.error}` });
        return null;
      }
      return check.payload.sub;
    };

    const requireAdmin = () => {
      const provided = req.headers['x-foxy-admin-key'];
      if (!provided || !safeEqual(provided, adminKey)) {
        sendJson(401, { error: 'Admin key required (X-Foxy-Admin-Key)' });
        return false;
      }
      return true;
    };

    const requirePartner = (rawBody) => {
      const check = verifyRequestSignature({
        headers: req.headers,
        secret: partnerSecret,
        expectedKeyId: partnerKeyId,
        method: req.method,
        path: url.pathname + url.search,
        body: rawBody
      });
      if (!check.valid) {
        sendJson(401, { error: `Partner authentication failed: ${check.error}` });
        return false;
      }
      return true;
    };

    const handle = (fn) => {
      Promise.resolve().then(fn).catch((err) => {
        if (!err.status) console.error(`[Controller] ${req.method} ${pathname}: ${err.message}`);
        sendJson(err.status || 500, { error: err.status ? err.message : 'Internal error' });
      });
    };

    // =====================================================================
    // Donor node API
    // =====================================================================

    // 1. Node registration. A new node id gets an identity token; an id that
    //    already exists can only be re-registered by presenting its token.
    if (req.method === 'POST' && pathname === '/api/nodes/register') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = data.nodeId ? String(data.nodeId) : `node-${randomUUID().slice(0, 8)}`;
        if (!NODE_ID_RE.test(nodeId)) return sendJson(400, { error: 'Invalid nodeId (a-z, 0-9, "-", 3-64 chars)' });

        const known = nodes.has(nodeId) || ledger.hasAccount(nodeId);
        if (known && !verifyNodeToken(bearer(), nodeId, networkSecret).valid) {
          return sendJson(401, { error: 'nodeId already registered: present its node token to re-register' });
        }

        const requestedSub = String(data.subdomain || '').toLowerCase();
        let primarySubdomain = SUBDOMAIN_RE.test(requestedSub) ? requestedSub : `node-${nodeId.slice(-12)}`.replace(/-+/g, '-');
        if (!claimSubdomain(primarySubdomain, nodeId)) {
          // Requested name is taken by another node: fall back to a unique one.
          primarySubdomain = `n-${nodeId}`.slice(0, 63);
          claimSubdomain(primarySubdomain, nodeId);
        }

        const nodeRecord = {
          id: nodeId,
          name: cleanText(data.name) || `Donor Node ${nodeId.slice(-4)}`,
          specs: cleanSpecs(data.specs),
          quota: {
            maxCpuCores: Number(data.quota?.maxCpuCores) || 2,
            maxRamMb: Number(data.quota?.maxRamMb) || 2048,
            maxStorageGb: Number(data.quota?.maxStorageGb) || 10
          },
          deviceClass: DEVICE_CLASSES.includes(data.deviceClass) ? data.deviceClass : 'PC',
          acceptsJobs: data.acceptsJobs !== false,
          status: 'ONLINE',
          registeredAt: new Date().toISOString(),
          lastHeartbeat: Date.now(),
          telemetry: {},
          walletAddress: null
        };
        nodes.set(nodeId, nodeRecord);
        ledger.getAccount(nodeId, data.walletAddress);

        console.log(`[Controller Security 🛡️] 🔑 Registered donor node [${nodeId}] (subdomain: ${primarySubdomain})`);
        sendJson(200, {
          success: true,
          node: publicNode(nodeRecord),
          nodeToken: issueNodeToken({ nodeId, secret: networkSecret }),
          subdomain: primarySubdomain,
          authToken: issueSubdomainToken({ nodeId, subdomain: primarySubdomain, secret: networkSecret })
        });
      });
    }

    // 2. Subdomain capability token: only for a subdomain this node owns (or
    //    that nobody owns yet).
    if (req.method === 'POST' && pathname === '/api/auth/token') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        const cleanSub = String(data.subdomain || '').toLowerCase();
        if (!SUBDOMAIN_RE.test(cleanSub)) return sendJson(400, { error: 'Invalid subdomain' });
        if (!claimSubdomain(cleanSub, nodeId)) {
          return sendJson(409, { error: `Subdomain '${cleanSub}' belongs to another node` });
        }
        sendJson(200, {
          success: true,
          subdomain: cleanSub,
          token: issueSubdomainToken({ nodeId, subdomain: cleanSub, secret: networkSecret })
        });
      });
    }

    // 3. Node heartbeat
    if (req.method === 'POST' && pathname === '/api/nodes/heartbeat') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        const node = nodes.get(nodeId);
        if (!node) return sendJson(404, { error: 'Node not registered' });

        const { telemetry } = data;
        const now = Date.now();
        // Uptime is measured by the controller's own clock, never reported.
        const deltaSecs = Math.max(1, Math.min(10, Math.round((now - node.lastHeartbeat) / 1000)));
        const counter = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
        const currentBytes = counter(telemetry?.bytesServed);
        const currentVpnBytes = counter(telemetry?.vpnBytesServed);
        const deltaBytes = Math.max(0, currentBytes - counter(node.telemetry?.bytesServed));
        const deltaVpnBytes = Math.max(0, currentVpnBytes - counter(node.telemetry?.vpnBytesServed));

        const wallet = data.walletAddress && ethers.isAddress(data.walletAddress) ? data.walletAddress : null;
        ledger.recordActivity(nodeId, {
          uptimeDeltaSeconds: deltaSecs,
          bytesDelta: deltaBytes,
          vpnBytesDelta: deltaVpnBytes,
          specs: node.specs,
          walletAddress: wallet
        });

        node.status = 'ONLINE';
        node.lastHeartbeat = now;
        if (wallet) node.walletAddress = wallet;
        node.telemetry = {
          cpuUsagePercent: Math.min(100, counter(telemetry?.cpuUsagePercent)),
          ramUsedMb: counter(telemetry?.ramUsedMb),
          requestsHandled: counter(telemetry?.requestsHandled),
          bytesServed: currentBytes,
          vpnBytesServed: currentVpnBytes
        };

        const running = new Set(
          (Array.isArray(data.activeWorkloads) ? data.activeWorkloads : [])
            .filter(w => w && w.status === 'RUNNING')
            .map(w => String(w.id))
        );

        // Each deployment is sent to its node once; it is re-sent only after a
        // reassignment, or if the node stops reporting it as running.
        const commands = [];
        for (const dep of deployments.values()) {
          if (!dep.assignedNodeId && dep.status === 'PENDING_NODE') {
            assignDeployment(dep, node);
            dep.status = 'ASSIGNED';
          }
          if (dep.assignedNodeId !== nodeId) continue;
          if (running.has(dep.id)) {
            dep.status = 'RUNNING';
            continue;
          }
          const waited = now - (dep.dispatchedAt || 0);
          if (dep.status !== 'DISPATCHED' || waited > 30000) {
            dep.status = 'DISPATCHED';
            dep.dispatchedAt = now;
            commands.push({
              type: 'DEPLOY_WORKLOAD',
              deploymentId: dep.id,
              subdomain: dep.subdomain,
              authToken: dep.authToken,
              config: dep.config
            });
          }
        }
        if (node.acceptsJobs !== false) commands.push(...bridge.takeJobsForNode(nodeId));

        const account = ledger.getAccount(nodeId);
        const usdValue = premiumEngine.calculateResourceUsdValue({
          uptimeSeconds: (account.epochsSettled * 30) + (account.pendingUptimeSeconds || 30),
          bytesServed: node.telemetry.bytesServed,
          vpnBytesServed: node.telemetry.vpnBytesServed,
          specs: node.specs
        });
        const link = bridge.getLink(nodeId);

        sendJson(200, {
          status: 'ACK',
          epoch: ledger.currentEpoch,
          rewards: {
            balance: account.balance,
            lifetimeEarnings: account.lifetimeEarnings,
            lifetimeComputeUnits: account.lifetimeComputeUnits,
            tier: account.tier,
            epochsSettled: account.epochsSettled,
            resourceValuationUsd: usdValue.totalUsd,
            tokenFloorPriceUsd: premiumEngine.treasury.foxyTokenFloorPriceUsd,
            treasuryBackingPoolUsd: premiumEngine.treasury.donorBackingPoolUsd,
            treasurySimulated: true,
            recentPayouts: account.recentPayouts.slice(0, 3)
          },
          foxyFinance: {
            linked: !!link,
            linkedAt: link?.linkedAt || null,
            deviceClass: effectiveDeviceClass(node.deviceClass, node.specs),
            uptimeRatio24h: Number(ledger.getUptimeRatio(nodeId, 24).toFixed(4))
          },
          pendingCommands: commands
        });
      });
    }

    // 4. One-time code to link this node to a Foxy Finance account
    if (req.method === 'POST' && pathname === '/api/nodes/link-code') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        sendJson(200, { success: true, ...bridge.createLinkCode(nodeId) });
      });
    }

    // 5. The donor can always break the link from their side
    if (req.method === 'POST' && pathname === '/api/nodes/unlink') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        sendJson(200, { success: true, unlinked: bridge.unlink(nodeId) });
      });
    }

    // 5b. Pay a Foxy Finance plan by burning the node's unclaimed $FOXY
    if (req.method === 'POST' && pathname === '/api/nodes/pay-with-foxy') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        const outcome = bridge.payPlanWithFoxy(nodeId, String(data.planId || ''));
        if (!outcome.ok) return sendJson(outcome.status, { error: outcome.error });
        console.log(`[Foxy Finance 🔥] ${outcome.payment.amountFoxy} $FOXY quemados por ${nodeId} para el plan ${outcome.payment.planId}`);
        sendJson(200, { success: true, payment: outcome.payment, balance: outcome.balance });
      });
    }

    // 6. Result of a compute job
    if (req.method === 'POST' && pathname === '/api/nodes/jobs/result') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        const outcome = bridge.submitResult(nodeId, String(data.jobId || ''), {
          result: data.result ?? null,
          error: data.error ?? null,
          durationMs: data.durationMs
        });
        if (!outcome.ok) return sendJson(outcome.status, { error: outcome.error });
        sendJson(200, { success: true, jobStatus: outcome.jobStatus });
      });
    }

    // 7. Claim rewards: only the node itself, to a valid EVM address
    if (req.method === 'POST' && pathname === '/api/ledger/claim') {
      return handle(async () => {
        const { data } = await readBody();
        const nodeId = requireNode(data.nodeId);
        if (!nodeId) return;
        if (data.walletAddress && !ethers.isAddress(data.walletAddress)) {
          return sendJson(400, { error: 'Invalid EVM wallet address' });
        }
        const result = await ledger.claimRewards(nodeId, data.walletAddress || null);
        if (!result.success) return sendJson(400, { error: result.error });
        console.log(`[Tokenomics 💰] Voucher (${result.receipt.settlement}) for node ${nodeId}: ${result.amount} $FOXY -> ${result.receipt.to}`);
        sendJson(200, result);
      });
    }

    // =====================================================================
    // Public read-only API
    // =====================================================================

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(200, { status: 'ok', epoch: ledger.currentEpoch, onlineNodes: bridge.onlineNodeIds().length });
    }

    if (req.method === 'GET' && pathname === '/api/nodes') {
      const list = Array.from(nodes.values());
      return sendJson(200, {
        count: list.length,
        onlineCount: list.filter(n => n.status === 'ONLINE').length,
        nodes: list.map(publicNode)
      });
    }

    if (req.method === 'GET' && pathname === '/api/deployments') {
      return sendJson(200, {
        count: deployments.size,
        deployments: Array.from(deployments.values()).map(({ authToken, ...rest }) => rest)
      });
    }

    if (req.method === 'GET' && pathname === '/api/ledger/leaderboard') {
      return sendJson(200, {
        symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
        currentEpoch: ledger.currentEpoch,
        networkTotalMinted: ledger.networkTotalMinted,
        networkTotalBurned: ledger.networkTotalBurned,
        config: TOKENOMICS_CONFIG,
        leaderboard: ledger.getLeaderboard()
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/ledger/account/')) {
      const targetNodeId = decodeURIComponent(pathname.slice('/api/ledger/account/'.length));
      const account = ledger.accounts.get(targetNodeId);
      if (!account) return sendJson(404, { error: 'Unknown node' });
      const { uptimeByHour, ...publicAccount } = account;
      return sendJson(200, {
        symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
        currentEpoch: ledger.currentEpoch,
        account: publicAccount
      });
    }

    if (req.method === 'GET' && pathname === '/api/vpn/nodes') {
      const onlineNodes = Array.from(nodes.values())
        .filter(n => n.status === 'ONLINE')
        .map(n => ({ nodeId: n.id, name: n.name, specs: n.specs, status: n.status, lastHeartbeat: n.lastHeartbeat }));
      return sendJson(200, { count: onlineNodes.length, nodes: onlineNodes });
    }

    if (req.method === 'GET' && pathname === '/api/premium/overview') {
      premiumEngine.updateTokenValuation(ledger.networkTotalMinted);
      return sendJson(200, premiumEngine.getTreasuryOverview());
    }

    if (req.method === 'GET' && pathname === '/api/foxy-finance/telemetry') {
      return sendJson(200, {
        ecosystem: 'Foxy Finance',
        network: bridge.getStats(),
        totalComputeUnitsProcessed: ledger.totalComputeUnitsProcessed,
        networkTotalBurned: ledger.networkTotalBurned,
        recentWorkloads: premiumEngine.foxyFinanceWorkloads,
        treasuryBacking: premiumEngine.treasury
      });
    }

    // =====================================================================
    // Operator API (admin key)
    // =====================================================================

    if (req.method === 'POST' && pathname === '/api/deployments') {
      return handle(async () => {
        const { data } = await readBody();
        if (!requireAdmin()) return;
        const cleanSub = String(data.subdomain || '').toLowerCase();
        if (!SUBDOMAIN_RE.test(cleanSub)) return sendJson(400, { error: 'Invalid subdomain' });

        const owner = subdomainOwners.get(cleanSub);
        const isDeploymentSub = Array.from(deployments.values()).some(d => d.subdomain === cleanSub);
        if (isDeploymentSub) return sendJson(409, { error: `Subdomain '${cleanSub}' already has a deployment` });
        if (owner) return sendJson(409, { error: `Subdomain '${cleanSub}' is already in use by a node` });

        const type = ['static', 'docker', 'node', 'python'].includes(data.config?.type) ? data.config.type : 'static';
        const deploymentRecord = {
          id: `dep-${randomUUID().slice(0, 8)}`,
          appName: cleanText(data.appName) || cleanSub,
          subdomain: cleanSub,
          assignedNodeId: null,
          authToken: null,
          status: 'PENDING_NODE',
          config: {
            type,
            appName: cleanText(data.appName) || cleanSub,
            image: type === 'docker' ? String(data.config?.image || '') : undefined
          },
          createdAt: new Date().toISOString()
        };

        const assignedNode = Array.from(nodes.values()).find(n => n.status === 'ONLINE') || null;
        if (assignedNode) {
          assignDeployment(deploymentRecord, assignedNode);
          deploymentRecord.status = 'ASSIGNED';
        }

        deployments.set(deploymentRecord.id, deploymentRecord);
        console.log(`[Controller Security 🛡️] 🚀 Deployment created: [${cleanSub}] -> Node: ${assignedNode?.id || 'Queued'}`);
        const { authToken, ...publicDeployment } = deploymentRecord;
        sendJson(201, { success: true, deployment: publicDeployment });
      });
    }

    // Simulated subscription (accounting model only: no payment is processed).
    if (req.method === 'POST' && pathname === '/api/premium/subscribe') {
      return handle(async () => {
        const { data } = await readBody();
        if (!requireAdmin()) return;
        if (!data.planId) return sendJson(400, { error: 'planId is required' });
        try {
          const subRecord = premiumEngine.subscribePlan(
            String(data.planId),
            cleanText(data.subscriberAddress, 64) || 'anonymous',
            data.paymentMethod === 'FOXY' ? 'FOXY' : 'USD'
          );
          premiumEngine.updateTokenValuation(ledger.networkTotalMinted);
          sendJson(201, { success: true, simulated: true, subscription: subRecord, treasury: premiumEngine.treasury });
        } catch (e) {
          sendJson(400, { error: e.message });
        }
      });
    }

    // =====================================================================
    // Partner API v1 (Foxy Finance) — every request is HMAC-signed
    // =====================================================================

    if (pathname.startsWith('/api/partner/v1/') || pathname === '/api/foxy-finance/dispatch') {
      return handle(async () => {
        const { raw, data } = req.method === 'POST' ? await readBody() : { raw: '', data: {} };
        if (!requirePartner(raw)) return;
        const route = pathname.replace('/api/partner/v1', '');

        if (req.method === 'GET' && route === '/network') {
          return sendJson(200, {
            ...bridge.getStats(),
            jobTypes: Object.keys(JOB_TYPES),
            benefitMatrix: BENEFIT_MATRIX,
            eligibility: ELIGIBILITY
          });
        }

        // Link a donor node to a partner user with the code the donor generated
        if (req.method === 'POST' && route === '/links/redeem') {
          const outcome = bridge.redeemLinkCode(data.code, data.userId);
          if (!outcome.ok) return sendJson(outcome.status, { error: outcome.error });
          return sendJson(200, { success: true, ...outcome, node: bridge.describeNode(outcome.nodeId) });
        }

        if (req.method === 'POST' && route === '/links/revoke') {
          const removed = bridge.unlink(String(data.nodeId || ''), String(data.userId || ''));
          return sendJson(removed ? 200 : 404, removed ? { success: true } : { error: 'Link not found for that user' });
        }

        const benefitsMatch = route.match(/^\/users\/([^/]+)\/benefits$/);
        if (req.method === 'GET' && benefitsMatch) {
          return sendJson(200, bridge.getUserBenefits(decodeURIComponent(benefitsMatch[1])));
        }

        const paymentsMatch = route.match(/^\/users\/([^/]+)\/payments$/);
        if (req.method === 'GET' && paymentsMatch) {
          const userId = decodeURIComponent(paymentsMatch[1]);
          return sendJson(200, { userId, payments: bridge.getUserPayments(userId) });
        }

        // Submit a compute job (legacy path kept for the bundled workload)
        if (req.method === 'POST' && (route === '/jobs' || pathname === '/api/foxy-finance/dispatch')) {
          let submitted;
          try {
            submitted = bridge.submitJob({
              type: data.type,
              params: data.params,
              replicas: data.replicas ?? 1,
              externalRef: data.externalRef,
              idempotencyKey: data.idempotencyKey,
              billingUsd: data.billingUsd
            });
          } catch (e) {
            return sendJson(400, { error: e.message });
          }
          return sendJson(submitted.created ? 202 : 200, {
            success: true,
            created: submitted.created,
            job: bridge.describeJob(submitted.job),
            onlineNodes: bridge.onlineNodeIds().length
          });
        }

        const jobMatch = route.match(/^\/jobs\/([A-Za-z0-9-]+)$/);
        if (req.method === 'GET' && jobMatch) {
          const job = bridge.getJob(jobMatch[1]);
          if (!job) return sendJson(404, { error: 'Job not found' });
          return sendJson(200, { job: bridge.describeJob(job) });
        }

        sendJson(404, { error: 'Not Found' });
      });
    }

    // Controller dashboard
    if (req.method === 'GET' && pathname === '/') {
      serveControllerDashboard(res, { port, nodes, deployments });
      return;
    }

    sendJson(404, { error: 'Not Found' });
  });

  return {
    server,
    nodes,
    deployments,
    ledger,
    bridge,
    premiumEngine,
    store,
    partner: { keyId: partnerKeyId, secret: partnerSecret },
    adminKey,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      for (const t of timers) clearInterval(t);
      clearInterval(ledger.epochTimer);
      try { store.flush(); } catch (err) { console.error(`[Controller] ${err.message}`); }
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function serveControllerDashboard(res, { port, nodes, deployments }) {
  const CONTROLLER_PORT = port;
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
              <td><code>${escapeHtml(n.id)}</code></td>
              <td><strong>${escapeHtml(n.name)}</strong></td>
              <td><span class="badge ${n.status === 'ONLINE' ? 'badge-online' : 'badge-offline'}">${escapeHtml(n.status)}</span></td>
              <td>${escapeHtml(n.quota?.maxCpuCores || 2)} núcleos</td>
              <td>${escapeHtml(((Number(n.quota?.maxRamMb) || 2048) / 1024).toFixed(1))} GB</td>
              <td>${n.telemetry?.cpuUsagePercent ? escapeHtml(n.telemetry.cpuUsagePercent) + '%' : '—'}</td>
              <td>${n.telemetry?.ramUsedMb ? escapeHtml(n.telemetry.ramUsedMb) + ' MB' : '—'}</td>
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
              <td><code>${escapeHtml(d.id)}</code></td>
              <td><strong>${escapeHtml(d.appName)}</strong></td>
              <td><code>${escapeHtml(d.subdomain)}</code></td>
              <td><code>${escapeHtml(d.assignedNodeId || 'En cola')}</code></td>
              <td><span class="badge badge-online">${escapeHtml(d.status)}</span></td>
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

// Start the controller when this file is run directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = createController();
  const port = await controller.listen();
  console.log(`[Foxy Controller] Control Plane listening on http://localhost:${port}`);
  console.log(`[Foxy Controller] Partner API (Foxy Finance): key id '${controller.partner.keyId}', secret in .foxy/finance-api-secret or FOXY_FINANCE_API_SECRET`);

  const shutdown = async () => {
    await controller.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
