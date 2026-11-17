// ==============================================================================
// Foxy Network - contract deployment
// Deploys FoxyToken and FoxyTreasuryVault to an EVM network.
//
//   FOXY_NETWORK=baseSepolia \
//   DEPLOYER_PRIVATE_KEY=0x... \
//   FOXY_ORACLE_ADDRESS=0x...   (address printed by the controller at startup) \
//   FOXY_FOUNDER_WALLET=0x...   (defaults to the deployer) \
//   node deploy.js
//
// The private key is read from the environment only. Never commit it.
// ==============================================================================

import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { compileContracts } from './compile.js';

export const NETWORKS = {
  localhost: { name: 'Localhost / Anvil / Hardhat', rpc: 'http://127.0.0.1:8545', chainId: 31337 },
  baseSepolia: { name: 'Base Sepolia Testnet', rpc: 'https://sepolia.base.org', chainId: 84532 },
  polygonAmoy: { name: 'Polygon Amoy Testnet', rpc: 'https://rpc-amoy.polygon.technology', chainId: 80002 },
  arbitrumSepolia: { name: 'Arbitrum Sepolia Testnet', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', chainId: 421614 }
};

/** Deploys both contracts with `signer`. Returns the ethers contract objects. */
export async function deployFoxyContracts(signer, { oracleAddress, founderWallet }) {
  const { artifacts } = compileContracts({ write: false });

  const tokenFactory = new ethers.ContractFactory(artifacts.FoxyToken.abi, artifacts.FoxyToken.bytecode, signer);
  const token = await tokenFactory.deploy(oracleAddress);
  await token.waitForDeployment();

  const vaultFactory = new ethers.ContractFactory(artifacts.FoxyTreasuryVault.abi, artifacts.FoxyTreasuryVault.bytecode, signer);
  const vault = await vaultFactory.deploy(founderWallet, await token.getAddress());
  await vault.waitForDeployment();

  return { token, vault, artifacts };
}

async function main() {
  const networkKey = process.env.FOXY_NETWORK || 'localhost';
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new Error(`Red desconocida '${networkKey}'. Disponibles: ${Object.keys(NETWORKS).join(', ')}`);
  }
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const oracleAddress = process.env.FOXY_ORACLE_ADDRESS;
  if (!privateKey) throw new Error('Falta DEPLOYER_PRIVATE_KEY');
  if (!oracleAddress || !ethers.isAddress(oracleAddress)) {
    throw new Error('Falta FOXY_ORACLE_ADDRESS (la dirección del oráculo que imprime el controlador al arrancar)');
  }

  const provider = new ethers.JsonRpcProvider(process.env.FOXY_RPC_URL || network.rpc);
  const signer = new ethers.Wallet(privateKey, provider);
  const founderWallet = process.env.FOXY_FOUNDER_WALLET || signer.address;
  if (!ethers.isAddress(founderWallet)) throw new Error('FOXY_FOUNDER_WALLET no es una dirección válida');

  const chainId = Number((await provider.getNetwork()).chainId);
  console.log(`🦊 Desplegando en ${network.name} (chainId ${chainId}) desde ${signer.address}`);

  const { token, vault } = await deployFoxyContracts(signer, { oracleAddress, founderWallet });
  const tokenAddress = await token.getAddress();

  console.log(`✅ FoxyToken:         ${tokenAddress}`);
  console.log(`✅ FoxyTreasuryVault: ${await vault.getAddress()}`);
  console.log(`\nConfigura el controlador con:\n  FOXY_TOKEN_ADDRESS=${tokenAddress}\n  FOXY_CHAIN_ID=${chainId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
