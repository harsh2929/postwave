/**
 * `?? []` must never be the only thing standing between wire data and an
 * iteration.
 *
 * `??` is a NULLISH guard: it catches null and undefined and NOTHING else. A
 * truthy non-array goes straight past it into `.map`/spread/for-of and throws
 * "is not a function" or "is not iterable" — and every one of these is a shape
 * a Go handler legitimately produces:
 *
 *   {}                  `omitempty` dropped the list
 *   {items: [], total}  a paged envelope where a bare array was expected
 *   "<!doctype html>"   an SPA fallback for an absent upstream
 *
 * The same sweep on apps/mobile hardened 71 sites and turned up 14 live
 * crashes. One of them read `.length` off an HTML document that had been typed
 * as an array and rendered 1,293 phantom rows. This sweep hardened 109 more
 * here.
 *
 * Five shapes, because the mobile guard shipped catching only the first and a
 * later pass found the other four still live.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx?$/u.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, "..");
const FILES = walk(ROOT);

/** Names that mean "this came off the wire". */
const WIRE = /\b(?:data|rows|payload|response|body|items|result|list|entries)\b/iu;

const SHAPES: [string, RegExp][] = [
  ["const binding", /(?:const|let)\s+[\w$]+\s*(?::[^=]+?)?=\s*([^;\n]*?)\s*\?\?\s*\[\]/gu],
  [
    "inline iteration",
    /\(\s*([^()]*?)\s*\?\?\s*\[\]\s*\)\s*\.\s*(?:map|filter|forEach|reduce|slice|some|every|find|sort|flatMap)\(/gu,
  ],
  ["for-of", /for\s*\(\s*const\s+[\w$]+\s+of\s*\(?\s*([^()]*?)\s*\?\?\s*\[\]/gu],
  ["spread", /\[\s*\.\.\.\s*\(?\s*([^\]()]*?)\s*\?\?\s*\[\]/gu],
  ["JSX prop", /[\w$]+=\{\s*([^{}]*?)\s*\?\?\s*\[\]\s*\}/gu],
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

describe("nullish array guard", () => {
  it("scans a real corpus (guards a vacuous pass)", () => {
    expect(FILES.length).toBeGreaterThan(500);
    const isArrayUses = FILES.reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/Array\.isArray\(/gu) ?? []).length,
      0,
    );
    // The codemod introduced ~109; if this collapses, the sweep was reverted.
    expect(isArrayUses).toBeGreaterThan(80);
    // A whole-source read; under a loaded machine it has taken 6 s.
  }, 60_000);

  it("never guards a wire-shaped iteration with `?? []` alone", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const [label, re] of SHAPES) {
        for (const m of src.matchAll(re)) {
          const expr = (m[1] ?? "").trim();
          if (!expr || !WIRE.test(expr)) continue;
          offenders.push(`${f.slice(ROOT.length + 1)} [${label}] ${expr}`);
        }
      }
    }
    expect(
      offenders,
      "`?? []` catches null/undefined only; a truthy non-array from the wire ({}, a paged envelope, an HTML fallback) passes straight through into the iteration and throws. Use Array.isArray(x) ? x : [].",
    ).toEqual([]);
  }, 60_000);
});
