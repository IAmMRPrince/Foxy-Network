// Compiles the Foxy contracts with solc-js and writes ABI + bytecode to ./artifacts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.join(__dirname, 'contracts');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');

export function compileContracts({ write = true } = {}) {
  const solc = require('solc');
  const sources = {};
  for (const file of fs.readdirSync(CONTRACTS_DIR).filter(f => f.endsWith('.sol'))) {
    sources[file] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf-8') };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris', // no PUSH0: deployable on every EVM chain
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (file) => {
      const local = path.join(CONTRACTS_DIR, path.basename(file));
      return fs.existsSync(local) ? { contents: fs.readFileSync(local, 'utf-8') } : { error: 'File not found' };
    }
  }));

  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  }
  const warnings = (output.errors || []).filter(e => e.severity === 'warning');

  const artifacts = {};
  for (const file of Object.keys(output.contracts)) {
    for (const [name, contract] of Object.entries(output.contracts[file])) {
      artifacts[name] = { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
    }
  }

  if (write) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    for (const [name, artifact] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(ARTIFACTS_DIR, `${name}.json`), JSON.stringify(artifact, null, 2));
    }
  }
  return { artifacts, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { artifacts, warnings } = compileContracts();
  for (const w of warnings) console.warn(w.formattedMessage);
  for (const [name, a] of Object.entries(artifacts)) {
    console.log(`✅ ${name}: ${(a.bytecode.length - 2) / 2} bytes -> artifacts/${name}.json`);
  }
}
