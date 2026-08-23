import { describe, expect, it } from "vitest";
import { clearCookieHeader, cookieHeader, readCookie, sign, unsign } from "./session.js";

const SECRET = "un-secreto-de-prueba-largo-y-aleatorio";

describe("cookie de sesión firmada (SDD §7.2)", () => {
  it("una firma válida devuelve el valor", async () => {
    const signed = await sign("s_abc123", SECRET);
    expect(await unsign(signed, SECRET)).toBe("s_abc123");
  });

  it("un id inventado no pasa: es el punto de la firma", async () => {
    expect(await unsign("s_inventado.firmafalsa", SECRET)).toBeNull();
  });

  it("una cookie firmada con otro secreto no pasa", async () => {
    const signed = await sign("s_abc123", "otro-secreto");
    expect(await unsign(signed, SECRET)).toBeNull();
  });

  it("manosear el valor invalida la firma", async () => {
    const signed = await sign("s_abc123", SECRET);
    const tampered = signed.replace("s_abc123", "s_abc124");
    expect(await unsign(tampered, SECRET)).toBeNull();
  });

  it("la cookie sale HttpOnly, Secure y SameSite=Lax", async () => {
    const h = cookieHeader(await sign("s_1", SECRET), 3600);
    expect(h).toContain("HttpOnly");
    expect(h).toContain("Secure");
    expect(h).toContain("SameSite=Lax");
    expect(h).toContain("Path=/");
  });

  it("el logout manda una cookie que expira ya", () => {
    expect(clearCookieHeader()).toContain("Max-Age=0");
  });

  it("lee la cookie de entre varias", () => {
    expect(readCookie("otra=1; brote_session=abc.def; tercera=3", "brote_session")).toBe("abc.def");
    expect(readCookie(undefined, "brote_session")).toBeNull();
    expect(readCookie("otra=1", "brote_session")).toBeNull();
  });
});
