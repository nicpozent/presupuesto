/**
 * Google OAuth 2.0 + PKCE, dentro del Worker. SDD §7.2.
 *
 * Diferencia con lo que decía el §7.2 original: el `state` y el `code_verifier` no
 * van a KV, van en una cookie firmada de vida corta. Es una escritura menos por
 * login —el plan gratuito da 1.000 de KV por día— y una pieza menos de
 * infraestructura. La propiedad que importa es la misma: el callback no puede
 * aceptar un `state` que este servidor no emitió.
 */
import { bytesToB64url, verifyRs256 } from "./jwks.js";
import { sign, unsign } from "./session.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = ["https://accounts.google.com", "accounts.google.com"];

export const PKCE_COOKIE = "brote_pkce";
export const PKCE_MAX_AGE = 600; // 10 minutos, como el TTL que pedía §7.2

const rand = (bytes = 32): string => bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)));

const sha256 = async (s: string): Promise<string> =>
  bytesToB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

export interface PkceStart {
  authUrl: string;
  /** Valor ya firmado para la cookie. */
  cookieValue: string;
}

/** Paso 1: arma la URL de Google y el sobre firmado con state + verifier + nonce. */
export async function startLogin(opts: {
  clientId: string;
  redirectUri: string;
  secret: string;
}): Promise<PkceStart> {
  const state = rand(16);
  const verifier = rand(32);
  const nonce = rand(16);
  const challenge = await sha256(verifier);

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  // Solo identidad. Nada de Gmail ni Drive (CLAUDE.md, §7.2 paso 2).
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // No pedimos offline_access: sin refresh token que guardar (§7.2).
  url.searchParams.set("prompt", "select_account");

  return {
    authUrl: url.toString(),
    cookieValue: await sign(JSON.stringify({ state, verifier, nonce }), opts.secret),
  };
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

export type CallbackResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; reason: string };

/** Paso 3: valida el state, canjea el código y verifica el id_token. */
export async function completeLogin(opts: {
  code: string;
  stateFromQuery: string;
  cookieValue: string | null;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  secret: string;
}): Promise<CallbackResult> {
  if (!opts.cookieValue) return { ok: false, reason: "sin_cookie_pkce" };
  const raw = await unsign(opts.cookieValue, opts.secret);
  if (!raw) return { ok: false, reason: "cookie_pkce_invalida" };

  let env: { state: string; verifier: string; nonce: string };
  try {
    env = JSON.parse(raw) as typeof env;
  } catch {
    return { ok: false, reason: "cookie_pkce_ilegible" };
  }
  // El state del query tiene que ser el que emitimos: esto corta el CSRF de login.
  if (env.state !== opts.stateFromQuery) return { ok: false, reason: "state_no_coincide" };

  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code_verifier: env.verifier,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return { ok: false, reason: `canje_fallido_${res.status}` };
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) return { ok: false, reason: "sin_id_token" };

  const verified = await verifyRs256(tok.id_token, GOOGLE_JWKS);
  if (!verified) return { ok: false, reason: "firma_invalida" };

  const p = verified.payload as {
    iss?: string; aud?: string; exp?: number; nonce?: string;
    sub?: string; email?: string; email_verified?: boolean; name?: string;
  };
  // iss, aud, exp y nonce. Los cuatro o nada (§7.2 paso 3).
  if (!p.iss || !GOOGLE_ISS.includes(p.iss)) return { ok: false, reason: "iss" };
  if (p.aud !== opts.clientId) return { ok: false, reason: "aud" };
  if (typeof p.exp !== "number" || p.exp * 1000 <= Date.now()) return { ok: false, reason: "exp" };
  if (p.nonce !== env.nonce) return { ok: false, reason: "nonce" };
  if (!p.sub || !p.email) return { ok: false, reason: "claims_incompletos" };
  // Un mail sin verificar en Google no alcanza para ser identidad.
  if (p.email_verified === false) return { ok: false, reason: "email_sin_verificar" };

  return { ok: true, identity: { sub: p.sub, email: p.email, name: p.name } };
}
