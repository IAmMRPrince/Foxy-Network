# 🦊 Foxy Network

> **Red de Servidores Descentralizada en la Nube (DePIN)**  
> Conectando recursos de cómputo, almacenamiento y ancho de banda donados por la comunidad a través de agentes y extensiones ligeras.

---

## 🎯 Objetivo General
Permitir que cualquier usuario con un dispositivo conectado a internet pueda virtualizar y donar/monetizar sus recursos ociosos (CPU, GPU, RAM, red) mediante una extensión de navegador o cliente ligero, creando una alternativa accesible, distribuida y económica a los proveedores de nube tradicionales (AWS, GCP, Azure).

---

## 🧭 Documentación & Planificación
- Plan maestro, arquitectura y matriz de riesgos: [foxy_network_master_plan.md](file:///C:/Users/yaidt/.gemini/antigravity-ide/brain/76adcbc3-8267-41ac-b9a4-1c8c5872ca9e/foxy_network_master_plan.md)

---

## 🏗️ Módulos Implementados (PoC Operativa)

| Módulo | Directorio | Puerto Local | Rol / Función |
| :--- | :--- | :--- | :--- |
| **`foxy-gateway`** | `packages/foxy-gateway` | `8080` (HTTP) / `8081` (WS) | Pasarela de entrada pública que multiplexa peticiones externas hacia los túneles inversos con verificación de firma JWT. |
| **`foxy-controller`**| `packages/foxy-controller` | `4000` (HTTP) | Plano de control y orquestador: registro de nodos, telemetría, balanceo y emisión de tokens criptográficos de autorización. |
| **`foxy-daemon`** | `packages/foxy-daemon` | `4040` (UI) / Puertos dinámicos | Daemon donante con **WorkloadEngine**: soporte dual para Contenedores OCI (Docker/Podman) y Sandbox Nativo de Procesos (Python 3 / Node.js 24 / Web Estática) con túneles inversos simultáneos y firma de autenticación. |
| **`foxy-security`** | `packages/foxy-security` | Biblioteca Compartida | Motor de seguridad criptográfica: emisión y verificación de tokens de capacidad JWT HMAC-SHA256 e identidades asimétricas Ed25519 anti-suplantación. |
| **`foxy-cli`** | `packages/foxy-cli` | CLI (`foxy`) | Herramienta para consultar estado (`foxy status`), nodos (`foxy nodes`) y desplegar apps (`foxy deploy`). |

---

## 🚀 Cómo Ejecutar el Sistema en Windows

### Opción A: En un Clic (Recomendada para Donantes)
* **Acceso Directo en el Escritorio:** Haz doble clic en el acceso directo recién creado en tu Escritorio: **`Foxy Network`**.
* **Bandeja del Sistema (`Foxy-Tray.bat`):** Ejecuta el nodo donante en segundo plano con un icono silencioso en la bandeja del sistema (junto al reloj de Windows).
  - Clic derecho en el icono: abre el panel web, consulta tu balance de `$FOXY`, pausa la donación o cierra la app.
* **Lanzador Totalmente Silencioso (`Foxy-Daemon-Silent.vbs`):** Ejecuta todo el sistema en segundo plano sin ninguna ventana de consola negra visible.
* **Lanzador con Consola (`Foxy-Network.bat`):** Ejecuta el sistema mostrando la consola interactiva en tiempo real.

### Opción B: Mediante Consola de Comandos
```bash
# Iniciar todos los servicios simultáneamente:
npm run start:all

# O iniciar cada servicio por separado:
npm run start:gateway     # Inicia el Ingress Gateway en http://localhost:8080
npm run start:controller  # Inicia el Orquestador en http://localhost:4000
npm run start:daemon      # Inicia el Daemon del Donante en http://localhost:4040
```

---

## 🖥️ Enlaces Rápidos en tu Máquina
- **Panel del Donante:** [http://localhost:4040](http://localhost:4040)
- **Portal Ingress Gateway:** [http://localhost:8080](http://localhost:8080)
- **Panel del Orquestador:** [http://localhost:4000](http://localhost:4000)
- **Servidor Demo Descentralizado (vía Túnel Inverso):** [http://localhost:8080/t/foxy-demo-app/](http://localhost:8080/t/foxy-demo-app/)

---

## 🛠️ Comandos de CLI (`foxy-cli`)
```bash
# Ver el estado del gateway y del orquestador:
node packages/foxy-cli/bin/foxy.js status

# Listar los nodos donantes conectados y su consumo:
node packages/foxy-cli/bin/foxy.js nodes

# Registrar el despliegue de una nueva aplicación:
node packages/foxy-cli/bin/foxy.js deploy mi-app "Mi Servidor Descentralizado"

# Ver tabla de clasificación y total acuñado en la red ($FOXY):
node packages/foxy-cli/bin/foxy.js leaderboard

# Consultar el balance de recompensas y recibos de un nodo:
node packages/foxy-cli/bin/foxy.js balance

# Reclamar tokens $FOXY a una dirección de wallet:
node packages/foxy-cli/bin/foxy.js claim <nodeId> 0xTuDireccionWallet
```
