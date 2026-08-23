# CLAUDE.md — Brote

Presupuesto personal para hogares argentinos, con análisis de gastos ajustado por
inflación y seguimiento automático de precios. Se despliega en Cloudflare.

Antes de empezar, leer `SDD.md` completo y mirar `screenshots/`. El prototipo en
`design-reference/Brote Budget.dc.html` es la referencia visual y de copy: es un
archivo HTML con estilos inline y un runtime propietario, **no se copia código de ahí**,
se recrean los diseños.

## Stack

- **Runtime**: Cloudflare Workers (`nodejs_compat`), TypeScript estricto.
- **Framework**: Hono para el router del Worker.
- **UI**: React 18 + Vite, servido como static assets del Worker. Tailwind opcional;
  si se usa, mapear los tokens de `design-reference/_ds/.../styles.css` a la config
  de Tailwind en lugar de inventar una paleta nueva.
- **Datos**: D1 (SQLite) como base principal. Esquema en `schema.sql`.
- **Cache**: KV para cotizaciones, IPC y precios scrapeados (TTL en `SDD.md` §6).
- **Archivos**: R2 para fotos de tickets.
- **Trabajo periódico**: solo Cron Triggers, sin Queues. Cotizaciones, IPC, precios y
  alertas corren en el handler `scheduled`. Precios por lotes de 40 ordenados por
  `last_checked_at`, con `Promise.allSettled` y timeout por comercio. El OCR de
  tickets va en el request, no diferido. Ver `DEPLOY.md` §5.
- **Auth**: Cloudflare Access con Google como IdP. El Worker valida el JWT
  `Cf-Access-Jwt-Assertion` contra el JWKS del equipo en cada request. No hay flujo
  OAuth propio, no hay tabla `sessions`. Ver `SDD.md` §7.1.
- **IA**: Cohere. Un solo proveedor para dos usos — leer tickets (imagen → JSON) y
  leer el precio en el HTML de un comercio agregado por el usuario. Ver `SDD.md` §6.1.

No agregar dependencias fuera de esta lista sin preguntar.

## Reglas del dominio — no negociables

Estas reglas son la razón de existir del producto. Romper cualquiera lo convierte en
otra app de gastos.

1. **Todo importe histórico se muestra en pesos constantes por defecto.** El toggle
   "Ajustado por inflación / Pesos nominales" existe en el Resumen y afecta a todas
   las series. El default es ajustado.
2. **Una sola función define cuánto costó un mes.** En el prototipo es
   `monthNominal(y, m)`, alimentada por la serie histórica real. Toda pantalla que
   muestre un total mensual la usa. Está prohibido tener una segunda fórmula
   (por ejemplo deflactar solo por IPC): ese fue un bug real y dio números
   distintos en tres pantallas para el mismo mes.
3. **El libro de movimientos es un subconjunto del gasto total.** Hay gasto sin
   movimiento individual (alquiler, expensas, cuotas). Nunca sumar filas de
   movimientos y presentar el resultado como gasto del mes: los totales salen de
   las categorías. Cuando se muestran ambos, decirlo en la UI, como hace el pie de
   Movimientos: "14 de 14 compras con detalle · $ 662.450 de $ 2.736.800 gastados en el mes".
4. **Los gastos recurrentes son reglas, no etiquetas.** Una regla tiene frecuencia
   (semanal, mensual, bimestral, anual), día y mes de inicio, y se materializa en
   todos los meses desde su inicio, incluidos los futuros. No aparece antes de su
   mes de inicio. En el mes en curso, si ya existe un movimiento real del mismo
   comercio, la regla no se duplica.
5. **Los precios mostrados llevan fecha y comercio.** Nunca un precio sin decir de
   dónde salió y cuándo se consultó. Si la consulta falló, se muestra el último
   precio con su antigüedad, no un precio inventado. Esto vale doble cuando el
   precio lo extrajo un modelo: si el JSON no parsea o viene `null`, es un fallo,
   no un cero ni una estimación.
6. **Ahorros y ahorros potenciales se calculan, no se hardcodean.** Los KPIs de
   ahorro y el plan de compra dividida se derivan de los precios disponibles y de
   qué fuentes tiene habilitadas el usuario. Si apagar una fuente no cambia el
   número, está mal.
7. **La conversión a dólares usa una cotización con fecha visible**, y BNA y xe.com
   se muestran por separado. Nunca promediar las dos fuentes en un número solo.

## Idioma y formato

- Toda la UI en **español rioplatense**, voseo ("agregá", "mirá", "seguís").
  Sin tuteo, sin español neutro.
- Copy del prototipo **literal**. No reescribir, no "mejorar", no acortar.
- Moneda: `$ 2.736.800` — símbolo, espacio fino, punto de miles, sin decimales.
  Miles en punto y decimales en coma, formato es-AR.
- Fechas cortas en minúscula: `17 ago`. Meses largos en minúscula: `agosto 2026`.
- Porcentajes con coma: `+3,2%`. Signo siempre visible en variaciones.

## Convenciones de código

- Los cálculos financieros van en `src/lib/finance/`, puros y con tests. Cada regla
  del dominio de arriba necesita al menos un test.
- Importes en **centavos, como entero**. Nunca float para dinero.
- El Worker no hace llamadas HTTP salientes en el camino de un request de usuario,
  con una excepción: el OCR de un ticket recién subido. Scraping y cotizaciones se
  hacen en Cron y se leen de KV.
- Multi-tenant desde el primer día: cada tabla tiene `household_id` y toda query lo
  filtra. Un hogar tiene varios usuarios (el prototipo muestra "Casa Domínguez" con
  Martín y Valentina).
- Sin `any` en dominio financiero.

## Privacidad

Requisito del producto, visible en la pantalla Conexiones: las credenciales bancarias
no se guardan; el borrado de datos es real y se confirma por correo; las fotos de
tickets se procesan y se pueden borrar. Implementar el borrado de verdad, incluyendo
objetos en R2.

## Qué no hacer

- No inventar pantallas ni features que no estén en `SDD.md`. Si algo falta, preguntar.
- No sustituir la paleta ni las tipografías (Caprasimo para títulos, Figtree para
  texto). El usuario puede elegir entre 6 paletas y 5 fondos: es un feature, está en
  `SDD.md` §11.
- No poner grillas con pistas fijas que no puedan encogerse. Usar
  `repeat(auto-fit, minmax(Npx, 1fr))` y `minmax(0, ...)`: los desbordes en las
  tarjetas de precios vinieron justamente de pistas fijas.
- No dejar datos de demostración en producción. `SDD.md` §12 lista qué es demo, qué
  sí se carga de fábrica (categorías, comercios, IPC) y cómo es cada estado vacío.
  La base de producción arranca vacía: un hogar nuevo no tiene ni un movimiento.
