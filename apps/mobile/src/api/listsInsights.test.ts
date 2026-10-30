/**
 * Per-list insight reads, driven with the exact bodies apps/api writes and
 * with rawRequest mocked — the transport seam a parser-only test cannot see.
 * The costly failure class here is a wrong envelope key rendering as a
 * quiet list (`events`, `forms`, `automations` are NOT the house `items`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchListActivity,
  fetchListAutomations,
  fetchListEngagement,
  fetchListForms,
  fetchListSuppressedTotal,
  fetchPerRowEngagement,
} from "./listsInsights";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

// Bodies mirror apps/api/internal/lists/analytics.go + member_suppressions.go.
const ENGAGEMENT = {
  list_id: "u-1",
  window_days: 30,
  opens: 120,
  clicks: 31,
  unsubs: 4,
  complaints: 1,
  bounces: 9,
};
const ACTIVITY = {
  list_id: "u-1",
  events: [
    { at: "2026-08-27T10:00:00Z", kind: "subscribed", email: "a@x.com" },
    {
      at: "2026-08-26T10:00:00Z",
      kind: "suppression_add",
      email: "b@x.com",
      detail: { reason: "hard bounce" },
    },
  ],
};

describe("list insight reads unwrap the envelope and read the real keys", () => {
  it("engagement breakdown lands with its counters", async () => {
    rawRequest.mockResolvedValue({ data: ENGAGEMENT, error: null });
    const out = await fetchListEngagement("7");
    expect(out).toMatchObject({ opens: 120, clicks: 31, bounces: 9 });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/lists/7/engagement-breakdown?window=30d",
    );
  });

  it("activity reads the `events` key (not `items`)", async () => {
    rawRequest.mockResolvedValue({ data: ACTIVITY, error: null });
    const rows = await fetchListActivity("7");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: "suppression_add",
      email: "b@x.com",
      detail: "hard bounce",
    });
  });

  it("suppressed total comes from the page envelope's total, not the slice", async () => {
    rawRequest.mockResolvedValue({
      data: { items: [{ email: "a@x.com" }], total: 37, page: 1, per_page: 1 },
      error: null,
    });
    await expect(fetchListSuppressedTotal("7")).resolves.toBe(37);
  });

  it("forms/automations read their named keys", async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        list_id: "u-1",
        forms: [{ id: "f1", name: "Footer signup", status: "published" }],
      },
      error: null,
    });
    await expect(fetchListForms("7")).resolves.toEqual([
      { id: "f1", name: "Footer signup", status: "published" },
    ]);
    rawRequest.mockResolvedValueOnce({
      data: {
        list_id: "u-1",
        automations: [{ id: "a1", name: "Welcome", status: "active" }],
      },
      error: null,
    });
    await expect(fetchListAutomations("7")).resolves.toEqual([
      { id: "a1", name: "Welcome", status: "active" },
    ]);
  });

  it.each([
    ["fetchListEngagement", () => fetchListEngagement("7")],
    ["fetchListActivity", () => fetchListActivity("7")],
    ["fetchListSuppressedTotal", () => fetchListSuppressedTotal("7")],
  ])("surfaces a failed %s instead of an empty answer", async (_n, call) => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "boom", status: 500 },
    });
    await expect(call()).rejects.toMatchObject({ message: "boom", status: 500 });
  });
});

describe("fetchPerRowEngagement", () => {
  it("sends deduped ids and parses the rows", async () => {
    rawRequest.mockResolvedValue({
      data: {
        list_id: "u-1",
        rows: [
          {
            id: "s1",
            email: "a@x.com",
            opens: 4,
            clicks: 1,
            last_engaged_at: "2026-08-20T09:00:00Z",
          },
        ],
      },
      error: null,
    });
    const out = await fetchPerRowEngagement("7", ["s1", "s1", null]);
    expect(out.capped).toBe(false);
    expect(out.rows[0]).toMatchObject({ email: "a@x.com", opens: 4 });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/lists/7/per-row-engagement?subscriber_ids=s1",
    );
  });

  it("caps at the server's 500-id limit and SAYS it trimmed", async () => {
    rawRequest.mockResolvedValue({
      data: { list_id: "u-1", rows: [] },
      error: null,
    });
    const ids = Array.from({ length: 600 }, (_, i) => `s${i}`);
    const out = await fetchPerRowEngagement("7", ids);
    expect(out.capped).toBe(true);
    const path = String(rawRequest.mock.calls[0]?.[1]);
    const sent = decodeURIComponent(path.split("subscriber_ids=")[1] ?? "").split(
      ",",
    );
    expect(sent).toHaveLength(500);
  });

  it("never fires with nothing to ask about", async () => {
    const out = await fetchPerRowEngagement("7", [null, undefined, " "]);
    expect(out.rows).toEqual([]);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
