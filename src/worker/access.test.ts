import { describe, expect, it } from "vitest";
import { identityKey } from "./access.js";

describe("identidad del proveedor (SDD §7.1)", () => {
  it("con un IdP OIDC usa el sub, no el email", () => {
    expect(identityKey({ sub: "1078...", email: "martin@gmail.com" })).toBe("1078...");
  });
  it("el sub gana aunque cambie el email: la identidad no se muda", () => {
    const a = identityKey({ sub: "abc", email: "viejo@gmail.com" });
    const b = identityKey({ sub: "abc", email: "nuevo@gmail.com" });
    expect(a).toBe(b);
  });
  it("sin sub —One-time PIN— cae al email, que ahí ES la identidad", () => {
    expect(identityKey({ email: "martin@gmail.com" })).toBe("email:martin@gmail.com");
  });
  it("normaliza mayúsculas para no crear dos usuarios por el mismo mail", () => {
    expect(identityKey({ email: "Martin@Gmail.com" }))
      .toBe(identityKey({ email: "martin@gmail.com" }));
  });
  it("un sub que parece un mail no colisiona con una clave de email", () => {
    // el prefijo "email:" existe justamente para esto
    expect(identityKey({ sub: "martin@gmail.com", email: "otro@gmail.com" }))
      .not.toBe(identityKey({ email: "martin@gmail.com" }));
  });
});
