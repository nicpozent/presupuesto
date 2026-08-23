/**
 * Formato es-AR, según CLAUDE.md. Un solo lugar: si el símbolo, el espacio fino o
 * el separador de miles se escriben a mano en un componente, se desalinean.
 */
const MESES_L = ["enero","febrero","marzo","abril","mayo","junio",
                 "julio","agosto","septiembre","octubre","noviembre","diciembre"] as const;
const MESES_3 = ["ene","feb","mar","abr","may","jun",
                 "jul","ago","sep","oct","nov","dic"] as const;

/** Espacio fino (U+2009) entre el símbolo y el número: "$ 2.736.800". */
const THIN = " ";

/** Centavos enteros → "$ 2.736.800". Sin decimales, punto de miles. */
export function ars(cents: number): string {
  const pesos = Math.round(cents / 100);
  return `$${THIN}${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(pesos)}`;
}

/** Variación con signo siempre visible y coma decimal: "+3,2%", "−1,4%". */
export function pct(value: number, decimals = 1): string {
  const n = new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(value));
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${n}%`;
}

/** "agosto 2026", en minúscula. */
export const monthLong = (year: number, month: number): string => `${MESES_L[month]} ${year}`;

/** "17 ago", en minúscula. */
export function dayShort(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MESES_3[Number(m) - 1]}`;
}

/** Antigüedad en palabras, como las tarjetas de Avisos: "hace 2 h", "ayer". */
export function ago(fromIso: string, nowIso: string): string {
  const h = Math.floor((Date.parse(nowIso) - Date.parse(fromIso)) / 3_600_000);
  if (h < 1) return "hace un rato";
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ayer";
  return `hace ${d} días`;
}
