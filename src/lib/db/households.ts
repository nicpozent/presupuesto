import type { HouseholdContext } from "./context.js";

export interface Household {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  palette: string;
  ground: string;
  inflationAdjusted: boolean;
}

export async function getHousehold(ctx: HouseholdContext): Promise<Household | null> {
  const r = await ctx.db
    .prepare(
      `select id, name, currency, timezone, palette, ground, inflation_adj
         from households where id = ?1`,
    )
    .bind(ctx.householdId)
    .first<{
      id: string; name: string; currency: string; timezone: string;
      palette: string; ground: string; inflation_adj: number;
    }>();
  if (!r) return null;
  return {
    id: r.id, name: r.name, currency: r.currency, timezone: r.timezone,
    palette: r.palette, ground: r.ground, inflationAdjusted: r.inflation_adj === 1,
  };
}

/** Los diez comercios de fábrica, sembrados por vía de acceso. SDD §6.2. */
export async function seedConnections(ctx: HouseholdContext): Promise<void> {
  // 'api' encendida; 'scrape' y 'llm' apagadas. La ausencia de fila no significa
  // habilitada: significa hogar a medio crear.
  await ctx.db
    .prepare(
      `insert into connections (household_id, retailer_id, enabled)
         select ?1, id, case when kind = 'api' then 1 else 0 end
           from retailers where household_id is null
       on conflict (household_id, retailer_id) do nothing`,
    )
    .bind(ctx.householdId)
    .run();
}
