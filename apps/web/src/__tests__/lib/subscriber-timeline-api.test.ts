// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: { get: mocks.get } }));

import { getSubscriberTimeline } from "@/lib/subscriber-timeline-api";

beforeEach(() => mocks.get.mockReset());

describe("getSubscriberTimeline", () => {
  it("forwards the opaque cursor, bounded page size, and cancellation signal", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValueOnce({
      subscriber_id: "subscriber/with spaces",
      email: "ada@example.com",
      stats: {
        sent_count: 0,
        opened_count: 0,
        clicked_count: 0,
        bounced_count: 0,
        replied_count: 0,
        open_rate: 0,
        click_rate: 0,
        engagement_score: 0,
        subscribed_at: "2026-08-29T08:00:00Z",
        current_status: "active",
      },
      events: [],
      pagination: { limit: 50, has_more: false },
    });

    await getSubscriberTimeline("subscriber/with spaces", {
      cursor: "opaque+/cursor=",
      limit: 50,
      signal,
    });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/subscribers/subscriber%2Fwith%20spaces/timeline",
      {
        query: { cursor: "opaque+/cursor=", limit: 50, category: undefined },
        signal,
      },
    );
  });

  it("sends a server-side category and rejects a response for another subscriber", async () => {
    mocks.get.mockResolvedValueOnce({
      subscriber_id: "different-subscriber",
      email: "ada@example.com",
      stats: {},
      events: [],
      pagination: {},
    });

    await expect(
      getSubscriberTimeline("subscriber-1", { category: "consent" }),
    ).rejects.toThrow("invalid response");
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/subscribers/subscriber-1/timeline",
      expect.objectContaining({
        query: expect.objectContaining({ category: "consent" }),
      }),
    );
  });
});
