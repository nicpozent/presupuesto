import { describe, expect, it } from "vitest";
import { computeMonthTotal, installmentsPaid, ruleOccursIn } from "./monthTotal.js";
import type { Month } from "./types.js";

const AGO = { year: 2026, month: 7 as Month };  // agosto 2026, mes en curso
const JUL = { year: 2026, month: 6 as Month };

describe("regla 3 — el total no es la suma de movimientos", () => {
  it("incluye gasto sin movimiento individual", () => {
    const r = computeMonthTotal({
      ym: AGO, currentMonth: AGO,
      transactions: [{ merchant: "Coto", amountCents: 14_840_000, ruleId: null, occurredOn: "2026-08-10" }],
      rules: [],
      fixed: [{ name: "Expensas", amountCents: 18_000_000 }],
      installments: [{ name: "Notebook", monthlyCents: 10_333_300, countTotal: 12, startedOn: "2026-03-01" }],
    });
    expect(r.loneTxCents).toBe(14_840_000);
    expect(r.totalCents).toBe(14_840_000 + 18_000_000 + 10_333_300);
    // el total es mayor que las filas de movimientos: eso es el punto
    expect(r.totalCents).toBeGreaterThan(r.loneTxCents);
  });
});

describe("regla 4 — los tres estados de una ocurrencia de regla", () => {
  const rule = {
    id: "r1", merchant: "Netflix", amountCents: 1_290_000,
    frequency: "monthly" as const, startYear: 2026, startMonth: 0 as Month, endedOn: null,
  };

  it("materializada: manda el importe real y se cuenta UNA vez", () => {
    const r = computeMonthTotal({
      ym: AGO, currentMonth: AGO,
      transactions: [{ merchant: "Netflix", amountCents: 1_390_000, ruleId: "r1", occurredOn: "2026-08-08" }],
      rules: [rule], fixed: [], installments: [],
    });
    expect(r.loneTxCents).toBe(0);          // tiene rule_id: no entra por A
    expect(r.rulesCents).toBe(1_390_000);   // el real, no el 1.290.000 de la regla
    expect(r.totalCents).toBe(1_390_000);   // ni cero ni el doble
  });

  it("tapada por una compra suelta del mismo comercio: no se duplica", () => {
    const r = computeMonthTotal({
      ym: AGO, currentMonth: AGO,
      transactions: [{ merchant: "Netflix", amountCents: 1_350_000, ruleId: null, occurredOn: "2026-08-08" }],
      rules: [rule], fixed: [], installments: [],
    });
    expect(r.loneTxCents).toBe(1_350_000);
    expect(r.rulesCents).toBe(0);
    expect(r.totalCents).toBe(1_350_000);
  });

  it("sin movimiento: aporta el importe de la regla", () => {
    const r = computeMonthTotal({
      ym: AGO, currentMonth: AGO, transactions: [],
      rules: [rule], fixed: [], installments: [],
    });
    expect(r.totalCents).toBe(1_290_000);
  });

  it("la dedup por comercio es SOLO del mes en curso", () => {
    // en un mes pasado, una compra suelta del mismo comercio no tapa la regla
    const r = computeMonthTotal({
      ym: JUL, currentMonth: AGO,
      transactions: [{ merchant: "Netflix", amountCents: 1_350_000, ruleId: null, occurredOn: "2026-07-08" }],
      rules: [rule], fixed: [], installments: [],
    });
    expect(r.totalCents).toBe(1_350_000 + 1_290_000);
  });

  it("no aparece antes de su mes de inicio", () => {
    expect(ruleOccursIn(rule, { year: 2025, month: 11 as Month })).toBe(false);
    expect(ruleOccursIn(rule, { year: 2026, month: 0 as Month })).toBe(true);
  });

  it("respeta la frecuencia: bimestral y anual", () => {
    const bi = { ...rule, frequency: "bimonthly" as const };
    expect(ruleOccursIn(bi, { year: 2026, month: 0 as Month })).toBe(true);
    expect(ruleOccursIn(bi, { year: 2026, month: 1 as Month })).toBe(false);
    expect(ruleOccursIn(bi, { year: 2026, month: 2 as Month })).toBe(true);
    const yr = { ...rule, frequency: "yearly" as const };
    expect(ruleOccursIn(yr, { year: 2026, month: 6 as Month })).toBe(false);
    expect(ruleOccursIn(yr, { year: 2027, month: 0 as Month })).toBe(true);
  });

  it("se materializa en meses futuros", () => {
    expect(ruleOccursIn(rule, { year: 2027, month: 5 as Month })).toBe(true);
  });
});

describe("cuotas — una sola verdad (§4.5)", () => {
  const inst = { name: "Notebook", monthlyCents: 10_333_300, countTotal: 12, startedOn: "2026-03-01" };
  it("cuenta las vencidas desde started_on, no una columna aparte", () => {
    expect(installmentsPaid(inst, AGO)).toBe(6);       // mar..ago
    expect(installmentsPaid(inst, { year: 2026, month: 1 as Month })).toBe(0);
    expect(installmentsPaid(inst, { year: 2030, month: 0 as Month })).toBe(12); // no pasa de countTotal
  });
  it("deja de sumar cuando se terminaron las cuotas", () => {
    const late = computeMonthTotal({
      ym: { year: 2027, month: 6 as Month }, currentMonth: AGO,
      transactions: [], rules: [], fixed: [], installments: [inst],
    });
    expect(late.installmentsCents).toBe(0);
  });
});
