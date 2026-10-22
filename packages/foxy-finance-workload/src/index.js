// ==============================================================================
// Foxy Finance - Automated Institutional Compute Worker
// Simulates continuous DeFi compute demand routed into Foxy Network DePIN
// ==============================================================================

import { FoxyFinanceEngine } from './finance-engine.js';

const CONTROLLER_URL = process.env.FOXY_CONTROLLER_URL || 'http://localhost:4000';
const engine = new FoxyFinanceEngine(CONTROLLER_URL);

console.log(`
📈 ========================================================
          FOXY FINANCE — INSTITUTIONAL CLOUD WORKLOAD
   Anchor Tenant & Compute Demand Generator for $FOXY
========================================================
  Orquestador DePIN: ${CONTROLLER_URL}
  Tipo de Cargas:   Arbitraje DeFi, Índices de Liquidez, Monte Carlo
  Respaldo:         Inyección de capital por consumo de cómputo
========================================================
`);

async function runPeriodicJobs() {
  const types = ['ARBITRAGE', 'RISK'];
  const chosenType = types[Math.floor(Math.random() * types.length)];
  await engine.dispatchJobToCluster(chosenType);
}

// Initial job dispatch
runPeriodicJobs();

// Periodic dispatch every 25 seconds
setInterval(runPeriodicJobs, 25000);
