import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('🦊 Iniciando el ecosistema completo de Foxy Network...\n');

const services = [
  {
    name: 'Gateway',
    color: '\x1b[35m', // Magenta
    cmd: 'node',
    args: ['packages/foxy-gateway/src/index.js']
  },
  {
    name: 'Controller',
    color: '\x1b[34m', // Blue
    cmd: 'node',
    args: ['packages/foxy-controller/src/index.js']
  },
  {
    name: 'Daemon',
    color: '\x1b[33m', // Yellow
    cmd: 'node',
    args: ['packages/foxy-daemon/src/index.js']
  },
  {
    name: 'FoxyFinance',
    color: '\x1b[32m', // Green
    cmd: 'node',
    args: ['packages/foxy-finance-workload/src/index.js']
  }
];

const processes = [];

services.forEach(svc => {
  const child = spawn(svc.cmd, svc.args, {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true
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
