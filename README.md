# 🦊 Foxy Network

> **Red Descentralizada de Servidores en la Nube & VPN Cifrada (DePIN)**  
> Conecta recursos de cómputo, almacenamiento y ancho de banda donados por la comunidad a través de clientes ligeros con liquidación criptográfica en tokens `$FOXY`.

---

## 🎯 Objetivo General
Permitir que cualquier usuario con un dispositivo conectado a internet (**Windows, macOS o Linux**) pueda virtualizar y donar recursos ociosos (CPU, RAM, ancho de banda y conexiones de red seguras). A cambio, el donante recibe recompensas automáticas en la criptomoneda nativa **`$FOXY`**. La red ofrece alojamiento de aplicaciones web en el edge y un **servicio VPN descentralizado (dVPN) con cifrado de extremo a extremo y política Zero-Logs**.

---

## 🏗️ Módulos de la Red

| Módulo | Directorio | Puerto Local | Rol / Función |
| :--- | :--- | :--- | :--- |
| **`foxy-daemon`** | `packages/foxy-daemon` | `4040` (UI) / Dinámicos | Cliente donante con soporte multiplataforma. Incluye **WorkloadEngine** (Docker/Podman y Sandbox Nativo Python/Node.js/Estático), **Gestor de Billeteras Web3 EVM** y **Repetidor dVPN con Firewall de Seguridad**. |
| **`foxy-vpn`** | `packages/foxy-vpn` | `1080` (Proxy Local) | Servicio de VPN Descentralizada (dVPN). Cifra el tráfico de los usuarios con **AES-256-GCM** y lo enruta de forma anónima a través de las IPs de los nodos donantes. |
| **`foxy-contracts`** | `packages/foxy-contracts` | On-Chain (EVM) | Smart Contracts Solidity del Token **`$FOXY`** (ERC-20) con minteo por **Proof-of-Contribution (PoC)**, firmas criptográficas de oráculo y mecanismo deflacionario de quema (**Burn**). |
| **`foxy-gateway`** | `packages/foxy-gateway` | `8080` (HTTP) / `8081` (WS) | Pasarela de entrada que multiplexa peticiones HTTP a los túneles inversos y multiplexa las sesiones de datos cifrados de la dVPN. |
| **`foxy-controller`**| `packages/foxy-controller` | `4000` (HTTP) | Plano de control y orquestador: registro de nodos, telemetría, ledger de recompensas `$FOXY`, firmas ECDSA de oráculo y conmutación por error (Failover). |
| **`foxy-security`** | `packages/foxy-security` | Biblioteca | Motor de seguridad criptográfica: tokens de capacidad JWT HMAC-SHA256, identidades Ed25519 y derivación de claves simétricas. |
| **`foxy-cli`** | `packages/foxy-cli` | CLI (`foxy`) | Línea de comandos para desarrolladores y donantes (`status`, `nodes`, `deploy`, `vpn`, `balance`, `claim`, `token`). |

---

## 💻 Compatibilidad Multiplataforma (Windows, macOS & Linux)

### 🪟 En Windows:
* **Lanzador Interactivo:** Haz doble clic en **[`Foxy-Network.bat`](file:///d:/OneDrive/Desktop/Foxy/Foxy%20Network/Foxy-Network.bat)** o en el acceso directo de tu escritorio.
* **Modo Bandeja del Sistema (System Tray):** Ejecuta **[`Foxy-Tray.bat`](file:///d:/OneDrive/Desktop/Foxy/Foxy%20Network/Foxy-Tray.bat)** para minimizar la app junto al reloj con menú contextual y notificaciones.
* **Modo Totalmente Invisible:** Ejecuta **`Foxy-Daemon-Silent.vbs`** para donar en segundo plano sin ventanas.

### 🍏 En macOS & 🐧 Linux:
* **Lanzador Universal:**
  ```bash
  chmod +x Foxy-Network.sh
  ./Foxy-Network.sh
  ```
* **Lanzador Rápido del Donante (Daemon):**
  ```bash
  chmod +x Foxy-Daemon.sh
  ./Foxy-Daemon.sh
  ```
* **Instalación como Servicio Automático de Inicio (Boot Service):**
  ```bash
  chmod +x scripts/install-service.sh
  ./scripts/install-service.sh
  ```
  *(Configura automáticamente **Systemd** en Linux o **Launchd** en macOS para ejecutarse siempre en segundo plano).*

---

## 🪙 Cripto Token `$FOXY` & Smart Contracts

Foxy Network cuenta con una economía basada en un contrato inteligente **ERC-20** estándar desplegable en cualquier red compatible con EVM (**Base, Polygon, Arbitrum, Ethereum, BNB Chain**):

* **Símbolo:** `$FOXY`
* **Nombre:** `Foxy Network Token`
* **Suministro Máximo:** 1,000,000,000 $FOXY
* **Contrato Inteligente:** [`packages/foxy-contracts/contracts/FoxyToken.sol`](file:///d:/OneDrive/Desktop/Foxy/Foxy%20Network/packages/foxy-contracts/contracts/FoxyToken.sol)

### Mecanismo de Recompensas (Proof-of-Contribution)
Cada 30 segundos (una época), el controlador calcula las contribuciones verificadas y acredita tokens al balance del donante:
1. **Tiempo en Línea (Uptime):** +0.25 $FOXY / minuto.
2. **Ancho de Banda Web Servido:** +1.50 $FOXY / MB.
3. **Tráfico dVPN Cifrado Enrutado:** +2.00 $FOXY / MB.
4. **Multiplicadores por Hardware:** 1.0x (Standard), 1.5x (High Performance), 2.0x (Ultra Compute).

### Billetera Web3 Integrada
El cliente donante genera automáticamente una billetera EVM (`0x...`) segura y privada sin requerir conocimientos previos. Desde el panel web ([http://localhost:4040](http://localhost:4040)), el usuario puede:
* Copiar su dirección de cobro.
* Vincular su propia dirección de **MetaMask** para recibir los pagos directamente.
* Exportar su clave privada o frase semilla de 12 palabras.
* Reclamar sus recompensas con firma criptográfica ECDSA lista para interactuar con la blockchain.

### Mecanismo Deflacionario (Burn)
Los usuarios que desean alojar aplicaciones o consumir ancho de banda de la red dVPN pagan tarifas en `$FOXY`. Un porcentaje de cada tarifa se **quema permanentemente (Burn)**, reduciendo la oferta circulante y respaldando el valor de la red.

---

## 🛡️ Servicio VPN Descentralizado Cifrado (dVPN)

Foxy Network transforma los nodos donantes en repetidores de salida seguros para ofrecer navegación privada y anónima:

* **Cifrado de Extremo a Extremo (E2EE):** Todo el tráfico entre el usuario de la VPN y el nodo donante se encapsula con **AES-256-GCM** y claves de sesión simétricas rotatorias.
* **Política Zero-Knowledge & Zero-Logs:** Los nodos de la red no guardan registros de peticiones, URLs visitadas ni direcciones IP de los clientes.
* **Firewall de Protección para el Donante:** El repetidor bloquea de forma estricta los puertos de spam (SMTP 25, 465, 587) y escaneos de fuerza bruta (SSH 22, SMB 445), permitiendo únicamente tráfico web seguro (HTTP 80, HTTPS 443, DNS 53, etc.).

### Cómo usar la VPN:
1. **Iniciar el Cliente Proxy Local:**
   ```bash
   node packages/foxy-cli/bin/foxy.js vpn connect
   ```
   *(Inicia un proxy HTTP CONNECT y SOCKS5 local en `127.0.0.1:1080`)*.
2. **Navegar a través de la Red Foxy:**
   Configura tu navegador (Chrome, Firefox) o cliente para usar el proxy `127.0.0.1:1080`.
   O prueba en terminal:
   ```bash
   curl -x http://127.0.0.1:1080 https://api.ipify.org
   ```
   Tu tráfico saldrá a internet con la IP del nodo donante asignado y de forma completamente cifrada.

---

## 🖥️ Enlaces Rápidos del Ecosistema

- **Panel de Control del Donante:** [http://localhost:4040](http://localhost:4040)
- **Portal Ingress Gateway:** [http://localhost:8080](http://localhost:8080)
- **Orquestador Central:** [http://localhost:4000](http://localhost:4000)
- **Estado de la dVPN:** [http://localhost:8080/api/vpn/status](http://localhost:8080/api/vpn/status)
- **Servidor Demo Descentralizado:** [http://localhost:8080/t/foxy-demo-app/](http://localhost:8080/t/foxy-demo-app/)

---

## 🛠️ Comandos de CLI (`foxy`)

```bash
# Consultar estado global del sistema:
node packages/foxy-cli/bin/foxy.js status

# Listar nodos donantes y sus recursos:
node packages/foxy-cli/bin/foxy.js nodes

# Iniciar el túnel VPN local cifrado:
node packages/foxy-cli/bin/foxy.js vpn connect 1080

# Ver información del token $FOXY y contratos:
node packages/foxy-cli/bin/foxy.js token

# Consultar balance y recompensas acumuladas:
node packages/foxy-cli/bin/foxy.js balance

# Reclamar tokens a tu billetera con firma Web3:
node packages/foxy-cli/bin/foxy.js claim <nodeId> 0xTuDireccionMetaMask

# Desplegar un servicio web en la red:
node packages/foxy-cli/bin/foxy.js deploy mi-app "Mi Aplicacion Cloud"
```

---

## 📄 Licencia
Distribuido bajo la licencia **Apache-2.0**. Desarrollado para la comunidad de código abierto y computación descentralizada.
