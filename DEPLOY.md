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
  usa Queues. Ver §5 para cuándo conviene pasar al plan pago.
- Un dominio en Cloudflare, o aceptar el subdominio `brote.<tu-cuenta>.workers.dev`.
- Node 20+ y `npm i -D wrangler`.
- Un proyecto en Google Cloud Console para el login.

```bash
npx wrangler login
npx wrangler whoami     # confirmá la cuenta correcta
```

---

## 1. Crear los recursos

Cada comando imprime un id. Copialos: van en `wrangler.toml`.

```bash
# Base de datos
npx wrangler d1 create brote

# Caches. No hay AUTH_STATE: sin flujo OAuth propio no hay state ni
# code_verifier que guardar (SDD §7.1).
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create PAGES

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

```bash
# Local primero, para probar sin tocar producción
npx wrangler d1 execute brote --local --file=./schema.sql

# Producción
npx wrangler d1 execute brote --remote --file=./schema.sql

# Verificación
npx wrangler d1 execute brote --remote --command="select name from sqlite_master where type='table'"
```

Las categorías predefinidas, los comercios y las unidades de medida se insertan
como semilla en el mismo `schema.sql`. Si preferís separarlo, movelo a un
`seed.sql` y corré el mismo comando.

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
npm run build          # la SPA queda en dist/client
npx wrangler deploy
```

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

Cada consulta a un comercio es un subrequest, y un Worker tiene 1000 subrequests y
30 segundos de CPU por invocación. Dos reglas alcanzan para no acercarse nunca:

**Trabajá por lote, no por catálogo completo.** En cada corrida atendé los N
productos con la consulta más vieja, en vez de todos:

```sql
select * from watched_items
where household_id = ?
order by last_checked_at asc nulls first
limit 40
```

Con cuatro corridas por día y lotes de 40, cada producto se refresca al menos una
vez al día sin importar cuántos haya en total.

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

Conectá el repo desde **Workers & Pages → tu Worker → Settings → Build**, o usá la
action oficial:

```yaml
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    command: deploy
```

El token se crea en **My Profile → API Tokens** con la plantilla *Edit Cloudflare
Workers*. Las migraciones de D1 corren como paso previo al deploy, nunca a mano en
producción.

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
  programado. D1 tiene time travel de 30 días, pero un export propio es barato.

## Costo esperado

Para un puñado de hogares: **cero**. Cron triggers (hasta 5), D1, KV y R2 tienen
tier gratuito, y el límite de 100.000 requests por día queda lejísimos. El único
renglón real es el OCR de tickets, que se cobra por imagen según el proveedor.

Si más adelante aparece Queues, son 5 USD/mes del plan Workers Paid.
