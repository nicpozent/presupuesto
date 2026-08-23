# Handoff: Brote — presupuesto personal con seguimiento de precios

## Qué es esto

Paquete de handoff para implementar **Brote** en un codebase real, desplegado en
Cloudflare. Todo el producto está en español rioplatense y asume moneda ARS con
inflación relevante.

Brote hace tres cosas:

1. **Análisis de gastos ajustado por inflación.** Toda comparación mes contra mes
   se muestra en pesos constantes, para distinguir "gasté más" de "todo salió más caro".
2. **Presupuesto y objetivos** con sobres por categoría, ingresos, compromisos fijos,
   cuotas y aguinaldo.
3. **Seguimiento de precios** de los productos que el hogar compra siempre, contra
   varios comercios, más cotizaciones de moneda e inflación oficial.

## Sobre los archivos de diseño

Los archivos en `design-reference/` son **referencias de diseño hechas en HTML**:
prototipos que muestran el aspecto y el comportamiento buscados, **no código de
producción para copiar**. `Brote Budget.dc.html` es un solo archivo con toda la UI
en estilos inline y datos de demostración embebidos; corre en un runtime propietario
(`support.js`) que no se despliega.

La tarea es **recrear estos diseños en el entorno del codebase destino** siguiendo
sus patrones. Si no hay codebase todavía, la recomendación concreta para Cloudflare
está en `SDD.md`.

## Fidelidad

**Alta (hi-fi).** Colores, tipografía, espaciado, jerarquía y copy son finales.
El copy en español debe tomarse **literal**: está escrito para el producto, no es
relleno. La UI debe recrearse fielmente usando el sistema de diseño incluido en
`design-reference/_ds/`, cuyos tokens están listados en `SDD.md` §11.

## Archivos del paquete

| Archivo | Para qué |
|---|---|
| `README.md` | Este mapa |
| `EMPEZAR.md` | Cómo arrancar el desarrollo: decisiones previas, primer mensaje a Claude Code, orden de etapas |
| `CLAUDE.md` | Instrucciones persistentes para Claude Code: stack, convenciones, reglas del dominio, qué no romper |
| `SDD.md` | Documento de diseño de software: arquitectura, cada pantalla en detalle, modelo de datos, API, matemática financiera, tokens |
| `schema.sql` | Esquema completo de Cloudflare D1, listo para `wrangler d1 execute` |
| `api-contract.md` | Todos los endpoints con request/response de ejemplo |
| `wrangler.example.toml` | Configuración de Workers, D1, KV, R2 y Cron |
| `DEPLOY.md` | Runbook de deployment en Cloudflare, de cuenta vacía a producción |
| `screenshots/` | Las diez vistas principales, 1440px de ancho |
| `design-reference/` | El prototipo HTML y el sistema de diseño (tokens, componentes) |

## Screenshots

Dieciocho capturas a 1440 px de ancho, recapturadas contra la versión actual del
prototipo. Los diálogos están recortados a su propio marco, a 2x.

| Archivo | Vista |
|---|---|
| `01-resumen.png` | Resumen — KPIs, serie nominal vs. real, proyección, cierre de mes |
| `02-analisis-gastos.png` | Análisis de gastos — tabla de categorías, insights, suscripciones |
| `03-movimientos-mes.png` | Movimientos — "Quién gastó qué", libro del mes, filtros, histórico 44 meses |
| `04-movimientos-anual.png` | Movimientos → Por año — resumen anual y exportación |
| `05-ingresos-compromisos.png` | Ingresos, vencimientos, cuotas por producto, aguinaldo, plata quieta |
| `06-presupuesto-objetivos.png` | Sobres, administración de categorías, objetivos con dueño |
| `07-precios-productos.png` | Productos seguidos con precio por comercio |
| `08-precios-canasta.png` | Canasta semanal comparada y plan de compra dividida |
| `09-precios-lista-compras.png` | Lista de compras por comercio |
| `10-precios-avisos.png` | Avisos de baja de precio y de vencimientos |
| `11-divisas-inflacion.png` | USD/EUR/CHF (BNA y xe.com) e inflación |
| `12-en-el-telefono.png` | Las cuatro acciones móviles |
| `13-conexiones.png` | Fuentes de datos, comercios propios, privacidad, alertas |
| `14-ayuda.png` | Centro de ayuda — 29 temas en 7 secciones |
| `15-onboarding.png` | Guía de configuración, tres pasos |
| `16-dialogo-registrar-compra.png` | Diálogo de carga: modo, categoría, de quién es, recurrencia |
| `17-dialogo-editar-movimiento.png` | Diálogo de edición con persona y regla recurrente |
| `18-perfil-valentina.png` | La misma pantalla filtrada por persona |

## Autenticación con Google: sí

Google es la única opción de login que hace falta, y en Cloudflare el camino corto
es **Cloudflare Access con Google como proveedor de identidad**: el Worker recibe el
JWT `Cf-Access-Jwt-Assertion` ya validado por el borde y no hay que escribir flujo
OAuth. Sirve bien para un hogar o un piloto cerrado.

Para producto abierto conviene **OAuth 2.0 + PKCE contra Google directamente** dentro
del Worker, con la sesión en una cookie `HttpOnly; Secure; SameSite=Lax` firmada, y el
`refresh_token` cifrado en D1. `SDD.md` §7 tiene el flujo completo, los scopes y el
manejo de sesión; `api-contract.md` los endpoints `/auth/*`.

## Lo primero que hay que decidir con el usuario

Dos puntos de `SDD.md` §6 necesitan definición del negocio antes de codear el
scraping de precios: qué comercios se consultan por API oficial y cuáles por
scraping, y con qué frecuencia. Está documentado como decisión abierta, no resuelto.
