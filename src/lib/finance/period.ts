import type { Month, YearMonth } from "./types.js";

/** Índice absoluto de meses, para comparar y restar sin pelear con Date. */
export const monthIndex = (ym: YearMonth): number => ym.year * 12 + ym.month;

export const fromIndex = (i: number): YearMonth => ({
  year: Math.floor(i / 12),
  month: (((i % 12) + 12) % 12) as Month,
});

/** Meses de `from` a `to`. Negativo si `to` es anterior. */
export const monthsBetween = (from: YearMonth, to: YearMonth): number =>
  monthIndex(to) - monthIndex(from);

export const sameMonth = (a: YearMonth, b: YearMonth): boolean =>
  monthIndex(a) === monthIndex(b);

/** Los meses entre dos puntos, inclusive, en orden. */
export function monthRange(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) out.push(fromIndex(i));
  return out;
}
