// SPDX-License-Identifier: AGPL-3.0-only
//
// Two pieces of docs chrome carried their structure in CSS only.
//
// 1. Breadcrumbs rendered a row of bare <span>s with aria-hidden "/"
//    separators. A breadcrumb IS a sequence, and that sequence was the only
//    information it carried — a screen reader read "Docs Migrations Mailchimp"
//    as one undifferentiated run, with nothing marking which entry is the page
//    the reader is actually on.
//
// 2. The docs Sidebar is one nav landmark holding several hundred links (every
//    API endpoint, every skill). Its four section labels were styled <div>s,
//    so heading and landmark navigation saw no structure at all — no way to
//    skip from the API endpoint list to Guides.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";

const SRC = resolve(process.cwd(), "src");

const TRAIL = [
  { label: "Docs", href: "/docs" },
  { label: "Migrations", href: "/docs/migrations" },
  { label: "Mailchimp" },
];

describe("docs breadcrumbs", () => {
  const html = renderToStaticMarkup(<Breadcrumbs items={TRAIL} />);

  it("renders the trail", () => {
    // Guard the guard: an empty render would satisfy every "not" below.
    expect(html).toContain("Mailchimp");
    expect(html).toContain("Migrations");
  });

  it("is an ordered list, so position and count are conveyed", () => {
    expect(html).toMatch(/<ol\b/);
    expect((html.match(/<li\b/g) ?? []).length).toBe(TRAIL.length);
  });

  it("marks exactly the last entry as the current page", () => {
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    // …and it is the last one, not merely some one of them.
    const at = html.indexOf('aria-current="page"');
    expect(html.slice(at).includes("Mailchimp")).toBe(true);
    expect(html.slice(0, at).includes("Mailchimp")).toBe(false);
  });

  it("keeps the separators out of the accessibility tree", () => {
    // Two separators for three crumbs, all hidden — the <ol> conveys order.
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBe(
      TRAIL.length - 1,
    );
  });

  it("does not linkify the current page", () => {
    // The last crumb is where you already are; a link there is a no-op that
    // costs a keyboard user a stop.
    expect((html.match(/<a\b/g) ?? []).length).toBe(TRAIL.length - 1);
  });
});

describe("docs sidebar sections", () => {
  const source = readFileSync(join(SRC, "components/docs/Sidebar.tsx"), "utf8");

  it("labels its sections with a heading element", () => {
    expect(source).toMatch(/function SectionHeader[\s\S]{0,600}?<h2\b/);
  });

  it("still uses that header for every section", () => {
    // Guard the guard: a heading component nothing renders proves nothing.
    const used = (source.match(/<SectionHeader>/g) ?? []).length;
    expect(used).toBeGreaterThanOrEqual(4);
  });
});
