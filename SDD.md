# SDD — Brote

Documento de diseño de software. Versión 1.0, sobre el prototipo
`design-reference/Brote Budget.dc.html`.

---

## 1. Alcance

Aplicación web de presupuesto personal para un hogar argentino. Tres capacidades:
análisis de gastos ajustado por inflación, planificación (sobres, ingresos,
compromisos, objetivos) y seguimiento de precios de productos habituales contra
varios comercios.

Fuera de alcance en v1: app nativa, pagos dentro de la app, débito automático,
inversiones más allá de mostrar rendimiento de plazo fijo y FCI money market.

## 2. Arquitectura en Cloudflare

```
Navegador (React SPA)
   │  fetch /api/*   cookie de sesión firmada
   ▼
Cloudflare Worker (Hono)
   ├── static assets  → la SPA
   ├── /auth/*        → Google OAuth 2.0 + PKCE
   ├── /api/*         → lectura y escritura
   ├── D1             → datos del hogar
   ├── KV             → cotizaciones, IPC, precios (cache con TTL)
   └── R2             → fotos de tickets
Cron Triggers
   ├── 0 11 * * *     → cotizaciones BNA + xe
   ├── 0 */6 * * *    → refresco de precios de productos seguidos
   ├── 0 12 15 * *    → IPC INDEC del mes
   └── 0 9 * * *      → alertas de vencimientos y de baja de precio
```

Un solo Worker. La SPA se sirve con `assets` del mismo Worker, así no hay CORS ni
dominio aparte. Región de D1: la más cercana a Sudamérica disponible al crear la base.

## 3. Modelo de datos

Esquema ejecutable en `schema.sql`. Resumen de tablas:

| Tabla | Contenido |
|---|---|
| `households` | Hogar, nombre visible ("Casa Domínguez"), moneda, zona horaria |
| `users` | Usuario, `google_sub`, email, nombre, avatar, rol en el hogar |
| `sessions` | Sesión firmada, expiración, user agent |
| `categories` | Categoría de gasto por hogar, con presupuesto mensual y flag de variable |
| `transactions` | Movimiento: fecha, comercio, detalle, categoría, importe en centavos, origen |
| `recurring_rules` | Regla recurrente: frecuencia, día, mes de inicio, importe, categoría |
| `incomes` | Ingreso por persona: tipo, importe, cuándo, si es fijo |
| `fixed_expenses` | Compromiso fijo: nombre, importe, día, nota de ajuste |
| `installments` | Producto en cuotas: nombre, comercio, precio total, cantidad, pagadas; la cuota se deriva |
| `goals` | Objetivo de ahorro: nombre, meta, acumulado, fecha objetivo |
| `watched_items` | Producto seguido: nombre, unidad, cantidad, cadencia, origen |
| `item_prices` | Precio por producto, comercio, fecha de consulta, fuente |
| `retailers` | Comercio: nombre, tipo de acceso (API/scraping), estado |
| `connections` | Qué fuentes habilitó el hogar, con su estado y último éxito |
| `fx_rates` | Cotización: moneda, compra, venta, fuente (bna/xe), fecha |
| `inflation` | IPC mensual del INDEC: año, mes, variación, índice |
| `receipts` | Foto de ticket: clave R2, estado de OCR, transacción resultante |
| `alerts` | Alerta generada: tipo, payload, leída |
| `audit_log` | Acciones sensibles: borrado, exportación, cambio de conexión |

Reglas transversales: toda tabla de datos lleva `household_id` y `created_at`;
importes en `INTEGER` de centavos; fechas en ISO 8601 UTC.

## 4. Vistas

Ocho vistas, navegación lateral fija de 252px. El contenido tiene `max-width: 1180px`.
Todas las medidas son las del prototipo a 1440px.

### 4.1 Resumen (`screenshots/01-resumen.png`)

Propósito: en una pantalla, si el mes viene bien o mal descontando la inflación.

- **Cuatro KPIs** en `repeat(auto-fit, minmax(210px, 1fr))`, tarjetas de
  `--radius-lg`, padding `20px 22px`, `--shadow-sm`. Etiqueta 11,5px mayúscula
  con `letter-spacing: 0.1em`; valor en Caprasimo 26px; nota 13px. Contenido:
  gastado en el mes, variación real, disponible, ahorro detectado.
- **Toggle nominal / real** como pastilla segmentada; afecta todas las series.
- **Serie histórica** de hasta 12 meses, barras verticales, altura 190px. Fuente
  única de verdad de los totales mensuales (§5.1).
- **Proyección** con selector de mes destino, hasta 12 meses adelante. Muestra el
  valor proyectado y su equivalente a valores de hoy, en textos separados.
- **Cierre de mes**: lo que salió bien, lo que no, y acciones concretas.
- Rango de histórico: 44 meses hacia atrás.

### 4.2 Análisis de gastos (`02-analisis-gastos.png`)

- **Tabla de categorías**: mes, mes anterior, variación nominal, variación real,
  presupuesto. La variación real es la columna que decide el color.
- **Insights** en tarjetas: desvío contra el propio promedio, suscripciones sin uso,
  cambio de comercio sugerido. Cada uno con acción.
- **Aumento por unidad**: producto, precio anterior, precio actual, variación.
  Grilla `minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)`.

### 4.3 Movimientos (`03-movimientos-mes.png`, `04-movimientos-anual.png`)

Dos ámbitos, pastilla "Por mes / Por año".

**Por mes**: selector de período (44 meses atrás + 6 adelante marcados
"programado"), buscador, filtro por categoría. Tabla con fecha, comercio y detalle,
categoría, origen, importe, editar. Las filas de una regla recurrente muestran
"Regla recurrente" y no ofrecen editar por ocurrencia. Pie con conteo de compras con
detalle y aclaración del total del mes.

**Por año**: selector 2023–2026. Total del año, total en pesos de hoy, promedio
mensual, mes más caro; doce barras mes a mes; desglose por categoría con
participación; seis comercios con mayor acumulado (aclarando que cubre solo
movimientos con comercio identificado); exportación a Excel.

**Registrar compra**: modal con tres modos (foto del ticket, total y categoría,
detalle completo) y un interruptor "Se repite todos los meses" con frecuencia y día.
**Editar movimiento**: mismos campos más el interruptor "Es un gasto recurrente".

### 4.4 Ingresos y compromisos (`05-ingresos-compromisos.png`)

Ingresos por persona con edición; poder de compra del sueldo contra inflación;
vencimientos ordenados por proximidad, con las reglas recurrentes del usuario
integradas; cuotas con progreso; aguinaldo proyectado; plata quieta con rendimiento
de plazo fijo y FCI.

### 4.5 Presupuesto y objetivos (`06-presupuesto-objetivos.png`)

Sobres por categoría con barra de consumo y presupuesto editable; agregar categoría;
objetivos de ahorro con meta, acumulado y fecha.

### 4.6 Precios (`07`, `08`, `09`)

Tres pestañas.

- **Productos**: cada producto seguido con precio por comercio ordenado de menor a
  mayor, el más barato marcado, precio por unidad, última compra, cadencia de compra,
  historial y segunda marca alternativa. Sugerencias detectadas en tickets.
- **Compra semanal**: canasta comparada comercio por comercio, con barras y
  diferencia contra el más barato; plan de compra dividida calculado agrupando cada
  producto en el comercio que hoy lo tiene más barato (si gana uno solo, lo dice).
  Grilla `repeat(auto-fit, minmax(280px, 1fr))`.
- **Cotizaciones e inflación**: USD, EUR y CHF con compra y venta del Banco Nación
  y referencia de xe.com por separado, serie de ocho semanas, e IPC del INDEC
  histórico y último dato.

Comercios en v1: Carrefour, Coto, Día, Diarco, Jumbo, Disco, Vea, Mercado Libre,
Farmacity, más "Almacén del barrio" como entrada manual.

### 4.7 Conexiones (`10-conexiones.png`)

El usuario administra sus propias fuentes: activar y desactivar cada comercio,
agregar una fuente nueva por URL, ver estado y última consulta, configurar
frecuencia y días de anticipación de las alertas, y ejercer privacidad (exportar
todo, borrar todo).

### 4.8 Ayuda

Centro de ayuda dentro de la app, en el menú principal. Siete secciones con 26
temas: nominal contra real, gastos recurrentes, de dónde sale cada total,
histórico y proyección, seguimiento de precios, categorías y sobres y cuotas, y
tus datos. Buscador sobre pregunta y respuesta, y filtro por sección.

Tres enlaces contextuales entran al tema exacto: el "?" junto al interruptor
nominal/real del Resumen, "¿Por qué la diferencia?" en el pie de Movimientos, y
"Cómo funciona" en el interruptor de gasto recurrente. Al navegar desde un
diálogo, el diálogo se cierra.

El contenido responde a las confusiones reales que aparecieron construyendo el
producto — sobre todo por qué la suma de movimientos no da el gasto del mes.
Es contenido del producto: va en el repo, no en un CMS.

### 4.9 Onboarding

Tres pasos con puntos de progreso: hogar e ingresos, primeras categorías, primeros
productos a seguir.

## 5. Matemática financiera

### 5.1 Total mensual — fuente única

```
monthNominal(y, m):
  si existe dato real del mes → ese total
  si es anterior a la serie   → primer dato / 1.035^k
  si es posterior             → último dato * 1.035^k
```

Toda pantalla que muestre un total mensual pasa por acá. Ver regla 2 de `CLAUDE.md`.

### 5.2 Escalar un importe entre meses

```
adjust(base, y, m):
  k = 0  → base
  k < 0  → base * monthNominal(y,m) / monthNominal(mesActual)
  k > 0  → base * (1 + IPC_PROY)^k        IPC_PROY = 2,0% mensual
```

Hacia atrás manda la serie histórica, que trae inflación **y** crecimiento real del
gasto. Deflactar solo por IPC subestima el pasado y fue un bug.

### 5.3 Pesos constantes

```
monthFactor(y, m) = Π (1 + ipc_i / 100)   para cada mes entre (y,m) y el mes actual
real = nominal * monthFactor(y, m)
```

### 5.4 Variación real

```
realChange = (gastoAhora / (gastoAnterior * (1 + ipcMes))) - 1
```

### 5.5 Proyección

Tendencia real de los últimos meses extrapolada al mes destino, más IPC proyectado
para el valor nominal. Se muestran los dos números por separado.

### 5.6 Canasta y compra dividida

Canasta por comercio: suma de los productos disponibles en ese comercio, solo
fuentes habilitadas. Compra dividida: agrupar cada producto en el comercio con el
precio más bajo; una pata por comercio ganador; el ahorro es la diferencia contra el
mejor comercio en una sola parada. Si hay una sola pata, el texto lo dice.

## 6. Ingesta de datos externos

| Dato | Fuente | Frecuencia | Cache |
|---|---|---|---|
| Cotización USD/EUR/CHF oficial | Banco Nación | diaria, 11:00 ART | KV 12 h |
| Cotización de referencia | xe.com | diaria | KV 12 h |
| IPC | INDEC | mensual, día 15 | KV 30 d |
| Precios de productos | comercio por comercio | cada 6 h | KV 6 h |

Todo se ejecuta en Cron, en lotes de 40 productos ordenados por `last_checked_at`
(ver `DEPLOY.md` §5); nunca en el request del usuario. Cada precio se
guarda con comercio, fecha de consulta y fuente. Si una consulta falla, se conserva
el precio anterior y la UI muestra su antigüedad.

Un adaptador por comercio, todos con la misma interfaz, para poder cambiar de método
sin tocar el resto:

```ts
interface RetailerAdapter {
  fetchPrice(item: WatchedItem, url?: string):
    Promise<{ priceCents: number; at: string; source: "api" | "llm" | "manual" }>;
}
```

### 6.1 Comercios que agrega el usuario

Además de los diez de fábrica, el usuario puede agregar cualquier sitio desde
Conexiones: nombre y URL. Estos comercios llevan `household_id` y `kind = 'llm'`.

Escribir un scraper por sitio no escala — son sitios que el equipo nunca vio. La
consulta la resuelve el modelo:

1. El Worker trae el HTML de la URL del producto (`item_urls`).
2. Lo limpia: saca `script`, `style`, `svg`, comentarios, y recorta a ~30 KB de
   texto alrededor de la primera aparición de un patrón de precio.
3. Se lo pasa a Cohere pidiendo JSON estricto:
   `{ "price_cents": number | null, "currency": string, "in_stock": boolean }`.
4. Si devuelve `null` o algo que no parsea, la consulta falla como cualquier otra:
   queda en `price_fetch_log` y la UI muestra el precio anterior con su antigüedad.
   Nunca se inventa un precio (regla 5 de `CLAUDE.md`).

Al agregar el sitio se hace una **verificación**: una consulta de prueba en el
momento. Si sale bien, `verified = 1`. Si no, el comercio queda cargado pero
apagado, con `verify_note` explicando qué pasó — la UI ya tiene ese estado
("Verificando el sitio…" y después el resultado).

Costo: una llamada al modelo por producto por comercio por corrida. Con lotes de 40
y cuatro corridas diarias es acotado, pero conviene cachear el HTML por unas horas
en KV para no pagar dos veces la misma página.

**Antes de habilitar cualquier consulta automática**, revisar los términos de uso
del sitio. Los comercios de fábrica que ofrecen API oficial van por API
(`kind = 'api'`), que siempre es preferible: más rápido, más barato y más estable.
Cuál va por cuál sigue siendo una decisión del negocio.

## 7. Autenticación con Google

**Decidido: Cloudflare Access.** Brote es para un hogar, no hay registro abierto,
así que §7.1 es el camino a implementar. §7.2 queda documentado para el día que haga
falta abrirlo, y no se implementa ahora.

### 7.1 Cloudflare Access (el camino elegido)

Google como IdP en Cloudflare Access, la aplicación protegida entera. El Worker recibe
`Cf-Access-Jwt-Assertion`, valida contra el JWKS del equipo y toma `email` y `sub` del
token. No hay que escribir flujo OAuth ni manejar refresh. Limitación: la lista de
usuarios se administra en Access, no en la app.

Consecuencias prácticas de esta decisión:

- No hay endpoints `/auth/*`, ni `code_verifier`, ni refresh tokens, ni el KV
  `AUTH_STATE`. Se pueden borrar de `wrangler.toml` y de `api-contract.md`.
- La tabla `sessions` no hace falta: cada request trae su propio JWT ya validado
  por el borde. Sí se mantiene `users`, creando la fila al primer ingreso a partir
  de `email` y `sub` del token.
- Los mails permitidos se administran en el panel de Access, no en la app. Para un
  hogar es lo correcto; para invitar gente de afuera habría que pasar a §7.2.
- El Worker igual valida el JWT contra el JWKS del equipo en cada request. No
  confiar en el header sin verificar: sin esa validación, cualquiera que llegue al
  Worker por otra ruta entra.

### 7.2 Google OAuth 2.0 + PKCE (para el día que se abra)

Flujo, todo dentro del Worker:

1. `GET /auth/google` genera `state` y `code_verifier`, los guarda en KV con TTL de
   10 minutos y redirige a Google con `code_challenge` S256.
2. Scopes: `openid email profile`. Nada más — no se pide acceso a Gmail ni a Drive.
3. `GET /auth/google/callback` valida `state`, canjea el código por tokens, verifica
   el `id_token` contra el JWKS de Google (`iss`, `aud`, `exp`, `nonce`).
4. Se crea o actualiza el usuario por `google_sub`, no por email.
5. Sesión propia: cookie `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 días, valor
   firmado HMAC con secreto en Workers Secrets; la fila en `sessions` permite
   revocar.
6. `POST /auth/logout` borra la sesión de D1 y la cookie.

El `refresh_token` de Google solo se guarda si más adelante hace falta acceso offline;
en v1 no hace falta y no se guarda. Secretos (`GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`) en Workers Secrets, nunca en
`wrangler.toml`.

**Hogar compartido**: el primer usuario crea el hogar; invita por email y el invitado
entra con su propio Google. La membresía vive en `users.household_id` más
`users.role`.

## 8. API

Contrato completo en `api-contract.md`. Convenciones: prefijo `/api`, JSON,
importes en centavos, errores con `{ error: { code, message } }`.

## 9. Exportaciones

Excel (CSV UTF-8 con BOM, separador `;` para que Excel es-AR lo abra bien) para:
análisis de gastos, movimientos, presupuesto y objetivos, y resumen anual. Se generan
en el Worker en streaming. Nombres de archivo `brote-<vista>-<período>.csv`.

## 10. Fotos de tickets

1. El navegador toma la foto con `<input type="file" accept="image/*" capture="environment">`
   o `getUserMedia` con permiso explícito.
2. Se sube directo a R2 con URL pre-firmada de vida corta emitida por el Worker.
3. El Worker llama al proveedor de OCR dentro del mismo request, con timeout:
   extrae comercio, fecha, total y líneas.
4. El usuario **confirma o corrige** antes de que se cree el movimiento; nunca se
   crea automáticamente.
5. Los productos detectados se ofrecen como sugerencias para seguir precio.
6. La imagen se puede borrar y el borrado elimina el objeto en R2.

Nada de la foto sale de la infraestructura del proyecto salvo hacia el proveedor de
OCR elegido, que hay que nombrar en la pantalla de privacidad.

## 11. Tokens de diseño

Sistema completo en `design-reference/_ds/organic-.../styles.css`.

**Tipografía**: títulos `Caprasimo` peso 400; texto `Figtree`. Cuerpo 15px,
`line-height: 1.55`. Títulos `line-height: 1.12`, `letter-spacing: -0.015em`.
Escala usada: 11,5px etiquetas mayúsculas, 12,5–13,5px notas, 14–15px cuerpo,
19–21px títulos de tarjeta, 25–26px valores de KPI, 32px título de pantalla.

**Radios**: `--radius-sm: 8px`, `--radius-md: 16px`, `--radius-lg: 28px`.
Tarjetas y diálogos usan `calc(--radius-lg * 1.15)`; botones, tags, inputs y
segmentados van a `999px`.

**Sombras**: `sm 0 1px 2px`, `md 0 3px 10px`, `lg 0 12px 32px`, todas con
`color-mix(in srgb, #2e2b25 14–22%, transparent)`.

**Espaciado**: escala `4.4 / 8.8 / 13.2 / 17.6 / 22 / 26.4 / 30.8 / 35.2 px`.
Gaps de layout usados: 16px entre tarjetas, 24–26px de padding interno.

**Color**: dos acentos generados en OKLCH desde un tono y un croma, en rampas de
nueve pasos. Luminosidad `0.955 0.90 0.82 0.73 0.635 0.56 0.475 0.375 0.28`;
croma relativo `0.30 0.45 0.65 0.85 1 1 0.95 0.85 0.70`. Sobre fondo oscuro la rampa
se invierte y el acento base sube a L 0.71. El token `--on-accent` define la tinta
sobre relleno de acento: casi blanco en claro, oscuro en oscuro. **Esto hay que
portarlo tal cual**: fue la causa de varios problemas de contraste.

**Paletas elegibles por el usuario** (tono/croma de acento 1 y 2):

| id | Nombre | Acento 1 | Acento 2 |
|---|---|---|---|
| `organic` | Organic | 52 / 0.11 | 122 / 0.05 |
| `rosa` | Rosa y verde | 355 / 0.115 | 148 / 0.075 |
| `violeta` | Violeta y azul | 295 / 0.14 | 245 / 0.10 |
| `azul` | Azul y coral | 245 / 0.13 | 25 / 0.13 |
| `bosque` | Bosque y rosa | 150 / 0.10 | 350 / 0.12 |
| `magenta` | Magenta y verde agua | 348 / 0.155 | 192 / 0.075 |

**Fondos elegibles**: Crema `#f5ead8`, Arena `#ece0c8`, más otros dos claros y
Noche `#1c1922` (oscuro, invierte la rampa).

**Layout**: barra lateral 252px fija, `100vh`, `position: sticky`. Contenido con
`max-width: 1180px`, padding `34px 40px`. Grillas siempre
`repeat(auto-fit, minmax(Npx, 1fr))` con `minmax(0, ...)` en las pistas de tabla.

## 12. Datos de demostración y estados vacíos

### 12.1 Nada de esto va a producción

Todo lo siguiente es demo: el hogar "Casa Domínguez" con Martín
y Valentina, la serie de gasto de septiembre 2025 a agosto 2026, las diez categorías
con sus importes, los catorce movimientos, los seis productos seguidos con sus
precios por comercio, las tres sugerencias, los ingresos, los compromisos fijos, las
tres cuotas, el aguinaldo, los tres objetivos de ahorro, las cotizaciones y la serie
de IPC.

Sirven como fixtures de test y como seed de un entorno de demo **separado**, marcado
como tal. La base de producción arranca vacía y no se siembra con nada de esto. Un
hogar nuevo tiene: cero movimientos, cero ingresos, cero productos seguidos, cero
objetivos.

Dos excepciones, que no son datos del usuario sino del contexto y sí se cargan de
entrada:

- **Las diez categorías de fábrica**, sin importes ni topes. Son el punto de partida
  que el usuario después renombra, borra o completa. Sin ellas la primera carga de
  un gasto no tiene dónde ir.
- **Los diez comercios de fábrica** y la serie de IPC del INDEC, que son datos
  públicos y los mismos para todos.

### 12.2 Los estados vacíos son parte del producto

Un hogar nuevo va a pasar sus primeros días en estas pantallas. Cada una necesita un
estado vacío diseñado, no un cero:

| Pantalla | Con cero datos | La acción que ofrece |
|---|---|---|
| Resumen | No hay KPIs ni serie que mostrar. En su lugar, los tres pasos de la guía de configuración | "Cargar el primer mes" |
| Análisis de gastos | Necesita dos meses para comparar. Decirlo: "El análisis compara meses; con un mes cargado ya empieza a servir" | "Registrar una compra" |
| Movimientos | Lista vacía con el mes en curso seleccionado | "Registrar compra" y "Subir un ticket" |
| Ingresos y compromisos | Sin ingresos no hay poder de compra ni plata quieta | "Agregar un ingreso" |
| Presupuesto | Las diez categorías con tope en cero, listas para poner el primero | "Poner topes" |
| Precios | Sin productos seguidos no hay canasta ni plan de compra | "Agregar producto" y las sugerencias del primer ticket |
| Divisas e inflación | **Funciona desde el día uno**: no depende de datos del usuario | — |
| Ayuda | Funciona desde el día uno | — |

Reglas para escribirlos: nunca un gráfico vacío con ejes y sin datos, nunca un
`$ 0` presentado como si fuera un dato, nunca "No hay información disponible". El
estado vacío dice qué falta y ofrece el botón que lo resuelve, en una línea.

Con un solo mes cargado, todo lo que compara contra el mes anterior tiene que
degradar con gracia: se muestra el valor y se omite la variación, sin fingir un
0% ni un +∞.

## 13. Orden de implementación sugerido

1. Worker + SPA vacía + D1 con `schema.sql` + login con Google.
2. Categorías, movimientos manuales, reglas recurrentes. Tests de §5.1 y §5.2.
3. Resumen y Análisis de gastos con datos reales.
4. Presupuesto, objetivos, ingresos y compromisos.
5. Precios: un solo comercio de punta a punta, después los demás por adaptador.
6. Cotizaciones e inflación por Cron.
7. Fotos de tickets y OCR.
8. Exportaciones, alertas, privacidad.
