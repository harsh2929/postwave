// SPDX-License-Identifier: AGPL-3.0-only
//
// Tags-page transport (audience-100/104/108): the three tag-taxonomy reads
// the page composes hit the mounted routes with the exact query, and every
// decoder fails closed on a payload the server does not send — an echo for a
// different query, a non-UUID or duplicate subscriber id, a negative count.
// The page test mocks this module, so this is the only place the paths live.

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMocks,
}));

import { ApiError } from "@/lib/api";
import {
  isTagVersionConflict,
  listSubscribersWithTag,
  listTagTaxonomy,
  suggestTags,
  TAG_SUBSCRIBER_SAMPLE_LIMIT,
  TAG_SUGGESTION_LIMIT,
} from "@/lib/tags-api";

const ADA = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCC1";
const BOB = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

beforeEach(() => apiMocks.get.mockReset());

describe("listTagTaxonomy", () => {
  it("GETs /api/v1/tag-taxonomy and decodes usage rows", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValue({
      items: [
        { tag: "vip", subscribers: 120, registered: true, created_at: "2026-07-01T00:00:00Z" },
        { tag: "legacy-import", subscribers: 12, registered: false, created_at: "not a date" },
      ],
    });
    await expect(listTagTaxonomy(signal)).resolves.toEqual([
      { tag: "vip", subscribers: 120, registered: true, created_at: "2026-07-01T00:00:00Z" },
      { tag: "legacy-import", subscribers: 12, registered: false },
    ]);
    expect(apiMocks.get).toHaveBeenCalledWith("/api/v1/tag-taxonomy", { signal });
  });

  it("refuses a catalogue without items or with a negative count", async () => {
    apiMocks.get.mockResolvedValue({ items: "nope" });
    await expect(listTagTaxonomy()).rejects.toThrow(/invalid catalogue/);
    apiMocks.get.mockResolvedValue({
      items: [{ tag: "vip", subscribers: -1, registered: true }],
    });
    await expect(listTagTaxonomy()).rejects.toThrow(/invalid subscriber count/);
  });
});

describe("suggestTags", () => {
  it("GETs /api/v1/tag-taxonomy/suggest with the trimmed q and the page's limit", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValue({
      q: "vi",
      items: [{ tag: "vip", subscribers: 120, registered: true }],
    });
    await expect(suggestTags("  vi ", undefined, signal)).resolves.toEqual([
      { tag: "vip", subscribers: 120, registered: true },
    ]);
    expect(apiMocks.get).toHaveBeenCalledWith("/api/v1/tag-taxonomy/suggest", {
      query: { q: "vi", limit: TAG_SUGGESTION_LIMIT },
      signal,
    });
    expect(TAG_SUGGESTION_LIMIT).toBe(5);
  });

  it("discards a response echoed for a different query", async () => {
    apiMocks.get.mockResolvedValue({ q: "vip", items: [] });
    await expect(suggestTags("vi")).rejects.toThrow(/unverifiable/);
  });
});

describe("listSubscribersWithTag", () => {
  it("GETs /api/v1/tag-taxonomy/subscribers?tag=&limit= and normalises ids", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValue({
      tag: "vip",
      items: [
        { id: ADA, email: "ada@example.test", status: "enabled", created_at: "2026-08-01T00:00:00Z" },
        { id: BOB, email: "bob@example.test", created_at: "2026-08-02T00:00:00Z" },
      ],
    });
    await expect(listSubscribersWithTag("vip", undefined, signal)).resolves.toEqual([
      { id: ADA.toLowerCase(), email: "ada@example.test", status: "enabled", created_at: "2026-08-01T00:00:00Z" },
      { id: BOB, email: "bob@example.test", status: "", created_at: "2026-08-02T00:00:00Z" },
    ]);
    expect(apiMocks.get).toHaveBeenCalledWith("/api/v1/tag-taxonomy/subscribers", {
      query: { tag: "vip", limit: TAG_SUBSCRIBER_SAMPLE_LIMIT },
      signal,
    });
    expect(TAG_SUBSCRIBER_SAMPLE_LIMIT).toBe(50);
  });

  it("fails closed on a foreign echo, a non-UUID id, or duplicate identities", async () => {
    const row = { id: BOB, email: "bob@example.test", status: "enabled", created_at: "2026-08-02T00:00:00Z" };
    apiMocks.get.mockResolvedValue({ tag: "churn-risk", items: [row] });
    await expect(listSubscribersWithTag("vip")).rejects.toThrow(/unverifiable/);
    apiMocks.get.mockResolvedValue({ tag: "vip", items: [{ ...row, id: "42" }] });
    await expect(listSubscribersWithTag("vip")).rejects.toThrow(/invalid subscriber id/);
    apiMocks.get.mockResolvedValue({ tag: "vip", items: [row, { ...row, id: BOB.toUpperCase() }] });
    await expect(listSubscribersWithTag("vip")).rejects.toThrow(/duplicate identities/);
  });
});

describe("isTagVersionConflict", () => {
  it("is exactly HTTP 412 from the API", () => {
    expect(isTagVersionConflict(new ApiError("precondition failed", 412))).toBe(true);
    expect(isTagVersionConflict(new ApiError("conflict", 409))).toBe(false);
    expect(isTagVersionConflict(new Error("412"))).toBe(false);
  });
});
