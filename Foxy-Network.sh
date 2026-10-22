#!/usr/bin/env bash
# ==============================================================================
# Foxy Network - Universal Launcher for Linux & macOS
# Decentralized Cloud Server Network & DePIN Engine
# ==============================================================================

set -e

# Terminal Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Determine Script Directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo -e "${CYAN}${BOLD}"
echo "  ______                _   _      _                      _    "
echo " |  ____|              | \ | |    | |                    | |   "
echo " | |__ _____  ___   _  |  \| | ___| |___      _____  _ __| | __"
echo " |  __/ _ \ \/ / | | | | . \` |/ _ \ __\ \ /\ / / _ \| '__| |/ /"
echo " | | | (_) >  <| |_| | | |\  |  __/ |_ \ V  V / (_) | |  |   < "
echo " |_|  \___/_/\_\\__, | |_| \_|\___|\__| \_/\_/ \___/|_|  |_|\_\\"
echo "                 __/ |                                         "
echo "                |___/    Decentralized Cloud & dVPN Engine     "
echo -e "${NC}"

echo -e "${BOLD}[1/3] Detectando entorno operativo...${NC}"
OS_TYPE="$(uname -s)"
case "${OS_TYPE}" in
    Linux*)     PLATFORM="Linux";;
    Darwin*)    PLATFORM="macOS";;
    *)          PLATFORM="UNKNOWN (${OS_TYPE})";;
esac
echo -e "      Sistema operativo: ${GREEN}${PLATFORM}${NC} ($(uname -m))"

# Check Node.js
echo -e "${BOLD}[2/3] Verificando dependencias de Node.js...${NC}"
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] Node.js no esta instalado en este sistema.${NC}"
    echo -e "        Por favor instala Node.js >= 18.x desde https://nodejs.org o via tu gestor de paquetes."
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "      Node.js detectado: ${GREEN}${NODE_VERSION}${NC}"

# Check dependencies
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}      Instalando dependencias de Foxy Network (npm install)...${NC}"
    npm install
fi

echo -e "${BOLD}[3/3] Iniciando cluster descentralizado...${NC}"
echo -e "      - Gateway Ingress Proxy:   ${CYAN}http://localhost:8080${NC} (Túneles: ws://localhost:8081)"
echo -e "      - Controller Plane:        ${CYAN}http://localhost:4000${NC}"
echo -e "      - Panel Donante / UI:      ${GREEN}http://localhost:4040${NC}"
echo -e "      - Servicio dVPN Encapsulado: ${YELLOW}127.0.0.1:1080${NC}"
echo ""
echo -e "${YELLOW}Presiona Ctrl+C en cualquier momento para detener todos los nodos limpiamente.${NC}"
echo "----------------------------------------------------------------------"

# Trap exit signals to kill all child processes
trap 'echo -e "\n${RED}Deteniendo todos los servicios de Foxy Network...${NC}"; kill 0; exit 0' SIGINT SIGTERM EXIT

# Start all services using node script
node scripts/start-all.js
