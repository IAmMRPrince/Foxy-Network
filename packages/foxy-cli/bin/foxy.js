#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROLLER_URL = process.env.FOXY_CONTROLLER_URL || 'http://localhost:4000';
const GATEWAY_URL = process.env.FOXY_GATEWAY_URL || 'http://localhost:8080';
const DAEMON_URL = process.env.FOXY_DAEMON_URL || 'http://127.0.0.1:4040';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Reads a local secret created by a Foxy service on this machine. */
function readLocalSecret(name, envVar) {
  if (envVar && process.env[envVar]) return process.env[envVar].trim();
  const dirs = [process.env.FOXY_STATE_DIR, path.join(process.cwd(), '.foxy'), path.join(REPO_ROOT, '.foxy'),
    path.join(REPO_ROOT, 'packages', 'foxy-daemon', '.foxy')].filter(Boolean);
  for (const dir of dirs) {
    try {
      const value = fs.readFileSync(path.join(dir, name), 'utf-8').trim();
      if (value) return value;
    } catch {
      // try the next location
    }
  }
  return null;
}

/** Calls the donor daemon running on this machine. */
async function daemonPost(route, body = {}) {
  const token = readLocalSecret('daemon-token', 'FOXY_DAEMON_TOKEN');
  if (!token) throw new Error('No se encontró el token del daemon local. ¿Está en ejecución en este equipo?');
  const res = await fetch(`${DAEMON_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Foxy-Token': token },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command) {
    case 'status':
      await showStatus();
      break;
    case 'nodes':
      await listNodes();
      break;
    case 'deploy':
      await deployApp(args[1], args[2]);
      break;
    case 'leaderboard':
      await showLeaderboard();
      break;
    case 'balance':
      await showBalance(args[1]);
      break;
    case 'claim':
      await claimRewards(args[1]);
      break;
    case 'link':
      await linkFoxyFinance();
      break;
    case 'vpn':
      await handleVpnCommand(args.slice(1));
      break;
    case 'domains':
    case 'domain':
      await handleDomainsCommand(args.slice(1));
      break;
    case 'finance':
      await handleFinanceCommand(args.slice(1));
      break;
    case 'token':
      await showTokenInfo();
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
}

async function showStatus() {
  console.log('\n🦊 === FOXY NETWORK SYSTEM STATUS ===\n');

  try {
    const gwRes = await fetch(`${GATEWAY_URL}/__foxy/status`);
    const gwData = await gwRes.json();
    console.log(`[Ingress Gateway]   🟢 ONLINE (${GATEWAY_URL})`);
    console.log(`   Túneles activos:   ${gwData.activeTunnelsCount}`);
    if (gwData.tunnels?.length > 0) {
      gwData.tunnels.forEach(t => {
        console.log(`   - [${t.subdomain}] -> Nodo: ${t.nodeId} (${t.requestCount} requests, ${t.directUrl})`);
      });
    }
  } catch (e) {
    console.log(`[Ingress Gateway]   🔴 OFFLINE (${GATEWAY_URL})`);
  }

  try {
    const ctrlRes = await fetch(`${CONTROLLER_URL}/api/nodes`);
    const ctrlData = await ctrlRes.json();
    console.log(`\n[Control Plane]     🟢 ONLINE (${CONTROLLER_URL})`);
    console.log(`   Nodos donantes:    ${ctrlData.onlineCount} online / ${ctrlData.count} total`);
  } catch (e) {
    console.log(`\n[Control Plane]     🔴 OFFLINE (${CONTROLLER_URL})`);
  }
  console.log('');
}

async function listNodes() {
  try {
    const res = await fetch(`${CONTROLLER_URL}/api/nodes`);
    const data = await res.json();
    console.log(`\n🦊 Nodos Donantes en Foxy Network (${data.nodes.length}):\n`);
    if (data.nodes.length === 0) {
      console.log('No hay nodos registrados.');
      return;
    }
    data.nodes.forEach(n => {
      const statusIcon = n.status === 'ONLINE' ? '🟢' : '🔴';
      console.log(`${statusIcon} ${n.name} (ID: ${n.id})`);
      console.log(`   CPU: ${n.quota?.maxCpuCores || 2} cores | RAM: ${n.quota?.maxRamMb || 2048} MB`);
      console.log(`   Uso actual: CPU ${n.telemetry?.cpuUsagePercent || 0}% | RAM ${n.telemetry?.ramUsedMb || 0} MB`);
      console.log(`   Último latido: hace ${Math.round((Date.now() - n.lastHeartbeat) / 1000)}s\n`);
    });
  } catch (e) {
    console.error(`Error conectando con el orquestador: ${e.message}`);
  }
}

async function deployApp(subdomain, appName) {
  if (!subdomain) {
    console.log('Uso: foxy deploy <subdominio> [nombre-app]');
    console.log('Ejemplo: foxy deploy mi-tienda "Tienda Online"');
    return;
  }

  try {
    const res = await fetch(`${CONTROLLER_URL}/api/deployments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Foxy-Admin-Key': readLocalSecret('admin-key', 'FOXY_ADMIN_KEY') || ''
      },
      body: JSON.stringify({
        subdomain,
        appName: appName || subdomain
      })
    });
    const data = await res.json();
    if (data.success) {
      console.log(`\n🎉 Despliegue registrado exitosamente!`);
      console.log(`ID: ${data.deployment.id}`);
      console.log(`Subdominio: ${data.deployment.subdomain}`);
      console.log(`Nodo asignado: ${data.deployment.assignedNodeId || 'En cola para próximo nodo'}`);
      console.log(`URL en la red: ${GATEWAY_URL}/t/${data.deployment.subdomain}/\n`);
    } else {
      console.error('Error al desplegar:', data.error);
    }
  } catch (e) {
    console.error(`Error conectando con el orquestador: ${e.message}`);
  }
}

async function showLeaderboard() {
  try {
    const res = await fetch(`${CONTROLLER_URL}/api/ledger/leaderboard`);
    const data = await res.json();
    console.log(`\n🪙 === TABLA DE LÍDERES DE RECOMPENSAS ${data.symbol} (Época actual: ${data.currentEpoch}) ===\n`);
    console.log(`Total acuñado en la red: ${data.networkTotalMinted} ${data.symbol}\n`);

    if (data.leaderboard.length === 0) {
      console.log('No hay nodos registrados en el ledger todavía.');
      return;
    }

    console.log('Pos | ID Nodo             | Tier         | Saldo Pendiente | Ganancias Totales');
    console.log('----+---------------------+--------------+-----------------+------------------');
    data.leaderboard.forEach(l => {
      const pos = String(l.rank).padEnd(3);
      const id = String(l.nodeId).padEnd(19);
      const tier = String(l.tier).padEnd(12);
      const bal = (l.balance.toFixed(4) + ' ' + data.symbol).padEnd(15);
      const life = l.lifetimeEarnings.toFixed(4) + ' ' + data.symbol;
      console.log(`${pos} | ${id} | ${tier} | ${bal} | ${life}`);
    });
    console.log('');
  } catch (e) {
    console.error(`Error consultando leaderboard: ${e.message}`);
  }
}

async function showBalance(nodeId) {
  try {
    // If nodeId not provided, ask controller for first online node or daemon
    let targetNode = nodeId;
    if (!targetNode) {
      const nodesRes = await fetch(`${CONTROLLER_URL}/api/nodes`);
      const nodesData = await nodesRes.json();
      targetNode = nodesData.nodes?.[0]?.id;
    }

    if (!targetNode) {
      console.log('Uso: foxy balance <nodeId>');
      return;
    }

    const res = await fetch(`${CONTROLLER_URL}/api/ledger/account/${targetNode}`);
    const data = await res.json();
    const acc = data.account;

    console.log(`\n🪙 Balance de Recompensas para [${targetNode}]:\n`);
    console.log(`   Wallet de Recompensas: ${acc.walletAddress}`);
    console.log(`   Nivel de Hardware:     ${acc.tier}`);
    console.log(`   Saldo Reclamable:      ${acc.balance} ${data.symbol}`);
    console.log(`   Ganancias Históricas:  ${acc.lifetimeEarnings} ${data.symbol}`);
    console.log(`   Épocas Liquidadas:     ${acc.epochsSettled}`);

    if (acc.recentPayouts?.length > 0) {
      console.log(`\n   Últimas liquidaciones recibidas:`);
      acc.recentPayouts.slice(0, 3).forEach(p => {
        console.log(`   - Época ${p.epoch}: +${p.reward} ${data.symbol} (Recibo: ${p.receiptHash})`);
      });
    }
    console.log('');
  } catch (e) {
    console.error(`Error consultando balance: ${e.message}`);
  }
}

async function claimRewards(walletAddress) {
  // Claims go through the local daemon: only the node itself can claim.
  try {
    const data = await daemonPost('/api/claim-rewards', walletAddress ? { walletAddress } : {});
    const r = data.receipt;
    console.log(`\n🎉 Reclamo procesado (${r.settlement})`);
    console.log(`Cantidad:     ${data.amount} $FOXY`);
    console.log(`Destinatario: ${r.to}`);
    if (r.settlement === 'ONCHAIN_VOUCHER') {
      console.log(`Contrato:     ${r.contractAddress} (chainId ${r.chainId})`);
      console.log(`Para acuñar:  claimContributionReward(${r.amountWei}, ${r.epoch}, ${r.signature})\n`);
    } else {
      console.log(`Nota:         ${r.note}\n`);
    }
  } catch (e) {
    console.error(`Error al reclamar: ${e.message}`);
  }
}

async function linkFoxyFinance() {
  try {
    const data = await daemonPost('/api/finance/link-code');
    console.log(`\n🔗 Código de vinculación con Foxy Finance: ${data.code}`);
    console.log(`   Escríbelo en tu cuenta de Foxy Finance antes de ${new Date(data.expiresAt).toLocaleTimeString()}.\n`);
  } catch (e) {
    console.error(`Error generando el código: ${e.message}`);
  }
}

async function handleFinanceCommand(subArgs) {
  const sub = subArgs[0] || 'status';
  try {
    if (sub === 'link') return await linkFoxyFinance();

    if (sub === 'pay') {
      if (!subArgs[1]) return console.log('Uso: foxy finance pay <planId>   (ej. FOXY_FINANCE_TRADER_PRO)');
      const data = await daemonPost('/api/finance/pay', { planId: subArgs[1] });
      console.log(`\n🔥 Plan ${data.payment.planId} pagado con ${data.payment.amountFoxy} $FOXY (quemados). Saldo: ${data.balance} $FOXY\n`);
      return;
    }

    if (sub === 'dispatch') {
      // Operator / partner side: needs the partner secret of this controller.
      const secret = readLocalSecret('finance-api-secret', 'FOXY_FINANCE_API_SECRET');
      if (!secret) return console.error('No se encontró el secreto de la API de Foxy Finance en este equipo.');
      const { FoxyNetworkClient } = await import('../../foxy-finance-workload/src/network-client.js');
      const client = new FoxyNetworkClient({ baseUrl: CONTROLLER_URL, secret, keyId: process.env.FOXY_FINANCE_KEY_ID || 'foxy-finance' });
      const type = subArgs[1] || 'monte_carlo_gbm';
      const replicas = parseInt(subArgs[2] || '1', 10);
      console.log(`\n📈 Enviando trabajo '${type}' (réplicas: ${replicas})...`);
      const job = await client.runJob(type, {}, { replicas, timeoutMs: 90000 });
      console.log(`Estado:        ${job.status}${job.error ? ' — ' + job.error : ''}`);
      console.log(`Unidades FCC:  ${job.computeUnits} por nodo`);
      if (job.verification) console.log(`Verificación:  ${job.verification.mode} (${job.verification.agreeing}/${job.verification.replicas} de acuerdo)`);
      if (job.result) console.log(`Resultado:     ${JSON.stringify(job.result)}`);
      console.log('');
      return;
    }

    const [telemetry, overview, board] = await Promise.all([
      fetch(`${CONTROLLER_URL}/api/foxy-finance/telemetry`).then(r => r.json()),
      fetch(`${CONTROLLER_URL}/api/premium/overview`).then(r => r.json()),
      fetch(`${CONTROLLER_URL}/api/ledger/leaderboard`).then(r => r.json())
    ]);
    const t = overview.treasury;
    console.log(`\n📈 === FOXY FINANCE ↔ FOXY NETWORK ===\n`);
    console.log(`Nodos online:               ${telemetry.network.onlineNodes} ${JSON.stringify(telemetry.network.onlineNodesByClass)}`);
    console.log(`Nodos vinculados a cuentas: ${telemetry.network.linkedNodes}`);
    console.log(`Trabajos:                   ${telemetry.network.jobs.completed} completados, ${telemetry.network.jobs.failed} fallidos, ${telemetry.network.jobs.queued + telemetry.network.jobs.running} en curso`);
    console.log(`Unidades FCC procesadas:    ${telemetry.totalComputeUnitsProcessed}`);
    console.log(`$FOXY acreditados / quemados: ${board.networkTotalMinted} / ${board.networkTotalBurned}`);
    console.log(`\nModelo contable (simulación, no son fondos reales):`);
    console.log(`  Ingresos: $${t.totalRevenueUsd}  |  Fundador 40%: $${t.founderProfitUsd}  |  Reserva 45%: $${t.donorBackingPoolUsd}  |  Quema 15%: $${t.totalBurnedUsd}\n`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
  }
}

async function handleVpnCommand(subArgs) {
  const subCmd = subArgs[0] || 'status';

  if (subCmd === 'connect' || subCmd === 'start') {
    const port = parseInt(subArgs[1] || '1080', 10);
    console.log(`\n🛡️ Iniciando cliente dVPN en 127.0.0.1:${port}...`);
    try {
      const { FoxyVpnClient } = await import('../../foxy-vpn/src/client.js');
      const vpnClient = new FoxyVpnClient({ port });
      await vpnClient.start();
    } catch (e) {
      console.error(`Error iniciando dVPN: ${e.message}`);
    }
    return;
  }

  // VPN Status
  try {
    const res = await fetch(`${GATEWAY_URL}/api/vpn/status`);
    const data = await res.json();
    console.log(`\n🛡️ === ESTADO DE LA RED DESCENTRALIZADA dVPN ===\n`);
    console.log(`Repetidores Exit Activos:   ${data.activeRelaysCount}`);
    console.log(`Sesiones Cifradas Activas:  ${data.activeSessionsCount}`);
    if (data.relays?.length > 0) {
      console.log(`Nodos repetidores disponibles:`);
      data.relays.forEach(r => console.log(`  - 🌐 [${r}] (X25519 + AES-256-GCM)`));
    } else {
      console.log(`Aún no hay nodos repetidores registrados.`);
    }
    console.log(`\nPara conectarte a través de la dVPN:`);
    console.log(`  foxy vpn connect [puerto-local]\n`);
  } catch (e) {
    console.error(`Error consultando estado dVPN: ${e.message}`);
  }
}

async function showTokenInfo() {
  console.log(`
🦊 ========================================================
               FOXY NETWORK TOKENOMICS ($FOXY)
========================================================
  Token:              Foxy Network Token ($FOXY)
  Estándar:           ERC-20 + Proof-of-Contribution + Burn
  Cap Máximo:         1,000,000,000 $FOXY
  Decimales:          18
  Redes Compatibles:  Ethereum, Base, Polygon, Arbitrum, BSC

  Mecanismo de Recompensas:
    - Tiempo de Uptime:   0.25 $FOXY / minuto
    - Ancho de Banda Web: 1.50 $FOXY / MB servido
    - Tráfico dVPN:       2.00 $FOXY / MB cifrado enrutado
    - Cómputo verificado: 0.50 $FOXY / unidad (trabajos de Foxy Finance)
    - Épocas de Pago:     Cada 30 segundos

  Contrato Inteligente:
    packages/foxy-contracts/contracts/FoxyToken.sol
========================================================
`);
}

async function handleDomainsCommand(subArgs) {
  const action = subArgs[0] || 'list';
  const { loadDomainMappings, ensureFoxSslCredentials } = await import('../../foxy-gateway/src/domains.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  if (action === 'setup' || action === 'install') {
    console.log('\n🌐 === CONFIGURANDO DOMINIOS .FOX Y CERTIFICADO SSL LOCAL ===\n');
    const creds = ensureFoxSslCredentials();
    console.log(`✅ Certificado SSL generado para *.fox en:\n   ${creds.certPath}`);

    const hostsEntries = [
      '127.0.0.1 www.foxyfianance.fox',
      '127.0.0.1 foxyfianance.fox',
      '127.0.0.1 www.foxyfinance.fox',
      '127.0.0.1 foxyfinance.fox',
      '127.0.0.1 www.foxynetwork.fox',
      '127.0.0.1 foxynetwork.fox'
    ];

    const hostsPath = os.platform() === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts';

    try {
      const currentHosts = fs.readFileSync(hostsPath, 'utf-8');
      const missing = hostsEntries.filter(entry => !currentHosts.includes(entry.split(' ')[1]));
      if (missing.length > 0) {
        const block = `\n# --- Foxy Network Decentralized .fox Domains ---\n${missing.join('\n')}\n`;
        fs.appendFileSync(hostsPath, block, 'utf-8');
        console.log(`✅ Dominios .fox agregados exitosamente a ${hostsPath}`);
      } else {
        console.log(`✅ Todos los dominios .fox ya están registrados en ${hostsPath}`);
      }
    } catch (err) {
      console.log(`⚠️ No se pudo escribir directamente en ${hostsPath} (requiere permisos de Administrador).`);
      console.log(`   👉 Puedes usar inmediatamente los dominios sin permisos de administrador a través del proxy dVPN (127.0.0.1:1080)`);
      console.log(`   👉 O ejecuta Configurar-Dominios-Fox.bat como Administrador para registrarlos a nivel de Windows.`);
    }

    if (os.platform() === 'win32') {
      try {
        execFileSync('certutil', ['-user', '-addstore', 'Root', creds.certPath], { stdio: 'ignore' });
        console.log(`✅ Certificado SSL instalado en el almacén de confianza del usuario actual.`);
      } catch {
        // Ignore if user cancels prompt
      }
    }
    console.log('');
    return;
  }

  const mappings = loadDomainMappings();
  console.log('\n🌐 === DOMINIOS DESCENTRALIZADOS .FOX ALOJADOS EN FOXY NETWORK ===\n');
  for (const [domain, info] of Object.entries(mappings)) {
    console.log(`  🦊 https://${domain.padEnd(24)} -> [${info.target}] (${info.name})`);
  }
  console.log(`\nPuertos del Gateway:`);
  console.log(`  - HTTP:  http://www.foxynetwork.fox:8080  | http://www.foxyfianance.fox:8080`);
  console.log(`  - HTTPS: https://www.foxynetwork.fox:8443 | https://www.foxyfianance.fox:8443`);
  console.log(`  - Proxy dVPN (sin puerto en URL): https://www.foxyfianance.fox & http://www.foxynetwork.fox (vía 127.0.0.1:1080)\n`);
}

function showHelp() {
  console.log(`
🦊 Foxy Network CLI — Herramienta de Gestión DePIN

Uso:
  foxy <comando> [opciones]

Comandos disponibles:
  status                Muestra el estado del Ingress Gateway y del Orquestador
  nodes                 Lista los nodos donantes activos y su capacidad
  deploy <subdominio>   Despliega un servicio o aplicación en un nodo donante
  leaderboard           Muestra la tabla de clasificación y total acuñado en la red
  balance [nodeId]      Consulta el saldo de tokens $FOXY y recibos de un nodo
  claim [addr]          Reclama las recompensas del nodo local (voucher firmado por el oráculo)
  finance [status|link|pay <plan>|dispatch [tipo] [réplicas]]
                        Estado del enlace con Foxy Finance, pago con $FOXY y trabajos de prueba
  link                  Genera un código para vincular este nodo con tu cuenta de Foxy Finance
  vpn [status|connect]  Consulta o inicia el túnel cliente dVPN cifrado (127.0.0.1:1080)
  domains [list|setup]  Lista o configura el hosting y DNS para www.foxyfianance.fox y www.foxynetwork.fox
  token                 Muestra detalles del token $FOXY, economía y smart contracts
  help                  Muestra este menú de ayuda
`);
}

main();
