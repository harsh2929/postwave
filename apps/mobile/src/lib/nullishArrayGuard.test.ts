/**
 * `?? []` must not stand in for a type check on data that is then iterated.
 *
 * ── THE DEFECT THIS EXISTS TO STOP ─────────────────────────────────────────
 * `??` is a NULLISH coalescer. It substitutes only for `null` and `undefined`,
 * and passes every other value through — including truthy non-arrays, which is
 * exactly what a wire payload produces when something upstream is wrong:
 *
 *   - Go's `omitempty` drops a list and a sibling object arrives in its place;
 *   - a handler returns a paged `{items: [], total: 0}` where a bare array was
 *     expected (or the reverse — both have happened here);
 *   - a reverse proxy answers 200 text/html for an absent upstream, and the
 *     client parses a DOCUMENT into the slot. Seen live on 2026-08-19: an HTML
 *     page became `MigrationJob[]` and the screen rendered 1,293 rows, one per
 *     character.
 *
 * FOURTEEN components in this codebase carried this identical defect, found by
 * mounting them for the first time. It was never fourteen mistakes — it is ONE
 * idiom that reads as "default to empty" and actually means "default to empty
 * only if null or undefined". Every author reached for it and every one was
 * wrong the same way, so a guard beats fixing the fifteenth by hand.
 *
 * ── WHAT IS AND IS NOT FLAGGED ─────────────────────────────────────────────
 * Only `?? []` that is IMMEDIATELY iterated — `(x ?? []).map(...)` — or bound
 * to a name that is iterated later in the same file. `?? []` on a value that is
 * merely passed along, stored, or spread is untouched: it is not making a claim
 * about the value's type.
 *
 * Node-run: no react-native imports.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/u.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, "..", "..");
const FILES = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app"))];

const ITERATORS =
  "map|filter|forEach|reduce|flatMap|some|every|find|findIndex|sort|join|" +
  "slice|concat|includes|indexOf|at|reverse|entries|keys|values";

/**
 * `for (const x of <wire> ?? [])` — for-of is an iteration too, and it was the
 * shape that survived the first sweep: `?? []` admits a truthy non-array and
 * for-of throws "object is not iterable" before the loop body runs once.
 */
const FOR_OF = /for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+([^)]*?)\s*\?\?\s*\[\]\s*\)/gu;

/**
 * Only WIRE-derived values are flagged.
 *
 * `?? []` on a prop typed `T[] | undefined` is safe — TypeScript guarantees the
 * runtime type, so the coalesce is doing exactly what it says. The defect is
 * `?? []` standing in for a type check on a value whose runtime shape NOTHING
 * guarantees: a query result, a parsed response body, a nested wire field.
 * Flagging both would make this guard something to argue with rather than obey.
 */
const WIRE = /\.data\b|\.rows\b|response|payload|body\b/u;

/** `(x ?? []).map(` — the coalesce and the iteration in one expression. */
const INLINE = new RegExp(
  `\\(([^()]*?)\\s*\\?\\?\\s*\\[\\]\\)\\s*\\.\\s*(?:${ITERATORS})\\s*\\(`,
  "gu",
);

/** `const rows = x ?? []` … later `rows.map(` in the same file. */
function boundThenIterated(src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;\n]*\?\?\s*\[\]\s*;/gu)) {
    const name = m[1]!;
    if (!WIRE.test(m[0])) continue;
    const used = new RegExp(`\\b${name}\\s*\\.\\s*(?:${ITERATORS})\\s*\\(`, "u");
    if (used.test(src)) hits.push(`${name} = … ?? []`);
  }
  return hits;
}

/**
 * `rows={x.data ?? []}` — a JSX prop is a hand-off, and the child iterates what
 * it is given. The nullish guard makes the PARENT look careful while passing
 * the child exactly the value that breaks it.
 */
/**
 * `[...(x ?? [])]` — a spread is an iteration too, and throws "is not iterable"
 * on a truthy non-array exactly like for-of.
 */
const SPREAD = /\[\s*\.\.\.\s*\(?\s*([^\]()]*?)\s*\?\?\s*\[\]\s*\)?\s*[,\]]/gu;

const JSX_PROP = /(\w+)=\{([^{}]*?)\s*\?\?\s*\[\]\}/gu;

describe("`?? []` never guards an iteration", () => {
  it("finds source files at all (guards an empty scan)", () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it("still sees the iterator idioms it is looking for", () => {
    // Floor: if the codebase stopped using .map entirely, the scan above
    // would pass by scanning for something that no longer exists.
    const iterating = FILES.filter((f) =>
      new RegExp(`\\.\\s*(?:${ITERATORS})\\s*\\(`, "u").test(readFileSync(f, "utf8")),
    );
    expect(iterating.length).toBeGreaterThan(100);
  });

  it("flags no `?? []` that feeds an iteration", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      const rel = f.slice(ROOT.length + 1);
      for (const m of src.matchAll(INLINE)) {
        if (WIRE.test(m[1] ?? "")) offenders.push(`${rel} -> (${(m[1] ?? "").trim()} ?? []).map(...)`);
      }
      for (const m of src.matchAll(SPREAD)) {
        if (WIRE.test(m[1] ?? "")) {
          offenders.push(`${rel} -> [...(${(m[1] ?? "").trim()} ?? [])]`);
        }
      }
      for (const m of src.matchAll(JSX_PROP)) {
        if (WIRE.test(m[2] ?? "")) {
          offenders.push(`${rel} -> ${m[1]}={${(m[2] ?? "").trim()} ?? []}`);
        }
      }
      for (const m of src.matchAll(FOR_OF)) {
        if (WIRE.test(m[1] ?? "")) {
          offenders.push(`${rel} -> for (… of ${(m[1] ?? "").trim()} ?? [])`);
        }
      }
      for (const h of boundThenIterated(src)) offenders.push(`${rel} -> ${h}`);
    }
    expect(
      offenders,
      "`??` substitutes only for null/undefined, so a TRUTHY non-array from the wire " +
        "(a paged envelope, an omitempty sibling, an HTML SPA fallback) goes straight " +
        "into the iteration and throws. Use Array.isArray(x) ? x : [] instead.",
    ).toEqual([]);
  });
});
