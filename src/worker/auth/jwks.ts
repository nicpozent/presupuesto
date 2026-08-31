/**
 * Verificación RS256 contra un JWKS, con WebCrypto y sin dependencias.
 *
 * Servía para el JWT de Cloudflare Access y sirve igual para el `id_token` de
 * Google (SDD §7.2 paso 3): es el mismo algoritmo y el mismo tipo de clave.
 */

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

export const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export const bytesToB64url = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const decodeJson = <T>(seg: string): T =>
  JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as T;

/** Cache en memoria del isolate: no gasta las 1.000 escrituras de KV por día. */
const cache = new Map<string, { keys: Jwk[]; at: number }>();
const TTL_MS = 3_600_000;

export async function fetchJwks(url: string): Promise<Jwk[]> {
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  cache.set(url, { keys: body.keys, at: now });
  return body.keys;
}

export interface VerifiedJwt {
  header: { alg: string; kid?: string };
  payload: Record<string, unknown>;
}

/**
 * Verifica firma y estructura. NO valida claims de negocio: eso lo hace quien
 * llama, que es el único que sabe qué `aud`, `iss` y `nonce` espera.
 */
export async function verifyRs256(token: string, jwksUrl: string): Promise<VerifiedJwt | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: { alg: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const jwk = (await fetchJwks(jwksUrl)).find((k) => k.kid === header.kid);
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
    b64urlToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return ok ? { header, payload } : null;
}
