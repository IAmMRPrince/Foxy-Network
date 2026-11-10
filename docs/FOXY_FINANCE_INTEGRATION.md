# Integración Foxy Finance ↔ Foxy Network

Esta guía es para quien mantiene el backend de **Foxy Finance**. Explica cómo conectar las dos plataformas para que:

1. un usuario de Foxy Finance vincule el hardware que aporta a Foxy Network,
2. Foxy Finance le aplique el descuento que ese hardware le da,
3. Foxy Finance descargue cómputo genérico en los nodos y lo pague en `$FOXY`,
4. el usuario pueda pagar su plan con `$FOXY`.

Foxy Finance nunca necesita el secreto de red ni acceso a los nodos: habla solo con el **controlador** de Foxy Network mediante una API firmada.

```
 Usuario ──(1) genera código en su nodo──▶ Daemon ──▶ Controlador
 Usuario ──(2) pega el código──▶ Foxy Finance ──(3) redeem firmado──▶ Controlador
 Foxy Finance ──(4) benefits / jobs / payments (firmado)──▶ Controlador ──▶ Nodos
```

## 1. Configuración (una sola vez)

En el servidor del controlador:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Pon ese valor en `FOXY_FINANCE_API_SECRET` del controlador **y** en la configuración de Foxy Finance. (Si no lo defines, el controlador genera uno en `.foxy/finance-api-secret`.) El identificador de clave por defecto es `foxy-finance` (`FOXY_FINANCE_KEY_ID`).

En producción, publica el controlador detrás de HTTPS.

## 2. Cliente listo para usar

| Lenguaje | Archivo | Dependencias |
| :--- | :--- | :--- |
| Python | [`integrations/python/foxy_network_client.py`](../integrations/python/foxy_network_client.py) | ninguna (biblioteca estándar) |
| JavaScript | [`packages/foxy-finance-workload/src/network-client.js`](../packages/foxy-finance-workload/src/network-client.js) | ninguna (Node ≥ 20) |

```python
import os
from foxy_network_client import FoxyNetworkClient, FoxyNetworkError

foxy = FoxyNetworkClient(
    base_url=os.environ["FOXY_NETWORK_URL"],          # https://controller.tu-dominio
    secret=os.environ["FOXY_FINANCE_API_SECRET"],
)
```

## 3. Vincular el nodo de un usuario

El usuario abre el panel de su nodo (`http://localhost:4040`) y pulsa **Generar código de vinculación** (o ejecuta `foxy link`). Obtiene un código como `QFS7V-WFNTS`, válido 10 minutos y de un solo uso. Lo pega en Foxy Finance, y el backend hace:

```python
user_id = TenantContext.get_user_id()        # SIEMPRE de la sesión autenticada
try:
    link = foxy.redeem_link_code(code_from_form, user_id)
except FoxyNetworkError as err:
    ...  # 404: código inválido o caducado · 429: demasiados intentos
```

**Por qué esto evita el IDOR.** El código solo puede generarlo quien controla el nodo, y solo puede canjearlo el backend de Foxy Finance (petición firmada) para el usuario de la sesión. Ninguna de las dos partes puede, por sí sola, atribuir un nodo a una cuenta ajena. La única regla que debe cumplir Foxy Finance: **no aceptar el `user_id` desde el formulario o la URL**.

Un nodo pertenece a un solo usuario a la vez; un usuario puede tener varios nodos. El donante puede desvincular desde su panel, y Foxy Finance con `foxy.revoke_link(node_id, user_id)`.

## 4. Consultar el beneficio antes de cobrar

```python
b = foxy.get_user_benefits(user_id)
discount = b["discountPercent"]      # 0, 15, 25, 50, 70 o 100
plan     = b["grantedPlan"]          # "PRO_QUANT" o None
```

| Clase | Equipo | Descuento |
| :--- | :--- | :--- |
| `IOT` | Microcontrolador / IoT | 15 % |
| `MOBILE` | Celular Android (Termux) | 25 % |
| `SBC` | Raspberry Pi / SBC | 50 % |
| `PC` | PC / laptop | 70 % |
| `SERVER` | VPS / bare metal | 100 % + plan Pro Quant |

Un nodo cuenta si ha enviado latido en los últimos 15 minutos **y** ha estado en línea al menos el 50 % de las últimas 24 h. Si no, `nodes[i].ineligibleReason` dice por qué (`NODE_OFFLINE`, `UPTIME_BELOW_MINIMUM`, `NODE_NOT_SEEN`). Se aplica el mejor descuento entre los nodos del usuario.

Consulta el beneficio **en cada ciclo de cobro**, no lo guardes indefinidamente: el descuento existe mientras el nodo siga aportando.

> **Límite conocido.** La clase de equipo la declara el propio nodo. El controlador solo rebaja a `PC` a quien se declara `SERVER` sin tener ≥ 4 núcleos y ≥ 8 GB. Para el 100 % de descuento conviene exigir además un mínimo de unidades de cómputo completadas (`nodes[i].lifetimeComputeUnits`), que sí es trabajo verificado.

## 5. Enviar cómputo a la red

Foxy Finance elige un trabajo de un **catálogo fijo** y envía solo parámetros. Los nodos nunca reciben código, posiciones ni estrategias.

| Tipo | Qué calcula | Parámetros principales |
| :--- | :--- | :--- |
| `monte_carlo_gbm` | Simulación Monte Carlo de movimiento browniano geométrico: media, percentiles, VaR y CVaR al 95 % y 99 % | `paths`, `steps`, `s0`, `mu`, `sigma`, `horizonYears`, `seed` |
| `matrix_benchmark` | Producto de matrices densas | `size`, `seed` |
| `sha256_benchmark` | Cadena de hashes SHA-256 | `iterations`, `seed` |
| `latency_probe` | Latencia TCP desde la red del donante a hosts públicos (puertos 80/443) | `targets: [{host, port}]`, `samples` |

```python
job = foxy.run_job(
    "monte_carlo_gbm",
    {"paths": 100_000, "steps": 30, "s0": 64_250, "mu": 0.05, "sigma": 0.62, "seed": 20261110},
    replicas=2,                       # validación cruzada entre 2 nodos
    idempotencyKey="risk-btc-2026-11-10",
)
if job["status"] == "COMPLETED":
    var_99 = job["result"]["valueAtRisk99"]
```

- **Validación cruzada.** Con `replicas` 2 o 3 el mismo trabajo se ejecuta en nodos distintos. Los trabajos son deterministas para una `seed`, así que los resultados deben coincidir exactamente. Si no hay mayoría, el trabajo queda `FAILED` y no se paga a nadie; si la hay, solo cobran los nodos que coincidieron (`verification.dissentingNodes` lista a los demás). Con `replicas: 1` confías en un solo nodo.
- **Pago.** Cada unidad de cómputo verificada (FCC) acredita 3,50 `$FOXY` al nodo. `job["computeUnits"]` dice cuántas vale el trabajo por nodo.
- **Tiempos.** Un nodo tiene 90 s por intento; un trabajo sin completar a los 10 minutos queda `FAILED`.
- `latency_probe` no admite réplicas: cada nodo mide su propia red (`attempts[i].result`).

## 6. Pago de planes con `$FOXY`

- **Saldo sin reclamar del nodo:** el donante ejecuta `foxy finance pay FOXY_FINANCE_TRADER_PRO` (325 `$FOXY`) o `FOXY_FINANCE_INSTITUTIONAL_DESK` (1320 `$FOXY`). El controlador quema ese saldo y Foxy Finance lo ve con `foxy.get_user_payments(user_id)`. El nodo debe estar vinculado.
- **Tokens ya en la billetera (on-chain):** `approve` + `FoxyTreasuryVault.paySubscriptionWithFoxy(planId, amount)`. Quema el 15 %, envía el 40 % al fundador y deja el 45 % como reserva de donantes; `isSubscribed(wallet, planId)` indica si el plan está vigente.

## 7. Referencia de la API

Todas las rutas van bajo `/api/partner/v1` y exigen tres cabeceras:

```
X-Foxy-Key-Id:    foxy-finance
X-Foxy-Timestamp: <segundos unix>
X-Foxy-Signature: hex( HMAC_SHA256( secreto, "<timestamp>.<MÉTODO>.<ruta con query>.<sha256 hex del cuerpo>" ) )
```

El reloj puede diferir como máximo 5 minutos. El cuerpo firmado debe ser, byte a byte, el que se envía.

| Método y ruta | Uso |
| :--- | :--- |
| `GET /network` | Nodos en línea por clase, tipos de trabajo, matriz de beneficios |
| `POST /links/redeem` `{code, userId}` | Vincular nodo ↔ usuario |
| `POST /links/revoke` `{nodeId, userId}` | Desvincular |
| `GET /users/{userId}/benefits` | Descuento y nodos del usuario |
| `GET /users/{userId}/payments` | Planes pagados con `$FOXY` |
| `POST /jobs` `{type, params, replicas?, idempotencyKey?, externalRef?, billingUsd?}` | Enviar trabajo |
| `GET /jobs/{id}` | Estado y resultado |

## 8. Probarlo en local

```bash
npm install
```

```bash
npm start
```

```bash
node packages/foxy-cli/bin/foxy.js finance dispatch monte_carlo_gbm
```

```bash
npm test
```

`npm start` levanta gateway, controlador, un nodo y una demo que envía trabajos reales cada 25 s usando el cliente JavaScript.
