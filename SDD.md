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
Cloudflare Access (Google IdP)      ← valida antes de que la request llegue al Worker
   │  Cf-Access-Jwt-Assertion
   ▼
Navegador (React SPA)
   │  fetch /api/*
   ▼
Cloudflare Worker (Hono)
   ├── static assets  → la SPA
   ├── middleware     → valida el JWT contra el JWKS del equipo, en cada request
   ├── /api/*         → lectura y escritura
   ├── D1             → datos del hogar; fuente de verdad de las series externas
   ├── KV             → cotizaciones, IPC, precios, HTML de producto (cache caliente)
   └── R2             → fotos de tickets
Cron Triggers  (UTC; ART = UTC−3)
   ├── 0 14 * * *     → 11:00 ART  cotizaciones BNA + xe
   ├── 0 */6 * * *    → cada 6 h   refresco de precios de productos seguidos
   ├── 0 15 15 * *    → día 15     IPC INDEC del mes
   └── 0 12 * * *     → 9:00 ART   alertas, y el vigilante de §13.2
```

**No hay `/auth/*` ni cookie de sesión propia**: el login es de Access y cada request
trae su JWT (§7.1). Un solo Worker; la SPA se sirve con `assets` del mismo Worker,
así no hay CORS ni dominio aparte. Región de D1: la más cercana a Sudamérica
disponible al crear la base.

Los horarios de cron son **UTC**, que es lo que interpreta Cloudflare, y son los
mismos que están en `wrangler.example.toml` y en `DEPLOY.md` §5. Escribirlos en hora
argentina en un lado y en UTC en el otro es un cron que corre tres horas fuera de
hora, y el que lo lee no se entera.

## 3. Modelo de datos

Esquema ejecutable en `schema.sql`. Resumen de tablas:

| Tabla | Contenido |
|---|---|
| `households` | Hogar, nombre visible ("Casa Domínguez"), moneda, zona horaria, paleta y fondo |
| `users` | Usuario, `google_sub`, email, nombre, avatar, rol; `household_id` **nullable** (§7.1) |
| `invites` | Invitación a un hogar por email, quién invitó, vencimiento, cuándo se aceptó (§7.1) |
| `categories` | Categoría de gasto por hogar, con presupuesto mensual y flag de variable |
| `transactions` | Movimiento: fecha, comercio, detalle, categoría, importe en centavos, origen, `rule_id` |
| `recurring_rules` | Regla recurrente: frecuencia, día, mes de inicio, importe, categoría |
| `incomes` | Ingreso por persona: tipo, importe, cuándo, si es fijo |
| `income_history` | Ingreso total del hogar mes a mes, para el poder de compra del sueldo |
| `fixed_expenses` | Compromiso fijo: nombre, importe, día, nota de ajuste |
| `installments` | Producto en cuotas: nombre, comercio, precio total, cantidad, pagadas; la cuota se deriva |
| `goals` | Objetivo de ahorro: nombre, meta, acumulado, fecha objetivo |
| `watched_items` | Producto seguido: nombre, unidad, cantidad, cadencia, origen, `last_checked_at` |
| `item_urls` | Dónde vive cada producto en cada comercio; sin URL no hay consulta (§6.1) |
| `item_prices` | Precio por producto, comercio, fecha de consulta, fuente |
| `item_alternatives` | Segunda marca equivalente, para la sugerencia de cambio |
| `price_fetch_log` | Fallos y éxitos de consulta de precio; sin Queues, esto reemplaza la dead letter queue |
| `retailers` | Comercio: nombre, tipo de acceso (`api`/`scrape`/`llm`/`manual`), verificación, estado |
| `connections` | Qué fuentes habilitó el hogar, con su estado y último éxito |
| `fx_rates` | Cotización: moneda, compra, venta, fuente (bna/xe), fecha |
| `inflation` | IPC mensual del INDEC: año, mes, variación, índice, si es estimado (§5.7) |
| `month_totals` | **Total de gasto por mes: la fuente única de §5.1.** Cómo se calcula, en §5.0 |
| `receipts` | Foto de ticket: clave R2, estado de OCR, transacción resultante |
| `alerts` | Alerta generada: tipo, payload, leída |
| `alert_prefs` | Las seis preferencias que edita Conexiones y que gobiernan Avisos: días de anticipación, umbral de baja, frecuencia de consulta, hora de envío, correo, notificación y resumen semanal (§4.6, §4.9) |
| `job_runs` | Última corrida de cada trabajo de fondo, para saber si un cron dejó de andar (§13.2) |
| `audit_log` | Acciones sensibles: borrado, exportación, cambio de conexión |

No hay tabla `sessions`: bajo Cloudflare Access cada request trae su propio JWT
validado en el borde (§7.1).

Reglas transversales: importes en `INTEGER` de centavos; fechas en ISO 8601 UTC;
toda tabla **de datos del hogar** lleva `household_id` y se filtra por él en cada
query, con el mecanismo de §13.3 para que eso sea cierto y no una intención.

Ocho tablas no llevan `household_id`, y **no son todas la misma clase de excepción**.
Confundirlas es un bug de aislamiento, así que van separadas:

| Clase | Tablas | Cómo se aísla |
|---|---|---|
| **Contexto público**, igual para todos los hogares | `fx_rates`, `inflation` | No hace falta aislar: no hay dato de nadie |
| **Sobre Brote, no sobre el hogar** | `job_runs` (§13.2) | Ídem |
| **La tabla del hogar** | `households` | Su `id` *es* el hogar |
| **Hijas de `watched_items`**, heredan el hogar por su padre | `item_prices`, `item_urls`, `item_alternatives`, `price_fetch_log` | **Sí hace falta aislar**: por el `household_id` del `watched_items` al que apuntan (§13.3) |

`retailers` es aparte: tiene `household_id` **nullable**, y `NULL` significa "de
fábrica, lo ve todo el mundo".

La cuarta fila es la peligrosa. `item_prices` son datos del hogar tanto como sus
movimientos —qué productos sigue, a qué precio los compra— y llegan al hogar solo a
través de `item_id`. Tratarlas como contexto público es una fuga. Cualquier tabla
nueva sin `household_id` tiene que decir en cuál de estas clases cae, o es un bug.

## 4. Vistas

**Nueve** entradas de navegación, barra lateral fija de 252px. El contenido tiene
`max-width: 1180px`. Todas las medidas son las del prototipo a 1440px.

El orden de la navegación es el del prototipo y no es alfabético ni arbitrario —va
de lo general a lo periférico— así que se respeta:

| # | Identificador | Etiqueta | §  |
|---|---|---|---|
| 1 | `overview` | Resumen | §4.1 |
| 2 | `analysis` | Análisis de gastos | §4.2 |
| 3 | `transactions` | Movimientos | §4.3 |
| 4 | `income` | Ingresos y compromisos | §4.4 |
| 5 | `budgets` | Presupuesto y objetivos | §4.5 |
| 6 | `watch` | Precios | §4.6 |
| 7 | `markets` | Divisas e inflación | §4.7 |
| 8 | `connections` | Conexiones | §4.9 |
| 9 | `help` | Ayuda | §4.10 |

`onboarding` (§4.11) no está en la navegación. **Precios lleva un badge** con la
cantidad de avisos sin leer; es la única entrada que lo lleva.

**`mobile` del prototipo no es una entrada de navegación.** Era la forma de presentar
el diseño del teléfono para revisarlo, no una pantalla que alguien visite: por eso es
una página de escritorio, con la barra lateral puesta, que muestra marcos de iPhone.
Lo que sí hay que construir es el comportamiento responsive de las pantallas que ya
existen, y eso está en §4.8. La navegación de producción no la incluye.

`18-perfil-valentina.png` no tiene sección propia: es Movimientos filtrado por
persona (§4.3). Los screenshots `16` y `17` son los diálogos de §4.3.

### 4.1 Resumen (`screenshots/01-resumen.png`)

Propósito: en una pantalla, si el mes viene bien o mal descontando la inflación.

- **Cuatro KPIs** en `repeat(auto-fit, minmax(210px, 1fr))`, tarjetas de
  `--radius-lg`, padding `20px 22px`, `--shadow-sm`. Etiqueta 11,5px mayúscula
  con `letter-spacing: 0.1em`; valor en Caprasimo 26px; nota 13px. Contenido:
  gastado en el mes, variación real, disponible, ahorro detectado (§4.1.1).
- **Toggle nominal / real** como pastilla segmentada; afecta todas las series.
- **Serie histórica** de hasta 12 meses, barras verticales, altura 190px. Fuente
  única de verdad de los totales mensuales (§5.1).
- **Proyección** con selector de mes destino, hasta 12 meses adelante. Muestra el
  valor proyectado y su equivalente a valores de hoy, en textos separados.
- **Cierre de mes**: lo que salió bien, lo que no, y acciones concretas.
- Rango de la serie: **desde el primer mes con dato real del hogar**, hasta 12 meses.
  Un hogar con tres meses cargados ve tres barras. No se rellena hacia atrás
  (§5.1). Los 44 meses son el rango del selector de período de Movimientos (§4.3),
  que es otra cosa.

#### 4.1.1 Ahorro detectado

El cuarto KPI. Es plata que el hogar **podría** dejar de gastar comprando lo mismo
donde hoy está más barato, no plata que ya ahorró: la nota de la tarjeta lo dice con
palabras. Se calcula, no se hardcodea, y apagar una fuente en Conexiones tiene que
moverlo (regla 6 de `CLAUDE.md`):

```
ahorroDetectado =
  Σ  max(0, last_paid_cents − mejorPrecioHabilitado(item)) × comprasPorMes(item)

  para cada watched_item que tenga last_paid_cents y al menos un precio
  vigente de una fuente habilitada

comprasPorMes(item) = 30 / cadence_days     (sin cadence_days, el item no entra)
mejorPrecioHabilitado(item) = min(price_cents) entre connections.enabled = 1
```

Consecuencias que hay que respetar: sin productos seguidos el KPI es cero y la
tarjeta muestra su estado vacío, no `$ 0` como si fuera un dato (§12.2). Un producto
cuyo precio más barato es el que ya pagó aporta cero, no negativo. Y apagar el
comercio más barato de un producto baja el número: si no lo baja, está mal.

### 4.2 Análisis de gastos (`02-analisis-gastos.png`)

- **Tabla de categorías**: mes, mes anterior, variación nominal, variación real,
  presupuesto. La variación real es la columna que decide el color.
- **Insights** en tarjetas, cada uno con acción **y con un importe de ahorro**. Ese
  importe es plata en pantalla, así que se calcula (regla 6) y se define en §4.2.1:
  no alcanza con especificar el texto de la tarjeta. Tres tipos, y cada uno necesita
  una señal que Brote realmente tenga:
  - *Desvío contra el propio promedio*: el gasto de la categoría contra su promedio
    de los últimos seis meses en pesos constantes (§5.3). Derivable hoy.
  - *Cambio de comercio sugerido*: mismo producto, comercio más barato entre las
    fuentes habilitadas. Derivable hoy, sale de los mismos precios que §4.1.1.
  - *Suscripciones a revisar*: **reformulado sobre lo observable**, decidido. El
    prototipo decía "Dos suscripciones sin uso desde hace 60 días… no registran
    actividad del hogar", y Brote no tiene señal de uso: ve el cargo, no si alguien
    mira Disney+. Afirmar el uso era afirmar algo que el producto no sabe. Dos
    disparadores, los dos derivables de `recurring_rules`:
    - **El cargo subió más que la inflación del período**: el importe de la regla
      creció por encima de `(1 + IPC acumulado)` desde el último cambio de importe.
    - **Viene cobrándose seis meses sin que nadie la toque**: la regla tiene seis
      ocurrencias o más y el hogar nunca la editó ni la confirmó.

    La tarjeta dice el hecho, no la conjetura: "Netflix subió 38% desde marzo, arriba
    del 21% de inflación del período" o "Spotify se viene cobrando desde febrero y
    nunca la revisaste". La copy de "sin uso" **no se usa**: es la segunda excepción a
    la regla de copy literal, por el mismo motivo que la de la foto (§4.8).
    El tipo de alerta pasa a llamarse `subscription_review`: `subscription_idle`
    nombraba justamente lo que no se puede observar.
- **Aumento por unidad**: producto, precio anterior, precio actual, variación.
  Grilla `minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)`.

#### 4.2.1 El ahorro de cada insight

Cada tarjeta de insight muestra un importe. Es el mismo problema que el KPI de §4.1.1
y se resuelve igual: **se deriva o no se muestra.**

| Insight | Ahorro |
|---|---|
| Desvío contra el promedio | `max(0, gastoDelMes − promedioDeLaCategoría)`, en pesos constantes (§5.3). Es lo que costó el desvío, no una promesa |
| Cambio de comercio | `(precioEnElComercioHabitual − mejorPrecioHabilitado) × comprasPorMes`, con las mismas definiciones de §4.1.1 |
| Suscripciones a revisar | Según el disparador: si **subió más que el IPC**, el exceso — `max(0, importeActual − importeAnterior × (1 + ipcAcumulado))`; si es la de **seis meses sin revisar**, el importe mensual completo, que es lo que se ahorra si se da de baja |

Dos reglas que valen para los tres:

- **Un insight sin ahorro derivable no muestra número.** Ni `$ 0`, ni "hasta",
  ni un estimado. La tarjeta existe igual: el texto es el valor, el importe es el
  argumento.
- **Los ahorros de los insights y el KPI de §4.1.1 no se suman.** Miran la misma
  oportunidad desde dos lados —el KPI agrega todos los productos, el insight de
  cambio de comercio señala uno— y presentarlos como sumables cuenta la misma plata
  dos veces. Ninguna pantalla muestra un total que los mezcle.

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

**Objetivos: el acumulado lo pone el usuario.** `saved_cents` es carga manual y Brote
no lo deduce del flujo de caja. Tenía sentido preguntárselo —el KPI de §4.1.1 y los
insights de §4.2.1 sí se calculan— así que queda dicho: lo que un hogar apartó para
un objetivo no es inferible de la diferencia entre lo que entró y lo que gastó, y
adivinarlo sería un número inventado en una pantalla de ahorro. La barra de progreso
es `saved_cents / target_cents`, sin ajuste por inflación en el acumulado y con la
meta expresada en pesos del día en que se fijó.

**Cuotas: una sola verdad.** `started_on` y `count_total` son el calendario, y de
ahí sale todo: qué meses tienen cuota (término D de §5.0) y cuántas van pagadas
—las que ya vencieron—. `count_paid` **no se guarda**: era una columna editable que
respondía la misma pregunta que las fechas, y las dos podían no coincidir. La barra
de progreso y el total del mes tienen que contar lo mismo o es la regla 2 otra vez,
en chico. Si el hogar paga adelantado o se atrasa, lo que se corrige es el
calendario.

### 4.6 Precios (`07-precios-productos.png`, `08-precios-canasta.png`, `09-precios-lista-compras.png`, `10-precios-avisos.png`)

**Cuatro** pestañas, con los nombres del prototipo (`watchTabs`):

- **Productos seguidos**: cada producto seguido con precio por comercio ordenado de
  menor a mayor, el más barato marcado, precio por unidad, última compra, cadencia de
  compra, historial y segunda marca alternativa. Sugerencias detectadas en tickets.
- **Compra semanal**: canasta comparada comercio por comercio, con barras y
  diferencia contra el más barato; plan de compra dividida calculado agrupando cada
  producto en el comercio que hoy lo tiene más barato (si gana uno solo, lo dice).
  Grilla `repeat(auto-fit, minmax(280px, 1fr))`.
- **Lista de compras** (`09`): el plan de compra dividida de §5.6 hecho lista para
  usar en el comercio. **No es un cálculo nuevo**: son los mismos productos seguidos,
  cada uno en el comercio que hoy lo tiene más barato entre las fuentes habilitadas,
  agrupados por comercio. Una tarjeta por comercio en
  `repeat(auto-fit, minmax(300px, 1fr))`, con el nombre del comercio en Caprasimo
  19px y su subtotal a la derecha; adentro una fila por producto con casilla, nombre,
  unidad en gris y precio.
  - La casilla es **estado local del navegador**, no del hogar: tildar "café" es
    "ya lo puse en el carrito", no un dato que valga guardar en D1. Un producto
    tildado se muestra en gris y su precio sigue contando en el total.
  - Tarjeta de cierre con "Total estimado" (todos los productos) y el pie:
    "Falta comprar {resto}. La lista se arma con tus productos seguidos al precio más
    bajo de hoy, agrupados por comercio." Dos números distintos —total y falta
    comprar— porque tildar no cambia el total.
  - **Estimado quiere decir estimado**: cada precio es el último consultado, con su
    fecha, y un precio `stale` se muestra con su antigüedad (regla 5). El total no
    es lo que va a salir en la caja y el copy no lo promete.
- **Avisos** (`10`): las alertas ya generadas, más nuevas arriba, una tarjeta por
  aviso. Cada tarjeta lleva marca, título, cuerpo con los dos precios, antigüedad en
  palabras ("hace 2 h", "ayer", "hace 2 días") y una acción.
  - **La marca y el color dicen la dirección**: `↓` sobre `--color-accent-2-200`
    cuando bajó —es una oportunidad—, `↑` sobre `--color-accent-100` cuando subió.
    El color no es decorativo y no se puede invertir.
  - El cuerpo dice **de dónde a dónde y contra qué**, nunca solo el porcentaje:
    "$ 36.800 → $ 33.500. Por debajo de los $ 34.000 que pediste que te avisemos."
    Un aviso de baja sin el precio anterior y el comercio no es un aviso, es un
    rumor (regla 5).
  - Los tipos que se muestran acá son **`price_drop`** (baja, marca `↓`) y
    **`price_rise`** (suba de canasta, marca `↑`, la tercera tarjeta del prototipo:
    "El aceite de girasol subió en cuatro de seis comercios"). Los `due_soon`,
    `budget_over` y `fx_move` viven en sus pantallas. `job_stale` (§13.2) también
    aparece acá, distinguible: no habla de la plata del hogar.
  - Cada tipo tiene una forma fija de `payload`, en `api-contract.md`, y la tarjeta se
    dibuja **solo** con eso: nada se infiere en el cliente. Una alerta de un tipo que
    la UI no conoce no se dibuja a medias, no se dibuja.
  - Pie: "Los avisos siguen la configuración de Conexiones: hora, baja mínima y
    canal." Los tres los edita el usuario en §4.9, y son de verdad tres: si cambiar
    la baja mínima no cambia qué avisos entran, está mal.

Comercios en v1: Carrefour, Coto, Día, Diarco, Jumbo, Disco, Vea, Mercado Libre,
Farmacity, más "Almacén del barrio" como entrada manual.

### 4.7 Divisas e inflación (`11-divisas-inflacion.png`)

Vista propia (`markets` en el prototipo), no una pestaña de Precios: es la única
pantalla que funciona desde el día uno porque no depende de datos del usuario
(§12.2).

USD, EUR y CHF con compra y venta del Banco Nación y referencia de xe.com por
separado —nunca promediadas, regla 7 de `CLAUDE.md`—, serie de ocho semanas, e IPC
del INDEC histórico y último dato, con el mes en curso marcado como estimado cuando
todavía no salió el oficial (§5.7).

### 4.8 En el teléfono: el diseño responsive

**No es una vista y no va en la navegación** (§4). `12-en-el-telefono.png` es la
página con la que el prototipo presenta el diseño del teléfono, y lo que se construye
es el comportamiento responsive de cuatro pantallas que ya existen. Esta sección
especifica ese comportamiento.

No es "la app en chico": abajo de la primera ruptura, el producto se reduce a lo que
se hace **de pie**. El copy del prototipo lo dice y es la regla de diseño de toda la
sección:

> El teléfono no repite el escritorio: solo lleva lo que se hace de pie, en el
> comercio o en la calle. Sacar la foto del ticket, ver cuánto queda del mes, la
> lista de compras con precios de hoy y los avisos de baja.

**Cuatro pantallas llegan al teléfono, y son cuatro a propósito**: lo que no está acá
se hace sentado. Nada de análisis, nada de configuración, nada de edición de reglas.
Las otras cinco vistas **no se rediseñan para el teléfono en v1**: se acceden, se leen
con scroll horizontal donde haga falta (§11) y no se les promete una experiencia
móvil.

| Pantalla del teléfono | Es la versión angosta de | Qué lleva |
|---|---|---|
| **Registrar** | El diálogo de registrar compra de §4.3 | "Sacale una foto al ticket" · "Brote lee las líneas y reconoce los productos que seguís." Zona de subida con borde punteado y el botón redondo de cámara, más "Elegir de la galería" y "Cargar solo el total". Debajo, "Último cargado" con comercio, importe y antigüedad |
| **Agosto** | Resumen (§4.1) y los sobres de §4.5 | "Gastado este mes" con el total del mes, "Queda …" con el porcentaje, y los sobres con su barra y su estado. Solo lectura: en el teléfono no se editan topes |
| **Lista** | La pestaña Lista de compras de §4.6 | "Total estimado" y la misma lista agrupada por comercio, con casillas. Es la pantalla que se usa adentro del supermercado |
| **Avisos** | La pestaña Avisos de §4.6 | Las tarjetas de §4.6, y "Ver todos los precios" al pie |

Cada una es la **misma pantalla** en angosto, no una pantalla nueva: mismo endpoint,
mismos números, misma procedencia. Si el teléfono y el escritorio muestran totales
distintos para el mismo mes, es el bug de la regla 2 otra vez.

Dos cosas que salen de acá y valen para todo el producto:

- **La foto no se descarta sola.** El borrado es del usuario, real y con el objeto de
  R2 incluido (§10, y la sección Privacidad de `CLAUDE.md`). El prototipo promete un
  descarte a los 30 días que el producto no hace, y lo promete en tres lugares:
  **se cambian las tres frases**, decidido. La copy que va a producción:

  | Dónde | Copy del prototipo | Copy que va |
  |---|---|---|
  | Permiso de cámara, §4.8 | "El teléfono pide permiso. La foto se descarta a los 30 días." | "El teléfono pide permiso. La foto queda guardada hasta que la borres." |
  | Diálogo de registrar compra, §4.3 | "Cámara o galería. La foto se sube por HTTPS, se lee y se descarta a los 30 días." | "Cámara o galería. La foto se sube por HTTPS, se lee y queda hasta que la borres." |
  | Conexiones, §4.9 | "Las fotos de tickets se procesan al subirlas y se descartan a los 30 días; los datos quedan." | "Las fotos de tickets se procesan al subirlas y quedan hasta que las borres; los datos quedan." |

  Es la **única** excepción a la regla de copy literal de `CLAUDE.md`, y está acá
  porque la frase original promete algo que el producto no hace. La entrada de Ayuda
  "¿Qué pasa con las fotos de tickets?" ya dice lo correcto ("Podés borrarla, y el
  borrado elimina también la imagen guardada") y **no se toca**.
- El total del mes y los sobres del teléfono salen de las mismas respuestas que el
  escritorio (§5.0, §5.1). El teléfono **no** tiene su propio cálculo: sería la
  cuarta pantalla del test de número único de §13.7.

### 4.9 Conexiones (`13-conexiones.png`)

El usuario administra sus propias fuentes: activar y desactivar cada comercio,
agregar una fuente nueva por URL, ver estado y última consulta, configurar
frecuencia y días de anticipación de las alertas, y ejercer privacidad (exportar
todo, borrar todo).

Esta pantalla es también donde se editan las seis preferencias que gobiernan la
pestaña de Avisos (§4.6) —hora, baja mínima, correo, notificación, resumen semanal y
días de anticipación—, la cadencia de consulta de §6.3, y donde se nombra a Cohere
como el proveedor que lee los tickets y los precios (§10).

**Qué entra**, que en el prototipo son tres interruptores (`sources`): tickets, CSV
y carga del hogar. Los tickets son §10 y la carga del hogar es §4.3. **La importación
por CSV está en el diseño y no está especificada acá** —qué formatos acepta, cómo
mapea a categorías, qué hace con los duplicados—: ver §13.4. Lo que sí queda
definido es que un movimiento importado, venga de un CSV propio o de un resumen que
el usuario bajó del banco, lleva `source = 'import'`.

**Brote no se conecta a ningún banco.** No hay integración bancaria, no se piden ni
se guardan credenciales, y la Ayuda lo dice con esas palabras. Por eso `'bank'` salió
del dominio de `transactions.source`: era un valor que insinuaba una integración que
el producto niega en su propia pantalla de privacidad.

### 4.10 Ayuda (`14-ayuda.png`)

Centro de ayuda dentro de la app, en el menú principal. **Siete secciones con 30
temas**, contados del prototipo:

| Sección | `id` | Temas |
|---|---|---|
| Nominal y real | `inflacion` | 4 |
| Gastos recurrentes | `recurrentes` | 5 |
| De dónde sale cada total | `totales` | 3 |
| Histórico y proyección | `historico` | 3 |
| Seguimiento de precios | `precios` | 7 |
| Categorías, sobres y cuotas | `categorias` | 4 |
| Tus datos | `datos` | 4 |

Buscador sobre pregunta y respuesta, y filtro por sección.

Tres enlaces contextuales entran al tema exacto: el "?" junto al interruptor
nominal/real del Resumen, "¿Por qué la diferencia?" en el pie de Movimientos, y
"Cómo funciona" en el interruptor de gasto recurrente. Al navegar desde un
diálogo, el diálogo se cierra.

El contenido responde a las confusiones reales que aparecieron construyendo el
producto — sobre todo por qué la suma de movimientos no da el gasto del mes.
Es contenido del producto: va en el repo, no en un CMS.

### 4.11 Onboarding (`15-onboarding.png`)

Tres pasos con puntos de progreso: hogar e ingresos, primeras categorías, primeros
productos a seguir.

## 5. Matemática financiera

Constantes, en un solo lugar. Ningún otro número mágico en esta sección:

| Constante | Valor | Dónde vive |
|---|---|---|
| `IPC_PROY` | 2,0% mensual | `IPC_PROJECTED_MONTHLY_PCT` en `wrangler.toml` |

No hay una segunda tasa de crecimiento. Cualquier extrapolación —hacia atrás o
hacia adelante— sale de la serie de IPC del INDEC y, donde esa serie no llega, de
`IPC_PROY`. Una versión anterior de este documento extrapolaba al 3,5% mensual en
`monthNominal` y al 2,0% en `adjust`: dos fórmulas para lo mismo, exactamente lo que
prohíbe la regla 2 de `CLAUDE.md`.

### 5.0 De dónde sale el total de un mes

`monthNominal` no calcula nada: lee `month_totals`. Esta sección define quién
escribe esa fila, porque es el número del que dependen todas las pantallas.

El total **no** es la suma de `transactions`. Hay gasto sin movimiento individual
—alquiler, expensas, cuotas— y sumar filas de movimientos y llamarlo gasto del mes
es la regla 3 de `CLAUDE.md` al revés. El total de un mes es la suma de cuatro
términos disjuntos:

```
recomputeMonthTotal(hogar, y, m):

  A = Σ transactions del mes con rule_id IS NULL         compras reales sueltas

  B = Σ  para cada ocurrencia de recurring_rules que cae en el mes:
           existe transaction del mes con rule_id = regla  → el importe de ESA
                                                              transaction
           si no, y es el mes en curso, y existe una
           transaction del mismo merchant con rule_id NULL → 0   (ya está en A)
           si no                                          → regla.amount_cents

  C = Σ fixed_expenses vigentes en el mes                 alquiler, expensas, servicios

  D = Σ installments.monthly_cents con cuota vencida en el mes
        (cuotas 1..count_total contadas desde started_on; ver §4.5)

  month_totals.nominal_cents = A + B + C + D
```

**Cada peso se cuenta exactamente una vez, y los tres casos de B son los tres
estados en que puede estar una regla en un mes.** Vale la pena leerlos despacio,
porque las dos formas de equivocarse son simétricas y las dos son bugs de los que
este documento ya vio:

- Una ocurrencia **materializada** —hay un movimiento con su `rule_id`— aporta el
  importe real del movimiento, no el de la regla. `A` no lo cuenta, porque `A` exige
  `rule_id IS NULL`; si `B` tampoco lo contara, ese gasto no aparecería en ningún
  término. Netflix cargado por la regla desaparecería del mes.
- Una ocurrencia **tapada por una compra suelta del mismo comercio en el mes en
  curso** aporta cero, porque el movimiento ya entró por `A`. Es la regla 4 de
  `CLAUDE.md`: la regla no se duplica. Si `B` sumara igual, el mes tendría dos veces
  el mismo alquiler.
- Una ocurrencia **todavía sin movimiento** —el mes que viene, o el alquiler que
  nadie carga a mano— aporta el importe de la regla. Es lo que hace que un mes futuro
  tenga total y que el gasto sin movimiento individual exista (regla 3).

Cuando hay importe real y importe de regla, **manda el real**: es el que de verdad
salió de la cuenta.

**`fixed_expenses` y `recurring_rules` no son la misma cosa y nunca describen la
misma obligación.** `fixed_expenses` es un compromiso que no genera movimiento
individual; `recurring_rules` es una compra que se repite y sí lo genera. La
invariante: `POST /api/fixed` rechaza con `422` un nombre que coincide con el
`merchant` de una regla activa, y al revés. Sin esta validación el alquiler cargado
en los dos lugares infla el mes y no hay forma de notarlo mirando la pantalla.

**Cuándo se recalcula.** Siempre en el Worker, nunca en el cliente, y siempre para
el mes afectado:

| Cambio | Meses a recalcular |
|---|---|
| Alta, edición o baja de `transactions` | el mes del movimiento (y el anterior si cambió la fecha) |
| Confirmación de un ticket | el mes del movimiento creado |
| Alta, edición o baja de `recurring_rules` | desde el mes de inicio de la regla hasta el horizonte de proyección |
| Alta, edición o baja de `fixed_expenses` | el mes en curso hasta el horizonte |
| Cambio en `installments` | los meses con cuota vencida |
| Alta, edición o baja de `incomes` | `income_history`, del mes del cambio hacia adelante |

El horizonte de proyección son los 12 meses adelante que ofrece el selector de
§4.1. Un mes sin ningún dato **no tiene fila**: eso es distinto de una fila en cero,
y la diferencia importa (§5.1 y §12.2).

**`income_history` tiene el mismo problema y la misma solución.** Es el ingreso total
del hogar mes a mes, y de ahí sale el poder de compra del sueldo de §4.4: sin él, esa
curva no tiene con qué dibujarse. Nadie decía quién la escribe.

```
recomputeIncomeHistory(hogar, y, m):
  amount_cents = Σ incomes.amount_cents de los ingresos vigentes en el mes
```

Se recalcula al dar de alta, editar o borrar un ingreso, desde el mes del cambio
hacia adelante hasta el horizonte. Un mes ya cerrado **no se reescribe**: si en marzo
el hogar cobró lo que cobró, subir el sueldo en agosto no cambia marzo. Es
exactamente lo que hace valiosa a la curva —muestra que el sueldo quedó quieto
mientras los precios subían— y reescribir el pasado la borraría.

### 5.1 Total mensual — fuente única

```
monthNominal(y, m) → { cents, basis }

  basis 'real'      hay fila en month_totals(hogar, y, m)
                    → cents = nominal_cents

  basis 'estimado'  no hay fila y (y,m) es posterior al último mes real
                    → cents = último real * Π (1 + ipc_i)
                      con el IPC publicado donde exista, IPC_PROY donde no

  basis 'sin dato'  no hay fila y (y,m) es anterior al primer mes real
                    → cents = null
```

Toda pantalla que muestre un total mensual pasa por acá. Ver regla 2 de `CLAUDE.md`.

**Hacia atrás no se extrapola.** Antes del primer mes cargado el hogar no tiene
historia y Brote no la inventa: `basis` es `sin dato` y la UI omite el punto. Un
hogar con tres meses cargados ve tres barras, no cuarenta y cuatro. Los 44 meses de
§4.3 son el rango del **selector de período** —se puede navegar a un mes viejo y
está vacío—, no una afirmación de que hay 44 meses de gasto.

**`basis` viaja hasta la UI.** Cada punto de serie que devuelve la API lo lleva, y
la pantalla distingue medido de estimado: los estimados van con trama y con leyenda.
Un valor `estimado` no se presenta nunca como dato del mes, y un `sin dato` no se
dibuja nunca como cero. Es la regla 5 de `CLAUDE.md` —ningún número sin decir de
dónde salió— aplicada a la serie de gasto y no solo a los precios.

### 5.2 Escalar un importe entre meses

```
adjust(base, y, m):
  k = 0  → base
  k < 0  → base * monthNominal(y,m).cents / monthNominal(mesActual).cents
  k > 0  → base * (1 + IPC_PROY)^k
```

Hacia atrás manda la serie histórica, que trae inflación **y** crecimiento real del
gasto. Deflactar solo por IPC subestima el pasado y fue un bug.

Si cualquiera de los dos `monthNominal` no es `real` —`sin dato`, o `estimado`
porque el mes actual todavía no cerró—, `adjust` devuelve `null` y la pantalla omite
la cifra. No se rellena con el mes más cercano ni se degrada a un factor de IPC:
ahí es donde vuelve a nacer la segunda fórmula que prohíbe la regla 2.

### 5.3 Pesos constantes

```
monthFactor(y, m) = Π (1 + ipc_i / 100)   para cada mes entre (y,m) y el mes actual
real = nominal * monthFactor(y, m)
```

La base es **el mes en curso**: "pesos de hoy" quiere decir pesos del mes que está
corriendo, y por lo tanto toda cifra ajustada cambia cuando cambia el mes. Es lo
correcto y hay que decirlo en la UI donde se muestra un total anual ajustado.

### 5.4 Variación real

```
realChange = (gastoAhora / (gastoAnterior * (1 + ipcMes))) - 1
```

`ipcMes` es el IPC del **mes más reciente de los dos** que se comparan: al comparar
julio contra junio se descuenta la inflación de julio. Si ese IPC todavía no está
publicado, se usa la estimación de §5.7 y la cifra queda marcada.

### 5.5 Proyección

Tendencia real de los últimos meses extrapolada al mes destino, más IPC proyectado
para el valor nominal. Se muestran los dos números por separado.

### 5.6 Canasta y compra dividida

Canasta por comercio: suma de los productos disponibles en ese comercio, solo
fuentes habilitadas. Compra dividida: agrupar cada producto en el comercio con el
precio más bajo; una pata por comercio ganador; el ahorro es la diferencia contra el
mejor comercio en una sola parada. Si hay una sola pata, el texto lo dice.

### 5.7 El IPC del mes que todavía no publicó el INDEC

El INDEC publica el IPC de un mes alrededor del día 15 del siguiente. O sea: durante
unas seis semanas el mes más reciente no tiene dato oficial, y `monthFactor` (§5.3) y
`realChange` (§5.4) lo necesitan. Con inflación mensual de varios puntos, no tener
ese número mueve visiblemente todas las cifras de la pantalla —incluida la columna
de variación real, que según §4.2 es la que decide el color de la fila.

La política, que es la que ya dice la Ayuda del prototipo ("El mes en curso usa una
estimación hasta que sale el dato oficial, y queda marcado como estimado"):

1. La tabla `inflation` es la autoridad. Un mes sin dato oficial se inserta con
   `monthly_pct = IPC_PROY` y `is_estimate = 1`.
2. Se calcula igual. **No** se suprime la columna de variación real: dejar la
   pantalla principal sin su número más importante durante seis semanas de cada mes
   es peor que estimarlo.
3. Toda cifra cuya cadena de cálculo tocó un `is_estimate = 1` se marca. La API lo
   devuelve como `ipcEstimated: true` y la UI lo dice con palabras, no con un
   asterisco.
4. Cuando sale el dato oficial, el cron del día 15 reemplaza la fila
   (`is_estimate = 0`) y recalcula. Las cifras ajustadas de ese mes cambian: es
   esperado y la Ayuda lo explica.
5. Nunca se presenta una estimación como medición. Es la misma regla que para los
   precios (regla 5 de `CLAUDE.md`).

### 5.8 Redondeo

Los importes son enteros de centavos (`CLAUDE.md`), pero §5.1–§5.4 son cadenas de
multiplicaciones por factores fraccionarios. La regla: **se calcula en punto
flotante y se redondea una sola vez, en el borde**, cuando la cifra se serializa a
JSON. Redondear en cada paso de una cadena de 44 factores acumula deriva.

Un total mensual del orden de `$ 2.736.800` son 273.680.000 centavos: entra de sobra
en el entero seguro de JavaScript, así que `number` alcanza y no hace falta
`BigInt`. Los porcentajes viajan como `number` con un decimal, ya redondeados en el
servidor: el cliente no recalcula inflación (ver `api-contract.md`).

## 6. Ingesta de datos externos

| Dato | Fuente | Frecuencia | TTL en KV | Serie durable |
|---|---|---|---|---|
| Cotización USD/EUR/CHF oficial | Banco Nación | diaria, 11:00 ART | 26 h | `fx_rates` |
| Cotización de referencia | xe.com | diaria | 26 h | `fx_rates` |
| IPC | INDEC | mensual, día 15 | 40 d | `inflation` |
| Precios de productos | comercio por comercio | cada 6 h | 7 h | `item_prices` |
| HTML de páginas de producto | el comercio | por consulta | 6 h | — (solo cache) |

**El TTL siempre es mayor que el intervalo de refresco.** Con TTL 12 h y refresco
diario había doce horas por día en las que la entrada de KV ya no estaba y el camino
de lectura no tenía de dónde sacar el dato: el Worker no puede salir a la red en el
request de un usuario (`CLAUDE.md`), así que la pantalla se quedaba sin cotización.
El margen de las dos horas extra absorbe una corrida que falló o que se atrasó.

**Camino de lectura, en este orden y sin un cuarto paso:**

1. KV. Si está, se usa.
2. Si no está, la última fila de la tabla durable de D1 (`fx_rates`, `inflation`,
   `item_prices`) y se repuebla KV. **D1 es la fuente de verdad; KV es cache
   caliente.** Un dato viejo con su fecha visible es un resultado aceptable.
3. Si D1 tampoco tiene nada —instalación nueva, cron que nunca corrió—, la API
   responde el estado vacío correspondiente. Nunca un cero, nunca una estimación,
   nunca un fetch en el request.

Todo el trabajo de red se ejecuta en Cron, en lotes de 40 productos ordenados por
`last_checked_at` (ver `DEPLOY.md` §5); nunca en el request del usuario. Cada precio
se guarda con comercio, fecha de consulta y fuente. Si una consulta falla, se
conserva el precio anterior, se marca `stale` y la UI muestra su antigüedad.

**Cuándo un precio es `stale`**, porque de esto depende lo que la pantalla dice y no
estaba definido. El cron lo escribe, no la UI, y hay dos causas:

1. **El último intento falló.** El precio anterior queda `stale = 1` en el momento en
   que la consulta falla, con su fila en `price_fetch_log`. No importa la antigüedad:
   sabemos que hoy no pudimos confirmarlo.
2. **Pasó el doble de la cadencia del hogar** sin una consulta exitosa: más de dos
   días en `daily`, más de catorce en `weekly` (§6.3). Un precio de ayer en un hogar
   `weekly` **no** es `stale`; uno de tres semanas sí.

Un precio `stale` no se oculta ni se reemplaza: se muestra con su antigüedad, que es
la regla 5. Y una consulta exitosa lo vuelve a poner en `0` — es la única cosa que
lo limpia.

Un adaptador por comercio, todos con la misma interfaz, para poder cambiar de método
sin tocar el resto:

```ts
type PriceSource = "api" | "scrape" | "llm" | "manual";

interface RetailerAdapter {
  fetchPrice(item: WatchedItem, url?: string):
    Promise<{ priceCents: number; at: string; source: PriceSource }>;
}
```

`PriceSource` y el `CHECK` de `item_prices.source` en `schema.sql` son la misma
lista y se editan juntos. `receipt` es un valor válido de la columna pero no de esta
interfaz: ese precio lo trae el OCR de un ticket (§10), no un adaptador.

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

### 6.2 Qué vía usa cada comercio de fábrica

Esto era una decisión pendiente y ya no lo es: la vía técnica de cada uno está
determinada por la plataforma sobre la que corre su tienda, y eso es verificable.
Cinco de los diez corren **VTEX**, que expone un endpoint JSON de catálogo del
propio storefront —el mismo dato que la página renderiza— y por lo tanto no
necesitan ni scraping de HTML ni una llamada al modelo:

```
GET https://{sitio}/api/catalog_system/pub/products/search/{término}?_from=0&_to=0
→ [ { productName, brand, items: [ { sellers: [ { commertialOffer:
      { Price, ListPrice, IsAvailable, AvailableQuantity } } ] } ] } ]
```

| Comercio | `kind` | Plataforma verificada | Cómo se resuelve el precio |
|---|---|---|---|
| Mercado Libre | `api` | API pública documentada | API oficial, con su token |
| Día | `api` | VTEX (`x-vtex-*`) | Endpoint de catálogo |
| Jumbo | `api` | VTEX | Endpoint de catálogo |
| Disco | `api` | VTEX | Endpoint de catálogo |
| Vea | `api` | VTEX | Endpoint de catálogo |
| Farmacity | `api` | VTEX | Endpoint de catálogo |
| Coto | `scrape` | No VTEX | Adaptador propio |
| Carrefour | `scrape` | No VTEX (Apache) | Adaptador propio |
| Diarco | `llm` | Sin tienda pública estable | La vía de §6.1, como un sitio del usuario |
| Almacén del barrio | `manual` | — | Lo carga el usuario |

Jumbo, Disco y Vea son del mismo grupo y comparten plataforma: **un solo adaptador
VTEX parametrizado por dominio** cubre los cinco, no cinco adaptadores. Es el
argumento más fuerte para empezar por acá en el paso 5 de §14.

Dos detalles que salen de probar el endpoint y que hay que respetar:

- **El campo es `Price`**, en pesos y como decimal. `ListPrice` puede venir con
  valores absurdos —se vio un `1198347.0` junto a un `Price` de `14500.0`— así que
  no se usa, y todo precio pasa por una validación de rango antes de guardarse. Un
  precio que no pasa la validación es un fallo (`price_fetch_log`), no un dato.
- Pesos decimales a centavos enteros: `round(Price * 100)`, una sola vez, al
  guardar. Ver §5.8.

**Lo que sigue siendo del negocio y no de la ingeniería** es el permiso, no el
método. Antes de encender cualquier consulta automática hay que revisar los términos
de uso del sitio; que el endpoint sea público y que `robots.txt` no lo prohíba es
necesario y no es suficiente.

**Estado inicial de las conexiones de un hogar nuevo: decidido, y es por vía de
acceso.** Encendidas las que consultan un endpoint público y documentado de la propia
tienda; apagadas las que necesitan leer HTML que el comercio no publicó para eso.

| Vía | Comercios | Estado inicial |
|---|---|---|
| `api` | Mercado Libre, Día, Jumbo, Disco, Vea, Farmacity | **Encendida** |
| `scrape` | Coto, Carrefour | **Apagada** |
| `llm` | Diarco | **Apagada** |
| `manual` | Almacén del barrio | No consulta: la carga el usuario |

Así Precios arranca con precios de seis comercios el primer día, y nada que dependa
de leer HTML ajeno sale a la red hasta que alguien lo enciende a sabiendas.

**No se implementa como "fila ausente = habilitada".** Al crear el hogar se insertan
las diez filas de `connections` con su `enabled` explícito. La ausencia de fila no
significa nada —es un hogar a medio crear— y así el estado de cada fuente se puede
leer, auditar y cambiar sin depender de un default implícito. El prototipo usa
`conns[r] !== false` porque es un prototipo con estado en memoria; el producto no.

Lo que queda decidido además, y no depende de lo anterior:

1. La revisión de términos y cada encendido o apagado se anotan en `audit_log` con la
   acción `connection_toggle`: queda quién lo hizo y cuándo.
2. Las consultas van al ritmo del cron —lotes de 40, con la cadencia del hogar de
   §6.3 y timeout por comercio— y no se acelera para "probar".
3. Un comercio que responde `429` o `403` se marca `status = 'degraded'` y se deja de
   consultar hasta que alguien lo mire. Eso no es negociable ni configurable.

API siempre es preferible a scraping: más rápido, más barato, más estable y menos
invasivo con el sitio. Un comercio que hoy está en `scrape` y mañana publica una
API se pasa a `api`, que es exactamente para lo que existe la interfaz de §6.

### 6.3 La frecuencia que elige el hogar contra el cron que es de todos

El cron de precios corre cada 6 h para toda la instalación (§2), pero el hogar elige
su propia cadencia en Conexiones, con dos opciones que la UI etiqueta **"Diaria"** y
**"Semanal"** (`check_frequency` = `daily` | `weekly`). Cómo conviven no estaba
escrito, y sin eso la preferencia es decorativa.

La cadencia del hogar es un **filtro de elegibilidad**, no un cron propio. Cada
corrida sigue armando el lote por `last_checked_at` ascendente (`DEPLOY.md` §5) y
agrega la condición:

```sql
select * from watched_items w
join households h on h.id = w.household_id
join alert_prefs p on p.household_id = h.id
where w.last_checked_at is null
   or w.last_checked_at < datetime('now',
        case p.check_frequency when 'weekly' then '-7 days' else '-1 day' end)
order by w.last_checked_at asc nulls first
limit 40
```

Consecuencias que hay que respetar:

- Un hogar en `weekly` **no** se consulta cuatro veces por día: sus productos quedan
  fuera del lote hasta que pasan siete días. Es el punto de la preferencia.
- Un producto que el usuario refresca a mano pone `last_checked_at = null` y por eso
  encabeza el lote siguiente, cualquiera sea la cadencia del hogar. El pedido
  explícito le gana a la preferencia.
- La antigüedad que muestra la UI se vuelve más grande en `weekly`, y eso está bien:
  el precio va con su fecha (regla 5). Lo que no puede pasar es que la pantalla
  presente un precio de seis días como si fuera de hoy.
- Sin fila en `alert_prefs`, la cadencia es `daily` por el `DEFAULT` de la columna.

Antes esta columna admitía `'6h'`, `'12h'` y `'24h'`: no podía representar "Semanal"
y ofrecía dos valores que ninguna pantalla mostraba.

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

#### 7.1.1 Cómo entra el segundo integrante del hogar

Access decide **quién llega a la aplicación**. Brote decide **a qué hogar
pertenece**. Son dos cosas distintas y las dos hacen falta: sin esto, Valentina pasa
Access, entra, y se encuentra con un hogar vacío propio en vez del de Martín.

Por eso `users.household_id` es nullable: un usuario válido todavía sin hogar es un
estado legítimo del sistema, no un error.

1. **Primer ingreso de la instalación**: no hay ningún hogar. Se crea el hogar, se
   crea el usuario con `role = 'owner'` y arranca el onboarding de §4.11.
2. **Ingreso de un mail desconocido**: se busca en `invites` una invitación vigente
   (`email` coincide, `expires_at` en el futuro, `accepted_at IS NULL`). Si hay, el
   usuario se crea con el `household_id` de la invitación y `role = 'member'`, y la
   invitación se marca aceptada. Si no hay, se crea la fila en `users` con
   `household_id NULL` y la pantalla pide que le pidan la invitación a quien
   administra el hogar. **No se crea un hogar nuevo**: crear un hogar por cada mail
   que pasa Access es exactamente el bug que esta sección evita.
3. **Invitar** es `POST /api/invites`, solo `role = 'owner'`.

**Son dos pasos y hay que decirlo en la UI**, porque el que administra tiene que
hacer los dos: agregar el mail en la policy de Access —si no, el invitado no llega
ni a la pantalla de login— y crear la invitación en Brote —si no, llega y no tiene
hogar. La pantalla de invitación los muestra como checklist de dos ítems, no como un
solo botón que miente.

Un usuario con `household_id NULL` recibe `403 forbidden` en todo endpoint de datos.
No es `401`: está autenticado, simplemente todavía no pertenece a ningún hogar.

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
2. Se sube directo a R2 con URL pre-firmada emitida por el Worker. La URL está
   fuera de Access por definición, así que se acota: la fila en `receipts` se crea
   **antes** de emitirla, la URL sirve para esa única clave de R2, vale 300 segundos
   (`expiresIn` en `api-contract.md`) y es solo `PUT`. Después de la subida el Worker
   valida tipo y tamaño del objeto contra lo declarado y descarta lo que no cierre:
   una URL pre-firmada sin validación posterior es un endpoint de subida abierto.
3. El Worker llama a **Cohere** dentro del mismo request, con timeout: extrae
   comercio, fecha, total y líneas.
4. El usuario **confirma o corrige** antes de que se cree el movimiento; nunca se
   crea automáticamente. El vínculo queda de los dos lados —`receipts.transaction_id`
   y `transactions.receipt_id`— y los dos se escriben en el **mismo batch de D1**.
   `receipts.transaction_id` es el autoritativo: si alguna vez discrepan, el
   back-pointer de `transactions` es el que está mal.
5. Los productos detectados se ofrecen como sugerencias para seguir precio.
6. **La imagen la borra el usuario cuando quiere, y el borrado es real**: se va la
   fila y se va el objeto en R2. No hay descarte automático a los 30 días ni a
   ningún plazo; la foto vive hasta que alguien la borra o hasta que se borra el
   hogar entero. El movimiento que salió del ticket sobrevive al borrado de la foto.
   Una fila de `receipts` con `deleted_at` y el objeto todavía en R2 es un bug de
   privacidad, y el test que lo cubre va con el borrado (sección Privacidad de
   `CLAUDE.md`: "implementar el borrado de verdad, incluyendo objetos en R2").

Nada de la foto sale de la infraestructura del proyecto salvo hacia Cohere, que es
el proveedor de OCR y el mismo que lee precios en HTML (§6.1). **Se nombra en la
pantalla de privacidad**, con esas palabras: decir "un proveedor de OCR" y no cuál
es no cumple el requisito de la sección Privacidad de `CLAUDE.md`.

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
| Precios · Lista de compras | Sin productos seguidos no hay lista. No mostrar tarjetas de comercio vacías ni un "Total estimado $ 0" | "Agregar producto" |
| Precios · Avisos | Sin avisos todavía: decir que se generan cuando un precio baja de lo que pidió, no "No hay información disponible" | "Configurar los avisos" |
| Conexiones | Las diez fuentes ya sembradas: las seis de `api` encendidas, Coto, Carrefour y Diarco apagadas (§6.2) | "Activar los que uses" y "Agregar una fuente" |
| Ayuda | Funciona desde el día uno | — |

Falta un estado que no es de datos vacíos sino de pertenencia, y sale de §7.1.1: el
**usuario que pasó Access y todavía no tiene hogar**. No ve ninguna de las pantallas
de arriba. Ve una sola, que dice quién administra el hogar y que le tiene que mandar
la invitación. No se le crea un hogar propio para tener algo que mostrarle: eso
parece funcionar y en realidad lo deja mirando datos que no son de nadie.

El teléfono no tiene fila propia: las cuatro pantallas angostas de §4.8 son las mismas
que las de arriba y heredan su estado vacío, con el mismo texto y el mismo botón. Un
estado vacío que dice una cosa en el escritorio y otra en el teléfono es un bug.

Reglas para escribirlos: nunca un gráfico vacío con ejes y sin datos, nunca un
`$ 0` presentado como si fuera un dato, nunca "No hay información disponible". El
estado vacío dice qué falta y ofrece el botón que lo resuelve, en una línea.

Con un solo mes cargado, todo lo que compara contra el mes anterior tiene que
degradar con gracia: se muestra el valor y se omite la variación, sin fingir un
0% ni un +∞.

## 13. Requisitos no funcionales y operación

El valor del producto es que los números estén bien. Los trabajos de fondo que
alimentan esos números y el aislamiento entre hogares son parte del diseño, no
detalles de deploy.

### 13.1 Migraciones del esquema

`schema.sql` es la línea de base de la v1 y se aplica una sola vez, en una base
vacía. Todo cambio posterior es un archivo nuevo en `migrations/NNNN-nombre.sql`,
numerado, **solo hacia adelante**, aplicado con
`npx wrangler d1 migrations apply brote`. No se edita una migración ya aplicada y no
se edita `schema.sql` para cambiar una base que ya existe: se agrega la migración y
`schema.sql` queda como referencia del punto de partida.

Una migración que toca `month_totals`, `inflation` o cualquier cosa de §5 fuerza un
recálculo (§5.0) como último paso del mismo archivo.

### 13.2 Salud de los trabajos de fondo

Un precio viejo con su fecha a la vista es un resultado aceptable (§6). **Un cron
que dejó de correr sin que nadie se entere, no.** Sin esto, el cron de cotizaciones
puede estar caído nueve días y la pantalla se ve perfecta, mostrando el mismo número
de siempre.

Cada corrida de `scheduled` escribe una fila en `job_runs`: qué trabajo, si terminó
bien, cuánto tardó, qué error. El cron de alertas de las 9:00 hace además de
vigilante: si un trabajo no tiene una corrida exitosa en **el doble de su intervalo**
—52 h para cotizaciones, 14 h para precios, 40 días para IPC—, genera una alerta
`job_stale`. Es la única alerta que no es sobre el dinero del hogar sino sobre Brote,
y aparece igual.

`price_fetch_log` sigue siendo el detalle por comercio: un comercio con muchos
fallos cambió su HTML (`DEPLOY.md` §8). `job_runs` es el nivel de arriba, el que
dice si el trabajo corrió.

Backups y logs, en `DEPLOY.md` §8: D1 tiene time travel de 30 días y el export
propio es barato.

### 13.3 Aislamiento por hogar, con mecanismo

"Toda query filtra por `household_id`" es una intención hasta que hay algo que la
hace cumplir. Una query sin filtrar es una fuga de datos entre hogares, y en tres
meses de código nadie se acuerda de la regla.

El mecanismo:

- Todo acceso a D1 pasa por `src/lib/db/`. Cada función de ahí recibe un
  `HouseholdContext` como **primer parámetro** y lo aplica ella misma. No es un
  parámetro opcional y no hay una variante sin él.
- `env.DB` no se usa en ningún lado fuera de `src/lib/db/`. Un test recorre el árbol
  y falla si aparece: es una prueba fea y vale lo que cuesta.
- El contexto sale del JWT validado (§7.1), nunca del body ni del query string.
  `api-contract.md` ya lo dice del lado de la API: ningún endpoint acepta
  `householdId` del cliente. Esta es la misma regla del lado de los datos.
- En `src/lib/db/public/` van **solo** las tablas de contexto y de Brote: `fx_rates`,
  `inflation`, `job_runs`. Nada más. Son las únicas que se pueden leer sin un hogar.
- **Las hijas de `watched_items` no van ahí** (§3). `item_prices`, `item_urls`,
  `item_alternatives` y `price_fetch_log` son datos del hogar que llegan por
  `item_id`, así que toda función que las toque recibe el `HouseholdContext` y
  **resuelve el padre primero**: el `item_id` se valida contra
  `watched_items.household_id` antes de leer o escribir la hija. En SQL, un `join` a
  `watched_items` con el filtro puesto; nunca `where item_id = ?` a secas.

  Esto no es teórico. `GET /api/watch/items/:id/history` y
  `PUT /api/watch/items/:id/urls` reciben el id en la URL: si la consulta filtra solo
  por `item_id`, cualquier hogar lee el historial de precios de otro cambiando un
  número en la dirección. El test que lo cubre pide el `:id` de un hogar con el token
  de otro y exige `404`, no `403`: que ni siquiera confirme que el id existe.

### 13.4 Decisiones abiertas

**Una.** Las otras se resolvieron y quedaron escritas donde corresponde:

| Decisión | Resuelta en |
|---|---|
| Vía de acceso de cada comercio de fábrica | §6.2 |
| Pantallas del prototipo sin especificar | §4.6, §4.8 |
| Estado inicial de las conexiones: por vía de acceso | §6.2 |
| La copy que prometía descartar la foto a los 30 días: se cambia la copy | §4.8 |
| El insight de suscripciones: reformulado sobre lo observable | §4.2, §4.2.1 |
| `mobile`: no es una vista, es el diseño responsive | §4, §4.8 |

Queda abierta:

1. **La importación por CSV** (§4.9). Está en el diseño como uno de los tres
   interruptores de "qué entra" y no está especificada: qué formatos acepta, cómo
   mapea a categorías, qué hace con los duplicados. Mismo criterio que las pantallas
   de §4.6 —primero se escribe acá, no se implementa a partir de la captura— y no
   bloquea nada antes del paso 9 de §14, porque los movimientos se cargan a mano y
   por ticket desde el paso 2.

Lo que **no** es una decisión abierta, aunque lo parezca: revisar los términos de uso
de cada comercio antes de encenderlo (§6.2). Eso es un paso del procedimiento, con su
registro en `audit_log`; no bloquea escribir el código.

### 13.5 Valores por defecto a confirmar

Varios números de este documento **no salen del prototipo ni de una restricción de la
plataforma**: los elegí yo al escribirlo porque el hueco necesitaba un valor. Son
razonables y son discutibles, y conviene que se lean como defaults y no como
decisiones tomadas:

| Valor | Dónde | De dónde salió |
|---|---|---|
| Invitación vence a los 14 días | §7.1.1 | Elegido |
| TTL de KV 26 h / 40 d / 7 h | §6 | La **regla** —TTL mayor que el intervalo— es firme; los números son elegidos |
| `job_stale` al doble del intervalo | §13.2 | Elegido |
| `stale` al doble de la cadencia | §6 | Elegido, por coherencia con el de arriba |
| `item_prices` se agrega a semanal a los 18 meses | §13.5 | Elegido |
| Promedio de la categoría sobre 6 meses | §4.2.1 | Elegido; el prototipo dice "tu propio promedio" y no da ventana |
| `comprasPorMes = 30 / cadence_days` | §4.1.1 | Elegido |
| p75 de lectura < 300 ms | §13.5 | Elegido |

Lo que **no** es elegido y no se toca sin cambiar el producto: `IPC_PROY = 2,0%`
(está en `wrangler.example.toml`), los 300 s de la URL pre-firmada (está en
`api-contract.md`), la hora `08:00` de los avisos y los lotes de 40 (están en el
prototipo y en `DEPLOY.md`).

### 13.6 Objetivos y límites

- **Latencia**: p75 de los endpoints de lectura por debajo de 300 ms de tiempo de
  servidor. Todos leen de D1 o KV; ninguno sale a la red (§6).
- **Corrida de cron**: bien lejos de los 1000 subrequests y 30 s de CPU por
  invocación. El lote de 40 con timeout por comercio es lo que lo garantiza
  (`DEPLOY.md` §5).
- **Volumen**: un hogar carga del orden de decenas de movimientos por mes y sigue
  decenas de productos. El límite de 10 GB de D1 no se toca. Lo que crece de verdad
  es `item_prices` —productos × comercios × cuatro corridas diarias—: se conserva un
  precio por producto, comercio y día, y por encima de 18 meses se agrega a un
  precio semanal.
- **Errores**: todo `5xx` y todo fallo de cron quedan en los logs del Worker con el
  `household_id` cuando corresponde, nunca con importes ni nombres de comercio del
  hogar.

### 13.7 Estrategia de test

`CLAUDE.md` pide un test por regla del dominio. Dos cosas más, que son las que
atrapan los bugs que este documento ya vio una vez:

- **Test de número único.** Para un mes fijo de fixture, `GET /api/overview`,
  `GET /api/transactions`, `GET /api/analysis` y `GET /api/transactions/annual`
  tienen que devolver **el mismo** total para ese mes, comparado por igualdad exacta
  de centavos. Es la regla 2 de `CLAUDE.md` convertida en algo mecánico: la segunda
  fórmula no se detecta leyendo código, se detecta cuando tres pantallas dan tres
  números.
- **Test de procedencia.** Ninguna respuesta de la API puede traer un importe con
  `basis` distinto de `real` sin su marca, ni un precio sin `checkedAt` y `source`
  (reglas 5 y 2). Un test recorre las respuestas de los fixtures y lo verifica.

Los datos de §12.1 son los fixtures. Corren en test y en el entorno de demo; no
tocan producción.

## 14. Orden de implementación sugerido

1. Worker + SPA vacía + D1 con `schema.sql` + Access (§7.1) + el acceso a datos de
   §13.3 con su test. El aislamiento va en el paso 1: agregarlo después es reescribir
   todas las queries.
2. Categorías, movimientos manuales, reglas recurrentes, `month_totals` con su
   recálculo. Tests de §5.0, §5.1 y §5.2, más el test de número único de §13.7.
3. Resumen y Análisis de gastos con datos reales.
4. Presupuesto, objetivos, ingresos y compromisos.
5. Precios: **el adaptador VTEX primero**, que con un solo adaptador parametrizado
   por dominio cubre cinco de los diez comercios de fábrica (§6.2); después Mercado
   Libre por su API, y al final los de adaptador propio y la vía del modelo de §6.1.
   Lista de compras y Avisos (§4.6) salen del mismo cálculo de §5.6: no se les
   escribe una fórmula aparte.
6. **Responsive de las cuatro pantallas de §4.8**, en la misma etapa en que se
   construye cada una y no como un paso al final: son las mismas pantallas en angosto,
   así que dejarlo para después significa rehacerlas. No hay una vista "En el
   teléfono" que construir.
7. Divisas e inflación por Cron (§4.7), con `job_runs` y la alerta `job_stale` de
   §13.2 en la misma etapa: un cron sin vigilancia no se nota cuando se cae.
8. Fotos de tickets y OCR.
9. Exportaciones, alertas, privacidad.
