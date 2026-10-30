// SPDX-License-Identifier: AGPL-3.0-only
//
// Ten legal pages ship, and every one of them was substantive — but the
// marketing footer's "Legal" column linked only to /roadmap and /security.
// Across the whole marketing surface, /legal/* appeared in exactly two other
// places: the cookie banner (→ /legal/cookies) and /security (→ the DPA and
// sub-processor register). The Privacy Policy, Terms, Refund Policy and AUP
// were reachable from no marketing page at all, and there is no /legal index
// to land on either.
//
// That is not a cosmetic nav gap. Terms §17 rests on "continued use
// constitutes acceptance", §10 defers refunds to the Refund Policy, and the
// payment processors named in these documents expect linked Terms and Privacy.
// A policy nobody can reach cannot do any of that work.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const MARKETING = join(SRC, "app/(marketing)");
const LAYOUT = readFileSync(join(MARKETING, "layout.tsx"), "utf8");

/** Legal pages that ship, by slug. */
function legalSlugs(): string[] {
  const dir = join(MARKETING, "legal");
  return readdirSync(dir).filter((entry) =>
    statSync(join(dir, entry)).isDirectory(),
  );
}

// The policies a reader must be able to find from any page. Deliberately not
// every slug: dpia and account-deletion are reached contextually from the
// documents that cite them, and affiliate-terms applies only to affiliates.
const MUST_BE_IN_FOOTER = [
  "privacy",
  "terms",
  "cookies",
  "refund",
  "aup",
  "dpa",
];

describe("legal page reachability", () => {
  it("finds the legal pages", () => {
    // Guard the guard: an empty read would make the assertions below vacuous.
    expect(legalSlugs().length).toBeGreaterThan(5);
  });

  it("links the core policies from the shared marketing footer", () => {
    const missing = MUST_BE_IN_FOOTER.filter(
      (slug) => !LAYOUT.includes(`/legal/${slug}"`),
    );
    expect(missing).toEqual([]);
  });

  it("does not describe the published legal pages as unavailable", () => {
    // /pricing said "Public legal documents and paid checkout remain
    // unavailable" and /about said "public legal terms … remain closed", while
    // ten legal pages ship as indexed, linkable documents. /security states it
    // correctly: they are published working drafts pending counsel review.
    //
    // The contradiction got sharper once the footer began linking them: a
    // reader can click Privacy Policy and then be told it does not exist.
    // What is genuinely unavailable is a *binding* agreement, not the pages.
    const offenders: string[] = [];
    for (const slug of ["pricing", "about"]) {
      const text = readFileSync(
        join(MARKETING, slug, "page.tsx"),
        "utf8",
      ).replace(/\s+/g, " ");
      if (
        /public legal (documents|terms)[^.]{0,60}(unavailable|remain closed)/i.test(
          text,
        )
      ) {
        offenders.push(slug);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only lists footer targets that exist", () => {
    const slugs = new Set(legalSlugs());
    const linked = [...LAYOUT.matchAll(/"\/legal\/([a-z-]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(linked.length).toBeGreaterThan(0);
    const dangling = [...new Set(linked)].filter((slug) => !slugs.has(slug));
    expect(dangling).toEqual([]);
  });
});
