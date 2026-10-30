// SPDX-License-Identifier: AGPL-3.0-only
//
// breadcrumbSchema() maps its items straight into positioned ListItems with no
// deduplication, so a malformed trail ships as-is into the page's JSON-LD.
//
// Four legal pages declared an ancestor crumb pointing at themselves:
//
//   { name: "Legal",   url: "https://moosewave.com/legal/dpa" },
//   { name: "Data Processing Addendum", url: PAGE_URL },   // same URL
//
// There is no /legal index page, so there was no ancestor URL to point at and
// the "Legal" level could only ever repeat the leaf. Two consecutive ListItems
// sharing an `item` URL is not a valid BreadcrumbList — the trail says the
// page is its own parent.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Every breadcrumbSchema([...]) call, with `PAGE_URL` resolved to its literal.
 *
 * Resolving matters: the offending pages wrote the ancestor as a string
 * literal and the leaf as the PAGE_URL constant. Those are textually different
 * and semantically identical, so a comparison of raw expressions passes while
 * the emitted JSON-LD still repeats the URL.
 */
function breadcrumbTrails(): { file: string; urls: string[] }[] {
  const trails: { file: string; urls: string[] }[] = [];
  for (const file of walk(join(SRC, "app"))) {
    const text = readFileSync(file, "utf8");
    const pageUrl = /const PAGE_URL\s*=\s*"([^"]+)"/.exec(text)?.[1];
    for (const m of text.matchAll(/breadcrumbSchema\(\[(.*?)\]\)/gs)) {
      // Stop at `}` as well as `,` — entries are written `url: PAGE_URL },`,
      // so a comma-only terminator captures a trailing brace and the constant
      // never matches by name.
      const urls = [...m[1]!.matchAll(/url:\s*([^,\n}]+)/g)].map((u) => {
        const raw = u[1]!.trim();
        if (raw === "PAGE_URL" && pageUrl) return `"${pageUrl}"`;
        return raw;
      });
      if (urls.length) trails.push({ file: file.slice(SRC.length + 1), urls });
    }
  }
  return trails;
}

describe("breadcrumb trails", () => {
  const trails = breadcrumbTrails();

  it("finds breadcrumb trails to check", () => {
    // Guard the guard: a renamed helper would otherwise make this vacuous.
    expect(trails.length).toBeGreaterThan(3);
  });

  it("never repeats a URL within one trail", () => {
    const offenders = trails
      .filter((t) => new Set(t.urls).size !== t.urls.length)
      .map((t) => `${t.file}: ${t.urls.join(" > ")}`);
    expect(offenders).toEqual([]);
  });

  it("only names an ancestor level that has a page of its own", () => {
    // A crumb pointing at /legal needs a /legal page to exist.
    const offenders: string[] = [];
    for (const { file, urls } of trails) {
      for (const raw of urls) {
        const m = /^"https:\/\/postwave\.com(\/[a-z0-9/-]*)"$/.exec(raw);
        if (!m) continue; // PAGE_URL constants and the bare origin
        const path = m[1]!;
        if (path === "" || path === "/") continue;
        const page = join(SRC, "app/(marketing)", path, "page.tsx");
        const docsPage = join(SRC, "app/(docs)", path, "page.tsx");
        try {
          statSync(page);
        } catch {
          try {
            statSync(docsPage);
          } catch {
            offenders.push(`${file}: crumb ${path} has no page`);
          }
        }
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
