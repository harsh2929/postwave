import { describe, expect, it } from "vitest";

import type { CollectionSummary } from "@/lib/collections";
import {
  COLLECTION_TYPE_FILTERS,
  collectionCoverageNote,
  collectionEmptyMessage,
  collectionFilterKey,
  collectionSizeLabel,
  collectionSourceSentence,
  collectionTypeLabel,
  collectionTypeParam,
  couponReferenceCaveat,
  isCollectionRoleDenied,
  sanitizeCollectionQuery,
} from "@/lib/collectionInventory";

function summary(over: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id: "3f7b1f1e-2c5d-4a6b-9f0a-1d2e3f4a5b6c",
    name: "Summer codes",
    collectionType: "content",
    sourceType: "uploaded",
    rowCount: 12,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-07-24T02:15:00Z",
    ...over,
  };
}

describe("collection size labelling", () => {
  it("keeps 'not reported' and 'empty' as different statements", () => {
    const unknown = collectionSizeLabel(null);
    const empty = collectionSizeLabel(0);
    expect(unknown.text).toBe("—");
    expect(unknown.spoken).toBe("Row count not reported");
    expect(unknown.empty).toBe(false);
    expect(empty.text).toBe("Empty");
    expect(empty.spoken).toBe("0 rows — this collection holds nothing");
    expect(empty.empty).toBe(true);
  });

  it("ships the exact figure for a screen reader", () => {
    expect(collectionSizeLabel(1).spoken).toBe("1 row");
    expect(collectionSizeLabel(4318).spoken).toBe("4,318 rows");
  });
});

describe("collection vocabulary", () => {
  it("echoes an unknown type or source instead of inventing one", () => {
    expect(collectionTypeLabel("coupons")).toBe("Coupons");
    expect(collectionTypeLabel("recipes")).toBe("recipes");
    expect(collectionTypeLabel("   ")).toBe("Untyped");
    expect(collectionSourceSentence("api")).toBe(
      "API — written through the API",
    );
    expect(collectionSourceSentence("carrier-pigeon")).toBe("carrier-pigeon");
  });

  it("offers exactly the three server-side kinds plus 'all'", () => {
    // types.go:19-23 — coupons, content, schedule. A fourth chip here would be
    // a filter the server 400s (`invalid_collection_type`, handlers.go:358).
    expect([...COLLECTION_TYPE_FILTERS]).toEqual([
      "all",
      "coupons",
      "content",
      "schedule",
    ]);
    expect(collectionTypeParam("all")).toBe("");
    expect(collectionTypeParam("schedule")).toBe("schedule");
  });
});

describe("coverage note", () => {
  it("says the denominator when the page is not the whole set", () => {
    expect(collectionCoverageNote(50, 312, true)).toBe(
      "Showing 50 of 312 collections.",
    );
  });

  it("stays silent when the page IS the whole set", () => {
    expect(collectionCoverageNote(7, 7, false)).toBeNull();
  });

  it("still warns when a cursor exists but no total was reported", () => {
    expect(collectionCoverageNote(50, null, true)).toBe(
      "There are more collections than the ones listed here.",
    );
    expect(collectionCoverageNote(50, null, false)).toBeNull();
  });
});

describe("coupon reference caveat", () => {
  it("fires only when a coupons collection is actually on screen", () => {
    expect(couponReferenceCaveat([summary(), summary()])).toBeNull();
    expect(
      couponReferenceCaveat([summary({ collectionType: "coupons" })]),
    ).toContain("not the coupon pool that discounts issue codes from");
  });
});

describe("search sanitisation", () => {
  it("trims exactly as the server does, so the query key matches the request", () => {
    // handlers.go:342 — strings.TrimSpace on q.
    expect(sanitizeCollectionQuery("  invoices ").value).toBe("invoices");
    expect(sanitizeCollectionQuery("   ").submittable).toBe(true);
    expect(sanitizeCollectionQuery("   ").value).toBe("");
  });

  it("refuses text the server rejects, rather than issuing a doomed request", () => {
    // validation.go:337-347 — control runes AND the bidi set, which a plain
    // \p{Cc} test would miss.
    const rtlOverride = sanitizeCollectionQuery("code\u202Etxt.exe");
    expect(rtlOverride.submittable).toBe(false);
    expect(rtlOverride.reason).toBe("unsafe-characters");
    expect(rtlOverride.value).toBe("");
    expect(sanitizeCollectionQuery("a\u0007b").reason).toBe("unsafe-characters");
    expect(sanitizeCollectionQuery("a\u061Cb").reason).toBe("unsafe-characters");
    expect(sanitizeCollectionQuery("a\u2069b").reason).toBe("unsafe-characters");
  });

  it("counts code points, not UTF-16 units, exactly as Go counts runes", () => {
    // MaxListSearchLength is 200 RUNES (types.go:134). 150 astral emoji are
    // 300 UTF-16 units and 150 runes: legal, and a `.length` check would
    // wrongly refuse them.
    const emoji = "🙂".repeat(150);
    expect(emoji.length).toBe(300);
    expect(sanitizeCollectionQuery(emoji).submittable).toBe(true);
    expect(sanitizeCollectionQuery("🙂".repeat(201)).reason).toBe("too-long");
    expect(sanitizeCollectionQuery("a".repeat(200)).submittable).toBe(true);
  });
});

describe("cursor identity", () => {
  it("changes whenever a filter the cursor is bound to changes", () => {
    // cursor.go:69-73 rejects a cursor whose embedded q / collection_type
    // disagree with the request, so these must not share a key.
    expect(collectionFilterKey("all", "")).not.toBe(
      collectionFilterKey("coupons", ""),
    );
    expect(collectionFilterKey("all", "codes")).not.toBe(
      collectionFilterKey("all", ""),
    );
  });

  it("treats whitespace-only differences as the same page", () => {
    expect(collectionFilterKey("all", " codes ")).toBe(
      collectionFilterKey("all", "codes"),
    );
  });

  it("treats an unsubmittable query as no query at all", () => {
    // The request drops it (api/collections.ts), so the key must too — or the
    // cached page and the request would disagree about what was asked.
    expect(collectionFilterKey("all", "a\u202Eb")).toBe(
      collectionFilterKey("all", ""),
    );
  });
});

describe("empty-state wording", () => {
  it("distinguishes an empty workspace from a filter that matched nothing", () => {
    expect(collectionEmptyMessage("all", "").title).toBe(
      "No reference collections",
    );
    expect(collectionEmptyMessage("coupons", "").title).toBe("No matches");
    expect(collectionEmptyMessage("all", "codes").title).toBe("No matches");
  });
});

describe("role refusal detection", () => {
  it("counts only a 403 as the server refusing this session", () => {
    expect(isCollectionRoleDenied({ status: 403 })).toBe(true);
    expect(isCollectionRoleDenied({ status: 404 })).toBe(false);
    expect(isCollectionRoleDenied({ status: 401 })).toBe(false);
    expect(isCollectionRoleDenied(null)).toBe(false);
  });
});
