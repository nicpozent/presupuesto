import type { Month, YearMonth } from "./types.js";
import { monthIndex } from "./period.js";

/**
 * Derivación de month_totals. SDD §5.0.
 *
 * El total NO es la suma de movimientos: hay gasto sin movimiento individual
 * (alquiler, expensas, cuotas). Regla 3 de CLAUDE.md.
 *
 *   A = movimientos del mes con rule_id NULL
 *   B = ocurrencias de reglas, en tres estados (ver abajo)
 *   C = compromisos fijos vigentes
 *   D = cuotas vencidas en el mes
 */

export interface TxInput {
  merchant: string;
  amountCents: number;
  ruleId: string | null;
  /** YYYY-MM-DD */
  occurredOn: string;
}

export interface RuleInput {
  id: string;
  merchant: string;
  amountCents: number;
  frequency: "weekly" | "monthly" | "bimonthly" | "yearly";
  startYear: number;
  startMonth: Month;
  /** YYYY-MM-DD, o null si sigue vigente */
  endedOn: string | null;
}

export interface FixedInput {
  name: string;
  amountCents: number;
}

export interface InstallmentInput {
  name: string;
  monthlyCents: number;
  countTotal: number;
  /** YYYY-MM-DD */
  startedOn: string;
}

export interface MonthTotalBreakdown {
  loneTxCents: number;
  rulesCents: number;
  fixedCents: number;
  installmentsCents: number;
  totalCents: number;
}

const ymOf = (iso: string): YearMonth => {
  const [y, m] = iso.split("-");
  return { year: Number(y), month: (Number(m) - 1) as Month };
};

/** ¿La regla tiene una ocurrencia en este mes? Respeta frecuencia e inicio. */
export function ruleOccursIn(rule: RuleInput, ym: YearMonth): boolean {
  const start = monthIndex({ year: rule.startYear, month: rule.startMonth });
  const here = monthIndex(ym);
  if (here < start) return false; // no aparece antes de su mes de inicio (regla 4)
  if (rule.endedOn && here > monthIndex(ymOf(rule.endedOn))) return false;
  const k = here - start;
  switch (rule.frequency) {
    case "weekly":
    case "monthly":
      return true;
    case "bimonthly":
      return k % 2 === 0;
    case "yearly":
      return k % 12 === 0;
  }
}

/** ¿La cuota n de este producto vence en este mes? */
export function installmentDueIn(inst: InstallmentInput, ym: YearMonth): boolean {
  const start = monthIndex(ymOf(inst.startedOn));
  const k = monthIndex(ym) - start;
  return k >= 0 && k < inst.countTotal;
}

export function computeMonthTotal(args: {
  ym: YearMonth;
  /** Solo los movimientos del mes en cuestión. */
  transactions: readonly TxInput[];
  rules: readonly RuleInput[];
  fixed: readonly FixedInput[];
  installments: readonly InstallmentInput[];
  /** El mes en curso, para la regla de deduplicación por comercio. */
  currentMonth: YearMonth;
}): MonthTotalBreakdown {
  const { ym, transactions, rules, fixed, installments, currentMonth } = args;
  const isCurrent = monthIndex(ym) === monthIndex(currentMonth);

  // A — compras sueltas: sin rule_id.
  const lone = transactions.filter((t) => t.ruleId === null);
  const loneTxCents = lone.reduce((a, t) => a + t.amountCents, 0);

  // B — una ocurrencia de regla puede estar en tres estados. Cada peso, una vez.
  let rulesCents = 0;
  for (const rule of rules) {
    if (!ruleOccursIn(rule, ym)) continue;
    const materialized = transactions.find((t) => t.ruleId === rule.id);
    if (materialized) {
      // 1. Materializada: manda el importe real, no el de la regla.
      rulesCents += materialized.amountCents;
      continue;
    }
    // 2. Tapada por una compra suelta del mismo comercio, solo en el mes en curso:
    //    ya entró por A, así que aporta cero (regla 4).
    if (isCurrent && lone.some((t) => t.merchant === rule.merchant)) continue;
    // 3. Sin movimiento: aporta el importe de la regla.
    rulesCents += rule.amountCents;
  }

  const fixedCents = fixed.reduce((a, f) => a + f.amountCents, 0);
  const installmentsCents = installments
    .filter((i) => installmentDueIn(i, ym))
    .reduce((a, i) => a + i.monthlyCents, 0);

  return {
    loneTxCents,
    rulesCents,
    fixedCents,
    installmentsCents,
    totalCents: loneTxCents + rulesCents + fixedCents + installmentsCents,
  };
}

/** Cuántas cuotas van pagadas. Derivado, no guardado. SDD §4.5. */
export function installmentsPaid(inst: InstallmentInput, current: YearMonth): number {
  const k = monthIndex(current) - monthIndex(ymOf(inst.startedOn)) + 1;
  return Math.max(0, Math.min(inst.countTotal, k));
}
