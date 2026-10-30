// SPDX-License-Identifier: AGPL-3.0-only
//
// Repo invariant: every CSV this app hands to the user must be either
//   (a) generated server-side, where Go's spreadsheetSafeCSVCell already
//       applies RFC-4180 quoting + the formula guard, or
//   (b) built through the shared toCsv/safeCsvCell helpers, which port those
//       exact semantics to the browser.
//
// A unit test on toCsv cannot catch the real failure mode. Every defect found
// in this codebase was a call site that hand-rolled its rows while a correct
// helper sat unused one import away: coupon-pool codes, subscriber import
// errors, inbox-reality reports, and billing usage. Discount redemption export
// is intentionally absent from the sanitized archive boundary.
// Reading found two of those; this test found the rest, and fails on the next.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const EXTS = new Set([".ts", ".tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

/** Files that download something whose filename ends in .csv. */
function csvDownloadSites(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    if (file.includes("__tests__")) continue;
    const src = readFileSync(file, "utf8");
    if (!/downloadTextFile\s*\(/.test(src)) continue;
    if (!/\.csv/.test(src)) continue;
    hits.push(file);
  }
  return hits;
}

// Text that looks like a CSV row being assembled by hand, rather than through
// the guarded builder: fields joined on a bare comma, or interpolated into a
// template with commas between them.
// Inside a file that downloads a .csv, ANY join on a bare comma is row
// assembly — the receiver-scoped forms ([...] / map(...) / a plain identifier)
// are all the same defect, so match the join itself rather than what precedes
// it. `${a},${b}` is the template-literal spelling of the same thing.
const HAND_ROLLED_ROW = [/\.join\(\s*","\s*\)/, /\}\s*,\s*\$\{/];

describe("CSV export contract", () => {
  it("every CSV download is server-generated or built through the guarded helper", () => {
    const offenders: string[] = [];

    for (const file of csvDownloadSites()) {
      const src = readFileSync(file, "utf8");

      // Exempting by *name* does not work: an earlier version of this test
      // waved through anything matching /Csv\(/, which would have covered a
      // hand-rolled client-side builder purely because of what it was called.
      // So detect the hand-rolling itself, and require the guard only then.
      const usesHelper = /\b(toCsv|safeCsvCell|csvCell)\s*\(/.test(src);
      const assemblesRows = HAND_ROLLED_ROW.some((p) => p.test(src));

      if (usesHelper || !assemblesRows) continue;
      offenders.push(relative(process.cwd(), file));
    }

    expect(offenders).toEqual([]);
  });

  it('no client-side CSV row is assembled with a naive join(",")', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      if (file.includes("__tests__")) continue;
      const src = readFileSync(file, "utf8");
      if (!/\.csv/.test(src)) continue;
      // A row assembled by joining fields on a bare comma bypasses both the
      // RFC-4180 quoting and the formula guard.
      if (/\]\s*\.join\(","\)/.test(src)) {
        offenders.push(relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
