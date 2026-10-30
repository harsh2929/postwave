// SPDX-License-Identifier: AGPL-3.0-only
//
// Compliance audit F-13 (docs/compliance/us-eu-compliance-audit-2026-09-05.md):
// the site has TWO publication gates and nothing made them agree.
//
//   POSTWAVE_PUBLIC_RELEASE_APPROVAL   → robots.ts + middleware: the site
//                                         becomes indexable and public
//   (marketing)/legal/layout.tsx        → every /legal/* page 404s
//
// The second was unconditional, so approving the first published a site whose
// cookie banner, footer, and sign-in screens all link to 404s — including the
// "Cookie Policy" link a visitor follows before deciding whether to accept.
// GDPR Art. 4(11)/Art. 7 require consent to be informed, and the banner writes
// the resulting decision to the server consent ledger either way.
//
// These tests pin three properties:
//   1. the legal gate still fails CLOSED by default (the counsel decision is
//      preserved, not weakened),
//   2. the two gates cannot be configured into the contradictory state, and
//   3. every internal /legal/* link actually resolves to a page — so a typo or
//      a deleted page is caught whether or not the gate is open.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  legalPublicationApproved,
  publicationGateConflict,
} from "@/lib/legal-publication";
import { publicReleaseApproved } from "@/lib/public-release";

const WEB_ROOT = resolve(process.cwd());
const SRC = join(WEB_ROOT, "src");
const LEGAL_DIR = join(SRC, "app", "(marketing)", "legal");

describe("legal publication gate fails closed", () => {
  it("is unapproved when the env var is absent or malformed", () => {
    expect(legalPublicationApproved(undefined)).toBe(false);
    expect(legalPublicationApproved("")).toBe(false);
    expect(legalPublicationApproved("yes")).toBe(false);
    expect(legalPublicationApproved("true")).toBe(false);
    // The prefix alone proves nothing; a reference to the approval record is
    // the point of the format.
    expect(legalPublicationApproved("approved:")).toBe(false);
    expect(legalPublicationApproved("approved:abc")).toBe(false);
  });

  it("is approved only for a prefixed, sufficiently long reference", () => {
    expect(legalPublicationApproved("approved:COUNSEL-2026-09")).toBe(true);
  });

  it("keeps the layout's 404 on the unapproved path", () => {
    const layout = readFileSync(join(LEGAL_DIR, "layout.tsx"), "utf8");
    expect(layout).toContain("notFound()");
    expect(layout).toContain("index: false");
    expect(layout).toContain("follow: false");
    // Guard the guard: the 404 must be reached from the approval check, not
    // left as dead code beside an always-render path.
    expect(layout).toMatch(/if\s*\(!approved && !preview\)\s*notFound/);
    expect(layout).toContain(
      'legalDraftPreviewAllowed((await headers()).get("host"))',
    );
  });
});

describe("the two publication gates must agree", () => {
  it("rejects publishing the site while the legal pages 404", () => {
    const conflict = publicationGateConflict(true, false);
    expect(conflict).not.toBeNull();
    expect(conflict).toContain("POSTWAVE_LEGAL_PUBLICATION_APPROVAL");
  });

  it("allows legal approval to land before the site goes public", () => {
    // Reviewing and approving the policies BEFORE launch is the intended
    // order; only the reverse is incoherent.
    expect(publicationGateConflict(false, true)).toBeNull();
  });

  it("allows both closed and both open", () => {
    expect(publicationGateConflict(false, false)).toBeNull();
    expect(publicationGateConflict(true, true)).toBeNull();
  });

  it("holds for the environment this build is running in", () => {
    expect(
      publicationGateConflict(
        publicReleaseApproved(),
        legalPublicationApproved(),
      ),
    ).toBeNull();
  });
});

/** Every `.tsx`/`.ts` source file under src, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("internal /legal links resolve to real pages", () => {
  it("has no link to a legal page that does not exist", () => {
    const routes = new Set(
      readdirSync(LEGAL_DIR).filter((entry) =>
        statSync(join(LEGAL_DIR, entry)).isDirectory(),
      ),
    );
    // Sanity-check the discovery itself: an empty set would make every
    // assertion below vacuously... loud, but a wrong path would make the
    // *routes* empty and every link look broken. Assert the shape instead.
    expect(routes.size).toBeGreaterThan(5);

    // Match LINKS, not every string that happens to look like the path. The
    // first draft of this scan matched any `"/legal/…"` literal and flagged
    // three false positives in src/lib/semantic-email, where `path +
    // "/legal/text"` builds a JSON-pointer diagnostic path for the `legal`
    // block type — same characters, unrelated namespace. Requiring an `href`
    // binding is what makes the match mean "a link".
    const HREF_TO_LEGAL =
      /href\s*[=:]\s*\{?\s*["'`]\/legal\/([a-z0-9-]+)["'`]/g;
    // Comments describe links they do not create; a commented-out or
    // historical path must not fail the build.
    //
    // ORDER IS LOAD-BEARING. Stripping block comments first silently ate this
    // whole test: `(marketing)/layout.tsx` carries the line comment
    // "…and /legal/* appeared nowhere else in global navigation…", and the
    // glob `/legal/*` contains the characters `/*`. Read as a block-comment
    // open, it swallowed everything down to the next `*/` — the entire footer
    // nav array included — so the file that binds seven legal links
    // contributed zero matches and a deliberately broken link went undetected.
    // Removing line comments first deletes that `/*` before it can be
    // misread.
    const stripComments = (text: string): string =>
      text.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

    const seen: string[] = [];
    const broken: string[] = [];
    const perFile = new Map<string, string[]>();
    for (const file of sourceFiles(SRC)) {
      const text = stripComments(readFileSync(file, "utf8"));
      const rel = file.slice(WEB_ROOT.length + 1);
      for (const match of text.matchAll(HREF_TO_LEGAL)) {
        const slug = match[1]!;
        seen.push(slug);
        perFile.set(rel, [...(perFile.get(rel) ?? []), slug]);
        if (!routes.has(slug)) broken.push(`${rel} → /legal/${slug}`);
      }
    }

    // Guard the guard — PER FILE, not in aggregate.
    //
    // An aggregate `seen.length >= 7` is what let the comment-stripper bug
    // through: 35 matches from other files kept it green while the footer
    // contributed zero. Naming the three surfaces the compliance argument
    // actually rests on means a scan that stops seeing any one of them fails
    // here instead of quietly passing.
    const footer = perFile.get("src/app/(marketing)/layout.tsx") ?? [];
    expect(footer).toContain("privacy");
    expect(footer).toContain("terms");
    expect(footer).toContain("cookies");
    expect(footer.length).toBeGreaterThanOrEqual(7);
    expect(perFile.get("src/components/marketing/cookie-banner.tsx")).toContain(
      "cookies",
    );
    expect(perFile.get("src/components/auth/auth-shell.tsx")).toContain(
      "privacy",
    );

    expect(broken).toEqual([]);
  });

  it("links to the cookie policy from the consent banner", () => {
    // The specific link the informed-consent argument turns on. If the banner
    // ever stops offering it, the gate coupling above stops mattering and this
    // test should be the thing that says so.
    const banner = readFileSync(
      join(SRC, "components", "marketing", "cookie-banner.tsx"),
      "utf8",
    );
    expect(banner).toContain("/legal/cookies");
  });
});
