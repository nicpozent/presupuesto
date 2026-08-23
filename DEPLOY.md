# Deployment de Brote en Cloudflare

Guía operativa, de cuenta vacía a producción. Asume que ya existe el codebase
generado a partir de `SDD.md` y `CLAUDE.md`, con la SPA compilando a `dist/client`
y el Worker en `src/worker/index.ts`.

Todo el producto vive en **un solo Worker**: sirve la SPA estática y responde la API
bajo `/api/*`. No hay dominio separado para el frontend, así que no hay CORS.

---

## 0. Antes de empezar

Necesitás:

- Una cuenta de Cloudflare. El **plan gratuito alcanza** para arrancar: esta guía no
  usa Queues. Ver §9 para los límites reales del plan gratuito.
- **Un dominio propio, agregado a Cloudflare como zona activa.** No es opcional y no
  se puede reemplazar por `workers.dev`: Cloudflare Access solo protege hostnames de
  una zona activa de tu cuenta, así que sin dominio no hay login y sin login no hay
  Brote. Es el único renglón que puede costar plata —un dominio, del orden de 10 USD
  al año— y si ya tenés uno, alcanza con un subdominio (`brote.tudominio.com`).
- Un proyecto en **Google Cloud Console**, para crear el cliente OAuth que Zero Trust
  usa como proveedor de identidad. Gratis.
- Node 22+ si vas a trabajar local. Si desplegás desde el panel (§10), no hace falta
  nada instalado.

```bash
npx wrangler login
npx wrangler whoami     # confirmá la cuenta correcta
```

Eso último solo para el camino con terminal. Desde el panel, saltá a §10.

---

## 1. Crear los recursos

Cada comando imprime un id. Copialos: van en `wrangler.toml`.

```bash
# Base de datos
npx wrangler d1 create brote

# Cache. No hay AUTH_STATE: sin flujo OAuth propio no hay state ni code_verifier
# que guardar (SDD §7.1). Y no hay PAGES: el cache de HTML no entra en las 1.000
# escrituras por día del plan gratuito (§9).
npx wrangler kv namespace create CACHE

# Fotos de tickets
npx wrangler r2 bucket create brote-receipts
```

Después copiá la plantilla y completá los ids:

```bash
cp wrangler.example.toml wrangler.toml
```

Reemplazá los tres `REEMPLAZAR` (`database_id` y los dos `id` de KV) y poné tu
dominio real en `APP_URL`.

---

## 2. Cargar el esquema

`schema.sql` es la línea de base y vive también como `migrations/0001_init.sql`. Se
aplica con el sistema de migraciones, no a mano, así que el próximo cambio es un
archivo nuevo y no una edición (`SDD.md` §13.1):

```bash
# Local primero, para probar sin tocar producción
npm run db:local

# Producción
npm run db:remote
```

Verificación: 42 comandos y las 26 tablas.

```bash
npx wrangler d1 execute brote --local \
  --command "select count(*) as tablas from sqlite_master where type='table'"
npx wrangler d1 execute brote --local \
  --command "select kind, count(*) from retailers group by kind"
```

Los diez comercios de fábrica se cargan con el esquema. **Cargarlos no los enciende**:
las filas de `connections` se siembran al crear el hogar, encendidas las de `api` y
apagadas las de `scrape` y `llm` (`SDD.md` §6.2).

---

## 3. Login: Cloudflare Access con Google

**Decidido: Access.** No se implementa flujo OAuth propio, no hay
`GOOGLE_CLIENT_SECRET` ni `SESSION_SECRET`, no hay tabla `sessions`. El razonamiento
y la alternativa descartada están en `SDD.md` §7.

En **Cloudflare Zero Trust → Access → Applications**, agregá una *Self-hosted
application*:

- **Application domain**: `brote.example.com` (y el de staging, como app aparte).
- **Identity provider**: Google. Se configura una vez en *Settings → Authentication*
  con un OAuth client de Google Cloud Console; los scopes que pide Access alcanzan y
  Brote no necesita nada de Gmail ni de Drive.
- **Policy**: *Allow*, con `Emails` y la lista de mails del hogar.
- **Session duration**: lo que quieras; Access renueva solo.

De la aplicación creada salen los dos valores públicos que van en `[vars]` de
`wrangler.toml`:

```
CF_ACCESS_TEAM_DOMAIN = "tu-equipo.cloudflareaccess.com"
CF_ACCESS_AUD         = el Application Audience Tag de la app
```

El único secreto de la v1 es la clave del modelo:

```bash
npx wrangler secret put COHERE_API_KEY
```

Repetí con `--env staging`: los secretos no se heredan entre entornos.

**El Worker igual valida el JWT.** Access pone `Cf-Access-Jwt-Assertion` y el
middleware lo verifica contra `https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
chequeando `aud`. Sin esa validación, cualquiera que llegue al Worker por otra ruta
—un custom domain que no pasó por Access, `workers.dev` sin apagar— entra sin nada.
Apagá la ruta `workers.dev` del Worker en producción.

**Agregar a alguien al hogar son dos pasos** (`SDD.md` §7.1.1): el mail en la policy
de Access **y** la invitación en Brote (`POST /api/invites`). Con solo el primero, la
persona entra y no tiene hogar; con solo el segundo, no llega ni al login.

---

## 4. Primer deploy

```bash
npm install
npm run typecheck      # sin errores de tipo
npm test               # 32 tests: la matemática de §5 y el aislamiento de §13.3
npm run build          # la SPA queda en dist/client
npx wrangler deploy
```

Antes de la primera vez, copiá la plantilla y completá los ids:

```bash
cp wrangler.example.toml wrangler.toml
```

`wrangler.toml` está en `.gitignore`: lleva ids de tu cuenta. La plantilla es la que
se versiona.

Comprobación mínima:

```bash
curl -i https://brote.example.com/api/health
```

Y en el navegador: entrar, pasar por la pantalla de Google que pone Access, ver el
Resumen con la cuenta vacía. Que no explote con cero datos es parte de la prueba
(`SDD.md` §12.2): la serie histórica no tiene que dibujar ejes vacíos ni un `$ 0`.

---

## 5. El trabajo de fondo: cotizaciones, IPC y precios

Brote no usa Queues. Todo el trabajo periódico lo hace el handler `scheduled` del
propio Worker. Es menos maquinaria, entra en el plan gratuito, y para el volumen de
un hogar sobra.

### Los cuatro horarios

Ya están en `wrangler.toml`, en UTC (ART es UTC−3):

| Cron | Hora ART | Qué hace |
|---|---|---|
| `0 14 * * *` | 11:00 diario | Cotizaciones BNA y xe.com |
| `0 */6 * * *` | cada 6 h | Refresco de precios de productos seguidos |
| `0 15 15 * *` | día 15, 12:00 | IPC del INDEC |
| `0 12 * * *` | 9:00 diario | Alertas de vencimientos y bajas de precio |

```ts
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case "0 14 * * *":  return ctx.waitUntil(actualizarCotizaciones(env));
      case "0 15 15 * *": return ctx.waitUntil(actualizarIpc(env));
      case "0 */6 * * *": return ctx.waitUntil(refrescarPrecios(env));
      case "0 12 * * *":  return ctx.waitUntil(enviarAlertas(env));
    }
  }
};
```

### Cotizaciones e IPC

Una o dos llamadas HTTP contra BNA, xe.com e INDEC, guardadas en KV con su TTL y
en D1 como serie histórica. No hay nada que diferir acá.

### Precios: el único que necesita cuidado

Cada consulta a un comercio es un subrequest. **En el plan gratuito son 50 por
invocación, no 1000**, y son 6 conexiones salientes simultáneas (§9). Ese es el número
que manda el diseño del lote:

**El lote se mide en PARES producto-comercio, no en productos.** Un producto seguido
en seis comercios son seis subrequests, así que "40 productos" podían ser 240
consultas: cinco veces el límite del plan gratuito. Lo que entra en una corrida son
40 pares, que deja diez subrequests de margen:

```sql
select w.id as item_id, u.retailer_id, u.url
  from watched_items w
  join item_urls u on u.item_id = w.id
  join connections c
    on c.household_id = w.household_id and c.retailer_id = u.retailer_id
 where c.enabled = 1
   and (w.last_checked_at is null
        or w.last_checked_at < datetime('now',
             case (select check_frequency from alert_prefs p
                    where p.household_id = w.household_id)
               when 'weekly' then '-7 days' else '-1 day' end))
 order by w.last_checked_at asc nulls first
 limit 40
```

Dos cosas de esa query, las dos del diseño y no del límite: `connections.enabled = 1`
es lo que hace que apagar una fuente apague de verdad las consultas (regla 6), y la
cadencia del hogar es un filtro de elegibilidad, no un cron aparte (`SDD.md` §6.3).

Con cuatro corridas por día y lotes de 40 pares, un hogar con veinte productos en seis
comercios —120 pares— se refresca completo cada tres corridas, o sea menos de un día.

**Aislá cada comercio.** `Promise.allSettled` con un límite de concurrencia, para
que uno caído no arrastre a los demás:

```ts
const resultados = await Promise.allSettled(
  comercios.map(c => conTimeout(consultarPrecio(c, producto), 8000))
);
for (const r of resultados) {
  if (r.status === "rejected") await registrarFallo(env, r.reason);
  else await guardarPrecio(env, r.value);
}
```

Un fallo no se reintenta dentro de la misma corrida: se anota en `price_fetch_log`
y el producto queda primero en la cola de la próxima, porque su `last_checked_at`
sigue siendo el más viejo. El reintento sale gratis del propio ordenamiento.

La UI ya está preparada para esto: si una consulta falla, muestra el último precio
conocido con su antigüedad. Nunca estima un precio.

### OCR de tickets: en el request

El usuario acaba de sacar la foto y está esperando el resultado. La llamada al
proveedor de OCR va dentro del request de `POST /api/receipts/:id/process`, con
timeout, y devuelve las líneas leídas para que las confirme. Un "lo estamos
procesando" acá sería peor experiencia y más código.

### Probar los cron sin esperar

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+14+*+*+*"
```

### Cuándo pasar a algo más

Tres señales, en orden de aparición:

1. **Los fallos importan y hay que reintentarlos con backoff.** Agregá una tabla
   `job` en D1 (`kind`, `payload`, `status`, `attempts`, `run_after`,
   `last_error`) y un cron de un minuto que drene un lote chico. El backoff es
   `run_after = now + 60 * 2^attempts`, y las filas en `status='dead'` son tu dead
   letter queue, con la ventaja de que se consultan con SQL.
2. **El lote no entra en los límites del Worker.** Ahí sí, Queues: `[[queues.producers]]`
   y `[[queues.consumers]]` con `max_batch_size` y `dead_letter_queue`, y el plan
   pago de 5 USD/mes. El código del paso 1 se tira casi entero.
3. **El refresco se vuelve un proceso de varios pasos con estado** — consultar,
   normalizar, comparar contra el histórico, decidir alerta. Eso es Cloudflare
   Workflows: cada paso se reintenta solo y el estado sobrevive a las fallas.

No empieces por el 2 ni por el 3.

### Antes de habilitar el scraping

Revisá los términos de cada sitio. Los comercios que ofrecen API oficial van por
API. Qué comercio se consulta de qué manera sigue abierto en `SDD.md` §6, y es una
decisión del negocio, no técnica.

---

## 6. Staging

```bash
npx wrangler deploy --env staging
```

Staging necesita sus propios recursos: creá una segunda D1 (`brote-staging`) y sus
propios namespaces de KV, y declaralos bajo `[env.staging]`. Compartir la base de
producción con staging es la forma más rápida de corromper datos reales.

---

## 7. Deploy continuo

Dos caminos, y la diferencia importante es qué pasa con las migraciones.

**a) Desde el panel (Workers Builds).** El más simple, y el paso a paso está en §10.
Requiere que `wrangler.toml` esté commiteado, y **no corre migraciones ni tests**: las
migraciones se aplican a mano en la consola de D1 (§10.2).

**b) Con GitHub Actions.** Más piezas, pero el pipeline hace todo:

```yaml
- run: npm ci && npm test          # 32 tests: si algo se rompe, no se despliega
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    command: d1 migrations apply brote --remote
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    command: deploy
```

El token se crea en **My Profile → API Tokens** con la plantilla *Edit Cloudflare
Workers*. Acá sí las migraciones corren como paso previo al deploy y nunca a mano.

Si vas por (a), la contrapartida es que el checklist de release lo hacés vos: aplicar
la migración antes de que el deploy salga, y correr `npm test` local. Ver §10.9.

---

## 8. Después de estar en el aire

- **Logs en vivo**: `npx wrangler tail`
- **Métricas y trazas**: ya activadas con `[observability] enabled = true`
- **Fallos de consulta**: `select retailer_id, count(*) from price_fetch_log
  where ok = 0 and created_at > ? group by 1`. Un comercio que aparece seguido
  cambió su HTML.
- **Trabajos de fondo**: `select job, max(started_at) from job_runs where ok = 1
  group by job`. Si alguno quedó atrás más del doble de su intervalo, ya tendría que
  haber una alerta `job_stale` (`SDD.md` §13.2); si no la hay, lo que está roto es el
  cron de alertas.
- **Migraciones**: `npx wrangler d1 migrations apply brote --remote`. `schema.sql` es
  la línea de base y no se edita para cambiar una base que ya existe (`SDD.md` §13.1).
- **Backups de D1**: `npx wrangler d1 export brote --remote --output=brote-$(date +%F).sql`,
  programado. En el plan gratuito el Time Travel de D1 es de **7 días**, no 30 (§9):
  razón de más para que el export propio sea una rutina y no un lujo.

## 9. El plan gratuito, con los números reales

Brote entra en el plan gratuito, pero **no con el diseño de la documentación
anterior**: varios límites que estaban escritos acá eran los del plan pago. Los
verificados contra la documentación de Cloudflare, agosto 2026:

| Recurso | Plan gratuito | Plan pago | Dónde aprieta |
|---|---|---|---|
| Requests | 100.000/día | sin límite diario | Lejísimos para un hogar |
| CPU por invocación | **10 ms** | hasta 5 min | Ver abajo: CPU no es tiempo de espera |
| Subrequests por invocación | **50** | 1000 | **Manda el tamaño del lote de precios (§5)** |
| Conexiones salientes simultáneas | **6** | 6 | El límite de concurrencia del `allSettled` |
| Cron triggers | 5 | 250 | Usamos 4 |
| Duración del cron (reloj) | 15 min | 15 min | De sobra |
| KV lecturas | 100.000/día | por uso | De sobra |
| KV **escrituras** | **1.000/día** | por uso | **Ver abajo: el cache de HTML no entra** |
| KV almacenamiento | 1 GB | por uso | De sobra |
| D1 consultas por invocación | **50** | 1000 | Hay que agrupar con `batch()` |
| D1 tamaño por base | 500 MB | 10 GB | De sobra |
| D1 Time Travel | **7 días** | 30 días | Por eso el export propio de §8 |
| R2 | 10 GB gratis | por uso | Las fotos de tickets |

**Los 10 ms de CPU asustan más de lo que aprietan.** CPU no cuenta el tiempo
esperando una respuesta HTTP ni una query de D1: un cron que hace 40 fetches y espera
está casi todo el tiempo sin usar CPU. Lo que sí gasta CPU es parsear: 40 respuestas
JSON de VTEX entran, 240 páginas de HTML crudo no. Otra razón para preferir `api`
sobre `scrape` (`SDD.md` §6.2).

**Las 1.000 escrituras de KV por día son el límite que cambia el diseño.** El cache de
HTML de páginas de producto —el binding `PAGES` que estaba en `wrangler.toml`— gastaba
una escritura por página consultada: 40 pares × 4 corridas = 160 por día en el mejor
caso, y mucho más con varios hogares. **Se saca del plan gratuito.** Los precios ya
viven en D1 (`item_prices`), que es la fuente de verdad; KV queda para lo que de
verdad se escribe poco:

| Qué se escribe en KV | Escrituras por día |
|---|---|
| Cotizaciones BNA + xe | ~6 (tres monedas × dos fuentes) |
| IPC | 1 por mes |
| **Total** | **menos de 10** |

Y el JWKS de Access no va a KV: se cachea en memoria del isolate por una hora
(`src/worker/access.ts`), que no gasta ninguna cuota.

**Cloudflare Access tiene plan gratuito** y es lo que autentica a Brote. La cantidad
de asientos incluidos no la pude confirmar en la documentación pública, así que
**verificalo en el panel de Zero Trust antes de contar con él** — para un hogar
alcanza cualquiera de los tramos, pero es el único número de esta tabla que no está
verificado.

### Cuándo se sale del plan gratuito

- **Muchos hogares con muchos productos**: el techo real no son los requests, son los
  50 subrequests por corrida. Con más hogares, cada uno se refresca menos seguido. La
  salida no es pagar: es bajar la cadencia (§6.3) antes que el lote.
- **OCR de tickets**: no es de Cloudflare. Cohere se cobra por imagen y es el único
  renglón que cuesta desde el primer ticket.
- **Queues**: si el lote deja de entrar, son 5 USD/mes del plan Workers Paid. Con
  lotes de 40 pares y cuatro corridas no hace falta.

---

## 10. Desplegar desde el panel de Cloudflare (Workers Builds)

Si no querés correr `wrangler deploy` desde tu máquina, el panel puede desplegar solo
en cada push. Cambia **quién** ejecuta el deploy, no cómo está armado el proyecto.

**Lo primero, porque es lo que rompe:** `wrangler.toml` **tiene que estar
commiteado**. Workers Builds corre `npx wrangler deploy`, y de ese archivo saca el
nombre del Worker y todos los bindings. Está en el repo con tres `REEMPLAZAR`.

### 10.1 Crear los recursos (una vez, desde el panel)

| Recurso | Dónde | Nombre |
|---|---|---|
| Base D1 | Storage & Databases → D1 → Create | `brote` |
| Namespace KV | Storage & Databases → KV → Create | `brote-cache` |
| Bucket R2 | R2 → Overview → completar el checkout de R2, después Create bucket | `brote-receipts` |

Anotá el **Database ID** de D1 y el **Namespace ID** de KV: van en `wrangler.toml`.

**R2 hay que activarlo antes de crear el bucket.** No alcanza con ir a *Create
bucket*: primero **R2 → Overview → completar el checkout** que agrega la suscripción de
R2 a la cuenta. Hasta que eso esté, la API no contesta y el deploy corta con

```
✘ [ERROR] A request to the Cloudflare API
          (/accounts/…/r2/buckets/brote-receipts) failed
```

que desconcierta porque nombra un recurso que la app todavía no usa. El
`bucket_name` de `wrangler.toml` tiene que coincidir exacto con el nombre del bucket.

El tramo gratuito de R2 son 10 GB, 1 millón de operaciones de escritura y 10 millones
de lectura por mes, con egress gratis. Un hogar con treinta tickets por mes de 2 MB usa
60 MB por mes: **catorce años de almacenamiento y el 0,003% de las escrituras.** Por eso
las fotos van a R2 y no a D1, donde el límite de 2 MB por fila no las aceptaría y los
500 MB de la base se los comerían compitiendo con los movimientos.

### 10.2 Cargar el esquema

**Workers Builds no corre migraciones.** Es lo que más sorprende: el deploy sale bien
y la primera request falla porque no hay tablas. Desde el panel: **D1 → brote →
Console**, pegar el contenido de `migrations/0001_init.sql` y ejecutar. Son 42
comandos y quedan 26 tablas.

Para verificar, en la misma consola:

```sql
select count(*) as tablas from sqlite_master where type='table';
select kind, count(*) from retailers group by kind;
```

Tienen que dar 26 tablas, y los diez comercios repartidos en `api` 6, `scrape` 2,
`llm` 1, `manual` 1 (§6.2 del SDD).

Cada migración nueva se aplica igual, a mano y en orden. Es el costo de no tener
`wrangler` en el circuito: anotalo en el checklist de release.

### 10.3 Access con Google

Son **dos cosas distintas** y en este orden:

1. **El proveedor de identidad**, una vez por cuenta. Requiere crear un cliente OAuth
   en Google Cloud Console: APIs & Services → Credentials → Create OAuth client →
   *Web application*, con
   - Authorized JavaScript origin: `https://<tu-equipo>.cloudflareaccess.com`
   - Authorized redirect URI: `https://<tu-equipo>.cloudflareaccess.com/cdn-cgi/access/callback`

   Con el Client ID y el Client Secret: Zero Trust → **Integrations → Identity
   providers** → Add new → **Google** (no *Google Workspace*: ese pide un dominio
   administrado y un admin).

   **Anda con una cuenta de Gmail común.** Dos elecciones lo definen:
   - En la pantalla de consentimiento, **External**, no Internal. *Internal* solo
     existe para proyectos atados a una organización de Google Cloud; *External* es
     "cualquiera con una cuenta de Google", que incluye `@gmail.com`.
   - Conviene apretar **Publish app** para pasar a *In production*. Los scopes que pide
     Access —`openid email profile`— no son sensibles y no necesitan verificación, y
     publicando te saca de encima el límite de 100 usuarios de prueba y el
     consentimiento que vence a los 7 días del modo *Testing*.

   **"External" y "In production" no abren Brote al mundo.** Google solo dice quién es
   la persona. Quién entra lo decide la policy de Access del punto 2: cualquiera puede
   autenticarse con Google y quedar afuera igual. Y el Worker valida el `aud` del token
   contra esta aplicación, así que un token de otra no sirve. La lista corta es la de
   Access, en un solo lugar.
2. **La aplicación**: Zero Trust → **Access controls → Applications** → Create new
   application → *Self-hosted and private* → Add public hostname, el hostname de Brote,
   y una policy *Allow* con los mails del hogar en `Emails`.

De la aplicación creada sale el **Application Audience (AUD) Tag**, que es el tercer
`REEMPLAZAR`. Los nombres de los menús del panel cambian de vez en cuando; lo que no
cambia es que son dos pasos y que el primero pasa por Google Cloud Console.

### 10.4 Completar `wrangler.toml` y commitear

```toml
CF_ACCESS_TEAM_DOMAIN = "tu-equipo.cloudflareaccess.com"
CF_ACCESS_AUD = "el AUD tag de 10.3"
APP_URL = "https://brote.example.com"
database_id = "el Database ID de 10.1"
id = "el Namespace ID de 10.1"
```

Los cinco son identificadores de tu cuenta, **no credenciales**: se commitean sin
problema. Si algo de esto fuera secreto, no iría en un archivo del repo.

### 10.5 Conectar el repo

**Workers & Pages → Create → Workers → Import a repository**, elegí
`nicpozent/presupuesto` y la rama.

| Campo | Valor |
|---|---|
| Worker name | `brote` — **tiene que coincidir** con `name` en `wrangler.toml` o el build falla |
| Build command | dejalo **vacío**: lo dispara `[build]` de `wrangler.toml` |
| Deploy command | `npx wrangler deploy` (es el default) |
| Root directory | vacío |

**El Build command del panel es opcional porque el build lo dispara wrangler.**
`wrangler.toml` tiene un bloque `[build]`:

```toml
[build]
command = "npm ci && npm test && npm run build"
```

`wrangler deploy` lo ejecuta antes de subir, así que la SPA se compila **aunque el
campo Build command del panel esté vacío**. Verificado desde un clone pelado, sin
`node_modules` y sin `dist`: wrangler imprime cada línea con el prefijo
`[custom build]` y después lee los 4 archivos de `dist/client`.

Esto existe porque el modo de fallar es horrible. Con el campo vacío y sin `[build]`,
el panel va del clone directo al deploy y wrangler corta con

```
✘ [ERROR] Could not detect a directory containing static files
          (e.g. html, css and js) for the project
```

que suena a un problema de configuración de `[assets]` y no dice en ningún lado que
faltó compilar. El `npm ci` va adentro del comando porque el entorno del build no
instala las dependencias solo: sin él, `npm run build` no encuentra ni `vite` ni `tsc`.

Podés poner igual el mismo comando en el campo del panel: no molesta, pero ya no hace
falta.

La versión de Node la fija `.node-version` (22), que es la que se verificó. Si el panel
usara otra, el build de Vite puede fallar por algo que no tiene nada que ver con tu
código.

`npm run build` corre `tsc --noEmit && vite build`: si algo no tipa, el build falla y
no se despliega. Es a propósito, igual que poner `npm test` adelante.

**Las 5 vulnerabilidades que reporta `npm ci` en el build son de
`devDependencies`** —`vitest`, `vite`, `esbuild`— y las tres son del servidor de
desarrollo: la UI de vitest escuchando, el dev server de vite, el dev server de
esbuild. **Nada de eso viaja al Worker**, que recibe el código compilado y los assets.
Limpiarlas necesita saltar a `vitest@3` y `vite@7`, que hoy choca por peer
dependencies; no vale la pena tocar la cadena de build para bajar un número que no
tiene exposición en producción. Queda anotado y se hace cuando haya que actualizar el
toolchain igual.

**Orden recomendado (B).** El `CF_ACCESS_AUD` sale de la aplicación de Access, y la
aplicación es más fácil de crear cuando el hostname ya existe en el DNS. Entonces:
completá `CF_ACCESS_TEAM_DOMAIN` y `APP_URL`, desplegá con `CF_ACCESS_AUD` todavía en
`REEMPLAZAR` —el Worker va a rechazar todo con `401`, que es lo correcto—, agregá el
custom domain, recién ahí creá la aplicación de Access eligiendo el hostname del
desplegable, y pusheá el AUD. Workers Builds vuelve a desplegar solo. Son dos builds y
no cuestan nada; a cambio, ningún hostname se tipea a mano.

### 10.6 El secreto

El único de la v1 es el del modelo, y va **fuera** del repo: Workers & Pages → brote →
Settings → **Variables and Secrets** → Add → tipo **Secret**, nombre
`COHERE_API_KEY`.

Ojo con la distinción del panel, que se confunde fácil:

- **Settings → Variables and Secrets**: lo que ve el Worker **en ejecución**. Acá va
  `COHERE_API_KEY`.
- **Settings → Build → Build variables and secrets**: solo durante el build, el Worker
  no las ve. Brote no necesita ninguna.

### 10.7 Comprobar

```bash
curl -i https://brote.example.com/api/health
```

Tiene que dar `200` y `{"ok":true,"service":"brote"}`. `/api/health` es la única ruta
sin Access, justamente para esto.

Después, en el navegador: entrar, pasar por Google, y ver el nombre del hogar. El
primer mail que entra crea el hogar y queda `owner` (`SDD.md` §7.1.1).

```bash
curl -i https://brote.example.com/api/me
```

Sin pasar por Access tiene que dar `401 unauthenticated`. Si diera `200`, el Worker
está sirviendo por una ruta que no pasa por Access: apagá la ruta `workers.dev` en
Settings → Domains & Routes.

### 10.8 Los cron

Salen de `[triggers]` en `wrangler.toml`, así que el primer deploy los crea. Se ven en
Settings → Trigger Events. **No los edites en el panel**: el próximo deploy los
sobrescribe con lo que diga el archivo.

### 10.9 Qué se pierde y cómo se compensa

| Con `wrangler` desde tu máquina | Desde el panel |
|---|---|
| `npm test` antes de desplegar | No corre. El build solo tipa: los 32 tests no se ejecutan |
| Migraciones con `wrangler d1 migrations apply` | A mano en la consola de D1 (§10.2) |
| `wrangler tail` para logs en vivo | Panel → Workers → brote → Logs |

Lo primero es lo que importa: **el panel no corre los tests**. Si querés que un test
roto frene el deploy, poné `npm test && npm run build` como Build command. Con la
matemática de §5 adentro, vale la pena.

### 10.10 Builds y el plan gratuito

Workers Builds tiene su propia cuota de minutos de build, aparte de los límites de §9.
No la pude confirmar en la documentación pública, así que **miralo en Workers & Pages →
tu cuenta → Builds antes de conectar un repo con muchos pushes**. Un proyecto de un
hogar con pushes ocasionales no debería acercarse, pero es el segundo número de este
documento que no está verificado (el otro son los asientos de Access, §9).

---

## Costo esperado

Para un hogar: **cero de Cloudflare**, con el diseño de §9. El único renglón real es
el OCR de tickets, que se cobra por imagen.
