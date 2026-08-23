import { DEFAULT_IPC_PROY_PCT, type InflationRow, type YearMonth } from "./types.js";
import { monthIndex, monthRange } from "./period.js";

/**
 * Serie de IPC indexada, con la política de §5.7: un mes sin dato oficial usa
 * IPC_PROY y queda marcado como estimado. Nunca se presenta como medición.
 */
export class InflationSeries {
  private readonly byIndex = new Map<number, InflationRow>();

  constructor(rows: readonly InflationRow[], private readonly projectedPct = DEFAULT_IPC_PROY_PCT) {
    for (const r of rows) this.byIndex.set(monthIndex(r), r);
  }

  /** El IPC de un mes. Si el INDEC no lo publicó, la estimación marcada. §5.7 */
  at(ym: YearMonth): InflationRow {
    const hit = this.byIndex.get(monthIndex(ym));
    if (hit) return hit;
    return { ...ym, monthlyPct: this.projectedPct, isEstimate: true };
  }

  /**
   * monthFactor de §5.3: producto de (1 + ipc) desde (y,m) hasta el mes actual.
   * Lleva a pesos del mes en curso. El mes base NO se incluye: un importe del mes
   * actual ya está en pesos de hoy y su factor es 1.
   */
  monthFactor(from: YearMonth, current: YearMonth): { factor: number; ipcEstimated: boolean } {
    if (monthIndex(from) >= monthIndex(current)) return { factor: 1, ipcEstimated: false };
    let factor = 1;
    let estimated = false;
    for (const m of monthRange(from, current)) {
      if (monthIndex(m) === monthIndex(from)) continue;
      const row = this.at(m);
      factor *= 1 + row.monthlyPct / 100;
      estimated = estimated || row.isEstimate;
    }
    return { factor, ipcEstimated: estimated };
  }

  /** IPC acumulado entre dos meses, en porcentaje. Para §4.2 y §4.2.1. */
  accumulatedPct(from: YearMonth, to: YearMonth): { pct: number; ipcEstimated: boolean } {
    const { factor, ipcEstimated } = this.monthFactor(from, to);
    return { pct: (factor - 1) * 100, ipcEstimated };
  }
}
