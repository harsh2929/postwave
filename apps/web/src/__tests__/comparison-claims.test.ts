// SPDX-License-Identifier: AGPL-3.0-only
//
// The /vs pages are the most claim-dense surface we publish: side-by-side
// pricing against named competitors. Two things can rot silently there.
//
// 1. Moosewave's own prices are hardcoded on all six pages with no link to
//    lib/pricing.ts. Change a tier and every comparison table keeps quoting
//    the old number — against a named competitor.
// 2. The tables carry derived arithmetic (annualized competitor cost, year-1
//    saving). Editing one figure without re-deriving the others produces a
//    table that looks authoritative and is wrong.
//
// The arithmetic here was verified by hand against all 24 rows before this
// test was written; it is a regression net, not a discovery tool. Note the
// direction handling: /vs/sendy honestly concedes that Sendy is cheaper in
// three of four rows, so a test that assumes savings always favour Moosewave
// would be wrong about the very page that is most careful.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const VS_DIR = join(SRC, "app/(marketing)/vs");

interface Row {
  page: string;
  scale: string;
  postwave: string;
  competitor: string;
  delta: string;
}

const ROW_RE =
  /\{\s*scale:\s*"([^"]*)",\s*postwave:\s*"([^"]*)",\s*competitor:\s*"([^"]*)",\s*delta:\s*"([^"]*)",?\s*\}/g;

function comparisonRows(): Row[] {
  const rows: Row[] = [];
  for (const entry of readdirSync(VS_DIR)) {
    const file = join(VS_DIR, entry, "page.tsx");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // vs/page.tsx index has no per-scale rows
    }
    for (const m of text.matchAll(ROW_RE)) {
      rows.push({
        page: entry,
        scale: m[1]!,
        postwave: m[2]!,
        competitor: m[3]!,
        delta: m[4]!,
      });
    }
  }
  return rows;
}

function money(raw: string): number {
  return Number(raw.replace(/[$,]/g, ""));
}

/** The "≈ $N" total a cell settles on, i.e. its last approximation. */
function annualTotal(cell: string): number | null {
  const all = [...cell.matchAll(/≈\s*\$([\d,]+(?:\.\d+)?)/g)];
  return all.length ? money(all[all.length - 1]![1]!) : null;
}

/** Prices offered by the canonical tier list. */
function tierPrices(): Set<string> {
  const src = readFileSync(join(SRC, "lib/pricing.ts"), "utf8");
  return new Set([...src.matchAll(/price:\s*"(\$[\d,]+)"/g)].map((m) => m[1]!));
}

describe("/vs comparison claims", () => {
  const rows = comparisonRows();

  it("finds the comparison tables", () => {
    // Guard the guard: a renamed field or restructured table would otherwise
    // make every assertion below pass by iterating an empty list.
    expect(rows.length).toBeGreaterThan(20);
    expect(tierPrices().size).toBeGreaterThan(2);
  });

  it("quotes only prices the pricing page actually offers", () => {
    const offered = tierPrices();
    const wrong: string[] = [];
    // Every Moosewave-attributed cell, not just the per-scale pricing rows —
    // the summary tables at the top of each page quote list prices too, and
    // scoping this to one table shape is how the drift would slip through.
    for (const entry of readdirSync(VS_DIR)) {
      let text: string;
      try {
        text = readFileSync(join(VS_DIR, entry, "page.tsx"), "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/postwave:\s*"([^"]*)"/g)) {
        // The headline figure in a Moosewave cell is our own list price;
        // later figures are pass-through costs (SES, VPS) that we do not set.
        const first = m[1]!.match(/\$[\d,]+/)?.[0];
        if (first && !offered.has(first)) {
          wrong.push(`${entry}: quotes ${first}, not in lib/pricing.ts`);
        }
      }
    }
    expect([...new Set(wrong)].sort()).toEqual([]);
  });

  it("supplies exactly the number of scenarios the shared copy promises", () => {
    // ComparisonPage hardcodes "Three honest scenarios where you should not
    // switch" above a variable-length array. A page with two or four would
    // silently contradict the sentence introducing it — the same shape as the
    // template-category and migration-source enumerations that drifted.
    const shared = readFileSync(
      join(SRC, "components/marketing/comparison-page.tsx"),
      "utf8",
    );
    const promised = /(\w+) honest scenarios/.exec(shared);
    expect(promised).not.toBeNull();
    const WORDS: Record<string, number> = { Two: 2, Three: 3, Four: 4 };
    const expected = WORDS[promised![1]!];
    expect(expected).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const entry of readdirSync(VS_DIR)) {
      let text: string;
      try {
        text = readFileSync(join(VS_DIR, entry, "page.tsx"), "utf8");
      } catch {
        continue;
      }
      const block = /const SCENARIOS: WhenScenario\[\] = \[(.*?)\n\];/s.exec(
        text,
      );
      if (!block) continue;
      const count = (block[1]!.match(/\n {2}\{/g) ?? []).length;
      if (count !== expected) wrong.push(`${entry}: ${count}`);
    }
    expect(wrong).toEqual([]);
  });

  it("quotes only offered prices in the shared page chrome too", () => {
    // The per-page sweep above reads `postwave:` fields. ComparisonPage's own
    // final CTA renders a price as a JSX literal — "Get Moosewave. $349" — on
    // all six pages, in a shape no field-scoped check can see. Same class of
    // miss as the native-tool count, which hid in prose, then a constant, then
    // a data row.
    const shared = readFileSync(
      join(SRC, "components/marketing/comparison-page.tsx"),
      "utf8",
    );
    const quoted = [...shared.matchAll(/\$[\d,]+/g)].map((m) => m[0]);
    expect(quoted.length).toBeGreaterThan(0); // guard the guard
    const offered = tierPrices();
    expect(quoted.filter((p) => !offered.has(p))).toEqual([]);
  });

  it("points its migration CTAs at guides that exist", () => {
    // Every comparison page renders three links to `/migrations/${slug}` built
    // from a template literal, so Next's typed routes and every static route
    // sweep in this suite are blind to them. A /vs page without a matching
    // migration guide would 404 from its own primary CTA.
    const guides = readFileSync(
      join(SRC, "app/(marketing)/migrations/[from]/page.tsx"),
      "utf8",
    );
    const block = /const DETAILS: Record<string, SourceDetail> = \{([\s\S]*?)\n\};/.exec(
      guides,
    );
    expect(block).not.toBeNull();
    const known = new Set(
      [...block![1]!.matchAll(/^ {2}"?([a-z0-9-]+)"?:\s*\{/gm)].map((m) => m[1]!),
    );
    expect(known.size).toBeGreaterThan(5); // guard the guard

    const slugs = readdirSync(VS_DIR).filter((entry) => {
      try {
        readFileSync(join(VS_DIR, entry, "page.tsx"), "utf8");
        return true;
      } catch {
        return false;
      }
    });
    expect(slugs.length).toBeGreaterThan(4); // guard the guard
    expect(slugs.filter((s) => !known.has(s)).sort()).toEqual([]);
  });

  it("states a year-1 saving that matches the two totals", () => {
    const wrong: string[] = [];
    for (const row of rows) {
      const pw = annualTotal(row.postwave);
      const comp = annualTotal(row.competitor);
      // First claim in the delta is the year-1 one.
      const claim = row.delta.match(/([A-Za-z-]+)\s*≈\s*\$([\d,]+)\+?\s*cheaper/);
      if (pw === null || comp === null || !claim) continue;

      const subject = claim[1]!;
      const amount = money(claim[2]!);
      // "Sendy ≈ $160 cheaper" reverses the direction of the comparison.
      const favoursPostwave = /^(Year-1|Moosewave)$/i.test(subject);
      const expected = favoursPostwave ? comp - pw : pw - comp;

      if (Math.abs(expected - amount) > 1.5) {
        wrong.push(
          `${row.page} [${row.scale}]: ${subject} saving should be $${expected} but says $${amount}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});
