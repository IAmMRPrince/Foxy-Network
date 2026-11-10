import assert from 'node:assert/strict';
import {
  issueFoxyFinanceBenefitToken,
  verifyFoxyFinanceBenefitToken
} from '../packages/foxy-security/src/index.js';
import { FoxyLedger, TOKENOMICS_CONFIG } from '../packages/foxy-controller/src/ledger.js';
import { PremiumEngine, PREMIUM_PLANS } from '../packages/foxy-controller/src/premium-tiers.js';
import { executeSovereignQuantTask } from '../packages/foxy-daemon/src/workload-engine.js';

console.log('🧪 Iniciando suite de pruebas del enlace FOXY FINANCE <-> FOXY NETWORK ($FOXY)...\n');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✅ [PASS] ${name}`);
    });
}

await test('1. Certificados Anti-IDOR (issueFoxyFinanceBenefitToken & verifyFoxyFinanceBenefitToken)', () => {
  const token = issueFoxyFinanceBenefitToken({
    userId: 'user-dalton-001',
    nodeId: 'node-vps-99',
    walletAddress: '0x1111111111111111111111111111111111111111',
    hardwareClass: 'VPS_BAREMETAL',
    discountPercent: 100,
    freeProQuant: true
  });

  const validCheck = verifyFoxyFinanceBenefitToken(token, 'user-dalton-001');
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.payload.discountPercent, 100);
  assert.equal(validCheck.payload.freeProQuant, true);

  // Anti-IDOR check: Another tenant trying to use Dalton's token must be rejected
  const idorAttack = verifyFoxyFinanceBenefitToken(token, 'attacker-user-666');
  assert.equal(idorAttack.valid, false);
  assert.match(idorAttack.error, /Anti-IDOR Violation/);
});

await test('2. Matriz de 5 niveles de hardware para descuentos en FOXY FINANCE', () => {
  const ledger = new FoxyLedger();
  clearInterval(ledger.epochTimer);

  assert.equal(ledger.classifyHardwareForFoxyFinance({ deviceType: 'ESP32_IOT' }).discountPercent, 15);
  assert.equal(ledger.classifyHardwareForFoxyFinance({ platform: 'android', cores: 4, totalRamMb: 4096 }).discountPercent, 25);
  assert.equal(ledger.classifyHardwareForFoxyFinance({ platform: 'linux', arch: 'arm64', cores: 4, totalRamMb: 4096 }).discountPercent, 50);
  assert.equal(ledger.classifyHardwareForFoxyFinance({ platform: 'win32', cores: 4, totalRamMb: 8192 }).discountPercent, 70);

  const vps = ledger.classifyHardwareForFoxyFinance({ platform: 'linux', cores: 16, totalRamMb: 32768 });
  assert.equal(vps.hardwareClass, 'VPS_BAREMETAL');
  assert.equal(vps.discountPercent, 100);
  assert.equal(vps.freeProQuant, true);
});

await test('3. Recompensas por Cómputo Cuantitativo (FCC) + Quema Deflacionaria + Anti-IDOR en FoxyLedger', async () => {
  const ledger = new FoxyLedger();
  clearInterval(ledger.epochTimer);

  ledger.recordActivity('node-quant-1', {
    uptimeDeltaSeconds: 60,
    bytesDelta: 2 * 1024 * 1024,
    vpnBytesDelta: 1 * 1024 * 1024,
    computeUnitsDelta: 6, // 6 FCC units from Monte Carlo 30k paths
    specs: { cores: 8, totalRamMb: 16384 },
    walletAddress: '0x2222222222222222222222222222222222222222'
  });

  ledger.settleEpoch();
  const acc = ledger.getAccount('node-quant-1');
  assert.equal(acc.tier, 'ULTRA_COMPUTE');
  assert.equal(acc.lifetimeComputeUnits, 6);
  assert.ok(acc.balance > 40, `Expected balance > 40 $FOXY, got ${acc.balance}`);

  // Bind tenant user and verify Anti-IDOR protection
  const binding = ledger.bindTenantUser('node-quant-1', 'tenant-alpha', acc.walletAddress, { cores: 8, totalRamMb: 16384 });
  assert.equal(binding.discountPercent, 100);
  assert.throws(
    () => ledger.bindTenantUser('node-quant-1', 'tenant-hijacker', '0x3333333333333333333333333333333333333333'),
    /Anti-IDOR Violation/
  );

  // Burn $FOXY tokens to pay service
  const burnRes = await ledger.burnTokensForService('node-quant-1', 15.5, 'FOXY_FINANCE_TRADER_PRO');
  assert.equal(burnRes.success, true);
  assert.equal(burnRes.burnedAmount, 15.5);
  assert.equal(ledger.networkTotalBurned, 15.5);
});

await test('4. Motor de Tesorería (40% Fundador / 45% Respaldo / 15% Quema) y Planes Trader Pro & Institutional Desk', () => {
  const engine = new PremiumEngine();
  assert.equal(PREMIUM_PLANS.FOXY_FINANCE_TRADER_PRO.priceUsd, 49.00);
  assert.equal(PREMIUM_PLANS.FOXY_FINANCE_TRADER_PRO.priceFoxy, 325.00);
  assert.equal(PREMIUM_PLANS.FOXY_FINANCE_INSTITUTIONAL_DESK.priceUsd, 199.00);

  const initialFounder = engine.treasury.founderProfitUsd;
  const initialReserve = engine.treasury.donorBackingPoolUsd;
  const initialBurn = engine.treasury.totalBurnedUsd;

  const job = engine.recordFoxyFinanceCompute({
    workloadName: 'Monte Carlo VaR 99%',
    computeUnits: 10,
    billingUsd: 2.00
  });

  assert.equal(job.founderShareUsd, 0.80);   // 40% of $2.00
  assert.equal(job.donorReserveUsd, 0.90);   // 45% of $2.00
  assert.equal(job.burnedUsd, 0.30);         // 15% of $2.00
  assert.equal(parseFloat((engine.treasury.founderProfitUsd - initialFounder).toFixed(2)), 0.80);
  assert.equal(parseFloat((engine.treasury.donorBackingPoolUsd - initialReserve).toFixed(2)), 0.90);
  assert.equal(parseFloat((engine.treasury.totalBurnedUsd - initialBurn).toFixed(2)), 0.30);
});

await test('5. Caja Negra Soberana: Consenso Determinista Monte Carlo VaR/CVaR 99% y Arbitraje (epsilon < 1e-6)', () => {
  const runNodeA = executeSovereignQuantTask({
    type: 'MONTE_CARLO_VAR',
    seed: 777888,
    parameters: { initialPrice: 68000, annualDrift: 0.08, annualVol: 0.45, days: 30, paths: 25000 }
  });
  const runNodeB = executeSovereignQuantTask({
    type: 'MONTE_CARLO_VAR',
    seed: 777888,
    parameters: { initialPrice: 68000, annualDrift: 0.08, annualVol: 0.45, days: 30, paths: 25000 }
  });

  assert.equal(runNodeA.resultHash, runNodeB.resultHash);
  assert.ok(Math.abs(runNodeA.var99 - runNodeB.var99) < 1e-6);
  assert.ok(Math.abs(runNodeA.cvar99 - runNodeB.cvar99) < 1e-6);
  assert.ok(runNodeA.cvar99 >= runNodeA.var99 && runNodeA.var99 >= runNodeA.var95);

  const arbA = executeSovereignQuantTask({ type: 'DEX_ARBITRAGE_SWEEP', seed: 991122 });
  const arbB = executeSovereignQuantTask({ type: 'DEX_ARBITRAGE_SWEEP', seed: 991122 });
  assert.equal(arbA.resultHash, arbB.resultHash);
});

await test('6. Integración E2E en vivo (Controller + Gateway + Daemon + SSL .fox + Túnel Inverso 200 OK)', async () => {
  const { ensureFoxSslCredentials, resolveFoxDomain } = await import('../packages/foxy-gateway/src/domains.js');
  const creds = ensureFoxSslCredentials();
  assert.ok(creds.cert.includes('BEGIN CERTIFICATE'));
  assert.equal(resolveFoxDomain('www.foxyfinance.fox').target, 'foxy-finance');
  assert.equal(resolveFoxDomain('www.foxyfianance.fox').target, 'foxy-finance');

  const ctrlPort = 14000;
  const gwHttpPort = 18080;
  const gwHttpsPort = 18443;
  const gwTunnelPort = 18081;
  const daemonPort = 14040;

  process.env.FOXY_CONTROLLER_PORT = String(ctrlPort);
  process.env.FOXY_CONTROLLER_URL = `http://127.0.0.1:${ctrlPort}`;
  process.env.FOXY_GATEWAY_HTTP_PORT = String(gwHttpPort);
  process.env.FOXY_GATEWAY_HTTPS_PORT = String(gwHttpsPort);
  process.env.FOXY_GATEWAY_TUNNEL_PORT = String(gwTunnelPort);
  process.env.FOXY_GATEWAY_TUNNEL_URL = `ws://127.0.0.1:${gwTunnelPort}`;
  process.env.FOXY_GATEWAY_URL = `http://127.0.0.1:${gwHttpPort}`;
  process.env.FOXY_DAEMON_PORT = String(daemonPort);
  process.env.FOXY_BIND_STANDARD_PORTS = 'false';

  // Start Controller, Gateway, and Daemon in-process
  await import('../packages/foxy-controller/src/index.js');
  await import('../packages/foxy-gateway/src/index.js');
  await import('../packages/foxy-daemon/src/index.js');

  // Wait for daemon to register with controller and open tunnel on gateway
  let tunnelReady = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${gwHttpPort}/__foxy/status`);
      if (res.ok) {
        const st = await res.json();
        if (st.activeTunnelsCount >= 1) {
          tunnelReady = true;
          break;
        }
      }
    } catch {
      // Wait
    }
  }
  assert.equal(tunnelReady, true, 'El túnel inverso del Daemon debía conectarse al Gateway');

  // Verify 200 OK through reverse tunnel (no 503!)
  const tunnelHttpRes = await fetch(`http://127.0.0.1:${gwHttpPort}/t/foxy-demo-app/`);
  assert.equal(tunnelHttpRes.status, 200, `Expected 200 OK from reverse tunnel, got ${tunnelHttpRes.status}`);

  // Dispatch Foxy Finance Monte Carlo job via Controller
  const dispRes = await fetch(`http://127.0.0.1:${ctrlPort}/api/foxy-finance/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workloadType: 'RISK', seed: 123456 })
  });
  assert.equal(dispRes.status, 200);
  const dispData = await dispRes.json();
  assert.equal(dispData.success, true);
  assert.equal(dispData.consensusVerified, true);
  assert.ok(dispData.quantOutput.var99 > 0);

  // Get registered node ID
  const nodesRes = await fetch(`http://127.0.0.1:${ctrlPort}/api/nodes`);
  const nodesData = await nodesRes.json();
  assert.ok(nodesData.nodes.length >= 1);
  const nodeId = nodesData.nodes[0].id;

  // Link Foxy Finance account & verify benefit
  const linkRes = await fetch(`http://127.0.0.1:${ctrlPort}/api/foxy-finance/link-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId,
      tenantUserId: 'dalton-ceo',
      specs: { cores: 16, totalRamMb: 32768 }
    })
  });
  assert.equal(linkRes.status, 200);
  const linkData = await linkRes.json();
  assert.equal(linkData.binding.discountPercent, 100);
  assert.equal(linkData.binding.freeProQuant, true);

  // Anti-IDOR hijack attempt must return 403
  const hijackRes = await fetch(`http://127.0.0.1:${ctrlPort}/api/foxy-finance/link-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId,
      tenantUserId: 'intruder-999'
    })
  });
  assert.equal(hijackRes.status, 403);

  // Verify benefit endpoint for Foxy Finance backend
  const verifyRes = await fetch(`http://127.0.0.1:${ctrlPort}/api/foxy-finance/verify-benefit/dalton-ceo`);
  assert.equal(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.valid, true);
  assert.equal(verifyData.discountPercent, 100);
});

console.log(`\n🎉 Todas las ${passed} suites de pruebas pasaron exitosamente.`);
process.exit(0);
