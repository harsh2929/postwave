import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listSubscriberTopics,
  normalizeSubscriberTopics,
  setSubscriberTopic,
  subscriberTopicTogglePath,
  subscriberTopicsPath,
} from "./topics";
import { rawRequest } from "./request";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const VIEW = {
  topic: {
    id: "t-1",
    tenantId: "ten-1",
    slug: "product-news",
    name: "Product news",
    description: "Releases and changelogs.",
    defaultOptIn: true,
    displayOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  optedIn: false,
};

describe("subscriber topic normalization", () => {
  it("flattens the server's {topic, optedIn} envelope", () => {
    expect(normalizeSubscriberTopics([VIEW])).toEqual([
      {
        id: "t-1",
        slug: "product-news",
        name: "Product news",
        description: "Releases and changelogs.",
        optedIn: false,
        defaultOptIn: true,
      },
    ]);
  });

  it("never invents an opt-in from a missing field", () => {
    const [row] = normalizeSubscriberTopics([
      { topic: { id: "t-2", slug: "x", name: "X" } },
    ]);
    // `optedIn` absent must read as NOT opted in. A truthiness bug here is a
    // claim that somebody consented.
    expect(row?.optedIn).toBe(false);
    expect(row?.defaultOptIn).toBe(false);
  });

  it("addresses a nameless topic by its slug rather than by nothing", () => {
    const [row] = normalizeSubscriberTopics([
      { topic: { id: "t-3", slug: "weekly" }, optedIn: true },
    ]);
    expect(row?.name).toBe("weekly");
  });

  it("drops rows with no id, since their switch could not post anywhere", () => {
    expect(
      normalizeSubscriberTopics([{ topic: { slug: "no-id" }, optedIn: true }]),
    ).toEqual([]);
  });

  it("tolerates an items envelope and refuses anything else", () => {
    expect(normalizeSubscriberTopics({ items: [VIEW] })).toHaveLength(1);
    expect(normalizeSubscriberTopics(null)).toEqual([]);
    expect(normalizeSubscriberTopics("<html>")).toEqual([]);
  });
});

describe("subscriber topic paths", () => {
  it("escapes the address, which is a route parameter here", () => {
    expect(subscriberTopicsPath("a+b@example.com")).toBe(
      "/api/v1/subscribers/a%2Bb%40example.com/topics",
    );
  });

  it("names the verb the server actually mounts", () => {
    expect(subscriberTopicTogglePath("a@b.com", "t-1", true)).toBe(
      "/api/v1/subscribers/a%40b.com/topics/t-1/subscribe",
    );
    expect(subscriberTopicTogglePath("a@b.com", "t-1", false)).toBe(
      "/api/v1/subscribers/a%40b.com/topics/t-1/unsubscribe",
    );
  });
});

describe("subscriber topic transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads through the per-subscriber route and normalizes the body", async () => {
    vi.mocked(rawRequest).mockResolvedValue({ data: [VIEW], error: null });

    const res = await listSubscriberTopics("ops@example.com");

    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/ops%40example.com/topics",
    );
    expect(res.data?.[0]?.name).toBe("Product news");
  });

  it("passes a read failure through instead of reporting no topics", async () => {
    vi.mocked(rawRequest).mockResolvedValue({
      data: null,
      error: { status: 500, message: "boom" },
    });

    const res = await listSubscriberTopics("ops@example.com");

    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(500);
  });

  it("sets one topic without submitting the whole array", async () => {
    vi.mocked(rawRequest).mockResolvedValue({ data: { ok: true }, error: null });

    await setSubscriberTopic("ops@example.com", "t-1", false);

    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/subscribers/ops%40example.com/topics/t-1/unsubscribe",
      {},
    );
  });
});
