import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * §13.3 — el mecanismo, no la intención.
 * "Toda query filtra por household_id" es una intención hasta que algo la hace
 * cumplir. Este test es feo y vale lo que cuesta.
 */
const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const tsFiles = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));

describe("aislamiento por hogar", () => {
  it("nadie usa env.DB / c.env.DB fuera de src/lib/db y src/worker", () => {
    const offenders = tsFiles.filter((f) => {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (rel.startsWith("lib/db/") || rel.startsWith("worker/")) return false;
      return /\benv\.DB\b/.test(readFileSync(f, "utf8"));
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("el cliente no toca D1 ni bindings del Worker", () => {
    const offenders = tsFiles
      .filter((f) => relative(SRC, f).replace(/\\/g, "/").startsWith("client/"))
      .filter((f) => /\b(D1Database|KVNamespace|R2Bucket)\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("toda función de src/lib/db recibe el contexto primero", () => {
    const bad: string[] = [];
    for (const f of tsFiles) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (!rel.startsWith("lib/db/") || rel.includes("/public/") || rel.endsWith("context.ts")) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/export async function (\w+)\(([^)]*)/g)) {
        const [, name, args] = m;
        // resolveUser es la excepción declarada: corre ANTES de que haya hogar (§7.1.1)
        if (name === "resolveUser") continue;
        if (!/^\s*ctx\s*:/.test(args)) bad.push(`${rel}:${name}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("las hijas de watched_items nunca se consultan solo por item_id", () => {
    // item_prices, item_urls, item_alternatives y price_fetch_log no tienen
    // household_id: llegan al hogar por su padre. Ver §3 y §13.3.
    const CHILD = /(item_prices|item_urls|item_alternatives|price_fetch_log)/;
    const offenders: string[] = [];
    for (const f of tsFiles) {
      const src = readFileSync(f, "utf8");
      if (!CHILD.test(src)) continue;
      // una query a una hija tiene que nombrar watched_items o household_id
      for (const stmt of src.split(/`/)) {
        if (!CHILD.test(stmt) || !/\b(select|insert|update|delete)\b/i.test(stmt)) continue;
        if (!/watched_items|household_id/.test(stmt)) {
          offenders.push(`${relative(SRC, f)}: ${stmt.trim().slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
