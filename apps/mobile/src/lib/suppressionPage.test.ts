/**
 * These two cases used to live in src/hooks/useOps.test.ts and import
 * `normalizeSuppressionPage` through a RE-EXPORT on the catch-all ops hook —
 * which meant five `vi.mock` calls (for @/api/ops, @/api/sdkClient,
 * @/hooks/useOnlineQueryGate, @/lib/connectivity and @/lib/secureVault) just to
 * reach a pure function. COMMERCE#60 deleted that module; the test now imports
 * the real home directly and needs no mocks at all.
 */
import { describe, expect, it } from "vitest";

import {
  mergeSuppressionPages,
  nextSuppressionPageParam,
  normalizeSuppressionPage,
  SUPPRESSION_MAX_PAGES,
  SUPPRESSION_PAGE_SIZE,
  type SuppressionPageBacking,
  type SuppressionRow,
} from "./suppressionPage";

describe("normalizeSuppressionPage", () => {
  it("preserves the canonical deliverability endpoint total", () => {
    expect(
      normalizeSuppressionPage({
        items: [{ id: "1", email: "a@example.com" }],
        total: 83,
        page: 1,
        size: 50,
      }),
    ).toEqual({
      items: [{ id: "1", email: "a@example.com" }],
      total: 83,
      page: 1,
      size: 50,
    });
  });

  it("normalizes a cached legacy array without inventing a larger total", () => {
    expect(
      normalizeSuppressionPage([{ id: "1", email: "a@example.com" }]),
    ).toMatchObject({
      total: 1,
      page: 1,
      size: 1,
    });
  });
});

/**
 * The paged list read: `useSuppressions` accepted a fully-plumbed `page`
 * argument that no caller ever passed, so only the newest 50 suppressions were
 * reachable from a phone. These cases pin the two halves of the fix — how far
 * paging goes, and what the flattened result claims.
 */
function backing(
  items: SuppressionRow[],
  over: Partial<Omit<SuppressionPageBacking, "value">> & { total?: number } = {},
): SuppressionPageBacking {
  const { total, ...rest } = over;
  return {
    value: {
      items,
      total: total ?? items.length,
      page: 1,
      size: SUPPRESSION_PAGE_SIZE,
    },
    fromSnapshot: false,
    capturedAt: 1_700_000_000_000,
    ...rest,
  };
}

function rows(count: number, prefix = "r"): SuppressionRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    email: `${prefix}${i}@example.com`,
  }));
}

describe("nextSuppressionPageParam", () => {
  it("asks for page 2 when a full page is loaded and more remain", () => {
    const first = backing(rows(SUPPRESSION_PAGE_SIZE), { total: 500 });
    expect(nextSuppressionPageParam(first, [first])).toBe(2);
  });

  it("stops at the page the server ran out on, even if total says otherwise", () => {
    // A row deleted mid-browse leaves `total` ahead of what the query can
    // return; trusting it alone would keep requesting empty pages forever.
    const short = backing(rows(SUPPRESSION_PAGE_SIZE - 1), { total: 500 });
    expect(nextSuppressionPageParam(short, [short])).toBeUndefined();
  });

  it("stops once the loaded rows reach the filtered total", () => {
    const full = backing(rows(SUPPRESSION_PAGE_SIZE), {
      total: SUPPRESSION_PAGE_SIZE,
    });
    expect(nextSuppressionPageParam(full, [full])).toBeUndefined();
  });

  it("never offers another page over an offline snapshot", () => {
    // The vault holds ONE projection, of page 1. Offering "Load more" would
    // either replay those rows as page 2 or fire a request that cannot succeed.
    const cached = backing(rows(SUPPRESSION_PAGE_SIZE), {
      total: 5_000,
      fromSnapshot: true,
    });
    expect(nextSuppressionPageParam(cached, [cached])).toBeUndefined();
  });

  it("stops at the page cap rather than promising to walk an archive", () => {
    const page = backing(rows(SUPPRESSION_PAGE_SIZE), { total: 400_000 });
    const all = Array.from({ length: SUPPRESSION_MAX_PAGES }, () => page);
    expect(nextSuppressionPageParam(page, all)).toBeUndefined();
    expect(nextSuppressionPageParam(page, all.slice(0, -1))).toBe(
      SUPPRESSION_MAX_PAGES,
    );
  });
});

describe("mergeSuppressionPages", () => {
  it("returns undefined before anything has loaded", () => {
    expect(mergeSuppressionPages(undefined)).toBeUndefined();
    expect(mergeSuppressionPages([])).toBeUndefined();
  });

  it("concatenates pages in order", () => {
    const merged = mergeSuppressionPages([
      backing(rows(2, "a"), { total: 4 }),
      backing(rows(2, "b"), { total: 4 }),
    ]);
    expect(merged?.value.items.map((r) => r.id)).toEqual([
      "a0",
      "a1",
      "b0",
      "b1",
    ]);
    expect(merged?.value.total).toBe(4);
  });

  it("drops the row a shifted OFFSET repeated across the boundary", () => {
    // The server orders by created_at DESC over LIMIT/OFFSET, so a suppression
    // added between two taps pushes the boundary row onto the next page too.
    const merged = mergeSuppressionPages([
      backing([{ id: "1", email: "a@example.com" }], { total: 3 }),
      backing(
        [
          { id: "1", email: "a@example.com" },
          { id: "2", email: "b@example.com" },
        ],
        { total: 3 },
      ),
    ]);
    expect(merged?.value.items.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("dedupes by address when the converged list has id-less legacy rows", () => {
    const merged = mergeSuppressionPages([
      backing([{ id: "", email: "a@example.com" }], { total: 2 }),
      backing([{ id: "", email: "A@example.com" }], { total: 2 }),
    ]);
    expect(merged?.value.items).toHaveLength(1);
  });

  it("never reports a total below what it is showing", () => {
    // A stale/absent total must not make the footer claim there is nothing
    // more to load while rows are on screen.
    const merged = mergeSuppressionPages([
      backing(rows(2, "a"), { total: 0 }),
      backing(rows(2, "b"), { total: 0 }),
    ]);
    expect(merged?.value.total).toBe(4);
  });

  it("takes provenance from the first page — the only one the vault answers", () => {
    const merged = mergeSuppressionPages([
      backing(rows(1, "a"), { fromSnapshot: true, capturedAt: 123 }),
      backing(rows(1, "b")),
    ]);
    expect(merged?.fromSnapshot).toBe(true);
    expect(merged?.capturedAt).toBe(123);
  });
});
