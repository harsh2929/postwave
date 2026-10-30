// SPDX-License-Identifier: AGPL-3.0-only
//
// "Five steps from sign-up to first campaign" is written out in four places —
// the quickstart's own metadata description, its intro paragraph, the
// getting-started card, and the search index's static doc body — and nowhere
// is it derived from the STEPS array that actually renders.
//
// All four are correct today. They are checked because this exact shape has
// drifted three times already in this codebase: the native-tool count (prose,
// then a constant, then a data row), the migration-source enumeration beside a
// derived length, and the template-category list. A count a human retypes is a
// count that eventually disagrees with the thing it counts.
//
// The step number is also an explicit `n` field rather than the array index,
// so it can drift from position: insert a step without renumbering and the
// page shows 01, 02, 02, 03.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const QUICKSTART = readFileSync(
  join(SRC, "app/(docs)/docs/quickstart/page.tsx"),
  "utf8",
);

const NUMBER_WORDS: Record<string, number> = {
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

/** The rendered steps: their declared numbers, and whether each has code. */
function steps(): { n: number; hasCode: boolean }[] {
  const block = /=\s*\[([\s\S]*?)\n\];/.exec(QUICKSTART);
  if (!block) return [];
  const chunks = block[1]!.split(/\n(?= {2}\{\n)/);
  return chunks
    .filter((chunk) => /\n\s*n: \d+,/.test(chunk))
    .map((chunk) => ({
      n: Number(/\n\s*n: (\d+),/.exec(chunk)![1]),
      hasCode: /\n\s*code: \{/.test(chunk),
    }));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every published "N step" claim about the quickstart. */
function claims(): { file: string; said: number; text: string }[] {
  const found: { file: string; said: number; text: string }[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /\b(three|four|five|six|seven|eight|\d+)[- ]steps?\b/gi,
    )) {
      const raw = m[1]!.toLowerCase();
      const said = NUMBER_WORDS[raw] ?? Number(raw);
      if (!said) continue;
      // Only claims about the quickstart itself; other pages count their own
      // steps ("Setup in 3 steps" on an integration page, for instance).
      const window = text.slice(Math.max(0, m.index! - 200), m.index! + 200);
      if (!/quickstart|sign-?up to (?:a )?(?:first|delivered) campaign/i.test(window)) {
        continue;
      }
      found.push({ file: file.slice(SRC.length + 1), said, text: m[0] });
    }
  }
  return found;
}

describe("quickstart step claims", () => {
  const parsed = steps();
  const published = claims();

  it("parses the steps and finds the claims", () => {
    // Guard the guard: either side empty makes every assertion below vacuous.
    expect(parsed.length).toBeGreaterThan(2);
    expect(published.length).toBeGreaterThan(2);
  });

  it("counts what it renders", () => {
    const wrong = published
      .filter(({ said }) => said !== parsed.length)
      .map(({ file, text }) => `${file}: "${text}" but ${parsed.length} render`);
    expect([...new Set(wrong)].sort()).toEqual([]);
  });

  it("numbers the steps 1..N with no gap or repeat", () => {
    // `n` is written by hand, not taken from the index, so inserting a step
    // without renumbering shows 01, 02, 02, 03 and breaks the React key too.
    expect(parsed.map((s) => s.n)).toEqual(
      parsed.map((_, index) => index + 1),
    );
  });

  it("keeps the promise of a code example on every step", () => {
    // The getting-started card says "Code examples for every step".
    const missing = parsed.filter((s) => !s.hasCode).map((s) => s.n);
    expect(missing).toEqual([]);
  });

  it("pads the step number instead of prefixing a zero", () => {
    // `0{s.n}` renders step ten as "010". Same latent bug the migration
    // guides carried.
    expect(QUICKSTART).toContain('String(s.n).padStart(2, "0")');
    expect(QUICKSTART).not.toMatch(/>\s*0\{s\.n\}/);
  });
});
