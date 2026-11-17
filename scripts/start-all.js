import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('🦊 Iniciando el ecosistema completo de Foxy Network...\n');

const services = [
  {
    name: 'Gateway',
    color: '\x1b[35m', // Magenta
    cmd: process.execPath,
    args: ['packages/foxy-gateway/src/index.js']
  },
  {
    name: 'Controller',
    color: '\x1b[34m', // Blue
    cmd: process.execPath,
    args: ['packages/foxy-controller/src/index.js']
  },
  {
    name: 'Daemon',
    color: '\x1b[33m', // Yellow
    cmd: process.execPath,
    args: ['packages/foxy-daemon/src/index.js']
  },
  {
    name: 'dVPN-DNS',
    color: '\x1b[36m', // Cyan
    cmd: process.execPath,
    args: ['packages/foxy-vpn/src/client.js']
  },
  {
    name: 'FoxyFinance',
    color: '\x1b[32m', // Green
    cmd: process.execPath,
    args: ['packages/foxy-finance-workload/src/index.js']
  }
];

// Local development: if the Foxy Finance project sits next to this repository
// (or FOXY_FINANCE_PORT is set), this machine's node publishes it as foxy-finance.
const financeDirs = ['FOXY FINANCE', 'FOXY FINAINCE', 'foxy-finance'].map(d => path.resolve(rootDir, '..', d));
const env = { ...process.env };
if (env.FOXY_HOST_FINANCE === undefined &&
    (env.FOXY_FINANCE_PORT || financeDirs.some(d => fs.existsSync(path.join(d, 'main.py'))))) {
  env.FOXY_HOST_FINANCE = '1';
}

const processes = [];

services.forEach(svc => {
  const child = spawn(svc.cmd, svc.args, {
    cwd: rootDir,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
  });

  child.stdout.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(l => {
      console.log(`${svc.color}[${svc.name}]\x1b[0m ${l}`);
    });
  });

  child.stderr.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(l => {
      console.error(`${svc.color}[${svc.name} ERR]\x1b[0m ${l}`);
    });
  });

  processes.push(child);
});

process.on('SIGINT', () => {
  console.log('\n\x1b[31mApagando todos los servicios de Foxy Network...\x1b[0m');
  processes.forEach(p => p.kill());
  process.exit(0);
});

process.on('SIGTERM', () => {
  processes.forEach(p => p.kill());
  process.exit(0);
});
