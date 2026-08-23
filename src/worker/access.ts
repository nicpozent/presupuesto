/**
 * Validación del JWT de Cloudflare Access. SDD §7.1.
 *
 * El borde ya autenticó, pero el Worker valida igual contra el JWKS del equipo en
 * cada request: sin eso, cualquiera que llegue al Worker por otra ruta —un custom
 * domain que no pasó por Access, workers.dev sin apagar— entra sin nada.
 *
 * Sin dependencias: RS256 con WebCrypto, que es lo que hay en el runtime.
 */

export interface AccessClaims {
  sub: string;
  email: string;
  name?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const raw = atob(b64);
  // ArrayBuffer explícito: WebCrypto pide BufferSource sobre ArrayBuffer, no sobre
  // ArrayBufferLike, que incluiría SharedArrayBuffer.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const decodeJson = <T>(seg: string): T =>
  JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as T;

/**
 * El JWKS se cachea en memoria del isolate. No va a KV: el free tier tiene 1.000
 * escrituras por día (DEPLOY.md §9) y esto se resuelve solo con el ciclo de vida
 * del isolate.
 */
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 3_600_000;

async function getKeys(teamDomain: string): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: now };
  return body.keys;
}

export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string },
): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header: { alg: string; kid?: string };
  let payload: { sub?: string; email?: string; name?: string; aud?: string | string[]; exp?: number; iss?: string };
  try {
    header = decodeJson(headerSeg);
    payload = decodeJson(payloadSeg);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const keys = await getKeys(opts.teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigSeg),
    new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
  );
  if (!ok) return null;

  // aud contra CF_ACCESS_AUD, exp, iss contra el equipo. Los tres o nada.
  const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!aud.includes(opts.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${opts.teamDomain}`) return null;
  if (!payload.sub || !payload.email) return null;

  return { sub: payload.sub, email: payload.email, name: payload.name };
}
