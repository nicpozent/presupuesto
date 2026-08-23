import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { identityKey } from "./access.js";
import { completeLogin, PKCE_COOKIE, PKCE_MAX_AGE, startLogin } from "./auth/google.js";
import {
  clearCookieHeader, cookieHeader, createSession, destroySession, readCookie,
  readSession, SESSION_COOKIE, SESSION_DAYS,
} from "./auth/session.js";
import { getHousehold, seedConnections } from "../lib/db/households.js";
import {
  createInvite, deleteInvite, getUserById, listInvites, resolveUser, type AppUser,
} from "../lib/db/users.js";
import { NotFoundInHousehold, type HouseholdContext } from "../lib/db/context.js";
import { readInflation, readJobHealth, readLatestFx } from "../lib/db/public/macro.js";
import { sign, unsign } from "./auth/session.js";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  RECEIPTS: R2Bucket;   // fotos de tickets; se usa en el paso 8 de SDD §14 (OCR)
  APP_URL: string;
  /** Público. El secreto va en Workers Secrets, no acá. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  DEFAULT_TIMEZONE: string;
  IPC_PROJECTED_MONTHLY_PCT: string;
}

type Vars = { user: AppUser; ctx: HouseholdContext | null };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const fail = (code: string, message: string) => ({ error: { code, message } });

// Salud: fuera de todo, para el curl del deploy.
app.get("/api/health", (c) => c.json({ ok: true, service: "brote" }));

const redirectUri = (env: Env) => `${env.APP_URL}/auth/google/callback`;

/** Arranca el login: manda a Google con PKCE. SDD §7.2 paso 1. */
app.get("/auth/google", async (c) => {
  const { authUrl, cookieValue } = await startLogin({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri: redirectUri(c.env),
    secret: c.env.SESSION_SECRET,
  });
  c.header(
    "Set-Cookie",
    `${PKCE_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=${PKCE_MAX_AGE}`,
  );
  return c.redirect(authUrl, 302);
});

/** Vuelta de Google. Valida state, canjea el código, verifica el id_token. §7.2 paso 3. */
app.get("/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json(fail("validation", "Falta code o state"), 422);

  const r = await completeLogin({
    code,
    stateFromQuery: state,
    cookieValue: readCookie(c.req.header("Cookie"), PKCE_COOKIE),
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    redirectUri: redirectUri(c.env),
    secret: c.env.SESSION_SECRET,
  });
  if (!r.ok) {
    console.warn("login rechazado:", r.reason);
    return c.json(fail("unauthenticated", "No pudimos validar el ingreso"), 401);
  }

  // §7.2 paso 4: el usuario se crea o se busca por su identidad estable, no por mail.
  const user = await resolveUser(c.env.DB, r.identity);
  const sid = await createSession(c.env.DB, user.id, c.req.header("User-Agent") ?? null);
  const signed = await sign(sid, c.env.SESSION_SECRET);

  c.header("Set-Cookie", cookieHeader(signed, SESSION_DAYS * 86400), { append: true });
  c.header("Set-Cookie", `${PKCE_COOKIE}=; Path=/auth; Max-Age=0`, { append: true });
  return c.redirect("/", 302);
});

/** §7.2 paso 6: borra la fila y la cookie. La fila es la que permite revocar. */
app.post("/auth/logout", async (c) => {
  const raw = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  if (raw) {
    const sid = await unsign(raw, c.env.SESSION_SECRET);
    if (sid) await destroySession(c.env.DB, sid);
  }
  c.header("Set-Cookie", clearCookieHeader());
  return c.body(null, 204);
});

/** La sesión manda: la cookie trae el id firmado y la fila de D1 decide si vale. */
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const raw = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  if (!raw) return c.json(fail("unauthenticated", "Entrá con Google"), 401);
  const sid = await unsign(raw, c.env.SESSION_SECRET);
  if (!sid) return c.json(fail("unauthenticated", "Sesión inválida"), 401);
  const session = await readSession(c.env.DB, sid);
  if (!session) return c.json(fail("unauthenticated", "La sesión venció"), 401);

  const user = await getUserById(c.env.DB, session.userId);
  if (!user) return c.json(fail("unauthenticated", "El usuario ya no existe"), 401);
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
