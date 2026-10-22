// ==============================================================================
// Foxy Network - Smart Contract Deployment & Tooling
// Deploys FoxyToken ($FOXY) to any EVM Compatible Network
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(`
🦊 ========================================================
           FOXY NETWORK SMART CONTRACT ENGINE
   Token: $FOXY (Foxy Network Token)
   Standard: ERC-20 + Deflationary DePIN Utility
========================================================
`);

const NETWORKS = {
  localhost: { name: 'Localhost / Anvil / Hardhat', rpc: 'http://127.0.0.1:8545', chainId: 31337 },
  baseSepolia: { name: 'Base Sepolia Testnet', rpc: 'https://sepolia.base.org', chainId: 84532 },
  polygonAmoy: { name: 'Polygon Amoy Testnet', rpc: 'https://rpc-amoy.polygon.technology', chainId: 80002 },
  arbitrumSepolia: { name: 'Arbitrum Sepolia Testnet', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', chainId: 421614 }
};

console.log('Redes compatibles para despliegue:');
for (const [key, net] of Object.entries(NETWORKS)) {
  console.log(`  - [${key}] ${net.name} (ChainID: ${net.chainId}) -> RPC: ${net.rpc}`);
}

console.log(`
Para compilar y desplegar usando Hardhat / Foundry:
  1. Instala dependencias: npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
  2. Configura tu RPC y clave privada en un archivo .env
  3. Ejecuta: npx hardhat run deploy.js --network baseSepolia

El contrato inteligente se encuentra listo en:
  contracts/FoxyToken.sol
`);
