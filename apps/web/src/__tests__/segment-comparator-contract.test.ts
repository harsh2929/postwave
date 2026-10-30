// SPDX-License-Identifier: AGPL-3.0-only
//
// Segments decide who receives a send, so the comparator vocabulary is the
// highest-consequence contract in the dashboard: a predicate that compiles to
// the wrong SQL does not error, it mails the wrong people.
//
// Two independent properties, and the second is what makes the first safe.
//
// 1. Every comparator the builder offers is one segments/compile.go handles.
//    The picker exposes fourteen across four field kinds; all fourteen are
//    covered today.
//
// 2. Every comparator switch in the compiler FAILS CLOSED. All of them end in
//    `default: return "", fmt.Errorf("segments: unknown/unsupported comparator
//    …")`. That is the property worth protecting: a default that fell through
//    to "match everything" or "match nothing" would turn an unrecognised
//    comparator into a silently wrong audience, and no test of the UI
//    vocabulary would notice.
//
// Deliberately not asserted: which switch a given field kind routes to. That
// mapping is the compiler's business, and property 2 means guessing wrong
// produces an error rather than a mis-targeted send.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPILE = readFileSync(
  resolve(process.cwd(), "../../apps/api/internal/segments/compile.go"),
  "utf8",
);
const PICKER = readFileSync(
  resolve(process.cwd(), "src/components/segments/comparator-picker.tsx"),
  "utf8",
);

/** Comparators the picker offers, across every field kind. */
function offered(): string[] {
  const values = [...PICKER.matchAll(/\{\s*value:\s*"([a-z_]+)"/g)].map(
    (m) => m[1]!,
  );
  return [...new Set(values)];
}

/** Every string literal any `case` in compile.go matches on. */
function handled(): Set<string> {
  const out = new Set<string>();
  for (const m of COMPILE.matchAll(/case ((?:"[^"]+"(?:,\s*)?)+):/g)) {
    for (const v of m[1]!.matchAll(/"([^"]+)"/g)) out.add(v[1]!);
  }
  return out;
}

describe("segment comparator vocabulary", () => {
  it("reads both sides", () => {
    // Guard the guard: an empty picker or an unparsed compiler makes the
    // coverage check vacuously true, which reads exactly like success.
    expect(offered().length).toBeGreaterThan(8);
    expect(handled().size).toBeGreaterThan(20);
  });

  it("offers no comparator the compiler does not handle", () => {
    const known = handled();
    const unknown = offered().filter((c) => !known.has(c));
    expect(unknown.sort()).toEqual([]);
  });
});

describe("the compiler fails closed on an unknown comparator", () => {
  it("emits no SQL from any comparator switch's default branch", () => {
    // The invariant is narrower than "the default returns an error", because
    // the compiler is fail-closed three different ways and an earlier version
    // of this test flagged two correct switches:
    //
    //   * most default to `return "", fmt.Errorf("segments: unknown …")`;
    //   * the engagement switch defaults to `return "", false, nil` — the
    //     middle value is `handled`, so it delegates to another compile path
    //     rather than erroring;
    //   * the metric-window switch has no default at all: it normalises
    //     in_last_days/more_than_days_ago and leaves anything else for
    //     predicates.CompileAggregate to reject.
    //
    // What all three share, and what actually prevents a mis-targeted send, is
    // that none of them returns a SQL fragment for a comparator it did not
    // recognise.
    const lines = COMPILE.split("\n");
    const leaky: string[] = [];
    let found = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*switch\s+.*\b(comparator|Comparator|op|cmp)\b.*\{/.test(lines[i]!)) {
        continue;
      }
      found += 1;
      let depth = 0;
      for (let j = i; j < lines.length; j += 1) {
        depth += (lines[j]!.match(/\{/g) ?? []).length;
        depth -= (lines[j]!.match(/\}/g) ?? []).length;
        if (/^\s*default:/.test(lines[j]!) && j > i) {
          const tail = lines.slice(j + 1, j + 5).join("\n");
          // A returned SQL fragment is a non-empty string literal or a
          // Sprintf/concatenation in the first return of the default arm.
          const ret = /return\s+([^\n]*)/.exec(tail)?.[1] ?? "";
          const emitsSQL =
            /^\s*(?:fmt\.Sprintf\(|col\b|"[^"]+")/.test(ret) &&
            !/^\s*""\s*,/.test(ret);
          if (emitsSQL) leaky.push(`compile.go:${j + 1} → ${ret.trim().slice(0, 60)}`);
        }
        if (depth <= 0 && j > i) break;
      }
    }
    expect(found, "no comparator switch found").toBeGreaterThan(3);
    expect(leaky.sort()).toEqual([]);
  });

  it("never treats an unknown comparator as a match-all", () => {
    // The specific shape that would be catastrophic: a default that returns a
    // TRUE fragment, so an unrecognised predicate selects the whole list.
    expect(COMPILE).not.toMatch(/default:\s*\n\s*return "TRUE"/);
    expect(COMPILE).not.toMatch(/default:\s*\n\s*return "1=1"/);
  });
});
