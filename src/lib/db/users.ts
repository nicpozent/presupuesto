import type { AnyContext, HouseholdContext } from "./context.js";

export interface AppUser {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "member" | null;
  householdId: string | null;
}

const id = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Resuelve el usuario del JWT ya validado, creándolo en su primer ingreso.
 * SDD §7.1.1: Access dice quién entra; esto dice a qué hogar pertenece.
 *
 *  1. no hay ningún hogar todavía  → crea el hogar y queda owner
 *  2. hay invitación vigente       → se une a ese hogar como member
 *  3. no hay invitación            → household_id NULL. NO se crea un hogar nuevo.
 */
export async function resolveUser(
  db: D1Database,
  claims: { sub: string; email: string; name?: string },
): Promise<AppUser> {
  const existing = await db
    .prepare(`select id, email, name, role, household_id from users where google_sub = ?1`)
    .bind(claims.sub)
    .first<{ id: string; email: string; name: string | null; role: string; household_id: string | null }>();
  if (existing) {
    await db.prepare(`update users set last_seen_at = datetime('now') where id = ?1`)
      .bind(existing.id).run();
    return {
      id: existing.id, email: existing.email, name: existing.name,
      role: existing.household_id ? (existing.role as "owner" | "member") : null,
      householdId: existing.household_id,
    };
  }

  const anyHousehold = await db.prepare(`select id from households limit 1`).first<{ id: string }>();
  const userId = id("u");

  // 1. Primer ingreso de la instalación: se crea el hogar.
  if (!anyHousehold) {
    const hid = id("h");
    await db.batch([
      db.prepare(`insert into households (id, name) values (?1, ?2)`).bind(hid, "Mi casa"),
      db.prepare(
        `insert into users (id, household_id, google_sub, email, name, role)
           values (?1, ?2, ?3, ?4, ?5, 'owner')`,
      ).bind(userId, hid, claims.sub, claims.email, claims.name ?? null),
    ]);
    return { id: userId, email: claims.email, name: claims.name ?? null, role: "owner", householdId: hid };
  }

  // 2. ¿Hay invitación vigente para este mail?
  const invite = await db
    .prepare(
      `select id, household_id from invites
        where lower(email) = lower(?1) and accepted_at is null
          and expires_at > datetime('now') limit 1`,
    )
    .bind(claims.email)
    .first<{ id: string; household_id: string }>();

  if (invite) {
    await db.batch([
      db.prepare(
        `insert into users (id, household_id, google_sub, email, name, role)
           values (?1, ?2, ?3, ?4, ?5, 'member')`,
      ).bind(userId, invite.household_id, claims.sub, claims.email, claims.name ?? null),
      db.prepare(`update invites set accepted_at = datetime('now') where id = ?1`).bind(invite.id),
    ]);
    return {
      id: userId, email: claims.email, name: claims.name ?? null,
      role: "member", householdId: invite.household_id,
    };
  }

  // 3. Sin invitación: usuario válido sin hogar. No se le crea uno propio.
  await db.prepare(
    `insert into users (id, household_id, google_sub, email, name)
       values (?1, null, ?2, ?3, ?4)`,
  ).bind(userId, claims.sub, claims.email, claims.name ?? null).run();
  return { id: userId, email: claims.email, name: claims.name ?? null, role: null, householdId: null };
}

export async function listInvites(ctx: HouseholdContext) {
  const { results } = await ctx.db
    .prepare(
      `select id, email, expires_at as expiresAt, accepted_at as acceptedAt
         from invites where household_id = ?1 order by expires_at desc`,
    )
    .bind(ctx.householdId)
    .all<{ id: string; email: string; expiresAt: string; acceptedAt: string | null }>();
  return results;
}

/** Vence a los 14 días — default a confirmar, SDD §13.5. */
export const INVITE_DAYS = 14;

export async function createInvite(ctx: HouseholdContext, email: string) {
  const already = await ctx.db
    .prepare(`select 1 as hit from users where lower(email) = lower(?1) and household_id = ?2`)
    .bind(email, ctx.householdId).first<{ hit: number }>();
  if (already) return { error: "validation" as const };
  const inviteId = id("inv");
  await ctx.db.prepare(
    `insert into invites (id, household_id, email, invited_by, expires_at)
       values (?1, ?2, ?3, ?4, datetime('now', '+${INVITE_DAYS} days'))`,
  ).bind(inviteId, ctx.householdId, email, ctx.userId).run();
  return { id: inviteId };
}

export async function deleteInvite(ctx: HouseholdContext, inviteId: string): Promise<boolean> {
  const r = await ctx.db
    .prepare(`delete from invites where id = ?1 and household_id = ?2 and accepted_at is null`)
    .bind(inviteId, ctx.householdId).run();
  return (r.meta.changes ?? 0) > 0;
}

export type { AnyContext };
