/**
 * Sesión propia. SDD §7.2 paso 5.
 *
 * La cookie lleva `<sessionId>.<HMAC>`: el id sirve para buscar la fila y borrarla
 * —de ahí que se pueda revocar—, y la firma evita que alguien invente un id.
 */
import { bytesToB64url } from "./jwks.js";

export const SESSION_COOKIE = "brote_session";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

export async function sign(value: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return `${value}.${bytesToB64url(new Uint8Array(mac))}`;
}

/** Devuelve el valor si la firma es válida, null si no. Comparación en tiempo constante. */
export async function unsign(signed: string, secret: string): Promise<string | null> {
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = await sign(value, secret);
  if (expected.length !== signed.length) return null;
  let diff = 0;
  for (let k = 0; k < signed.length; k++) diff |= signed.charCodeAt(k) ^ expected.charCodeAt(k);
  return diff === 0 ? value : null;
}

export const cookieHeader = (signed: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${signed}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;

export const clearCookieHeader = (): string =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

export interface SessionRow {
  userId: string;
}

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | null,
): Promise<string> {
  const id = newId("s");
  await db
    .prepare(
      `insert into sessions (id, user_id, expires_at, user_agent)
         values (?1, ?2, datetime('now', '+${SESSION_DAYS} days'), ?3)`,
    )
    .bind(id, userId, userAgent)
    .run();
  return id;
}

/** Busca la sesión y descarta las vencidas. La fila es la que manda, no la cookie. */
export async function readSession(db: D1Database, id: string): Promise<SessionRow | null> {
  const row = await db
    .prepare(
      `select user_id as userId from sessions
        where id = ?1 and expires_at > datetime('now')`,
    )
    .bind(id)
    .first<SessionRow>();
  return row ?? null;
}

export async function destroySession(db: D1Database, id: string): Promise<void> {
  await db.prepare(`delete from sessions where id = ?1`).bind(id).run();
}

/** Barrido de vencidas, para el cron diario. */
export async function purgeExpiredSessions(db: D1Database): Promise<number> {
  const r = await db.prepare(`delete from sessions where expires_at <= datetime('now')`).run();
  return r.meta.changes ?? 0;
}
