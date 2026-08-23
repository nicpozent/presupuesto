import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// Vite intenta resolver "node:sqlite" como un paquete y falla; createRequire lo
// carga por el loader de Node, que es de donde viene.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...a: never[]): Record<string, unknown>[]; run(...a: never[]): void };
  };
};
import { NotAllowed, resolveUser } from "./users.js";

const OWNER = "martin@gmail.com";

/** Adaptador mínimo de node:sqlite a la forma de D1 que usa resolveUser. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("schema.sql", "utf8"));
  const prep = (sql: string) => {
    const st = db.prepare(sql.replace(/\?(\d+)/g, "?"));
    let args: unknown[] = [];
    const api = {
      bind: (...a: unknown[]) => { args = a; return api; },
      first: async () => (st.all(...(args as never[]))[0] ?? null),
      run: async () => { st.run(...(args as never[])); return { meta: { changes: 1 } }; },
      all: async () => ({ results: st.all(...(args as never[])) }),
    };
    return api;
  };
  return {
    prepare: prep,
    batch: async (stmts: unknown[]) => { for (const s of stmts) await (s as { run: () => Promise<unknown> }).run(); return []; },
  } as unknown as D1Database;
}

describe("§7.2 — quién puede entrar", () => {
  let db: D1Database;
  beforeEach(() => { db = fakeD1(); });

  it("el dueño declarado crea el hogar y queda owner", async () => {
    const u = await resolveUser(db, { sub: "g1", email: OWNER }, OWNER);
    expect(u.role).toBe("owner");
    expect(u.householdId).toBeTruthy();
  });

  it("un desconocido NO crea el hogar, aunque entre primero", async () => {
    await expect(resolveUser(db, { sub: "gX", email: "random@gmail.com" }, OWNER))
      .rejects.toThrow(NotAllowed);
  });

  it("y no le queda ninguna fila en users", async () => {
    await resolveUser(db, { sub: "gX", email: "random@gmail.com" }, OWNER).catch(() => {});
    const r = await db.prepare("select count(*) as n from users").bind().first<{ n: number }>();
    expect(r?.n).toBe(0);
  });

  it("el mail del dueño se compara sin importar mayúsculas ni espacios", async () => {
    const u = await resolveUser(db, { sub: "g1", email: " Martin@Gmail.com " }, OWNER);
    expect(u.role).toBe("owner");
  });

  it("un invitado vigente se une como member, no como owner", async () => {
    const owner = await resolveUser(db, { sub: "g1", email: OWNER }, OWNER);
    await db.prepare(
      `insert into invites (id, household_id, email, expires_at)
         values (?1, ?2, ?3, datetime('now','+14 days'))`,
    ).bind("inv1", owner.householdId, "valentina@gmail.com").run();
    const v = await resolveUser(db, { sub: "g2", email: "valentina@gmail.com" }, OWNER);
    expect(v.role).toBe("member");
    expect(v.householdId).toBe(owner.householdId);
  });

  it("una invitación vencida no sirve", async () => {
    const owner = await resolveUser(db, { sub: "g1", email: OWNER }, OWNER);
    await db.prepare(
      `insert into invites (id, household_id, email, expires_at)
         values (?1, ?2, ?3, datetime('now','-1 day'))`,
    ).bind("inv2", owner.householdId, "tarde@gmail.com").run();
    await expect(resolveUser(db, { sub: "g3", email: "tarde@gmail.com" }, OWNER))
      .rejects.toThrow(NotAllowed);
  });

  it("el segundo ingreso del dueño no crea otro hogar", async () => {
    const a = await resolveUser(db, { sub: "g1", email: OWNER }, OWNER);
    const b = await resolveUser(db, { sub: "g1", email: OWNER }, OWNER);
    expect(b.id).toBe(a.id);
    expect(b.householdId).toBe(a.householdId);
  });
});
