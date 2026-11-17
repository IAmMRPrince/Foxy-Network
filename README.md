# 🦊 Foxy Network

> **Red Descentralizada de Servidores en la Nube & VPN Cifrada (DePIN)**  
> Conecta recursos de cómputo, almacenamiento y ancho de banda donados por la comunidad a través de clientes ligeros con liquidación criptográfica en tokens `$FOXY`.

---

## 🎯 Objetivo General
Permitir que cualquier usuario con un dispositivo conectado a internet (**Windows, macOS o Linux**) pueda virtualizar y donar recursos ociosos (CPU, RAM, ancho de banda y conexiones de red seguras). A cambio, el donante recibe recompensas automáticas en la criptomoneda nativa **`$FOXY`**. La red ofrece alojamiento de aplicaciones web en el edge y un **servicio VPN descentralizado (dVPN) cifrado**.

> ⚠️ **Estado del proyecto: prototipo (v0.2).** Funciona en local y tiene pruebas automáticas, pero no ha pasado una auditoría de seguridad externa ni tiene contratos desplegados en mainnet. Lee [`SECURITY.md`](SECURITY.md) antes de usarlo con fondos o datos reales.

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
| **`foxy-cli`** | `packages/foxy-cli` | CLI (`foxy`) | Línea de comandos para desarrolladores y donantes (`status`, `nodes`, `deploy`, `vpn`, `balance`, `claim`, `link`, `finance`, `token`). |

---

## 💻 Compatibilidad Multiplataforma (Windows, macOS & Linux)

### 🪟 En Windows:
* **Lanzador Interactivo:** Haz doble clic en **[`Foxy-Network.bat`](Foxy-Network.bat)** o en el acceso directo de tu escritorio.
* **Modo Bandeja del Sistema (System Tray):** Ejecuta **[`Foxy-Tray.bat`](Foxy-Tray.bat)** para minimizar la app junto al reloj con menú contextual y notificaciones.
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
* **Contrato Inteligente:** [`packages/foxy-contracts/contracts/FoxyToken.sol`](packages/foxy-contracts/contracts/FoxyToken.sol)

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
* Exportar su clave privada o frase semilla de 12 palabras (el panel solo escucha en `127.0.0.1` y exige un token de sesión local).
* Reclamar sus recompensas: el oráculo firma un *voucher* ECDSA que el donante canjea en `FoxyToken.claimContributionReward()`. Sin contrato configurado (`FOXY_TOKEN_ADDRESS`) el reclamo queda marcado como **simulación**.

### 💎 Respaldo por Servicios Premium & Monetización del Creador
El token `$FOXY` no es inflacionario sin sustento: su valor está respaldado por el flujo de ingresos de **Servicios Premium** y la **Demanda Institucional de Foxy Finance**:

* **Servicios Premium Facturables:**
  - **Foxy Pro Tunnel ($19/mes):** Túneles dedicados, failover ultrarrápido (<1s) y certificados SSL automáticos.
  - **Enterprise dVPN Business ($49/mes):** IPs residenciales estáticas dedicadas y pools de ancho de banda garantizado.
* **Modelo de Reparto de Ingresos (Smart Contract `FoxyTreasuryVault.sol`):**
  - 👑 **40% Margen del Fundador:** Ingreso neto directo a la billetera del creador del proyecto.
  - 🏦 **45% Reserva de Donantes:** queda en la bóveda y el propietario del contrato la desembolsa a los donantes. **No fija ni garantiza un precio** para `$FOXY`.
  - 🔥 **15% Recompra y Quema:** los pagos en `$FOXY` queman ese 15% en el acto; en pagos con moneda nativa se aparta para que el propietario lo recompre en un DEX y lo queme (el contrato no integra un router DEX).

> El motor `PremiumEngine` del controlador es un **modelo contable simulado**: no custodia fondos. El dinero real solo se mueve a través de `FoxyTreasuryVault.sol`.

### 📈 Respaldo Institucional por Cómputo de Foxy Finance
El ecosistema **Foxy Finance** cubre una parte significativa de su capacidad de cómputo en la nube (cálculo de riesgo DeFi Monte Carlo, escaneo de arbitraje multi-DEX y liquidación de libros contables) ejecutándose directamente sobre los nodos de Foxy Network. Los nodos ejecutan únicamente trabajos de un catálogo fijo (Monte Carlo, álgebra lineal, SHA-256, sondas de latencia) y cobran `$FOXY` por cada unidad de cómputo verificada. Detalles en [`docs/FOXY_FINANCE_INTEGRATION.md`](docs/FOXY_FINANCE_INTEGRATION.md).

---

## 🛡️ Servicio VPN Descentralizado Cifrado (dVPN)

Foxy Network transforma los nodos donantes en repetidores de salida seguros para ofrecer navegación privada y anónima:

* **Cifrado cliente ↔ nodo de salida:** cada sesión acuerda una clave efímera con **X25519** y cifra con **AES-256-GCM**. El gateway solo retransmite el texto cifrado. *Limitación conocida:* el intercambio aún no está autenticado con la identidad del nodo, así que un gateway malicioso podría interponerse activamente; el tráfico HTTPS sigue protegido por su propio TLS.
* **Sin registro de destinos:** el software del nodo no escribe en sus logs los hosts visitados. Como en cualquier VPN, el nodo de salida ve a qué servidor se conecta cada sesión (no su contenido si es HTTPS).
* **Firewall de Protección para el Donante:** el repetidor solo abre conexiones a **direcciones públicas** en los puertos web (80, 443, 8080, 8443). Nunca alcanza `localhost`, la red local del donante ni direcciones de metadatos de nube, y resuelve el DNS una sola vez para evitar *DNS rebinding*.

### Cómo usar la VPN:
1. **Iniciar el Cliente Proxy Local:**
   ```bash
   node packages/foxy-cli/bin/foxy.js vpn connect
   ```
   *(Inicia un proxy HTTP / HTTP CONNECT local en `127.0.0.1:1080`)*.
2. **Navegar a través de la Red Foxy:**
   Configura tu navegador (Chrome, Firefox) o cliente para usar el proxy `127.0.0.1:1080`.
   O prueba en terminal:
   ```bash
   curl -x http://127.0.0.1:1080 https://api.ipify.org
   ```
   Tu tráfico saldrá a internet con la IP del nodo donante asignado y de forma completamente cifrada.

---


---

## 🔗 Integración con FOXY FINANCE

Foxy Network es la capa de infraestructura de **[FOXY FINANCE](https://github.com/IAmMRPrince/foxy-finance)**. Los dos proyectos se conectan por una API firmada (HMAC-SHA256); la guía completa y los clientes listos para usar están en [`docs/FOXY_FINANCE_INTEGRATION.md`](docs/FOXY_FINANCE_INTEGRATION.md).

1. **Vincular hardware con la cuenta.** El donante pulsa *Generar código de vinculación* en su panel (o `foxy link`) y escribe ese código de un solo uso en Foxy Finance. Solo quien controla el nodo puede generarlo, así que nadie puede atribuirse el nodo de otro usuario.
2. **Descuentos por hardware aportado.** Foxy Finance consulta el beneficio del usuario antes de cobrar. El nodo debe seguir en línea (≥ 50 % de las últimas 24 h):

   | Equipo | Clase | Beneficio en Foxy Finance |
   | :--- | :--- | :--- |
   | Microcontrolador / IoT | `IOT` | 15 % de descuento *(reservado: el daemon actual requiere Node.js)* |
   | Celular Android (Termux) | `MOBILE` | 25 % |
   | Raspberry Pi / SBC | `SBC` | 50 % |
   | PC / laptop | `PC` | 70 % |
   | Servidor VPS / bare metal (≥ 4 núcleos, ≥ 8 GB) | `SERVER` | 100 % — plan Pro Quant |

3. **Cómputo distribuido verificado.** Foxy Finance envía trabajos de un **catálogo fijo** (`monte_carlo_gbm`, `matrix_benchmark`, `sha256_benchmark`, `latency_probe`) indicando solo parámetros. Los nodos nunca reciben código ni datos de estrategias. Con `replicas: 2` o `3` el mismo trabajo se ejecuta en varios nodos y solo se paga a los que coinciden.
4. **Pago con `$FOXY`.** Un nodo vinculado puede pagar un plan de Foxy Finance quemando su saldo (`foxy finance pay FOXY_FINANCE_TRADER_PRO`), o on-chain con `FoxyTreasuryVault.paySubscriptionWithFoxy()`.

## 🌐 Dominios `.fox` y alojamiento de Foxy Finance

El gateway resuelve dominios `.fox` y los sirve por HTTP (`:8080`) y HTTPS (`:8443`) con un certificado local autofirmado:

| Dominio | Destino |
| :--- | :--- |
| `www.foxynetwork.fox` | Portal del gateway |
| `www.foxyfinance.fox`, `www.foxyfianance.fox` | Túnel `foxy-finance` (el SaaS de Foxy Finance) |
| `<app>.foxynetwork.fox` | Túnel `<app>` |

- **Abrirlos en tu navegador:** `node packages/foxy-cli/bin/foxy.js domains setup` (o `Configurar-Dominios-Fox.bat` en Windows) añade los dominios al archivo `hosts` y, en Windows, confía en el certificado local. Alternativa sin permisos de administrador: usar el proxy `foxy vpn connect`, que envía los nombres `.fox` al gateway.
- **Publicar Foxy Finance desde tu nodo:** arranca el daemon con `FOXY_HOST_FINANCE=1`. Conecta el túnel `foxy-finance` con `127.0.0.1:8000` (`FOXY_FINANCE_PORT`) y, si no hay nada escuchando y existe la carpeta del proyecto (`FOXY_FINANCE_DIR` o una carpeta `FOXY FINANCE` junto a este repo), lo lanza con `uvicorn`. `npm start` lo activa solo cuando encuentra esa carpeta. Es una opción para el nodo del operador: los nodos de los donantes no la activan.
- `.fox` no es un dominio de internet real: solo funciona en equipos configurados así o a través del proxy. Para puertos 80/443 sin número en la URL, `FOXY_BIND_STANDARD_PORTS=true` (requiere privilegios).

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
node packages/foxy-cli/bin/foxy.js claim 0xTuDireccionMetaMask

# Vincular este nodo con tu cuenta de Foxy Finance (genera un código de un solo uso):
node packages/foxy-cli/bin/foxy.js link

# Estado del enlace con Foxy Finance / lanzar un trabajo de prueba con 2 réplicas:
node packages/foxy-cli/bin/foxy.js finance status
node packages/foxy-cli/bin/foxy.js finance dispatch monte_carlo_gbm 2

# Desplegar un servicio web en la red:
node packages/foxy-cli/bin/foxy.js deploy mi-app "Mi Aplicacion Cloud"
```

---

## 📄 Licencia
Distribuido bajo la licencia **Apache-2.0**. Desarrollado para la comunidad de código abierto y computación descentralizada.
