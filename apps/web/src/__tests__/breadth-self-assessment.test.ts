// SPDX-License-Identifier: AGPL-3.0-only
//
// /vs is the competitor-comparison hub. Its own header comment sets the rule:
// "Moosewave self-assessment stays conservative on competitor facts." Three
// cells broke it, each contradicting the capability page it links to:
//
//   * Ad-audience sync said "Yes" for Meta + Google + TikTok + LinkedIn + Snap
//     while /audiences says four of those five have "live certification still
//     gating promotion" — and MailerLite is marked "Partial" on this very row
//     for the same Meta-only state.
//   * Landing pages said "Yes" while /landing-pages says the block editor,
//     custom domains, SEO controls and metrics "are being staged" and the
//     dashboard "does not present them until the editor and publish flow are
//     enabled".
//   * Commerce said "Yes" while every connector is RuntimePartial in the
//     integration catalog and /commerce gates live store activation.
//
// Scoring ourselves on a softer scale than the competitors in the same table
// is the specific failure this guards.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const VS = readFileSync(join(SRC, "app/(marketing)/vs/page.tsx"), "utf8");

/** dimension → Moosewave's own cell value. */
function postwaveCells(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of VS.matchAll(
    /dimension:\s*"([^"]+)",[\s\S]*?postwave:\s*"([^"]+)"/g,
  )) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

const page = (slug: string): string =>
  readFileSync(join(SRC, `app/(marketing)/${slug}/page.tsx`), "utf8");

describe("/vs Moosewave self-assessment", () => {
  const cells = postwaveCells();

  it("parses the breadth matrix", () => {
    // Guard the guard: a restructured table would otherwise pass vacuously.
    expect(cells.size).toBeGreaterThan(4);
  });

  it("does not claim Yes where the capability page says staged or gated", () => {
    const HEDGED: { dimension: string; slug: string; hedge: RegExp }[] = [
      {
        dimension: "Ad-audience sync",
        slug: "audiences",
        hedge: /gating promotion/i,
      },
      {
        dimension: "Landing pages",
        slug: "landing-pages",
        hedge: /being staged|does not present them until/i,
      },
      {
        dimension: "Commerce integrations",
        slug: "commerce",
        hedge: /remains gated on/i,
      },
    ];
    const offenders: string[] = [];
    for (const { dimension, slug, hedge } of HEDGED) {
      if (!hedge.test(page(slug))) continue; // page no longer hedges — Yes is fair
      if (cells.get(dimension) === "Yes") {
        offenders.push(`${dimension}: "Yes" but /${slug} still hedges`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scores push by the same rule it applies to competitors", () => {
    // The Push row disqualifies Mailchimp with "admin-app alerts to the
    // marketer, not a customer-facing channel". /sms describes Moosewave's push
    // as exactly that — "Operational alerts, straight to your phone", relayed
    // to the marketer's own first-party device. If our push is still
    // operational-only, our cell cannot outrank Mailchimp's on this row.
    const sms = page("sms");
    const operationalOnly =
      /Operational alerts/i.test(sms) &&
      !/customer-facing push|push campaign|push broadcast/i.test(sms);
    if (!operationalOnly) return; // a real push channel shipped — cell is free

    const RANK: Record<string, number> = { No: 0, Roadmap: 1, Partial: 2, Yes: 3 };
    const mailchimpPush = /dimension: "Push notifications"[\s\S]*?mailchimp:\s*"([^"]+)"/.exec(
      VS,
    )?.[1];
    expect(mailchimpPush).toBeTruthy();
    expect(RANK[cells.get("Push notifications")!]).toBeLessThanOrEqual(
      RANK[mailchimpPush!]!,
    );
  });

  it("keeps every commerce connector's claim within its catalog status", () => {
    const catalog = readFileSync(
      join(REPO, "apps/api/internal/integrations/catalog.go"),
      "utf8",
    );
    const partial = ["shopify", "woocommerce", "bigcommerce", "wix", "square"]
      .filter((slug) =>
        new RegExp(`item\\("${slug}"[^)]*RuntimePartial`).test(catalog),
      );
    // If they are all still partial, our commerce cell must not read "Yes".
    if (partial.length === 5) {
      expect(cells.get("Commerce integrations")).not.toBe("Yes");
    }
  });
});
