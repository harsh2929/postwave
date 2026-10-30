// SPDX-License-Identifier: AGPL-3.0-only
//
// RSC-02: /docs/api emitted one row per operation — 1,955 of them, ~1.2 MB of
// HTML, ~10,000 DOM nodes, and 1,955 viewport prefetches — with no pagination
// of any kind. The index now paginates by tag with a real URL per tag.
//
// The page is an async server component, so awaiting it and rendering it to
// static markup measures the thing the finding measured: the bytes and the row
// count of the emitted document. Expectations come from operationsByTag(),
// which is the page's INPUT — if the page went back to rendering everything,
// the all-tags row count would jump to the spec total and this fails.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ApiIndexPage from "@/app/(docs)/docs/api/page";
import { listOperations, operationsByTag } from "@/lib/docs/loadOpenAPI";

const PREVIEW_ROWS = 3;
const SRC = resolve(process.cwd(), "src");
const PAGE = readFileSync(join(SRC, "app/(docs)/docs/api/page.tsx"), "utf8");

async function markup(tag?: string): Promise<string> {
  return renderToStaticMarkup(
    await ApiIndexPage({ searchParams: Promise.resolve({ tag }) }),
  );
}

const rowCount = (html: string): number =>
  (html.match(/data-testid="api-operation"/g) ?? []).length;

describe("/docs/api pagination", () => {
  const groups = operationsByTag();

  it("has enough operations for pagination to be the point", () => {
    // Guard the guard: with a tiny spec every count below would coincide.
    expect(listOperations().length).toBeGreaterThan(1_000);
    expect(groups.length).toBeGreaterThan(50);
  });

  it("previews each tag instead of listing every operation", async () => {
    const expected = groups.reduce(
      (n, g) => n + Math.min(PREVIEW_ROWS, g.operations.length),
      0,
    );
    const html = await markup();
    expect(rowCount(html)).toBe(expected);
    expect(rowCount(html)).toBeLessThan(listOperations().length / 3);
    // The document that Lighthouse and a 4G phone actually pay for. The
    // unpaginated page was ~1.2 MB of rows alone.
    expect(html.length).toBeLessThan(600_000);
  });

  it("offers every tag a URL that lists it in full", async () => {
    const html = await markup();
    const missing = groups
      .filter((g) => g.operations.length > PREVIEW_ROWS)
      .filter((g) => !html.includes(`/docs/api?tag=${g.slug}`));
    expect(missing.map((g) => g.tag)).toEqual([]);
  });

  it("renders exactly one tag in full when that URL is requested", async () => {
    // The largest tag — the case the byte budget cares about most.
    const largest = [...groups].sort(
      (a, b) => b.operations.length - a.operations.length,
    )[0]!;
    const html = await markup(largest.slug);
    expect(rowCount(html)).toBe(largest.operations.length);
    for (const op of largest.operations.slice(0, 5)) {
      expect(html).toContain(`/docs/api/${op.slug}"`);
    }
    // Nothing from any other tag came along.
    const otherTag = groups.find((g) => g.slug !== largest.slug)!;
    expect(html).not.toContain(`/docs/api/${otherTag.operations[0]!.slug}"`);
  });

  it("falls back to the all-tags view for an unknown tag", async () => {
    expect(rowCount(await markup("not-a-real-tag"))).toBe(
      rowCount(await markup()),
    );
  });

  it("never viewport-prefetches an endpoint row", async () => {
    // 1,955 prefetching links was a network storm of its own. Every row is
    // emitted by one component, and that component opts out.
    expect(PAGE.match(/data-testid="api-operation"/g)).toHaveLength(1);
    const row = PAGE.slice(PAGE.indexOf('data-testid="api-operation"'));
    expect(row.slice(0, row.indexOf("</Link>"))).toContain("prefetch={false}");
  });
});
