// SPDX-License-Identifier: AGPL-3.0-only
//
// The legal pages may not invent their own infrastructure facts.
//
// WHAT WENT WRONG. Four documents — the privacy policy, the DPA, the DPIA and
// the sub-processor register — each hard-coded an answer to "where does the
// data live", and all four gave the same wrong one for months: Hetzner for
// compute and Neon for Postgres, a stack `infra/RUNBOOK_STATUS.md:40` records
// as "an archived Hetzner prototype… not an alternate Moosewave Cloud platform".
// Vercel was listed as the frontend host although apps/web builds
// `output: "standalone"` and deploys on AWS. AWS itself, which runs everything,
// was named nowhere. The DPA and a support macro incorporated a technical-
// measures document by reference to a URL that returned 404.
//
// None of that was a coding error. It was four copies of a fact with no owner,
// and copies drift. @/lib/legal/infrastructure is now the owner, and this file
// is what stops the copies coming back:
//
//   1. No legal page names a retired vendor.
//   2. No legal page hard-codes a hosting region string.
//   3. Every /legal/* path referenced anywhere in the repo resolves to a route.
//   4. The pages that state infrastructure facts import them.
//
// A note on scope: these assertions read the page SOURCE rather than rendering
// it. That is deliberate. The legal routes 404 until
// POSTWAVE_LEGAL_PUBLICATION_APPROVAL is set (see @/lib/legal-publication), so
// a rendering test would assert against an empty page and pass for the wrong
// reason — which is the same class of mistake as the bug being fixed.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INFRASTRUCTURE,
  RETIRED_VENDOR_CLAIMS,
  SUBPROCESSORS,
  SUBPROCESSORS_PATH,
  TOM_PATH,
} from "@/lib/legal/infrastructure";

const APP_DIR = path.join(__dirname, "..", "app");
const LEGAL_DIR = path.join(APP_DIR, "(marketing)", "legal");
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

/**
 * A line carrying this marker may name a retired vendor. It exists for exactly
 * one legitimate case: the sub-processor changelog, which has to say what was
 * removed. Silently dropping vendors from a published register and leaving no
 * record is its own transparency failure.
 */
const ALLOW_MARKER = "legal-vendor-claim-ok";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const LEGAL_PAGES = walk(LEGAL_DIR);

describe("legal pages state one set of infrastructure facts", () => {
  it("finds the legal pages it is meant to guard", () => {
    // A guard that silently guards nothing is worse than no guard: it reports
    // green after someone moves the directory.
    expect(LEGAL_PAGES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(RETIRED_VENDOR_CLAIMS)(
    "no legal page claims $name is a sub-processor",
    ({ name, reason }) => {
      const offenders: string[] = [];
      for (const file of LEGAL_PAGES) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!new RegExp(`\\b${name}\\b`, "i").test(line)) return;
          if (line.includes(ALLOW_MARKER)) return;
          // The changelog paragraph names what was removed, and its opening
          // line carries the marker; continuation lines of the same JSX text
          // node do not. Allow a short window after a marked line.
          const windowStart = Math.max(0, i - 14);
          if (lines.slice(windowStart, i).some((l) => l.includes(ALLOW_MARKER))) return;
          offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
        });
      }
      expect(
        offenders,
        `${name} may not appear in a legal page — ${reason}. ` +
          "If it has genuinely become a sub-processor again, add it to " +
          "SUBPROCESSORS in @/lib/legal/infrastructure and remove it from " +
          "RETIRED_VENDOR_CLAIMS.",
      ).toEqual([]);
    },
  );

  it("no legal page hard-codes a hosting region", () => {
    // The region determines the Chapter V transfer analysis. A page that spells
    // it out in prose can disagree with the register, and the disagreement is
    // invisible until a regulator or a customer's privacy reviewer finds it.
    const offenders: string[] = [];
    for (const file of LEGAL_PAGES) {
      if (file.includes(`${path.sep}sub-processors${path.sep}`)) continue; // renders SUBPROCESSORS[].region
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.includes("INFRASTRUCTURE.")) return;
          if (line.includes(ALLOW_MARKER)) return;
          if (/\b(us-west-2|us-east-1|eu-central-1|eu-west-1|eu-north-1)\b/.test(line)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      "Import the region from @/lib/legal/infrastructure instead of writing it out.",
    ).toEqual([]);
  });

  it("the pages that describe hosting import the register", () => {
    for (const name of ["privacy", "dpa", "dpia", "sub-processors", "tom"]) {
      const file = path.join(LEGAL_DIR, name, "page.tsx");
      expect(existsSync(file), `${name} legal page is missing`).toBe(true);
      expect(
        readFileSync(file, "utf8"),
        `/legal/${name} states infrastructure facts, so it must import them`,
      ).toContain("@/lib/legal/infrastructure");
    }
  });
});

describe("every referenced /legal path resolves to a route", () => {
  /**
   * The DPA incorporated its technical-measures annex by reference to
   * https://moosewave.com/legal/tom, which did not exist. A support macro linked
   * /legal/subprocessors, which does not exist either — the route is
   * /legal/sub-processors. A legal cross-reference that 404s incorporates
   * nothing, so the link target is part of the obligation, not decoration.
   */
  const SEARCH_ROOTS = [
    path.join(REPO_ROOT, "apps", "web", "src"),
    path.join(REPO_ROOT, "apps", "api", "internal", "privacy"),
    path.join(REPO_ROOT, "docs", "support"),
  ].filter((p) => existsSync(p));

  function collectFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", "__snapshots__"].includes(entry.name)) continue;
          if (entry.name.startsWith(".next")) continue;
          stack.push(full);
        } else if (/\.(tsx?|go|json|md)$/.test(entry.name)) {
          out.push(full);
        }
      }
    }
    return out;
  }

  function legalRouteExists(slug: string): boolean {
    const dir = path.join(LEGAL_DIR, slug);
    return existsSync(dir) && statSync(dir).isDirectory() && existsSync(path.join(dir, "page.tsx"));
  }

  it("resolves every /legal/<slug> reference in web, API and support copy", () => {
    const broken = new Map<string, string[]>();
    // Only real site links. Two things look like one and are not: a module
    // specifier ("@/lib/legal/infrastructure") and a JSON-pointer path
    // ("…/legal/text" in the semantic-email decoder). So a match must either
    // carry the apex domain or sit on a line that is building a link.
    const absolute = /postwave\.com\/legal\/([a-z0-9-]+)/g;
    const relative = /["'`]\/legal\/([a-z0-9-]+)/g;
    const linkish = /href|<Link|\]\(|markdown_link/i;
    for (const root of SEARCH_ROOTS) {
      for (const file of collectFiles(root)) {
        // This test names the broken URLs in its own prose; skip itself.
        if (file === __filename) continue;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const matches = [
            ...line.matchAll(absolute),
            ...(linkish.test(line) ? [...line.matchAll(relative)] : []),
          ];
          for (const match of matches) {
            const slug = match[1];
            if (legalRouteExists(slug)) continue;
            const where = broken.get(slug) ?? [];
            where.push(path.relative(REPO_ROOT, file));
            broken.set(slug, where);
          }
        }
      }
    }
    expect(
      Object.fromEntries([...broken].map(([k, v]) => [k, [...new Set(v)]])),
      "These /legal/<slug> links have no route. A DPA cannot incorporate a " +
        "document by reference to a 404.",
    ).toEqual({});
  });

  it("the canonical sub-processor and TOM paths are routes", () => {
    for (const p of [SUBPROCESSORS_PATH, TOM_PATH]) {
      expect(legalRouteExists(p.replace("/legal/", "")), `${p} must be a route`).toBe(true);
    }
  });
});

describe("the sub-processor register is internally coherent", () => {
  it("names the cloud provider that actually runs the platform", () => {
    const names = SUBPROCESSORS.map((s) => s.name);
    expect(
      names.some((n) => n.includes(INFRASTRUCTURE.cloudProvider)),
      "The infrastructure provider is a sub-processor and must be disclosed, " +
        "or the customer's Art. 28(2) objection right is unexercisable.",
    ).toBe(true);
  });

  it("gives every entry a transfer basis and an assurance level", () => {
    for (const s of SUBPROCESSORS) {
      expect(s.transfer.length, `${s.name} has no transfer basis`).toBeGreaterThan(0);
      expect(["canonical", "conditional", "planned"]).toContain(s.assurance);
      expect(s.dpa, `${s.name} has no DPA link`).toMatch(/^https:\/\//);
    }
  });

  it("does not list a vendor it also declares retired", () => {
    const retired = new Set(RETIRED_VENDOR_CLAIMS.map((r) => r.name.toLowerCase()));
    for (const s of SUBPROCESSORS) {
      expect(
        retired.has(s.name.toLowerCase()),
        `${s.name} is both listed and retired`,
      ).toBe(false);
    }
  });
});
