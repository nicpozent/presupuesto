import { InflationSeries } from "./inflation.js";
import { monthIndex } from "./period.js";
import {
  DEFAULT_IPC_PROY_PCT,
  type MonthNominal,
  type MonthTotalRow,
  type YearMonth,
} from "./types.js";

/**
 * monthNominal: la fuente única de los totales mensuales. SDD §5.1.
 * Lee month_totals; no calcula el total (eso es §5.0 / monthTotal.ts).
 *
 * Hacia atrás NO extrapola: antes del primer mes real el hogar no tiene historia
 * y Brote no la inventa.
 */
export class MonthSeries {
  private readonly byIndex = new Map<number, number>();
  private readonly firstIdx: number | null;
  private readonly lastIdx: number | null;

  constructor(
    rows: readonly MonthTotalRow[],
    private readonly ipc: InflationSeries,
    private readonly projectedPct = DEFAULT_IPC_PROY_PCT,
  ) {
    for (const r of rows) this.byIndex.set(monthIndex(r), r.nominalCents);
    const idx = [...this.byIndex.keys()].sort((a, b) => a - b);
    this.firstIdx = idx.length ? idx[0] : null;
    this.lastIdx = idx.length ? idx[idx.length - 1] : null;
  }

  get hasData(): boolean {
    return this.firstIdx !== null;
  }

  /** El primer mes con dato real: dónde arranca la serie del Resumen. §4.1 */
  get firstRealMonth(): YearMonth | null {
    return this.firstIdx === null ? null : { year: Math.floor(this.firstIdx / 12), month: ((this.firstIdx % 12) as YearMonth["month"]) };
  }

  monthNominal(ym: YearMonth): MonthNominal {
    const here = monthIndex(ym);
    const real = this.byIndex.get(here);
    if (real !== undefined) return { cents: real, basis: "real", ipcEstimated: false };

    // Antes del primer mes real: sin dato. No se rellena hacia atrás. §5.1
    if (this.firstIdx === null || here < this.firstIdx) {
      return { cents: null, basis: "sinDato", ipcEstimated: false };
    }

    // Posterior al último real: se estima con el IPC publicado donde exista y
    // IPC_PROY donde no. Queda marcado como estimado.
    const last = this.byIndex.get(this.lastIdx as number) as number;
    let cents = last;
    let ipcEstimated = false;
    for (let i = (this.lastIdx as number) + 1; i <= here; i++) {
      const row = this.ipc.at({ year: Math.floor(i / 12), month: ((i % 12) as YearMonth["month"]) });
      const pct = row.isEstimate ? this.projectedPct : row.monthlyPct;
      cents *= 1 + pct / 100;
      ipcEstimated = true;
    }
    return { cents: Math.round(cents), basis: "estimado", ipcEstimated };
  }

  /**
   * adjust de §5.2. Devuelve null si alguno de los dos meses no es real: no se
   * rellena con el mes más cercano ni se degrada a un factor de IPC solo.
   */
  adjust(baseCents: number, ym: YearMonth, current: YearMonth): number | null {
    const k = monthIndex(ym) - monthIndex(current);
    if (k === 0) return baseCents;
    if (k > 0) return Math.round(baseCents * Math.pow(1 + this.projectedPct / 100, k));
    const there = this.monthNominal(ym);
    const now = this.monthNominal(current);
    if (there.basis !== "real" || now.basis !== "real") return null;
    if (there.cents === null || now.cents === null || now.cents === 0) return null;
    return Math.round((baseCents * there.cents) / now.cents);
  }

  /** Pesos constantes: nominal llevado a pesos del mes en curso. §5.3 */
  toReal(nominalCents: number, ym: YearMonth, current: YearMonth): { cents: number; ipcEstimated: boolean } {
    const { factor, ipcEstimated } = this.ipc.monthFactor(ym, current);
    return { cents: Math.round(nominalCents * factor), ipcEstimated };
  }
}

/**
 * Variación real de §5.4. ipcMes es el IPC del mes MÁS RECIENTE de los dos.
 * Devuelve null si falta alguno de los dos lados: se muestra el valor y se omite
 * la variación, no se finge un 0% ni un +infinito (§12.2).
 */
export function realChange(
  nowCents: number | null,
  prevCents: number | null,
  ipcMonthPct: number,
): number | null {
  if (nowCents === null || prevCents === null || prevCents === 0) return null;
  return nowCents / (prevCents * (1 + ipcMonthPct / 100)) - 1;
}
