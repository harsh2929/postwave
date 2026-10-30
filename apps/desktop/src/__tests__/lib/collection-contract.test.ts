import { describe, expect, it } from "vitest";

import {
  decodeCollectionDetail,
  decodeCollectionPage,
  decodeDeleteAcknowledgement,
} from "../../lib/collections/collection-contract";

const tenant = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const base = {
  id,
  tenant_id: tenant,
  name: "Content map",
  collection_type: "content",
  source_type: "uploaded",
  row_count: 1,
  version: 3,
  created_at: "2026-07-22T10:00:00Z",
  updated_at: "2026-07-22T10:01:00.123Z",
};

describe("reference collection response contract", () => {
  it("decodes metadata-only pages and preserves a bounded cursor", () => {
    const decoded = decodeCollectionPage(
      { items: [{ ...base, data: [] }], total: 2, next_cursor: "cursor-2" },
      tenant,
    );
    expect(decoded).toEqual({
      items: [{ ...base, data: [] }],
      total: 2,
      next_cursor: "cursor-2",
    });
  });

  it("rejects identity, tenant, timestamp, and summary-data mismatches", () => {
    expect(
      decodeCollectionPage({
        items: [{ ...base, id: "not-a-uuid", data: [] }],
        total: 1,
      }),
    ).toBeNull();
    expect(
      decodeCollectionPage(
        { items: [{ ...base, data: [] }], total: 1 },
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toBeNull();
    expect(
      decodeCollectionPage({
        items: [{ ...base, updated_at: undefined, data: [] }],
        total: 1,
      }),
    ).toBeNull();
    expect(
      decodeCollectionPage({
        items: [{ ...base, data: [{ key: "leak" }] }],
        total: 1,
      }),
    ).toBeNull();
    expect(
      decodeCollectionPage(
        { items: [{ ...base, data: [] }], total: 1 },
        "tenant-slug",
      ),
    ).toBeNull();
    expect(
      decodeCollectionPage({
        items: [{ ...base, name: "unsafe\u2028name", data: [] }],
        total: 1,
      }),
    ).toBeNull();
  });

  it("caps list pages before they can amplify renderer work", () => {
    const items = Array.from({ length: 201 }, (_, index) => ({
      ...base,
      id: `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
      data: [],
    }));
    expect(decodeCollectionPage({ items, total: items.length })).toBeNull();
  });

  it("rejects duplicate page IDs and non-progressing empty cursor pages", () => {
    expect(
      decodeCollectionPage({
        items: [
          { ...base, data: [] },
          { ...base, data: [] },
        ],
        total: 2,
      }),
    ).toBeNull();
    expect(
      decodeCollectionPage({ items: [], total: 1, next_cursor: "cursor" }),
    ).toBeNull();
    expect(
      decodeCollectionPage({
        items: [{ ...base, data: [] }],
        total: 2,
        next_cursor: "cursor\u0000hidden",
      }),
    ).toBeNull();
  });

  it("decodes bounded nested legacy values while preserving control content", () => {
    const row = {
      message: "مرحبا\u202e",
      config: { tags: ["one", "two"], enabled: true },
    };
    expect(
      decodeCollectionDetail({ ...base, data: [row] }, tenant)?.data[0],
    ).toEqual(row);
  });

  it("rejects impossible PostgreSQL NUL values while preserving other controls", () => {
    expect(
      decodeCollectionDetail({ ...base, data: [{ value: "one\u0000two" }] }),
    ).toBeNull();
    expect(
      decodeCollectionDetail({ ...base, data: [{ value: "one\ntwo" }] })
        ?.data[0]?.value,
    ).toBe("one\ntwo");
  });

  it("rejects malformed detail shape, unsafe keys, depth, and number loss", () => {
    expect(
      decodeCollectionDetail({ ...base, row_count: 2, data: [{}] }),
    ).toBeNull();
    expect(
      decodeCollectionDetail({ ...base, data: [{ "co\u202ede": "x" }] }),
    ).toBeNull();
    expect(
      decodeCollectionDetail({ ...base, data: [{ "co\u2029de": "x" }] }),
    ).toBeNull();
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 9; depth += 1) nested = [nested];
    expect(decodeCollectionDetail({ ...base, data: [{ nested }] })).toBeNull();
    expect(
      decodeCollectionDetail({
        ...base,
        data: [{ id: 9_007_199_254_740_992 }],
      }),
    ).toBeNull();
  });

  it("accepts only an exact delete acknowledgement", () => {
    expect(
      decodeDeleteAcknowledgement({ ok: true, id, version: 4 }, id, 3),
    ).toBe(true);
    expect(decodeDeleteAcknowledgement({ ok: true }, id, 3)).toBe(false);
    expect(
      decodeDeleteAcknowledgement({ ok: true, id, version: 3 }, id, 3),
    ).toBe(false);
    expect(
      decodeDeleteAcknowledgement(
        {
          ok: true,
          id: "33333333-3333-4333-8333-333333333333",
          version: 4,
        },
        id,
        3,
      ),
    ).toBe(false);
    expect(decodeDeleteAcknowledgement(true, id, 3)).toBe(false);
  });
});
