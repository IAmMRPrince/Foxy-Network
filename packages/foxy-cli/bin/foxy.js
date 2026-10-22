#!/usr/bin/env node
import process from 'node:process';

const CONTROLLER_URL = process.env.FOXY_CONTROLLER_URL || 'http://localhost:4000';
const GATEWAY_URL = process.env.FOXY_GATEWAY_URL || 'http://localhost:8080';

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
      await claimRewards(args[1], args[2]);
      break;
    case 'vpn':
      await handleVpnCommand(args.slice(1));
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
      headers: { 'Content-Type': 'application/json' },
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

async function claimRewards(nodeId, walletAddress) {
  let targetNode = nodeId;
  if (!targetNode) {
    const nodesRes = await fetch(`${CONTROLLER_URL}/api/nodes`);
    const nodesData = await nodesRes.json();
    targetNode = nodesData.nodes?.[0]?.id;
  }

  if (!targetNode) {
    console.log('Uso: foxy claim <nodeId> [walletAddress]');
    return;
  }

  try {
    const res = await fetch(`${CONTROLLER_URL}/api/ledger/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: targetNode, walletAddress })
    });
    const data = await res.json();
    if (data.success) {
      console.log(`\n🎉 ¡Reclamación de recompensas completada!`);
      console.log(`Cantidad:    ${data.amount} $FOXY`);
      console.log(`TxHash:      ${data.receipt.txHash}`);
      console.log(`Destinatario:${data.receipt.to}`);
      console.log(`Red:         ${data.receipt.network}\n`);
    } else {
      console.error(`Error al reclamar: ${data.error}`);
    }
  } catch (e) {
    console.error(`Error conectando con el orquestador: ${e.message}`);
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
      data.relays.forEach(r => console.log(`  - 🌐 [${r}] (Cifrado AES-256-GCM / Zero-Logs)`));
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
    - Épocas de Pago:     Cada 30 segundos

  Contrato Inteligente:
    packages/foxy-contracts/contracts/FoxyToken.sol
========================================================
`);
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
  claim [nodeId] [addr] Reclama y transfiere las recompensas acumuladas (firmadas Web3)
  vpn [status|connect]  Consulta o inicia el túnel cliente dVPN cifrado (127.0.0.1:1080)
  token                 Muestra detalles del token $FOXY, economía y smart contracts
  help                  Muestra este menú de ayuda
`);
}

main();
