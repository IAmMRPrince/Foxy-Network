import fs from 'node:fs';

const mocPath = 'D:\\Obsidian\\Mister Prince\\Aprendizaje\\06-Proyectos-Personales\\MOC-FOXY-PROYECTOS.md';

const updatedContent = `---
created: 2026-08-28
updated: 2026-10-23
tags: [FOXY, proyectos, IA, automatizacion, SaaS, ciberseguridad, DePIN, dVPN, Web3, Scorpion-Apex-Group]
aliases: [Proyectos FOXY, Ecosistema FOXY, Mapa de Proyectos FOXY]
related: ["[[MOC-Principal]]", "[[MOC-IA]]", "[[FOXY-NETWORK]]", "[[FOXY FINANCE]]"]
---

# 🦊 MOC - Proyectos FOXY (Mapa Maestro)

> **Objetivo**: Ecosistema Integrado de IA + Trading Cuantitativo + DePIN + dVPN + SaaS  
> **Empresa Matriz / OpCo**: Scorpion Apex Group S.A.S.  
> **Fundador & Desarrollador Principal**: Dalton Yaid Torres Rondon  
> **Última actualización**: 2026-10-23 (Integración de Foxy Network DePIN, Tokenomics $FOXY y dVPN)

---

## 🎯 Visión General del Ecosistema

\`\`\`
┌─────────────────────────────────────────────────────────────────────────┐
│                        SCORPION APEX GROUP                              │
│                    (Sociedad Matriz / OpCo S.A.S.)                      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│  FOXY FINANCE   │          │   FoxyLearner   │          │   Foxy Reader   │
│ (SaaS Cuant.)   │          │   (IA & LLMs)   │          │ (Datos / OCR)   │
│ [[FOXY FINANCE]]│          │  Fine-Tuning    │          │  Extracción     │
└────────┬────────┘          └────────┬────────┘          └────────┬────────┘
         │                            │                            │
         └────────────────────────────┼────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     FOXY NETWORK (DePIN & dVPN)                         │
│                    Nota Maestra: [[FOXY-NETWORK]]                       │
│  - Capa de Cómputo Descentralizado & Servidores en la Nube              │
│  - Red dVPN Cifrada (AES-256-GCM / Zero-Logs / Filtro Antifraude)        │
│  - Token $FOXY + FoxyTreasuryVault (40% Fundador / 45% Backing / 15% Burn)│
│  - Cliente Ancla: FOXY FINANCE (Simulaciones Monte Carlo & Arbitraje)   │
│  - Monorepo: D:\\OneDrive\\Desktop\\Foxy\\Foxy Network                      │
└─────────────────────────────────────────────────────────────────────────┘
\`\`\`

---

## 📊 Arquitectura de los Componentes

### 🌐 1. FOXY NETWORK — Infraestructura Física Descentralizada (DePIN) & dVPN
* **Nota Maestra:** [[FOXY-NETWORK]]
* **Repositorio:** \`D:\\OneDrive\\Desktop\\Foxy\\Foxy Network\` | [GitHub](https://github.com/IAmMRPrince/Foxy-Network)
* **¿Qué es?**: Red distribuida que permite a usuarios en Windows, macOS y Linux donar recursos ociosos de CPU, RAM y ancho de banda, obteniendo recompensas en el token \`$FOXY\`.
* **Servicios Activos:**
  * **Ingress Gateway Inverso:** Multiplexación de tráfico web por subdominios firmados (\`:8080\` / \`:8081\`).
  * **Servicio dVPN Cifrado:** Túneles seguros punto a punto con proxy local en \`127.0.0.1:1080\`.
  * **Bóveda de Tesorería On-Chain (\`FoxyTreasuryVault.sol\`):** Recauda ingresos de suscripciones Pro ($19 a $299 USD/mes), distribuyendo el **40% de margen neto a Dalton Yaid Torres**, **45% al fondo de respaldo de liquidez** y **15% a buyback-and-burn**.
  * **Cliente Ancla de Cómputo:** [[FOXY FINANCE]] procesa sus simulaciones pesadas en la red, generando demanda real desde el día 1.

---

### 📈 2. FOXY FINANCE — SaaS Cuantitativo de Trading Algorítmico
* **Nota Maestra:** [[FOXY FINANCE]] | [[FOXY-FINANCE-ANALISIS]]
* **Repositorio:** \`D:\\OneDrive\\Desktop\\Foxy\\FOXY FINAINCE\`
* **¿Qué es?**: Plataforma cuantitativa basada en FastAPI con motor híbrido (Hurst, Amihud, Teoría de Juegos Bayesiana, Kelly Fraccional, Filtro OBI y Pesos Adaptativos de Kalman).
* **Precios & Tiers:** 9.90 € / 29 € / 79 € / 299 € mensuales.
* **Integración con Network:** Ejecuta sus barridos de arbitraje multi-DEX y simulaciones de riesgo Monte Carlo sobre los nodos de [[FOXY-NETWORK]], pagando tarifas computacionales en el pool de tesorería.

---

### 🧠 3. FoxyLearner — Entrenamiento & Fine-Tuning de IA Local
* **Ubicación:** \`D:\\OneDrive\\Desktop\\Foxy\\FoxyProject\\FoxyLearner\`
* **¿Qué es?**: Motor de ajuste fino de LLMs (HuggingFace, Llama, GPT-2) optimizado para operar en hardware local o descargado a nodos de [[FOXY-NETWORK]].

---

### 📄 4. Foxy Reader — Extracción & Procesamiento Documental
* **Ubicación:** \`D:\\OneDrive\\Desktop\\Foxy\\foxy reader\`
* **¿Qué es?**: Pipeline de ingestión y OCR para documentos estructurados, PDFs y transcripciones multimedia, alimentando datos limpios a FoxyLearner y Foxy Finance.

---

## 🪙 Modelo de Tres Activos del Ecosistema

| Activo | Función | Mecánica |
| :--- | :--- | :--- |
| **\`$FOXY\`** | Token de utilidad y gobernanza protocolar (ERC-20, cap 1B) | Minteo por Proof-of-Contribution ($RU_i$). Quema deflacionaria por uso de red. |
| **\`FXC\`** | Foxy Credit (Crédito de uso fijo = 0.01 USD) | Empleado por usuarios residenciales para dVPN y acceso a túneles sin volatilidad. |
| **\`FCC\`** | Foxy Compute Credit (1 FCC = 1 vCPU/GPU-hora estándar) | Empleado por [[FOXY FINANCE]] y clientes B2B para pagar cómputo institucional. |

---

## ⚖️ Marco Legal & Gobierno Corporativo
* **OpCo (Scorpion Apex Group S.A.S.):** 100% propiedad del fundador. Facturación comercial, compliance DIAN (Res. 240/2025), IVA 19%, y relaciones con operadores ISP.
* **Flujo Financiero del Fundador:** 40% del margen bruto de suscripciones y cómputo transferido directamente desde la Bóveda de Tesorería, más 20% de asignación de tokens con cliff de 12 meses y vesting a 48 meses.
* **Seguridad de Red:** Zero-Logs estricto y firewall activo (bloqueo de puertos SMTP 25, SSH 22, SMB 445) para proteger la responsabilidad civil de los donantes.

---

## 🔗 Conexiones & Notas Maestras
* [[FOXY-NETWORK]] — Red DePIN, dVPN, Smart Contracts y Valuación
* [[FOXY FINANCE]] — Motor Cuantitativo y Entitlements
* [[FOXY-FINANCE-ANALISIS]] — Análisis Econométrico y Algorítmico
* [[FOXY SOFTWARES]] — Catálogo General de Soluciones
* [[MOC-Principal]] — Índice General del Vault
`;

fs.writeFileSync(mocPath, updatedContent, 'utf-8');
console.log('✅ MOC-FOXY-PROYECTOS.md actualizado exitosamente en:', mocPath);
