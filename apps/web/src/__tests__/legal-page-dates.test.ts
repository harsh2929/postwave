// SPDX-License-Identifier: AGPL-3.0-only
//
// A legal page states when it was last updated, and readers rely on that date
// to know which version they agreed to. Three pages stated two different ones:
// the DPA, Privacy Policy and Terms each said "Last updated: 2026-06-02" in
// the header and "Last updated: 2026-04-30" in the closing note.
//
// A line-oriented grep does not catch this — the footer wraps as
//
//     This is a working draft pending counsel review. Last updated:
//     2026-04-30.
//
// so the label and the date sit on different lines. Whitespace is collapsed
// here before matching, which is what surfaced it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { LEGAL_FACTS_VERSION } from "@/lib/legal/infrastructure";

const LEGAL = resolve(process.cwd(), "src/app/(marketing)/legal");

function legalPages(): { slug: string; text: string }[] {
  return readdirSync(LEGAL)
    .filter((entry) => statSync(join(LEGAL, entry)).isDirectory())
    .map((slug) => ({
      slug,
      // Collapse whitespace so a wrapped "Last updated:\n  2026-04-30" reads
      // the same as an inline one.
      text: readFileSync(join(LEGAL, slug, "page.tsx"), "utf8").replace(
        /\s+/g,
        " ",
      ),
    }));
}

function statedDates(text: string): string[] {
  const literalDates = [
    ...text.matchAll(/Last updated:\s*(\d{4}-\d{2}-\d{2})/g),
  ].map((match) => match[1]!);
  const canonicalDates = /Last updated:\s*\{LEGAL_FACTS_VERSION\}/u.test(text)
    ? [LEGAL_FACTS_VERSION]
    : [];
  return [...new Set([...literalDates, ...canonicalDates])];
}

describe("legal page revision dates", () => {
  const pages = legalPages();

  it("finds the legal pages", () => {
    // Guard the guard: an empty directory read would pass everything below.
    expect(pages.length).toBeGreaterThan(5);
  });

  it("states one last-updated date per document", () => {
    const conflicts = pages
      .map((p) => ({ slug: p.slug, dates: statedDates(p.text) }))
      .filter((p) => p.dates.length > 1)
      .map((p) => `${p.slug}: ${p.dates.sort().join(" vs ")}`);
    expect(conflicts).toEqual([]);
  });

  it("dates every policy that binds the reader", () => {
    // affiliate-terms carries no date at all. It is listed here rather than
    // silently skipped so the gap stays visible; remove it from the allowance
    // once the page is dated.
    const UNDATED_ALLOWANCE = new Set(["affiliate-terms"]);
    const undated = pages
      .filter((p) => statedDates(p.text).length === 0)
      .map((p) => p.slug)
      .filter((slug) => !UNDATED_ALLOWANCE.has(slug));
    expect(undated).toEqual([]);
  });

  it("names the paid tiers the way the price list does", () => {
    // The Terms and Refund Policy called the $29 tier "Sending"; the price
    // list — and the checkout a customer actually goes through — calls it
    // "Cloud Sending". A contract that names a tier differently from the
    // thing purchased is hard to map to the purchase.
    const tiers = readFileSync(
      resolve(process.cwd(), "src/lib/pricing.ts"),
      "utf8",
    );
    const names = [...tiers.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toContain("Cloud Sending");
    expect(names).not.toContain("Sending");

    // "Sending" as a standalone product name — not preceded by Cloud/Pro and
    // not the ordinary verb ("managed sending", "before sending").
    const offenders = pages
      .filter((p) =>
        /(?<!Cloud |Pro |managed |recurring |before |any )\bSending (?:tiers?|\(\$)/.test(
          p.text,
        ),
      )
      .map((p) => p.slug);
    expect(offenders).toEqual([]);
  });
});
