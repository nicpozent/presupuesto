# Empezar el desarrollo de la app real

Guía de arranque para construir Brote con base de datos, login y precios en vivo.
Esto **no es un deploy**: es abrir un proyecto de desarrollo. El paso a paso de la
publicación está en `DEPLOY.md`, y se usa recién al final del punto 1 de abajo.

---

## Las tres decisiones previas: resueltas

**1. Login: Cloudflare Access con Google.** Brote es para un hogar. No se escribe
flujo OAuth, no hay tabla `sessions`, los mails permitidos se administran en el
panel. El Worker sí valida el JWT en cada request. Detalle en `SDD.md` §7.1.

**2. IA: Cohere, para las dos cosas.** Leer tickets (imagen → JSON con comercio,
fecha, total y líneas) y leer el precio en el HTML de un comercio agregado por el
usuario. Un proveedor, una API key, un solo lugar donde mirar el gasto. Sacá la
key en dashboard.cohere.com antes de la etapa 5.

**3. Comercios: los diez de fábrica más los que agregue el usuario.** Ya está en el
diseño — Conexiones tiene "Agregar sitio" con nombre y URL, y verifica el sitio al
guardarlo. Técnicamente son `kind = 'llm'`: se trae el HTML y Cohere extrae el
precio, en vez de escribir un scraper por sitio. `SDD.md` §6.1.

Lo único que queda abierto, y es del negocio: **de los diez de fábrica, cuáles van
por API oficial**. Siempre que haya API, es preferible a leer HTML.

---

## Preparar el proyecto

```bash
mkdir brote-app && cd brote-app
git init
```

Copiá adentro el paquete de handoff entero:

```
brote-app/
├── CLAUDE.md              ← copiado desde design_handoff_brote_budget/
├── docs/
│   ├── SDD.md
│   ├── DEPLOY.md
│   ├── api-contract.md
│   └── screenshots/
├── design-reference/      ← el prototipo y el sistema de diseño
└── schema.sql
```

`CLAUDE.md` va en la raíz: Claude Code lo lee solo en cada sesión. Es lo que
mantiene las reglas del dominio en pie sin que tengas que repetirlas.

Instalá Claude Code y abrí el proyecto:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

---

## El primer mensaje

No le pidas "hacé la app". Pedile una etapa, con criterio de terminado:

> Leé CLAUDE.md, docs/SDD.md completo y mirá docs/screenshots/.
> Vamos a construir Brote por etapas; hoy solo la etapa 1.
>
> Etapa 1: Worker con Hono + SPA de React con Vite servida como assets del mismo
> Worker + D1 con schema.sql aplicado + login con Google. Nada de pantallas de
> producto todavía: alcanza con entrar, ver el nombre del hogar y salir.
>
> Antes de escribir código mostrame la estructura de carpetas que proponés y
> esperá que la apruebe.

Ese "esperá que la apruebe" importa. La estructura de carpetas es la decisión que
más cuesta cambiar después.

---

## Las siete etapas

Están en `SDD.md` §13 y este es el orden, que no conviene alterar:

1. **Base**: Worker + SPA + D1 + login. Entrás y salís.
2. **Categorías, movimientos, reglas recurrentes.** Con los tests de `SDD.md` §5.1
   y §5.2 pasando. Acá se juegan las reglas 2, 3 y 4 de `CLAUDE.md`.
3. **Resumen y Análisis de gastos** con datos reales.
4. **Presupuesto, objetivos, ingresos y compromisos.**
5. **Precios**: productos seguidos, canasta, plan de compra dividida, el cron de
   refresco por lotes.
6. **Divisas e inflación**: BNA, xe.com, IPC del INDEC.
7. **Tickets con foto, alertas, exportaciones, Ayuda.**

Después de cada etapa: desplegar a staging siguiendo `DEPLOY.md` y usarla unos
días. Es la única manera de descubrir que algo estaba mal pensado antes de haber
construido tres etapas encima.

---

## Los tests que no se negocian

`CLAUDE.md` tiene siete reglas del dominio. Tres ya fueron bugs reales durante el
diseño, y son las que hay que blindar con tests desde la etapa 2:

- **Una sola función define cuánto costó un mes.** El bug fue tener una segunda
  fórmula: tres pantallas mostraban números distintos para el mismo mes. El test
  compara el total del Resumen, el de Análisis, el del resumen anual y la suma de
  sobres, y exige que den igual.
- **El libro de movimientos es un subconjunto del gasto.** Nunca sumar filas y
  presentar eso como gasto del mes.
- **Los recurrentes son reglas, no etiquetas.** Con mes de inicio, frecuencia, y
  sin duplicarse contra un movimiento real del mismo comercio en el mes en curso.

Si Claude Code propone "simplificar" alguna de las tres, no es una simplificación:
es volver al bug.

---

## Cuánto va a salir

- Cloudflare: gratis hasta que aparezca Queues, que probablemente no aparezca.
  Ver `DEPLOY.md` §5.
- OCR: por imagen, según el proveedor.
- Dominio propio: lo que salga el dominio.

---

## Mientras tanto

El prototipo de `brote-cloudflare/` se publica en cinco minutos y no interfiere
con nada. Tenerlo andando en el teléfono mientras se desarrolla sirve para dos
cosas: verlo funcionando ya, y darte cuenta de qué partes usás de verdad antes de
que estén construidas.
