import { describe, expect, it } from "vitest";
import { completeLogin, startLogin } from "./google.js";
import { unsign } from "./session.js";

const SECRET = "secreto-de-prueba-largo";
const OPTS = {
  clientId: "123.apps.googleusercontent.com",
  redirectUri: "https://presupuesto.nicopozza.workers.dev/auth/google/callback",
  secret: SECRET,
};

describe("§7.2 — arranque del login con PKCE", () => {
  it("pide S256 y solo scopes de identidad", async () => {
    const { authUrl } = await startLogin(OPTS);
    const u = new URL(authUrl);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(OPTS.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(OPTS.redirectUri);
  });

  it("no pide acceso offline: no hay refresh token que guardar", async () => {
    const { authUrl } = await startLogin(OPTS);
    expect(new URL(authUrl).searchParams.get("access_type")).toBeNull();
  });

  it("nunca pide Gmail ni Drive", async () => {
    const { authUrl } = await startLogin(OPTS);
    const scope = new URL(authUrl).searchParams.get("scope") ?? "";
    expect(scope).not.toMatch(/gmail|drive|calendar/i);
  });

  it("el challenge no es el verifier en claro", async () => {
    const { authUrl, cookieValue } = await startLogin(OPTS);
    const challenge = new URL(authUrl).searchParams.get("code_challenge");
    const env = JSON.parse((await unsign(cookieValue, SECRET)) as string);
    expect(challenge).not.toBe(env.verifier);
    expect(challenge).toBeTruthy();
  });

  it("cada login trae state, verifier y nonce nuevos", async () => {
    const a = JSON.parse((await unsign((await startLogin(OPTS)).cookieValue, SECRET)) as string);
    const b = JSON.parse((await unsign((await startLogin(OPTS)).cookieValue, SECRET)) as string);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("el sobre va firmado: manosearlo lo invalida", async () => {
    const { cookieValue } = await startLogin(OPTS);
    expect(await unsign(cookieValue.replace(/^./, "X"), SECRET)).toBeNull();
  });
});

describe("§7.2 — el callback rechaza antes de hablar con Google", () => {
  const base = {
    code: "4/abc",
    clientId: OPTS.clientId,
    clientSecret: "secreto",
    redirectUri: OPTS.redirectUri,
    secret: SECRET,
  };

  it("sin cookie de PKCE no sigue", async () => {
    const r = await completeLogin({ ...base, stateFromQuery: "x", cookieValue: null });
    expect(r).toEqual({ ok: false, reason: "sin_cookie_pkce" });
  });

  it("una cookie con firma inválida no sigue", async () => {
    const r = await completeLogin({ ...base, stateFromQuery: "x", cookieValue: "falso.firma" });
    expect(r).toEqual({ ok: false, reason: "cookie_pkce_invalida" });
  });

  it("un state que no emitimos no sigue: esto corta el CSRF de login", async () => {
    const { cookieValue } = await startLogin(OPTS);
    const r = await completeLogin({ ...base, stateFromQuery: "state-del-atacante", cookieValue });
    expect(r).toEqual({ ok: false, reason: "state_no_coincide" });
  });
});
