import { useEffect, useState } from "react";

interface Me {
  user: { id: string; email: string; name: string | null; role: string | null };
  household: { id: string; name: string; palette: string; ground: string } | null;
}

type State =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "ready"; me: Me }
  | { kind: "error"; message: string };

const card: React.CSSProperties = {
  background: "var(--color-neutral-100)",
  borderRadius: "calc(var(--radius-lg) * 1.15)",
  padding: "24px 26px",
  boxShadow: "var(--shadow-sm)",
  maxWidth: 620,
};

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/me")
      .then(async (r) => {
        if (r.status === 401) return null;   // no entró todavía, no es un error
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          throw new Error(body?.error?.message ?? `Error ${r.status}`);
        }
        return r.json() as Promise<Me>;
      })
      .then((me) => setState(me ? { kind: "ready", me } : { kind: "anon" }))
      .catch((e: Error) => setState({ kind: "error", message: e.message }));
  }, []);

  return (
    <main style={{ padding: "34px 40px", maxWidth: 1180, margin: "0 auto" }}>
      <div
        style={{
          fontSize: 11.5,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          fontWeight: 700,
          color: "var(--color-neutral-600)",
        }}
      >
        Brote
      </div>
      <h1 style={{ fontSize: 32, marginTop: 6, marginBottom: 22 }}>
        Tu mes, sin el efecto inflación
      </h1>

      {state.kind === "loading" && <p style={{ color: "var(--color-neutral-700)" }}>Cargando…</p>}

      {/* 401 no es un error: es "todavía no entraste". SDD §7.2 */}
      {state.kind === "anon" && (
        <div style={card}>
          <h2 style={{ fontSize: 21, marginBottom: 6 }}>Entrá para ver tu mes</h2>
          <p style={{ color: "var(--color-neutral-700)" }}>
            Brote usa tu cuenta de Google solo para saber quién sos. No pide acceso a tu
            correo ni a tus archivos.
          </p>
          <a
            href="/auth/google"
            style={{
              display: "inline-flex", alignItems: "center", minHeight: 48,
              padding: "0 22px", borderRadius: 999, textDecoration: "none",
              background: "var(--color-accent)", color: "var(--on-accent)",
              fontWeight: 700, fontSize: "15.5px",
            }}
          >
            Entrar con Google
          </a>
        </div>
      )}

      {state.kind === "error" && (
        <div style={card}>
          <h2 style={{ fontSize: 21, marginBottom: 6 }}>No pudimos entrar</h2>
          <p style={{ color: "var(--color-neutral-700)", margin: 0 }}>{state.message}</p>
        </div>
      )}

      {/* Usuario que pasó Access y todavía no tiene hogar. SDD §7.1.1 y §12.2 */}
      {state.kind === "ready" && !state.me.household && (
        <div style={card}>
          <h2 style={{ fontSize: 21, marginBottom: 6 }}>Todavía no estás en un hogar</h2>
          <p style={{ color: "var(--color-neutral-700)" }}>
            Entraste con <strong>{state.me.user.email}</strong>, pero nadie te invitó a un hogar
            todavía. Pedile la invitación a quien lo administra: son dos pasos, el mail en la
            policy de Access y la invitación acá adentro.
          </p>
        </div>
      )}

      {state.kind === "ready" && state.me.household && (
        <div style={card}>
          <h2 style={{ fontSize: 21, marginBottom: 6 }}>{state.me.household.name}</h2>
          <p style={{ color: "var(--color-neutral-700)" }}>
            Entraste como {state.me.user.name ?? state.me.user.email}
            {state.me.user.role === "owner" ? " y administrás este hogar" : ""}. La base
            está vacía: todavía no hay ni un movimiento.
          </p>
          <p style={{ color: "var(--color-neutral-700)", marginBottom: 0 }}>
            Etapa 1 lista. Lo que sigue es Categorías y Movimientos (SDD §14, paso 2).
          </p>
        </div>
      )}
    </main>
  );
}
