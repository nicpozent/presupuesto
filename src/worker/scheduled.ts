import type { Env } from "./index.js";

/**
 * Trabajo de fondo. Cada corrida deja su fila en job_runs para que §13.2 pueda
 * saber si un cron dejó de andar.
 *
 * Free tier (DEPLOY.md §9): 50 subrequests y 50 queries de D1 por invocación.
 * Por eso el lote se mide en PARES producto-comercio, no en productos.
 */
export const JOB_BY_CRON: Record<string, "fx" | "ipc" | "prices" | "alerts"> = {
  "0 14 * * *": "fx",
  "0 15 15 * *": "ipc",
  "0 */6 * * *": "prices",
  "0 12 * * *": "alerts",
};

export async function runScheduled(cron: string, env: Env): Promise<void> {
  const job = JOB_BY_CRON[cron];
  if (!job) return;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let ok = 1;
  let error: string | null = null;
  try {
    // Los handlers concretos se implementan por etapa (SDD §14, pasos 5 a 8).
    // La contabilidad de job_runs existe desde ahora para no agregarla después.
    if (job === "fx" || job === "ipc" || job === "prices" || job === "alerts") {
      // no-op por ahora: la etapa que lo implemente reemplaza esta rama
    }
  } catch (e) {
    ok = 0;
    error = e instanceof Error ? e.message : String(e);
  }
  await env.DB.prepare(
    `insert into job_runs (id, job, ok, started_at, finished_at, ms, error)
       values (?1, ?2, ?3, ?4, datetime('now'), ?5, ?6)`,
  )
    .bind(
      `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      job, ok, startedAt, Date.now() - t0, error,
    )
    .run();
}
