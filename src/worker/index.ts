import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { verifyAccessJwt, type AccessClaims } from "./access.js";
import { getHousehold, seedConnections } from "../lib/db/households.js";
import {
  createInvite, deleteInvite, listInvites, resolveUser, type AppUser,
} from "../lib/db/users.js";
import { NotFoundInHousehold, type HouseholdContext } from "../lib/db/context.js";
import { readInflation, readJobHealth, readLatestFx } from "../lib/db/public/macro.js";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  RECEIPTS: R2Bucket;
  APP_URL: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DEFAULT_TIMEZONE: string;
  IPC_PROJECTED_MONTHLY_PCT: string;
}

type Vars = { user: AppUser; ctx: HouseholdContext | null };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const fail = (code: string, message: string) => ({ error: { code, message } });

// Salud: fuera de todo, para el curl del deploy.
app.get("/api/health", (c) => c.json({ ok: true, service: "brote" }));

/** Access valida en el borde; el Worker valida igual, en cada request (§7.1). */
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const token =
    c.req.header("Cf-Access-Jwt-Assertion") ??
    c.req.header("cf-access-jwt-assertion") ??
    "";
  if (!token) {
    return c.json(fail("unauthenticated", "Falta el token de Access"), 401);
  }
  let claims: AccessClaims | null = null;
  try {
    claims = await verifyAccessJwt(token, {
      teamDomain: c.env.CF_ACCESS_TEAM_DOMAIN,
      aud: c.env.CF_ACCESS_AUD,
    });
  } catch {
    return c.json(fail("upstream_unavailable", "No se pudo validar el token"), 503);
  }
  if (!claims) return c.json(fail("unauthenticated", "Token inválido"), 401);

  const user = await resolveUser(c.env.DB, claims);
  c.set("user", user);
  c.set(
    "ctx",
    user.householdId
      ? { householdId: user.householdId, userId: user.id, role: user.role ?? "member", db: c.env.DB }
      : null,
  );
  return next();
});

/** El hogar es null mientras nadie lo invitó. §7.1.1 */
app.get("/api/me", async (c) => {
  const user = c.get("user");
  const ctx = c.get("ctx");
  if (!ctx) return c.json({ user: { ...user, role: null }, household: null });
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    household: await getHousehold(ctx),
  });
});

/** Todo endpoint de datos exige hogar: 403 no_household, no 401. */
const needHousehold: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  if (!c.get("ctx")) {
    return c.json(
      fail("no_household", "Pedile una invitación a quien administra el hogar"),
      403,
    );
  }
  return next();
};

app.use("/api/invites", needHousehold);
app.use("/api/invites/*", needHousehold);
app.use("/api/overview", needHousehold);
app.use("/api/inflation", needHousehold);
app.use("/api/fx", needHousehold);

app.get("/api/invites", async (c) => c.json({ invites: await listInvites(c.get("ctx")!) }));

app.post("/api/invites", async (c) => {
  const ctx = c.get("ctx")!;
  if (ctx.role !== "owner") return c.json(fail("forbidden", "Solo el dueño invita"), 403);
  const body = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
  if (!body.email) return c.json(fail("validation", "Falta el mail"), 422);
  const r = await createInvite(ctx, body.email);
  if ("error" in r) return c.json(fail("validation", "Ese mail ya es del hogar"), 422);
  return c.json(r, 201);
});

app.delete("/api/invites/:id", async (c) => {
  const ctx = c.get("ctx")!;
  if (ctx.role !== "owner") return c.json(fail("forbidden", "Solo el dueño invita"), 403);
  const gone = await deleteInvite(ctx, c.req.param("id"));
  return gone ? c.body(null, 204) : c.json(fail("not_found", "La invitación no existe"), 404);
});

// Divisas e inflación: funcionan desde el día uno, no dependen de datos del hogar.
app.get("/api/inflation", async (c) => {
  const series = await readInflation(c.env.DB, Number(c.req.query("months") ?? 24));
  const latest = series.at(-1) ?? null;
  return c.json({
    latest,
    projectedMonthlyPct: Number(c.env.IPC_PROJECTED_MONTHLY_PCT),
    series,
  });
});

app.get("/api/fx", async (c) => c.json({ rates: await readLatestFx(c.env.DB) }));

/** Salud de los trabajos de fondo. §13.2 */
app.get("/api/ops/jobs", async (c) => c.json({ jobs: await readJobHealth(c.env.DB) }));

app.onError((err, c) => {
  // Un :id de otro hogar responde 404, no 403: no se confirma que exista (§13.3).
  if (err instanceof NotFoundInHousehold) return c.json(fail("not_found", err.message), 404);
  console.error("unhandled", err.message);
  return c.json(fail("internal", "Algo salió mal"), 500);
});

export default {
  fetch: app.fetch,
  /** Cron. Ver DEPLOY.md §5 y los límites del free tier en §9. */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { runScheduled } = await import("./scheduled.js");
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env>;

export { app };
