#!/usr/bin/env bash
# ==============================================================================
# Foxy Daemon - Standalone Donor Client for Linux & macOS
# Connects to Foxy Network, donates idle resources and earns $FOXY
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "🦊 Iniciando Foxy Daemon (Modo Donante)..."

if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js no instalado. Visita https://nodejs.org"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    npm install
fi

echo "Accede a tu panel donante en: http://localhost:4040"
npm --workspace=foxy-daemon start
