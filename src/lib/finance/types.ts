/**
 * Tipos del dominio financiero. Sin `any` (CLAUDE.md).
 * Importes SIEMPRE en centavos enteros.
 */

/** Mes 0-11, como en el prototipo y en el esquema. */
export type Month = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface YearMonth {
  year: number;
  month: Month;
}

/** De dónde salió un total mensual. SDD §5.1. */
export type Basis = "real" | "estimado" | "sinDato";

export interface MonthNominal {
  /** null cuando basis es "sinDato": no se inventa un número. */
  cents: number | null;
  basis: Basis;
  /** true si la cadena de cálculo usó un IPC todavía no publicado. SDD §5.7. */
  ipcEstimated: boolean;
}

/** Una fila de month_totals. */
export interface MonthTotalRow extends YearMonth {
  nominalCents: number;
}

/** Una fila de inflation. */
export interface InflationRow extends YearMonth {
  monthlyPct: number;
  isEstimate: boolean;
}

/** IPC proyectado mensual, de wrangler.toml. SDD §5. */
export const DEFAULT_IPC_PROY_PCT = 2.0;
