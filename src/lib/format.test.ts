import { describe, expect, it } from "vitest";
import { ago, ars, dayShort, monthLong, pct } from "./format.js";

describe("formato es-AR (CLAUDE.md)", () => {
  it("moneda: símbolo, espacio fino, punto de miles, sin decimales", () => {
    expect(ars(273_680_000)).toBe("$ 2.736.800");
    expect(ars(0)).toBe("$ 0");
    expect(ars(949_000)).toBe("$ 9.490");
  });
  it("porcentajes con coma y signo siempre visible", () => {
    expect(pct(3.2)).toBe("+3,2%");
    expect(pct(-1.4)).toBe("−1,4%");
    expect(pct(0)).toBe("0,0%");
  });
  it("meses y fechas en minúscula", () => {
    expect(monthLong(2026, 7)).toBe("agosto 2026");
    expect(dayShort("2026-08-17")).toBe("17 ago");
  });
  it("antigüedad en palabras", () => {
    expect(ago("2026-08-17T09:00:00Z", "2026-08-17T11:00:00Z")).toBe("hace 2 h");
    expect(ago("2026-08-16T09:00:00Z", "2026-08-17T11:00:00Z")).toBe("ayer");
    expect(ago("2026-08-15T09:00:00Z", "2026-08-17T11:00:00Z")).toBe("hace 2 días");
  });
});
