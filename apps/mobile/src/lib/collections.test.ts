import { describe, expect, it } from "vitest";

import {
  normalizeCollectionDetail,
  normalizeCollectionListPage,
  normalizeCollectionSummary,
} from "@/lib/collections";

/**
 * The payloads below are the server's, not invented: the field names come from
 * the JSON tags on `Collection` / `ListPage`
 * (apps/api/internal/collections/types.go:60-102), and the LIST item's
 * `"data": []` is what `scanCollectionSummaries` hard-codes at repo.go:367
 * while projecting `jsonb_array_length(data)` into `row_count` separately.
 */
const LIST_ITEM = {
  id: "3f7b1f1e-2c5d-4a6b-9f0a-1d2e3f4a5b6c",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  name: "Summer codes",
  collection_type: "coupons",
  source_type: "uploaded",
  data: [],
  row_count: 4318,
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-24T02:15:00Z",
};

describe("reference collection summaries", () => {
  it("reads row_count and never the stubbed data array", () => {
    const summary = normalizeCollectionSummary(LIST_ITEM);
    // The trap: `data.length` is 0 for EVERY list row, including this
    // 4,318-row one (repo.go:367).
    expect(summary?.rowCount).toBe(4318);
  });

  it("answers null — not zero — for a count the server did not send", () => {
    const { row_count: _omitted, ...withoutCount } = LIST_ITEM;
    expect(normalizeCollectionSummary(withoutCount)?.rowCount).toBeNull();
  });

  it("keeps a genuine zero as zero, distinct from an absent count", () => {
    expect(
      normalizeCollectionSummary({ ...LIST_ITEM, row_count: 0 })?.rowCount,
    ).toBe(0);
  });

  it("rejects a fractional or negative count rather than rounding one", () => {
    expect(
      normalizeCollectionSummary({ ...LIST_ITEM, row_count: 12.5 })?.rowCount,
    ).toBeNull();
    expect(
      normalizeCollectionSummary({ ...LIST_ITEM, row_count: -3 })?.rowCount,
    ).toBeNull();
  });

  it("drops a row with no id instead of offering a dead press target", () => {
    expect(normalizeCollectionSummary({ ...LIST_ITEM, id: "  " })).toBeNull();
    expect(normalizeCollectionSummary(null)).toBeNull();
    expect(normalizeCollectionSummary([LIST_ITEM])).toBeNull();
  });

  it("keeps an unknown collection_type verbatim rather than defaulting it", () => {
    expect(
      normalizeCollectionSummary({ ...LIST_ITEM, collection_type: "recipes" })
        ?.collectionType,
    ).toBe("recipes");
  });
});

describe("reference collection list page", () => {
  it("reads the filter-wide total and the keyset cursor", () => {
    const page = normalizeCollectionListPage({
      items: [LIST_ITEM],
      total: 312,
      next_cursor: "eyJ2IjoxfQ",
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(312);
    expect(page.nextCursor).toBe("eyJ2IjoxfQ");
  });

  it("treats an omitted next_cursor as the last page", () => {
    // `next_cursor` carries omitempty (types.go:101), so the LAST page simply
    // has no key — there is no empty-string sentinel to test for.
    const page = normalizeCollectionListPage({ items: [LIST_ITEM], total: 1 });
    expect(page.nextCursor).toBeNull();
  });

  it("returns an empty page — with a null total — for an unreadable body", () => {
    const page = normalizeCollectionListPage("nope");
    expect(page.items).toEqual([]);
    expect(page.total).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("skips unaddressable items without dropping the rest of the page", () => {
    const page = normalizeCollectionListPage({
      items: [LIST_ITEM, { name: "orphan" }, { ...LIST_ITEM, id: "other-id" }],
      total: 3,
    });
    expect(page.items.map((item) => item.id)).toEqual([LIST_ITEM.id, "other-id"]);
    // The TOTAL still says three: the server counted three rows and one of them
    // is simply not renderable. Recomputing it from the survivors would hide
    // the discrepancy.
    expect(page.total).toBe(3);
  });
});

describe("reference collection detail", () => {
  const DETAIL = {
    ...LIST_ITEM,
    data: [{ code: "SUMMER10" }, { code: "SUMMER20" }],
    row_count: 2,
  };

  it("reads the complete row bodies the detail route returns", () => {
    const detail = normalizeCollectionDetail(DETAIL);
    expect(detail?.rows).toEqual([{ code: "SUMMER10" }, { code: "SUMMER20" }]);
    expect(detail?.rowCount).toBe(2);
  });

  it("falls back to the array length ONLY in the detail case", () => {
    // Legitimate here and nowhere else: `Get` decodes the whole array and sets
    // RowCount = len(c.Data) (repo.go:343), so the array IS the measurement.
    const { row_count: _omitted, ...withoutCount } = DETAIL;
    expect(normalizeCollectionDetail(withoutCount)?.rowCount).toBe(2);
  });

  it("drops a non-object row rather than rendering it as a blank record", () => {
    const detail = normalizeCollectionDetail({
      ...DETAIL,
      data: [{ code: "A" }, null, "B"],
    });
    expect(detail?.rows).toEqual([{ code: "A" }]);
  });
});
