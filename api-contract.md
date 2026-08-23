# Contrato de API — Brote

Prefijo `/api`. JSON en request y response. Todos los importes en **centavos**
(`amountCents`). Fechas ISO 8601. La sesión viaja en cookie `HttpOnly`; no hay
tokens en el body.

Errores:

```json
{ "error": { "code": "not_found", "message": "El movimiento no existe" } }
```

Códigos: `unauthenticated` (401), `forbidden` (403), `not_found` (404),
`validation` (422), `rate_limited` (429), `upstream_unavailable` (503).

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

### `GET /api/me`
```json
{ "user": { "id": "u_1", "email": "martin@…", "name": "Martín", "role": "owner" },
  "household": { "id": "h_1", "name": "Casa Domínguez", "currency": "ARS",
                 "palette": "organic", "ground": "crema", "inflationAdjusted": true } }
```

### Agregar a alguien del hogar
No hay endpoint: se agrega el mail en la policy de Access, en el panel. La fila en
`users` se crea sola en su primer ingreso.

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
    { "year": 2025, "month": 8, "nominalCents": 130550000, "realCents": 168900000, "ipcPct": 3.1 }
  ],
  "close": {
    "good": ["…"],
    "bad": ["…"],
    "actions": [{ "label": "…", "target": "watch" }]
  }
}
```
`realCents` ya viene calculado en el servidor: el cliente no recalcula inflación.

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
      "nominalChangePct": 7.8, "realChangePct": 5.6, "budgetCents": 72000000,
      "isVariable": true, "mtdCents": 44800000 }
  ],
  "insights": [
    { "kind": "Promedio", "title": "…", "body": "…",
      "action": { "label": "…", "target": "transactions" } }
  ],
  "unitPriceMoves": [
    { "name": "Café molido 500 g", "thenCents": 1145000, "nowCents": 1290000, "deltaPct": 12.7 }
  ]
}
```

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
`monthTotalCents` sale de `month_totals`, **no** de sumar `items`.

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
  "months": [{ "month": 0, "nominalCents": 165100000, "realCents": 189200000 }],
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
                     "countTotal": 12, "countPaid": 5, "monthlyCents": 10333300 }],
  "bonus": { "amountCents": 107500000, "month": "diciembre 2026",
             "base": "la mitad del mejor sueldo del semestre" },
  "idleCash": { "cents": 48000000, "tnaPlazoPct": 42, "tnaFciPct": 39 }
}
```
`dueSoon` incluye los `fixed_expenses` **y** las reglas recurrentes del usuario,
ordenados por proximidad. `fromRule` distingue el origen.

### `PATCH /api/income/:id` · `PATCH /api/fixed/:id` · `PATCH /api/installments/:id`

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
la antigüedad; nunca se omite el precio ni se reemplaza por una estimación.

### `POST /api/watch/items`
`{ "name": "…", "unit": "1 L", "targetCents": 500000, "retailerIds": ["coto","diarco"] }`

### `PATCH /api/watch/items/:id` · `DELETE /api/watch/items/:id`
### `GET /api/retailers`
Los de fábrica (`householdId: null`) más los del hogar.
```json
[{ "id": "coto", "name": "Coto", "kind": "api", "enabled": true },
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
{ "latest": { "year": 2026, "month": 7, "monthlyPct": 2.1, "isEstimate": false },
  "projectedMonthlyPct": 2.0,
  "series": [{ "year": 2026, "month": 6, "monthlyPct": 2.0 }] }
```

---

## Conexiones y privacidad

### `GET /api/connections`
```json
{ "connections": [{ "retailerId": "diarco", "name": "Diarco", "kind": "scrape",
                    "enabled": true, "status": "ok", "lastOkAt": "2026-08-17T11:04:00Z",
                    "lastError": null }],
  "prefs": { "dueDaysAhead": 3, "priceDropPct": 5, "checkFrequency": "6h" } }
```
### `PATCH /api/connections/:retailerId` — `{ "enabled": false }`
### `POST /api/connections/custom` — `{ "name": "Almacén Don José", "url": "https://…" }`
### `PATCH /api/alert-prefs` — `{ "dueDaysAhead": 5, "priceDropPct": 8 }`

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

Tipos: `due_soon`, `price_drop`, `budget_over`, `subscription_idle`, `fx_move`.
