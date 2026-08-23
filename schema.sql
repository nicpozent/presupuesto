-- Brote — esquema Cloudflare D1
-- wrangler d1 execute brote --file=./schema.sql
--
-- Convenciones:
--   · importes en centavos, INTEGER
--   · fechas ISO 8601 UTC en TEXT
--   · toda tabla de datos del hogar lleva household_id y se filtra por él en cada
--     query. Excepciones declaradas, todas de contexto público: fx_rates,
--     inflation, job_runs y las filas de retailers de fábrica. Ver SDD §13.3.

PRAGMA foreign_keys = ON;

CREATE TABLE households (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,              -- "Casa Domínguez"
  currency      TEXT NOT NULL DEFAULT 'ARS',
  timezone      TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  palette       TEXT NOT NULL DEFAULT 'organic',
  ground        TEXT NOT NULL DEFAULT 'crema',
  inflation_adj INTEGER NOT NULL DEFAULT 1, -- ajustado por inflación por defecto
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  -- NULL a propósito: un usuario que pasó Access pero todavía no fue invitado a
  -- ningún hogar es un estado válido. Ver SDD §7.1.1.
  household_id TEXT REFERENCES households(id) ON DELETE CASCADE,
  -- Identidad estable del proveedor, no el email. Con un IdP OIDC (Google) es el
  -- claim 'sub' del token; con One-time PIN, donde no hay sub, es el email, que ahí
  -- ES la identidad. Se llama idp_sub y no google_sub porque el proveedor es una
  -- decisión de despliegue, no del esquema. Ver SDD §7.1.
  idp_sub      TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
CREATE INDEX idx_users_household ON users(household_id);

-- No hay tabla de sesiones: el login lo resuelve Cloudflare Access y cada request
-- trae su propio JWT, validado contra el JWKS del equipo. Ver SDD §7.1.

-- Access decide quién llega a la app; esta tabla decide a qué hogar pertenece.
-- Sin invitación, un mail nuevo que pasa Access queda con household_id NULL y no
-- ve datos de nadie. Ver SDD §7.1.1: son dos pasos, el panel de Access y esto.
CREATE TABLE invites (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  invited_by   TEXT REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT
);

-- ── Gasto ────────────────────────────────────────────────────────────────────

CREATE TABLE categories (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  is_variable  INTEGER NOT NULL DEFAULT 1,  -- variable = controlable por el hogar
  sort_order   INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,
  UNIQUE (household_id, name)
);

CREATE TABLE transactions (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  occurred_on  TEXT NOT NULL,               -- YYYY-MM-DD
  merchant     TEXT NOT NULL,
  detail       TEXT,
  amount_cents INTEGER NOT NULL,
  -- Sin 'bank': Brote no se conecta a ningún banco y las credenciales bancarias no
  -- se guardan nunca (Ayuda: "¿Brote guarda mis claves del banco?" → "No"). Un
  -- resumen bancario que el usuario baja y sube entra como 'import', igual que un
  -- CSV. Dejar 'bank' en el dominio insinuaba una integración que el producto niega.
  source       TEXT NOT NULL CHECK (source IN
                 ('ticket_photo','quick_total','full_detail','recurring','import')),
  receipt_id   TEXT,
  rule_id      TEXT REFERENCES recurring_rules(id) ON DELETE SET NULL,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tx_household_date ON transactions(household_id, occurred_on DESC);
CREATE INDEX idx_tx_category ON transactions(category_id);

-- Regla recurrente: NO es una etiqueta. Se materializa en todos los meses desde
-- start_year/start_month, incluidos los futuros. Ver CLAUDE.md regla 4.
CREATE TABLE recurring_rules (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  merchant     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  frequency    TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','bimonthly','yearly')),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  start_year   INTEGER NOT NULL,
  start_month  INTEGER NOT NULL CHECK (start_month BETWEEN 0 AND 11),
  ended_on     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rules_household ON recurring_rules(household_id);

-- ── Ingresos y compromisos ───────────────────────────────────────────────────

CREATE TABLE incomes (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  who          TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- "Sueldo en relación de dependencia"
  amount_cents INTEGER NOT NULL,
  when_text    TEXT,                        -- "el 5 de cada mes"
  is_fixed     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE income_history (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  year         INTEGER NOT NULL,
  month        INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (household_id, year, month)
);
-- Quién la escribe: SDD §5.0, igual que month_totals. Se recalcula al tocar incomes,
-- del mes del cambio hacia adelante. Un mes ya cerrado NO se reescribe: si el sueldo
-- sube en agosto, marzo sigue diciendo lo que se cobró en marzo. En eso está todo el
-- valor de la curva de poder de compra de §4.4.

CREATE TABLE fixed_expenses (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  day_of_month INTEGER NOT NULL,
  note         TEXT                          -- "ajusta por ICL en octubre"
);

-- Se carga POR PRODUCTO: nombre, precio total y en cuántas cuotas. La cuota
-- mensual se deriva, no se pide. Ver SDD §4.5.
--
-- started_on + count_total son el calendario de cuotas y la ÚNICA verdad sobre
-- cuántas se pagaron: count_paid se deriva de las fechas, no se guarda. Tenerlo
-- como columna editable creaba dos respuestas para la misma pregunta — la barra de
-- progreso decía cinco y el total del mes contaba seis. Ver SDD §5.0 y §4.5.
CREATE TABLE installments (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,              -- "Heladera Whirlpool"
  retailer_id   TEXT REFERENCES retailers(id),  -- dónde se compró, opcional
  total_cents   INTEGER NOT NULL,           -- precio del producto
  count_total   INTEGER NOT NULL,           -- 3 | 6 | 9 | 12 | 18 | 24
  monthly_cents INTEGER NOT NULL,           -- round(total_cents / count_total)
  started_on    TEXT NOT NULL               -- sin esto no hay calendario de cuotas
);
CREATE INDEX idx_installments_household ON installments(household_id);

CREATE TABLE goals (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  target_cents  INTEGER NOT NULL,
  saved_cents   INTEGER NOT NULL DEFAULT 0,  -- carga manual; Brote no lo deduce (§4.5)
  target_date   TEXT,
  note          TEXT
);

-- ── Precios ──────────────────────────────────────────────────────────────────

-- Los diez comercios de fábrica tienen household_id NULL y los ve todo el mundo.
-- Los que agrega el usuario en Conexiones llevan su household_id. Ver SDD §6.1.
CREATE TABLE retailers (
  id          TEXT PRIMARY KEY,             -- 'coto', 'diarco', 'mercadolibre'
  household_id TEXT REFERENCES households(id) ON DELETE CASCADE,  -- NULL = de fábrica
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('api','scrape','llm','manual')),
  base_url    TEXT,                         -- lo que pegó el usuario
  is_wholesale INTEGER NOT NULL DEFAULT 0,
  -- Verificación del sitio propio: la UI muestra "Verificando el sitio…" y después
  -- si sirve o no. verify_note explica el fallo en palabras del usuario.
  verified    INTEGER NOT NULL DEFAULT 0,
  verify_note TEXT,
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','degraded','down')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_retailers_household ON retailers(household_id);

-- Dónde vive cada producto en cada comercio. Para los comercios propios el usuario
-- pega la URL del producto; para los de fábrica la resuelve el adaptador.
CREATE TABLE item_urls (
  item_id     TEXT NOT NULL REFERENCES watched_items(id) ON DELETE CASCADE,
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  PRIMARY KEY (item_id, retailer_id)
);

-- Qué fuentes habilitó el hogar. Apagar una acá tiene que cambiar los cálculos
-- de canasta, plan de compra dividida y KPI de ahorro. Ver CLAUDE.md regla 6.
--
-- Al crear un hogar se insertan las DIEZ filas con su enabled explícito, por vía de
-- acceso: encendidas las de kind='api' (Mercado Libre y los cinco VTEX), apagadas las
-- de 'scrape' y 'llm'. La ausencia de fila no significa "habilitada": significa hogar
-- a medio crear. Ver SDD §6.2.
CREATE TABLE connections (
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  retailer_id   TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  custom_url    TEXT,                        -- fuente agregada por el usuario
  last_ok_at    TEXT,
  last_error    TEXT,
  PRIMARY KEY (household_id, retailer_id)
);

CREATE TABLE watched_items (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,              -- "Café molido La Morenita 500 g"
  unit          TEXT NOT NULL,              -- "500 g"
  qty           REAL NOT NULL,              -- 0.5
  per           TEXT NOT NULL,              -- 'kg' | 'L' | 'unidad'
  cadence_days  INTEGER,                    -- cada cuántos días se compra
  origin        TEXT,                       -- "de tu ticket de Coto"
  target_cents  INTEGER,                    -- precio objetivo para alertar
  last_paid_cents INTEGER,
  last_paid_at_retailer TEXT REFERENCES retailers(id),
  suggested     INTEGER NOT NULL DEFAULT 0, -- sugerido por OCR, sin confirmar
  -- Ordena el lote del cron: el más viejo se consulta primero. NULL = nunca
  -- consultado, va al frente. Un refresh manual lo pone en NULL. Ver DEPLOY.md §5.
  last_checked_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_household ON watched_items(household_id);
CREATE INDEX idx_items_stale ON watched_items(household_id, last_checked_at);

-- Un precio SIEMPRE lleva comercio, fecha de consulta y fuente.
-- Ver CLAUDE.md regla 5: nunca un precio sin procedencia.
--
-- AISLAMIENTO: esta tabla NO tiene household_id y NO es contexto público. Son datos
-- del hogar que llegan por item_id. Toda lectura o escritura resuelve primero el
-- watched_items.household_id: join a watched_items con el filtro puesto, nunca
-- "where item_id = ?" a secas. Vale igual para item_urls, item_alternatives y
-- price_fetch_log. Ver SDD §3 y §13.3.
CREATE TABLE item_prices (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES watched_items(id) ON DELETE CASCADE,
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL,
  checked_at  TEXT NOT NULL,
  -- Misma lista que PriceSource en SDD §6. Se editan juntas.
  -- 'receipt' es válido acá y no en el adaptador: ese precio lo trae el OCR (§10).
  source      TEXT NOT NULL CHECK (source IN ('api','scrape','llm','manual','receipt')),
  url         TEXT,
  -- Lo escribe el cron, no la UI: último intento fallido, o el doble de la cadencia
  -- del hogar sin consulta exitosa (SDD §6 y §6.3). Una consulta OK lo vuelve a 0.
  stale       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_prices_item_time ON item_prices(item_id, checked_at DESC);

-- Sin Queues no hay dead letter queue: los fallos de consulta se registran acá.
-- No hay reintento explícito — un producto que falló conserva su last_checked_at
-- viejo y por eso encabeza el lote siguiente.
CREATE TABLE price_fetch_log (
  id          TEXT PRIMARY KEY,
  item_id     TEXT REFERENCES watched_items(id) ON DELETE CASCADE,
  retailer_id TEXT NOT NULL REFERENCES retailers(id),
  ok          INTEGER NOT NULL,
  status      INTEGER,                    -- código HTTP, si hubo respuesta
  error       TEXT,                       -- 'timeout' | 'parse' | 'http' | …
  ms          INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fetchlog_retailer ON price_fetch_log(retailer_id, created_at DESC);
CREATE UNIQUE INDEX idx_prices_latest ON item_prices(item_id, retailer_id, checked_at);

-- Segunda marca equivalente, para la sugerencia de cambio
CREATE TABLE item_alternatives (
  item_id     TEXT NOT NULL REFERENCES watched_items(id) ON DELETE CASCADE,
  brand       TEXT NOT NULL,
  retailer_id TEXT REFERENCES retailers(id),
  price_cents INTEGER NOT NULL,
  qty         REAL NOT NULL,
  PRIMARY KEY (item_id, brand)
);

-- ── Macro ────────────────────────────────────────────────────────────────────

CREATE TABLE fx_rates (
  currency   TEXT NOT NULL CHECK (currency IN ('USD','EUR','CHF')),
  source     TEXT NOT NULL CHECK (source IN ('bna','xe')),
  buy_cents  INTEGER,                        -- BNA compra
  sell_cents INTEGER,                        -- BNA venta / referencia xe
  observed_on TEXT NOT NULL,
  PRIMARY KEY (currency, source, observed_on)
);

-- IPC INDEC. Alimenta monthFactor() y toda conversión a pesos constantes.
CREATE TABLE inflation (
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  monthly_pct REAL NOT NULL,
  index_value REAL,
  is_estimate INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (year, month)
);

-- Total de gasto por mes del hogar: fuente única de verdad de los totales
-- mensuales (SDD §5.1). Se recalcula al escribir movimientos y reglas.
CREATE TABLE month_totals (
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  month         INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  nominal_cents INTEGER NOT NULL,
  computed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, year, month)
);

-- ── Tickets, alertas, auditoría ──────────────────────────────────────────────

CREATE TABLE receipts (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','needs_review','confirmed','failed')),
  ocr_payload   TEXT,                        -- JSON crudo del OCR
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- La foto NO se descarta sola. La borra el usuario, y el borrado es real: se va
  -- la fila y se va el objeto en R2. La transacción que salió del ticket queda.
  -- Ojo: la copy del prototipo promete un descarte a los 30 días que el producto no
  -- hace; es una decisión pendiente, SDD §13.4.
  deleted_at    TEXT                         -- borrado real: también el objeto en R2
);

CREATE TABLE alerts (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- job_stale no es sobre la plata del hogar sino sobre Brote: un cron que dejó
  -- de correr. Aparece igual. Ver SDD §13.2.
  kind         TEXT NOT NULL CHECK (kind IN
                 ('due_soon','price_drop','price_rise','budget_over','subscription_review',
                  'fx_move','job_stale')),
  -- price_rise faltaba y el prototipo lo muestra: la tercera tarjeta de Avisos es una
  -- suba ("El aceite de girasol subió en cuatro de seis comercios", marca ↑). Ver
  -- SDD §4.6.
  --
  -- subscription_review, no subscription_idle: Brote ve el cargo, nunca el uso, así
  -- que "idle" nombraba lo único que no se puede observar. Los dos disparadores
  -- derivables están en SDD §4.2.
  --
  -- JSON, una forma fija por kind, documentada en api-contract.md. La tarjeta se
  -- dibuja SOLO con lo que trae el payload: si un campo no está, no se infiere.
  -- Un kind que la UI no conoce no se dibuja, no se dibuja a medias.
  payload      TEXT NOT NULL,                -- JSON
  read_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_alerts_household ON alerts(household_id, created_at DESC);

-- Lo que edita el usuario en Conexiones (SDD §4.9) y que gobierna la pestaña de
-- Avisos (§4.6): hora, baja mínima y canal. Si cambiar la baja mínima no cambia qué
-- avisos entran, está mal.
CREATE TABLE alert_prefs (
  household_id   TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  due_days_ahead INTEGER NOT NULL DEFAULT 3,
  price_drop_pct REAL NOT NULL DEFAULT 5,
  -- El toggle de Conexiones ofrece dos opciones y las etiqueta "Diaria" y "Semanal"
  -- (SDD §6.3). Antes esta columna admitía '6h','12h','24h': ni podía representar
  -- "Semanal" ni ofrecía 6h ni 12h en ninguna pantalla.
  check_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (check_frequency IN ('daily','weekly')),
  send_hour      TEXT NOT NULL DEFAULT '08:00',   -- hora local del hogar
  by_mail        INTEGER NOT NULL DEFAULT 1,      -- "Correo electrónico"
  by_push        INTEGER NOT NULL DEFAULT 1,      -- "Notificación en el teléfono"
  weekly_digest  INTEGER NOT NULL DEFAULT 1       -- "Resumen semanal"
);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  user_id      TEXT,
  action       TEXT NOT NULL,                -- 'export','purge','connection_toggle'
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Una fila por corrida de un trabajo de fondo. Un precio viejo con su fecha a la
-- vista es aceptable; un cron caído nueve días sin que nadie se entere, no.
-- El cron de alertas mira esta tabla y levanta un alert 'job_stale' si un trabajo
-- no tiene corrida exitosa en el doble de su intervalo. Ver SDD §13.2.
CREATE TABLE job_runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL CHECK (job IN ('fx','ipc','prices','alerts')),
  ok          INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ms          INTEGER,
  items_done  INTEGER,                     -- productos atendidos en el lote
  error       TEXT
);
CREATE INDEX idx_jobruns_job ON job_runs(job, started_at DESC);

-- Comercios de v1. El kind sale de la plataforma verificada de cada tienda; la
-- tabla con la evidencia y el porqué está en SDD §6.2. Día, Jumbo, Disco, Vea y
-- Farmacity corren VTEX y los cubre UN adaptador parametrizado por dominio.
--
-- Ojo: cargarlos acá no dice nada sobre si están encendidos. Eso lo dice connections,
-- que se siembra con las diez filas al crear cada hogar: 'api' encendida, 'scrape' y
-- 'llm' apagadas. Ver SDD §6.2.
INSERT INTO retailers (id, name, kind, is_wholesale) VALUES
  ('mercadolibre','Mercado Libre','api',0),   -- API oficial documentada
  ('dia','Día','api',0),                      -- VTEX
  ('jumbo','Jumbo','api',0),                  -- VTEX
  ('disco','Disco','api',0),                  -- VTEX
  ('vea','Vea','api',0),                      -- VTEX
  ('farmacity','Farmacity','api',0),          -- VTEX
  ('coto','Coto','scrape',0),                 -- adaptador propio
  ('carrefour','Carrefour','scrape',0),       -- adaptador propio
  ('diarco','Diarco','llm',1),                -- sin tienda pública estable: vía §6.1
  ('almacen','Almacén del barrio','manual',0);
