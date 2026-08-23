# Contrato de API — Brote

Prefijo `/api`. JSON en request y response. Todos los importes en **centavos**
(`amountCents`). Fechas ISO 8601. No hay cookie de sesión propia ni tokens en el
body: la identidad viaja en el header `Cf-Access-Jwt-Assertion` que pone Cloudflare
Access, y el Worker lo valida en cada request (`SDD.md` §7.1).

Los importes derivados de un cálculo de §5 llevan su procedencia. Dos campos, en
todo endpoint que los produzca:

- `basis`: `"real"` | `"estimado"` | `"sinDato"` — de dónde salió el total del mes
  (`SDD.md` §5.1). Un punto `sinDato` no se dibuja; uno `estimado` se dibuja marcado.
- `ipcEstimated`: `true` cuando la cadena de cálculo usó un IPC todavía no publicado
  por el INDEC (`SDD.md` §5.7).

Nunca se omite ninguno de los dos para "simplificar el JSON": son la regla 5 de
`CLAUDE.md` del lado de la API.

Errores:

```json
{ "error": { "code": "not_found", "message": "El movimiento no existe" } }
```

Códigos: `unauthenticated` (401), `forbidden` (403), `no_household` (403),
`not_found` (404), `validation` (422), `rate_limited` (429),
`upstream_unavailable` (503).

Todo endpoint resuelve el `household_id` desde la sesión. **Ningún endpoint acepta
`householdId` del cliente.**

---

## Auth

**No hay endpoints de login.** El login lo resuelve Cloudflare Access con Google
antes de que la request llegue al Worker (`SDD.md` §7.1). Cada request trae el
header `Cf-Access-Jwt-Assertion`; un middleware lo valida contra
`https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, chequea `aud` contra
`CF_ACCESS_AUD`, y saca `email` y `sub`. Si falta o no valida: `401 unauthenticated`.

Al primer ingreso de un mail nuevo se crea la fila en `users`. El logout es
`/cdn-cgi/access/logout`, servido por Cloudflare.

**Access dice quién entra a la app; Brote dice a qué hogar pertenece** (`SDD.md`
§7.1.1). Al primer ingreso: si no existe ningún hogar, se crea el hogar y el usuario
queda `owner`; si hay una invitación vigente para ese mail, se une a ese hogar como
`member`; si no hay ninguna, la fila en `users` queda con `household_id` en `null` y
**no se crea un hogar nuevo**.

Un usuario sin hogar recibe `403 forbidden` con `code: "no_household"` en todo
endpoint de datos —está autenticado, no pertenece— y solo puede llamar a
`GET /api/me`.

### `GET /api/me`
```json
{ "user": { "id": "u_1", "email": "martin@…", "name": "Martín", "role": "owner" },
  "household": { "id": "h_1", "name": "Casa Domínguez", "currency": "ARS",
                 "palette": "organic", "ground": "crema", "inflationAdjusted": true } }
```
Con el usuario todavía sin hogar, `household` es `null` y el cliente muestra la
pantalla de "pedile la invitación a quien administra el hogar":
```json
{ "user": { "id": "u_2", "email": "valentina@…", "name": "Valentina", "role": null },
  "household": null }
```

### Agregar a alguien del hogar
**Son dos pasos y los dos hacen falta** (`SDD.md` §7.1.1): agregar el mail en la
policy de Access —sin eso no llega ni al login— y crear la invitación acá —sin eso
llega y no tiene hogar. La UI los muestra como checklist de dos ítems.

#### `GET /api/invites` · solo `owner`
```json
{ "invites": [{ "id": "inv_1", "email": "valentina@…", "expiresAt": "2026-09-06T00:00:00Z",
                "acceptedAt": null }] }
```
#### `POST /api/invites` · solo `owner`
`{ "email": "valentina@…" }` → `201 { "id": "inv_1", "expiresAt": "2026-09-06T00:00:00Z" }`

Vence a los 14 días. Un `member` recibe `403 forbidden`. Un mail ya miembro del
hogar, `422 validation`.

#### `DELETE /api/invites/:id` · solo `owner`
Revoca una invitación no aceptada.

---

## Resumen

### `GET /api/overview?mode=real|nominal&range=12`
```json
{
  "month": { "year": 2026, "month": 7 },
  "kpis": {
    "spentCents": 273680000,
    "realChangePct": -1.4,
    "availableCents": 24320000,
    "detectedSavingsCents": 9640000,
    "priceSources": 7
  },
  "series": [
    { "year": 2025, "month": 8, "nominalCents": 130550000, "realCents": 168900000,
      "ipcPct": 3.1, "basis": "real", "ipcEstimated": false },
    { "year": 2026, "month": 7, "nominalCents": 273680000, "realCents": 273680000,
      "ipcPct": 2.0, "basis": "real", "ipcEstimated": true }
  ],
  "close": {
    "good": ["…"],
    "bad": ["…"],
    "actions": [{ "label": "…", "target": "watch" }]
  }
}
```
`realCents` ya viene calculado en el servidor: el cliente no recalcula inflación.

`series` **empieza en el primer mes con dato real del hogar** y `range` la acota: no
se rellena hacia atrás con meses inventados (`SDD.md` §5.1). Un hogar con tres meses
cargados recibe tres puntos. `detectedSavingsCents` se calcula según §4.1.1 y cambia
cuando el hogar apaga una fuente en `/api/connections`.

### `GET /api/overview/projection?to=2027-03&mode=real`
```json
{ "to": "2027-03", "monthlyTrendPct": 1.8, "ipcProjectedPct": 2.0,
  "projectedCents": 341200000, "projectedTodayCents": 289400000,
  "note": "Extrapola tu tendencia real de +1,8% mensual." }
```
`projectedCents` y `projectedTodayCents` son distintos por definición: no colapsarlos.

---

## Categorías y análisis

### `GET /api/categories`
### `POST /api/categories` — `{ "name": "Mascotas", "budgetCents": 5000000, "isVariable": true }`
### `PATCH /api/categories/:id` — `{ "budgetCents": 7200000 }`
### `DELETE /api/categories/:id` — archiva, no borra: los movimientos históricos la referencian.

### `GET /api/analysis?year=2026&month=7`
```json
{
  "categories": [
    { "id": "c_1", "name": "Supermercado", "nowCents": 74200000, "prevCents": 68800000,
      "nominalChangePct": 7.8, "realChangePct": 5.6, "ipcEstimated": true,
      "budgetCents": 72000000, "isVariable": true, "mtdCents": 44800000 }
  ],
  "insights": [
    { "kind": "Promedio", "title": "…", "body": "…", "savingCents": 5600000,
      "action": { "label": "…", "target": "transactions" } },
    { "kind": "Suscripciones", "title": "…", "body": "…", "savingCents": 1290000,
      "action": { "label": "…", "target": "analysis" } }
  ],
  "unitPriceMoves": [
    { "name": "Café molido 500 g", "thenCents": 1145000, "nowCents": 1290000, "deltaPct": 12.7 }
  ]
}
```
`savingCents` se **calcula** según `SDD.md` §4.2.1 y es `null` cuando ese insight en
particular no tiene un ahorro derivable. `null` significa que la UI no muestra
importe: nunca un `0` ni un estimado. Y no se suma con
`kpis.detectedSavingsCents` de `/api/overview`: miran la misma oportunidad y
sumarlos cuenta la misma plata dos veces.

---

## Movimientos

### `GET /api/transactions?year=2026&month=7&q=&categoryId=`
```json
{
  "period": { "year": 2026, "month": 7, "kind": "current" },
  "monthTotalCents": 273680000,
  "detailedTotalCents": 66245000,
  "items": [
    { "id": "t_1", "occurredOn": "2026-08-14", "merchant": "Coto Villa Crespo",
      "detail": "23 productos · ticket detallado", "categoryId": "c_1",
      "source": "ticket_photo", "amountCents": 14840000,
      "ruleId": null, "editable": true }
  ]
}
```
`period.kind`: `current` | `history` | `scheduled`. En `scheduled` solo vienen
ocurrencias de reglas y `editable` es `false` (se edita la regla, no la ocurrencia).
`monthTotalCents` sale de `month_totals`, **no** de sumar `items`. Cómo se calcula
esa fila y cuándo se recalcula está en `SDD.md` §5.0; ningún endpoint la deriva por
su cuenta. `detailedTotalCents` sí es la suma de `items`, y el pie de la pantalla
muestra los dos y dice que son distintos (regla 3 de `CLAUDE.md`).

### `POST /api/transactions`
```json
{ "occurredOn": "2026-08-17", "merchant": "Coto", "detail": "Compra del mes",
  "categoryId": "c_1", "amountCents": 12500000, "source": "quick_total",
  "receiptId": null,
  "recurring": { "frequency": "monthly", "dayOfMonth": 5 } }
```
Si viene `recurring`, se crea también la regla con `startYear`/`startMonth` = el mes
del movimiento.

### `PATCH /api/transactions/:id`
Mismos campos. `recurring: null` elimina la regla asociada.

### `DELETE /api/transactions/:id`

### `GET /api/transactions/years`
`{ "years": [2026, 2025, 2024, 2023] }`

### `GET /api/transactions/annual?year=2026`
```json
{
  "year": 2026, "monthsRecorded": 8,
  "totalCents": 1727390000, "totalTodayCents": 1893400000,
  "avgMonthlyCents": 215923750,
  "highest": { "month": 7, "cents": 273680000 },
  "lowest": { "month": 0, "cents": 165100000 },
  "months": [{ "month": 0, "nominalCents": 165100000, "realCents": 189200000,
               "basis": "real" }],
  "categories": [{ "name": "Alquiler y expensas", "totalCents": 452000000, "sharePct": 26.2 }],
  "topMerchants": [{ "name": "Coto Villa Crespo", "totalCents": 98400000 }],
  "topMerchantsNote": "Cubre solo los movimientos con comercio identificado."
}
```

---

## Reglas recurrentes

### `GET /api/recurring`
### `POST /api/recurring`
```json
{ "merchant": "Netflix", "amountCents": 1290000, "categoryId": "c_9",
  "frequency": "monthly", "dayOfMonth": 8, "startYear": 2026, "startMonth": 7 }
```
`frequency`: `weekly` | `monthly` | `bimonthly` | `yearly`. `dayOfMonth` 1–28.

### `PATCH /api/recurring/:id`
### `DELETE /api/recurring/:id` — deja de materializarse; los movimientos ya creados quedan.

---

## Ingresos y compromisos

### `GET /api/income`
```json
{
  "incomes": [{ "id": "i_1", "who": "Martín", "kind": "Sueldo en relación de dependencia",
                "amountCents": 215000000, "whenText": "el 5 de cada mes", "isFixed": true }],
  "purchasingPower": { "salaryRealCents": 208000000, "vsYearAgoPct": -4.2 },
  "dueSoon": [{ "name": "Alquiler", "amountCents": 62000000, "dayOfMonth": 5,
                "daysAway": 2, "note": "ajusta por ICL en octubre", "fromRule": false }],
  "installments": [{ "name": "Notebook (Mercado Libre)", "totalCents": 124000000,
                     "countTotal": 12, "countPaid": 5, "monthlyCents": 10333300,
                     "startedOn": "2026-03-01" }],
  "bonus": { "amountCents": 107500000, "month": "diciembre 2026",
             "base": "la mitad del mejor sueldo del semestre" },
  "idleCash": { "cents": 48000000, "tnaPlazoPct": 42, "tnaFciPct": 39 }
}
```
`dueSoon` incluye los `fixed_expenses` **y** las reglas recurrentes del usuario,
ordenados por proximidad. `fromRule` distingue el origen.

### `PATCH /api/income/:id` · `PATCH /api/fixed/:id` · `PATCH /api/installments/:id`
### `POST /api/fixed` · `DELETE /api/fixed/:id`

`countPaid` es **derivado** y de solo lectura: son las cuotas ya vencidas contando
desde `startedOn` (`SDD.md` §4.5). `PATCH /api/installments/:id` lo rechaza con
`422 validation`; lo que se corrige es `startedOn` o `countTotal`. Tenerlo escribible
daba dos respuestas para "cuántas van pagadas", y la barra de progreso y el total del
mes podían no coincidir.

`POST /api/fixed` y `POST /api/recurring` rechazan con `422 validation` un nombre de
compromiso fijo que coincide con el `merchant` de una regla activa, y al revés: los
dos alimentan el total del mes por términos distintos (`SDD.md` §5.0) y cargar el
alquiler en los dos lugares lo cuenta dos veces sin que se note en la pantalla.

---

## Presupuesto y objetivos

### `GET /api/budget`
```json
{ "envelopes": [{ "categoryId": "c_1", "name": "Supermercado",
                  "budgetCents": 72000000, "spentCents": 74200000, "consumedPct": 103 }],
  "goals": [{ "id": "g_1", "name": "Vacaciones", "targetCents": 150000000,
              "savedCents": 62000000, "targetDate": "2027-01-15" }] }
```
### `POST /api/goals` · `PATCH /api/goals/:id` · `DELETE /api/goals/:id`

`savedCents` es carga manual del usuario (`SDD.md` §4.5). Brote no lo deduce del
flujo de caja ni lo mueve solo.

---

## Precios

### `GET /api/watch/items`
```json
{
  "items": [{
    "id": "w_1", "name": "Café molido La Morenita 500 g", "unit": "500 g",
    "qty": 0.5, "per": "kg", "cadenceDays": 21, "daysSincePurchase": 19,
    "origin": "de tu ticket de Coto",
    "lastPaidCents": 1145000, "lastPaidAt": "carrefour",
    "targetCents": null,
    "prices": [{ "retailerId": "diarco", "retailer": "Diarco", "priceCents": 949000,
                 "perUnitCents": 1898000, "checkedAt": "2026-08-17T11:04:00Z",
                 "source": "scrape", "stale": false, "isCheapest": true }],
    "alternative": { "brand": "Café La Virginia 500 g", "retailerId": "diarco",
                     "priceCents": 890000, "qty": 0.5 }
  }],
  "suggestions": [{ "name": "Papel higiénico x8", "origin": "detectado en tu ticket de Coto" }]
}
```
Cada precio trae `checkedAt`, `source` y `stale`. Si `stale` es `true` la UI muestra
la antigüedad; nunca se omite el precio ni se reemplaza por una estimación. `stale` lo
escribe el cron —último intento fallido, o el doble de la cadencia del hogar sin éxito
(`SDD.md` §6)— y el cliente solo lo lee.

**Los endpoints con `:id` de producto validan el dueño.** `GET
/api/watch/items/:id/history`, `PUT /api/watch/items/:id/urls` y
`POST /api/watch/items/:id/refresh` resuelven el `watched_items.household_id` antes de
tocar `item_prices` o `item_urls`, que no tienen `household_id` propio. Un `:id` de
otro hogar responde `404 not_found`, no `403`: no se confirma que el id exista
(`SDD.md` §13.3).

### `POST /api/watch/items`
`{ "name": "…", "unit": "1 L", "targetCents": 500000, "retailerIds": ["coto","diarco"] }`

### `PATCH /api/watch/items/:id` · `DELETE /api/watch/items/:id`
### `GET /api/retailers`
Los de fábrica (`householdId: null`) más los del hogar. `kind` sale de la plataforma
verificada de cada tienda (`SDD.md` §6.2). `enabled` refleja `connections`, que se
siembra al crear el hogar con las diez filas explícitas: `api` encendida, `scrape` y
`llm` apagadas. Encender o apagar siempre queda en `audit_log`.
```json
[{ "id": "coto", "name": "Coto", "kind": "scrape", "enabled": false },
 { "id": "disco", "name": "Disco", "kind": "api", "enabled": true },
 { "id": "r_h1_1", "name": "Vital Mayorista", "kind": "llm", "baseUrl": "https://…",
   "enabled": true, "verified": true }]
```

### `POST /api/retailers` — agregar un comercio propio
`{ "name": "Vital Mayorista", "baseUrl": "https://vitalmayorista.com.ar" }`
→ `201 { "id": "r_h1_1", "verified": false, "verifying": true }`

Dispara una consulta de prueba en el momento. La UI muestra "Verificando el
sitio…" y hace polling a `GET /api/retailers` hasta que `verifying` sea `false`.
Si falla, queda `verified: false` con `verifyNote` en palabras del usuario y el
comercio arranca apagado.

### `PATCH /api/retailers/:id` — `{ "enabled": false }`
Apagar una fuente **cambia** canasta, plan de compra dividida y KPI de ahorro
(regla 6 de `CLAUDE.md`).

### `DELETE /api/retailers/:id`
Solo comercios del hogar. Los de fábrica se apagan, no se borran.

### `PUT /api/watch/items/:id/urls`
`{ "urls": { "r_h1_1": "https://vitalmayorista.com.ar/cafe-500g" } }`
Dónde vive el producto en cada comercio propio. Sin URL no hay consulta posible.

### `POST /api/watch/items/:id/refresh` — adelanta el producto en el próximo lote
poniendo `last_checked_at = null`; `202 { "scheduled": true }`.
### `GET /api/watch/items/:id/history?weeks=8`

### `GET /api/watch/basket`
```json
{
  "retailers": [{ "retailerId": "diarco", "name": "Diarco", "totalCents": 4159000,
                  "deltaVsCheapestCents": 0, "itemsCovered": 6 }],
  "cheapestSingleStopCents": 4159000,
  "splitPlan": { "totalCents": 4159000, "stops": 1,
                 "legs": [{ "retailerId": "diarco", "retailer": "Diarco",
                            "items": ["café 500 g", "aceite 1,5 L"] }],
                 "savingVsSingleStopCents": 0,
                 "note": "Todo lo que seguís está más barato en el mismo comercio." }
}
```
El plan se **calcula** desde los precios de las fuentes habilitadas. Apagar Diarco en
`/api/connections` tiene que cambiar `legs`, `stops` y el ahorro.

Los ítems de cada pata vienen completos, porque la pestaña **Lista de compras**
(`SDD.md` §4.6) se dibuja con esto y **no tiene endpoint propio**: es el mismo plan
de §5.6 agrupado por comercio, no un segundo cálculo.

```json
"legs": [{ "retailerId": "diarco", "retailer": "Diarco", "subtotalCents": 4159000,
           "items": [{ "itemId": "w_1", "name": "Café molido La Morenita 500 g",
                       "unit": "500 g", "priceCents": 949000,
                       "checkedAt": "2026-08-17T11:04:00Z", "stale": false }] }]
```
Cada ítem lleva `checkedAt` y `stale`: el total de la lista es **estimado** y la UI
no lo presenta como lo que va a salir en la caja. El tildado de la casilla es estado
local del navegador y no se manda al servidor.

### `GET /api/fx`
```json
{ "rates": [{ "currency": "USD", "name": "Dólar estadounidense",
              "bna": { "buyCents": 141200, "sellCents": 145200, "observedOn": "2026-08-17" },
              "xe": { "referenceCents": 146800, "observedOn": "2026-08-17" },
              "weeks": [133800, 135200] }] }
```
BNA y xe.com van separados. No promediar.

### `GET /api/inflation?months=24`
```json
{ "latest": { "year": 2026, "month": 7, "monthlyPct": 2.0, "isEstimate": true },
  "projectedMonthlyPct": 2.0,
  "series": [{ "year": 2026, "month": 6, "monthlyPct": 2.1, "isEstimate": false }] }
```
`isEstimate` viaja en cada punto. El INDEC publica alrededor del día 15, así que el
mes más reciente es estimado durante unas seis semanas: se calcula igual y se marca,
nunca se presenta como medición (`SDD.md` §5.7).

---

## Conexiones y privacidad

### `GET /api/connections`
```json
{ "connections": [{ "retailerId": "diarco", "name": "Diarco", "kind": "llm",
                    "enabled": false, "status": "ok", "lastOkAt": null,
                    "lastError": null }],
  "prefs": { "dueDaysAhead": 3, "priceDropPct": 5, "checkFrequency": "daily",
             "sendHour": "08:00", "byMail": true, "byPush": true,
             "weeklyDigest": true } }
```
### `PATCH /api/connections/:retailerId` — `{ "enabled": false }`
### `POST /api/connections/custom` — `{ "name": "Almacén Don José", "url": "https://…" }`
### `PATCH /api/alert-prefs`
`{ "dueDaysAhead": 5, "priceDropPct": 8, "sendHour": "08:00", "byMail": true,
   "byPush": true, "weeklyDigest": true }`

Son las cosas que edita Conexiones y que gobiernan la pestaña de Avisos (`SDD.md`
§4.6): hora, baja mínima y canal. `priceDropPct` filtra de verdad qué alertas se
generan; si cambiarlo no cambia el contenido de `GET /api/alerts`, está mal.

`checkFrequency` es `"daily"` | `"weekly"` —la UI los etiqueta "Diaria" y "Semanal"—
y es la cadencia del hogar, que funciona como filtro de elegibilidad del lote del
cron, no como un cron propio (`SDD.md` §6.3). No admite `"6h"` ni `"12h"`: no había
pantalla que los ofreciera.

### `GET /api/export/:view?year=2026&month=7`
`view`: `analysis` | `transactions` | `budget` | `annual`. Devuelve
`text/csv; charset=utf-8` con BOM y separador `;`, nombre
`brote-<view>-<período>.csv`.

### `POST /api/privacy/export` — arma un zip con todo y lo manda por correo. `202`.
### `POST /api/privacy/purge` — borrado real, incluidos los objetos en R2. Requiere
confirmación por correo. `202 { "confirmationSentTo": "…" }`. Se registra en `audit_log`.

---

## Tickets

### `POST /api/receipts/presign`
`{ "contentType": "image/jpeg" }` → `{ "receiptId": "r_1", "uploadUrl": "…", "expiresIn": 300 }`
### `POST /api/receipts/:id/process` — corre el OCR en el request, con timeout.
`200` con las líneas leídas para confirmar.
### `GET /api/receipts/:id`
```json
{ "id": "r_1", "status": "needs_review",
  "parsed": { "merchant": "Coto Villa Crespo", "occurredOn": "2026-08-14",
              "totalCents": 14840000,
              "lines": [{ "name": "Café molido 500 g", "priceCents": 1099000 }] } }
```
### `POST /api/receipts/:id/confirm` — crea el movimiento con lo corregido por el
usuario. **El movimiento nunca se crea sin este paso.**
### `DELETE /api/receipts/:id` — borra la fila y el objeto en R2.

---

## Alertas

### `GET /api/alerts?unread=true`
### `POST /api/alerts/:id/read`

Tipos: `due_soon`, `price_drop`, `price_rise`, `budget_over`, `subscription_review`,
`fx_move`, `job_stale`.

**Una forma fija de `payload` por tipo.** La tarjeta se dibuja solo con lo que trae el
payload: ningún campo se infiere en el cliente, y un tipo que la UI no conoce no se
dibuja —no se dibuja a medias—. Los campos son los que ya define la pantalla de la
que sale cada alerta, no un vocabulario nuevo:

| `kind` | `payload` | Sale de |
|---|---|---|
| `price_drop` | `{ itemId, name, retailerId, retailer, fromCents, toCents, targetCents, url }` | §4.6 Avisos |
| `price_rise` | `{ itemId, name, retailersUp, retailersTotal, avgDeltaPct, ipcMonthlyPct }` | §4.6 Avisos |
| `due_soon` | `{ name, amountCents, dayOfMonth, daysAway, note, fromRule }` | `GET /api/income` · `dueSoon` |
| `budget_over` | `{ categoryId, name, budgetCents, spentCents, consumedPct }` | `GET /api/budget` · `envelopes` |
| `fx_move` | `{ currency, source, fromCents, toCents, observedOn }` | `GET /api/fx` |
| `job_stale` | `{ job, lastOkAt, expectedWithinHours }` | `SDD.md` §13.2 |
| `subscription_review` | `{ ruleId, merchant, amountCents, trigger, prevAmountCents, ipcPeriodPct, monthsUnreviewed }` | §4.2 · `trigger` es `"rose_above_ipc"` o `"unreviewed_6m"` |

`targetCents` en `price_drop` es lo que hace legible la tarjeta del prototipo ("Por
debajo de los $ 34.000 que pediste que te avisemos"): sin él la alerta no puede decir
contra qué se compara, y eso es la regla 5.

`job_stale` no habla de la plata del hogar sino de Brote: un trabajo de fondo que no
tuvo corrida exitosa en el doble de su intervalo (`SDD.md` §13.2). Aparece igual, y
la UI la distingue de las otras.

`subscription_review` reemplaza a `subscription_idle`: Brote ve el cargo, nunca el
uso, así que la alerta habla de lo observable —el cargo subió más que la inflación del
período, o viene cobrándose seis meses sin que nadie la revise (`SDD.md` §4.2)—. No
afirma que la suscripción no se use.
