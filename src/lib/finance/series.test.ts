import { describe, expect, it } from "vitest";
import { InflationSeries } from "./inflation.js";
import { MonthSeries, realChange } from "./series.js";
import type { Month, MonthTotalRow } from "./types.js";

const M = (m: number) => m as Month;
const AGO = { year: 2026, month: M(7) };

// Doce meses reales: sep 2025 .. ago 2026, como los fixtures de §12.1
const rows: MonthTotalRow[] = Array.from({ length: 12 }, (_, i) => {
  const idx = 2025 * 12 + 8 + i;
  return { year: Math.floor(idx / 12), month: M(idx % 12), nominalCents: 130_000_000 + i * 12_000_000 };
});
const ipc = new InflationSeries(
  rows.map((r) => ({ year: r.year, month: r.month, monthlyPct: 2.1, isEstimate: false })),
);

describe("§5.1 — monthNominal es la fuente única y lleva procedencia", () => {
  const s = new MonthSeries(rows, ipc);

  it("un mes con dato es 'real'", () => {
    const r = s.monthNominal(AGO);
    expect(r.basis).toBe("real");
    expect(r.cents).toBe(rows[11].nominalCents);
    expect(r.ipcEstimated).toBe(false);
  });

  it("hacia atrás NO extrapola: es 'sinDato' con cents null", () => {
    const r = s.monthNominal({ year: 2023, month: M(0) });
    expect(r.basis).toBe("sinDato");
    expect(r.cents).toBeNull();       // nunca un cero presentado como dato
  });

  it("hacia adelante estima y queda marcado", () => {
    const r = s.monthNominal({ year: 2026, month: M(9) });
    expect(r.basis).toBe("estimado");
    expect(r.ipcEstimated).toBe(true);
    expect(r.cents).toBeGreaterThan(rows[11].nominalCents);
  });

  it("la serie arranca en el primer mes real, no 44 meses atrás", () => {
    expect(s.firstRealMonth).toEqual({ year: 2025, month: 8 });
  });

  it("un hogar sin datos no tiene serie ni inventa una", () => {
    const empty = new MonthSeries([], ipc);
    expect(empty.hasData).toBe(false);
    expect(empty.monthNominal(AGO)).toMatchObject({ cents: null, basis: "sinDato" });
  });
});

describe("§5.2 — adjust", () => {
  const s = new MonthSeries(rows, ipc);
  it("k = 0 devuelve la base", () => {
    expect(s.adjust(1000, AGO, AGO)).toBe(1000);
  });
  it("hacia atrás usa la serie histórica, no solo el IPC", () => {
    const back = s.adjust(100_000, { year: 2025, month: M(8) }, AGO) as number;
    // 130.000.000 / 262.000.000 ~ 0,496
    expect(back).toBeGreaterThan(45_000);
    expect(back).toBeLessThan(55_000);
  });
  it("devuelve null si el mes no es real: no rellena", () => {
    expect(s.adjust(100_000, { year: 2023, month: M(0) }, AGO)).toBeNull();
  });
  it("hacia adelante usa IPC_PROY", () => {
    const fwd = s.adjust(100_000, { year: 2026, month: M(9) }, AGO) as number;
    expect(fwd).toBe(Math.round(100_000 * 1.02 ** 2));
  });
});

describe("§5.3 y §5.7 — pesos constantes e IPC estimado", () => {
  it("el mes en curso tiene factor 1", () => {
    const s = new MonthSeries(rows, ipc);
    expect(s.toReal(1000, AGO, AGO)).toEqual({ cents: 1000, ipcEstimated: false });
  });
  it("un mes pasado se lleva a pesos de hoy y sube", () => {
    const s = new MonthSeries(rows, ipc);
    const r = s.toReal(100_000, { year: 2025, month: M(8) }, AGO);
    expect(r.cents).toBeGreaterThan(100_000);
    expect(r.ipcEstimated).toBe(false);
  });
  it("si falta el IPC de un mes, se estima Y se marca", () => {
    const partial = new InflationSeries([{ year: 2026, month: M(6), monthlyPct: 2.1, isEstimate: false }]);
    const s = new MonthSeries(rows, partial);
    const r = s.toReal(100_000, { year: 2026, month: M(5) }, AGO);
    expect(r.ipcEstimated).toBe(true);   // nunca una estimación sin marca
  });
});

describe("§5.4 — variación real", () => {
  it("descuenta la inflación del mes más reciente", () => {
    // +7,8% nominal con 2,1% de IPC ~ +5,6% real
    const r = realChange(107_800, 100_000, 2.1) as number;
    expect(r * 100).toBeCloseTo(5.58, 1);
  });
  it("devuelve null y no finge un 0% cuando falta un lado", () => {
    expect(realChange(100_000, null, 2.1)).toBeNull();
    expect(realChange(null, 100_000, 2.1)).toBeNull();
    expect(realChange(100_000, 0, 2.1)).toBeNull();   // ni +infinito
  });
});
