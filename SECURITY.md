# Seguridad

Foxy Network es un **prototipo**. No ha pasado una auditoría externa. No lo uses con fondos reales ni lo despliegues en mainnet sin una.

## Cómo reportar una vulnerabilidad

Usa **Security → Report a vulnerability** en el repositorio de GitHub (reporte privado). No abras un issue público con los detalles.

## Modelo de seguridad

| Componente | Quién puede usarlo | Cómo se autentica |
| :--- | :--- | :--- |
| Panel del donante (`:4040`) | Solo el propio equipo | Escucha en `127.0.0.1`, comprueba la cabecera `Host`, no envía CORS y exige un token de sesión en cada llamada a la API |
| API de nodos del controlador | Cada nodo, sobre sí mismo | Token de identidad firmado por el controlador (`Authorization: Bearer`) |
| API de operador | Operador de la red | `X-Foxy-Admin-Key` |
| API de Foxy Finance | Backend de Foxy Finance | Peticiones firmadas con HMAC-SHA256 y marca de tiempo |
| Túneles y repetidores dVPN | Nodos registrados | Tokens emitidos por el controlador |

Los secretos se generan al azar en la carpeta `.foxy/` (ignorada por git) o se leen de variables de entorno. La clave del oráculo es independiente del resto. Los nodos donantes **no** tienen el secreto de red.

## Si usaste una versión anterior a la 0.2

- El archivo `.foxy-network-secret` estuvo publicado en el repositorio y el texto `foxy-depin-cluster-shared-secret-v1` estaba en el código. **Considera comprometido todo lo derivado de ellos**: tokens de subdominio, claves de sesión dVPN y, sobre todo, la clave del oráculo antiguo. Si desplegaste `FoxyToken` con ese oráculo, cámbialo con `setNetworkOracle()` de inmediato.
- El panel antiguo entregaba la clave privada de la billetera a cualquier página web. Si tu billetera auto-generada tuvo fondos, **muévelos a una billetera nueva**.
- Quitar el archivo del repositorio no lo borra del historial de git.

## Limitaciones conocidas

- **Ancho de banda auto-reportado.** Los bytes servidos los informa el nodo; el controlador solo los limita por latido. El tiempo en línea sí lo mide el controlador. Falta que el gateway mida el tráfico.
- **Clase de equipo auto-declarada.** Ver `docs/FOXY_FINANCE_INTEGRATION.md`.
- **dVPN sin autenticación del nodo de salida.** El intercambio de claves protege frente a un gateway que solo observa, no frente a uno que se interpone activamente. El nodo de salida ve a qué servidor va cada conexión.
- **Trabajos con una sola réplica** confían en el nodo que los ejecuta. Usa `replicas: 2` o `3` para verificarlos.
- **Cargas `docker`.** Ejecutan la imagen que indique el operador de la red, con límites de CPU, memoria y procesos, pero sin un aislamiento reforzado. Las cargas `python` y `node` solo sirven una página fija.
- **Estado en un archivo JSON** (`.foxy/controller-state.json`), válido para un solo controlador.
- **Contratos sin auditar** y con funciones de propietario (cambiar oráculo, porcentajes, desembolsar reservas): quien tenga la clave del propietario controla los fondos de la bóveda.
- El `PremiumEngine` del controlador es un modelo contable simulado; no representa fondos reales ni un precio de mercado.
