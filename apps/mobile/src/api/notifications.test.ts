import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
// The whole module is stubbed: importActual would pull request.ts → sdkClient →
// react-native, which cannot be parsed in the node environment. checkedApiResult
// is reproduced faithfully (reject on envelope error, pass through otherwise).
vi.mock("./request", () => ({
  rawRequest,
  checkedApiResult: async (promise: Promise<{ error: { message: string } | null }>) => {
    const result = await promise;
    if (result.error) throw new Error(result.error.message);
    return result;
  },
}));

const {
  NOTIFICATION_FEED_LIMIT,
  fetchNotificationFeed,
  markFeedAllRead,
  markFeedItemRead,
  markFeedSeen,
  markNotificationRead,
} = await import("./notifications");

const NOW = "2026-07-25T10:00:00.000Z";

const feed = () => ({
  items: [
    { id: "a", kind: "k", title: "A", created_at: NOW },
    { id: "b", kind: "k", title: "B", created_at: NOW, read_at: NOW },
  ],
  unread_count: 1,
});

// A block body: an arrow returning the mock would be treated by vitest as a
// cleanup hook and then CALLED with no arguments after every test.
beforeEach(() => {
  rawRequest.mockReset();
});

describe("fetchNotificationFeed", () => {
  it("asks for the server's maximum page, not a 30-item window", async () => {
    rawRequest.mockResolvedValue({ data: feed(), error: null });
    await fetchNotificationFeed();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      `/api/v1/notifications?limit=${NOTIFICATION_FEED_LIMIT}`,
    );
  });

  it("passes the server-side unread filter through", async () => {
    rawRequest.mockResolvedValue({ data: feed(), error: null });
    await fetchNotificationFeed({ unreadOnly: true, limit: 50 });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/notifications?limit=50&unread=true",
    );
  });

  it("throws instead of rendering a failure as an empty inbox", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "server exploded" },
    });
    await expect(fetchNotificationFeed()).rejects.toThrow("server exploded");
  });

  it("tolerates a malformed payload without crashing the screen", async () => {
    rawRequest.mockResolvedValue({ data: { items: null }, error: null });
    expect(await fetchNotificationFeed()).toEqual({
      items: [],
      unread_count: 0,
    });
  });
});

describe("markNotificationRead", () => {
  it("throws so an optimistic update can roll back", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 409, message: "nope" },
    });
    await expect(markNotificationRead("a")).rejects.toThrow("nope");
  });

  it("encodes the id", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await markNotificationRead("a/b");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/notifications/a%2Fb/read",
    );
  });
});

describe("markFeedItemRead", () => {
  it("stamps the row and decrements the unread count", () => {
    const next = markFeedItemRead(feed(), "a", NOW);
    expect(next?.items[0]?.read_at).toBe(NOW);
    expect(next?.unread_count).toBe(0);
  });

  it("is a no-op for an already-read row, so the count can't go negative", () => {
    const before = feed();
    expect(markFeedItemRead(before, "b", NOW)).toBe(before);
  });

  it("never drives the count below zero", () => {
    const broken = { items: feed().items, unread_count: 0 };
    expect(markFeedItemRead(broken, "a", NOW)?.unread_count).toBe(0);
  });

  it("handles an undefined cache entry", () => {
    expect(markFeedItemRead(undefined, "a", NOW)).toBeUndefined();
  });
});

describe("markFeedAllRead", () => {
  it("clears every row and zeroes the count", () => {
    const next = markFeedAllRead(feed(), NOW);
    expect(next?.items.every((i) => i.read_at)).toBe(true);
    expect(next?.unread_count).toBe(0);
  });
});

describe("markFeedSeen", () => {
  it("stamps seen_at locally so opening the inbox needs no refetch", () => {
    const next = markFeedSeen(feed(), NOW);
    expect(next?.items.every((i) => i.seen_at)).toBe(true);
  });

  it("returns the same object when everything is already seen", () => {
    const seen = {
      items: feed().items.map((i) => ({ ...i, seen_at: NOW })),
      unread_count: 1,
    };
    expect(markFeedSeen(seen, NOW)).toBe(seen);
  });

  it("does not touch read state", () => {
    expect(markFeedSeen(feed(), NOW)?.unread_count).toBe(1);
  });
});
