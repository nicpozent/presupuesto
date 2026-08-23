/**
 * Aislamiento por hogar. SDD §13.3.
 *
 * Toda función de src/lib/db/ recibe un HouseholdContext como PRIMER parámetro.
 * No es opcional y no hay variante sin él. El contexto sale del JWT validado
 * (§7.1), nunca del body ni del query string.
 */
export interface HouseholdContext {
  readonly householdId: string;
  readonly userId: string;
  readonly role: "owner" | "member";
  readonly db: D1Database;
}

/** El usuario pasó Access pero todavía no pertenece a ningún hogar. §7.1.1 */
export interface PendingContext {
  readonly householdId: null;
  readonly userId: string;
  readonly db: D1Database;
}

export type AnyContext = HouseholdContext | PendingContext;

export const hasHousehold = (c: AnyContext): c is HouseholdContext => c.householdId !== null;

/** Se lanza cuando un :id no pertenece al hogar. El handler responde 404, no 403. */
export class NotFoundInHousehold extends Error {
  constructor(what: string) {
    super(`${what} no existe en este hogar`);
    this.name = "NotFoundInHousehold";
  }
}

/**
 * Resuelve el hogar de un watched_item ANTES de tocar sus tablas hijas.
 *
 * item_prices, item_urls, item_alternatives y price_fetch_log no tienen
 * household_id: llegan al hogar por item_id (§3). Sin este chequeo, un :id de la
 * URL alcanza para leer los precios de otro hogar. Devuelve el id validado para
 * que la query de la hija lo use, y tira NotFoundInHousehold si no es del hogar.
 */
export async function assertOwnsItem(ctx: HouseholdContext, itemId: string): Promise<string> {
  const row = await ctx.db
    .prepare("select id from watched_items where id = ?1 and household_id = ?2")
    .bind(itemId, ctx.householdId)
    .first<{ id: string }>();
  if (!row) throw new NotFoundInHousehold("El producto");
  return row.id;
}
