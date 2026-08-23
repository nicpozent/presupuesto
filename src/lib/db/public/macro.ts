/**
 * Las ÚNICAS tablas que se leen sin un hogar: contexto público (fx_rates,
 * inflation) y salud de Brote (job_runs). SDD §3 y §13.3.
 *
 * Las hijas de watched_items NO van acá: son datos del hogar que llegan por
 * item_id y se leen con assertOwnsItem.
 */
import type { InflationRow, Month } from "../../finance/types.js";

export async function readInflation(db: D1Database, months = 24): Promise<InflationRow[]> {
  const { results } = await db
    .prepare(
      `select year, month, monthly_pct as pct, is_estimate as est
         from inflation order by year desc, month desc limit ?1`,
    )
    .bind(months)
    .all<{ year: number; month: number; pct: number; est: number }>();
  return results
    .map((r) => ({ year: r.year, month: r.month as Month, monthlyPct: r.pct, isEstimate: r.est === 1 }))
    .reverse();
}

export interface FxRow {
  currency: "USD" | "EUR" | "CHF";
  source: "bna" | "xe";
  buyCents: number | null;
  sellCents: number | null;
  observedOn: string;
}

/** Última cotización por moneda y fuente. BNA y xe por separado: regla 7. */
export async function readLatestFx(db: D1Database): Promise<FxRow[]> {
  const { results } = await db
    .prepare(
      `select currency, source, buy_cents as buyCents, sell_cents as sellCents,
              max(observed_on) as observedOn
         from fx_rates group by currency, source`,
    )
    .all<FxRow>();
  return results;
}

export interface JobHealth {
  job: string;
  lastOkAt: string | null;
}

export async function readJobHealth(db: D1Database): Promise<JobHealth[]> {
  const { results } = await db
    .prepare(`select job, max(started_at) as lastOkAt from job_runs where ok = 1 group by job`)
    .all<JobHealth>();
  return results;
}
