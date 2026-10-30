import { describe, expect, it } from "vitest";

import type { Review } from "../lib/api/reviews";
import {
  REVIEW_EMBED_MAX_CHARS,
  REVIEW_LIST_CAP,
  REVIEW_REPLY_MAX_CHARS,
  clampRating,
  excerpt,
  isReviewDecidable,
  parseReviewDetail,
  parseReviewEmbedSnippet,
  parseReviewList,
  parseReviewsCatalog,
  parseWidgetList,
  ratingDistribution,
  reviewMatchesQuery,
  safePublicWidgetUrl,
  sortReviewsForQueue,
  starString,
  statusBadgeClass,
  statusBadgeTone,
  statusLabel,
  widgetStatusBadgeTone,
  widgetStatusLabel,
  widgetTypeLabel,
} from "../lib/reviews-helpers";

function wireReview(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "review-1",
    product_id: "product-1",
    review_type: "product",
    reviewer_name: "Ada",
    reviewer_email: "ada@example.test",
    rating: 5,
    title: "Excellent",
    body: "Thoughtful review body",
    status: "pending",
    verified_buyer: true,
    incentivized: false,
    featured: false,
    submitted_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function parsedReview(overrides: Record<string, unknown> = {}): Review {
  const parsed = parseReviewDetail(wireReview(overrides)).review;
  if (!parsed) throw new Error("Fixture must parse");
  return parsed;
}

describe("Reviews wire limits", () => {
  it("pins user-visible limits to the audited server contracts", () => {
    expect(REVIEW_LIST_CAP).toBe(200);
    expect(REVIEW_REPLY_MAX_CHARS).toBe(4_000);
    expect(REVIEW_EMBED_MAX_CHARS).toBe(32_768);
  });
});

describe("parseReviewList", () => {
  it("parses exact backend tags and preserves unknown status truth", () => {
    const parsed = parseReviewList({
      items: [
        wireReview({
          tenant_id: "tenant-1",
          request_id: "request-1",
          order_id: "order-1",
          customer_id: "customer-1",
          source_platform: "shopify",
          source_ref: "gid://review/1",
          status: "awaiting_legal",
          metadata: { locale: "en" },
          raw_payload: { provider: true },
        }),
      ],
    });

    expect(parsed).toMatchObject({
      envelopeValid: true,
      invalidCount: 0,
      items: [
        {
          id: "review-1",
          tenant_id: "tenant-1",
          request_id: "request-1",
          order_id: "order-1",
          customer_id: "customer-1",
          source_platform: "shopify",
          source_ref: "gid://review/1",
          status: "awaiting_legal",
          metadata: { locale: "en" },
          raw_payload: { provider: true },
        },
      ],
    });
  });

  it("drops malformed rows, reports each one, and retains sound rows", () => {
    const parsed = parseReviewList({
      items: [
        wireReview(),
        wireReview({ id: "" }),
        wireReview({ rating: 4.5 }),
        wireReview({ verified_buyer: "true" }),
        wireReview({ status: "" }),
      ],
    });

    expect(parsed.envelopeValid).toBe(true);
    expect(parsed.items.map((review) => review.id)).toEqual(["review-1"]);
    expect(parsed.invalidCount).toBe(4);
  });

  it("rejects malformed and over-cap envelopes rather than inventing emptiness", () => {
    expect(parseReviewList(null)).toEqual({
      items: [],
      invalidCount: 1,
      envelopeValid: false,
    });
    expect(parseReviewList([]).envelopeValid).toBe(false);
    expect(parseReviewList({ data: [] }).envelopeValid).toBe(false);

    const oversized = {
      items: Array.from({ length: REVIEW_LIST_CAP + 1 }, (_, index) =>
        wireReview({ id: `review-${index}` }),
      ),
    };
    expect(parseReviewList(oversized)).toEqual({
      items: [],
      invalidCount: REVIEW_LIST_CAP + 1,
      envelopeValid: false,
    });
  });

  it("rejects oversized display strings and malformed object fields", () => {
    expect(
      parseReviewList({
        items: [
          wireReview({ title: "x".repeat(1_025) }),
          wireReview({ body: "x".repeat(32_769) }),
          wireReview({ metadata: [] }),
        ],
      }),
    ).toMatchObject({ items: [], invalidCount: 3, envelopeValid: true });
  });
});

describe("parseReviewDetail", () => {
  it("distinguishes replies not loaded from a loaded empty set", () => {
    expect(
      parseReviewDetail(wireReview()).review?.public_replies,
    ).toBeUndefined();
    expect(
      parseReviewDetail(wireReview({ public_replies: [] })).review
        ?.public_replies,
    ).toEqual([]);
  });

  it("parses reply status and backend metadata fields", () => {
    const parsed = parseReviewDetail(
      wireReview({
        public_replies: [
          {
            id: "reply-1",
            tenant_id: "tenant-1",
            review_id: "review-1",
            author: "Store owner",
            body: "Thank you.",
            status: "published",
            metadata: { channel: "desktop" },
            created_at: "2026-07-02T00:00:00Z",
            updated_at: "2026-07-02T01:00:00Z",
          },
        ],
      }),
    );

    expect(parsed.invalidCount).toBe(0);
    expect(parsed.review?.public_replies?.[0]).toMatchObject({
      id: "reply-1",
      status: "published",
      metadata: { channel: "desktop" },
    });
  });

  it("rejects the detail if a reply is malformed or oversized", () => {
    for (const reply of [
      { id: "reply-1", body: "Missing status" },
      {
        id: "reply-1",
        body: "x".repeat(REVIEW_REPLY_MAX_CHARS + 1),
        status: "published",
      },
      "not an object",
    ]) {
      expect(
        parseReviewDetail(wireReview({ public_replies: [reply] })),
      ).toEqual({ review: null, invalidCount: 1 });
    }
  });
});

describe("parseWidgetList", () => {
  it("requires identity, name, status and type and preserves metadata", () => {
    const parsed = parseWidgetList({
      items: [
        {
          id: "widget-1",
          tenant_id: "tenant-1",
          slug: "home-reviews",
          name: "Homepage reviews",
          status: "scheduled_future_state",
          widget_type: "product_reviews",
          metadata: { owner: "growth" },
          public_url: "https://reviews.example.test/home-reviews",
        },
        {
          id: "widget-2",
          name: "Missing type",
          status: "draft",
        },
      ],
    });

    expect(parsed.envelopeValid).toBe(true);
    expect(parsed.invalidCount).toBe(1);
    expect(parsed.items).toEqual([
      expect.objectContaining({
        id: "widget-1",
        status: "scheduled_future_state",
        metadata: { owner: "growth" },
      }),
    ]);
  });

  it("rejects malformed envelopes, malformed records and oversized names", () => {
    expect(parseWidgetList({ items: "nope" }).envelopeValid).toBe(false);
    expect(
      parseWidgetList({
        items: [
          null,
          {
            id: "widget-1",
            name: "x".repeat(257),
            status: "draft",
            widget_type: "summary",
          },
          {
            id: "widget-2",
            name: "Good",
            status: "draft",
            widget_type: "summary",
            metadata: [],
          },
        ],
      }),
    ).toMatchObject({ items: [], invalidCount: 3, envelopeValid: true });
  });
});

describe("parseReviewsCatalog", () => {
  it("preserves unknown enum strings and reports invalid or duplicate values", () => {
    const parsed = parseReviewsCatalog({
      schema_version: "klv11.reviews.v1",
      statuses: ["pending", "future_state", "", "pending", 42],
      widget_types: ["summary", "future_widget"],
      review_types: ["product", "future_review_type"],
      public_contract: "Approved reviews only.",
    });

    expect(parsed.catalog).toMatchObject({
      statuses: ["pending", "future_state"],
      widget_types: ["summary", "future_widget"],
      review_types: ["product", "future_review_type"],
      public_contract: "Approved reviews only.",
    });
    expect(parsed.invalidCount).toBe(3);
  });

  it("rejects malformed envelopes and missing required catalogs", () => {
    expect(parseReviewsCatalog(null)).toEqual({
      catalog: null,
      invalidCount: 1,
    });
    expect(
      parseReviewsCatalog({ statuses: [], widget_types: ["summary"] }),
    ).toEqual({ catalog: null, invalidCount: 1 });
    expect(
      parseReviewsCatalog({ statuses: ["pending"], widget_types: "summary" }),
    ).toEqual({ catalog: null, invalidCount: 1 });
  });
});

describe("review search and queue ordering", () => {
  it("searches review content/context without indexing direct PII or correlation IDs", () => {
    const review = parsedReview({
      reviewer_name: "Private Person",
      reviewer_email: "secret@example.test",
      customer_id: "customer-sensitive",
      order_id: "order-sensitive",
      request_id: "request-sensitive",
      source_ref: "source-sensitive",
      body: "Durable and bright",
      product_id: "lamp-42",
      source_platform: "shopify",
    });

    expect(reviewMatchesQuery(review, "durable")).toBe(true);
    expect(reviewMatchesQuery(review, "lamp-42")).toBe(true);
    expect(reviewMatchesQuery(review, "SHOPIFY")).toBe(true);
    for (const pii of [
      "Private Person",
      "secret@example.test",
      "customer-sensitive",
      "order-sensitive",
      "request-sensitive",
      "source-sensitive",
    ]) {
      expect(reviewMatchesQuery(review, pii)).toBe(false);
    }
  });

  it("sorts pending queue work oldest-first and decided history newest-first", () => {
    const newest = parsedReview({
      id: "newest",
      submitted_at: "2026-07-03T00:00:00Z",
    });
    const oldest = parsedReview({
      id: "oldest",
      submitted_at: "2026-07-01T00:00:00Z",
    });
    const middle = parsedReview({
      id: "middle",
      submitted_at: "2026-07-02T00:00:00Z",
    });
    const source = [newest, oldest, middle];

    expect(
      sortReviewsForQueue(source, "pending").map((review) => review.id),
    ).toEqual(["oldest", "middle", "newest"]);
    expect(
      sortReviewsForQueue(source, "approved").map((review) => review.id),
    ).toEqual(["newest", "middle", "oldest"]);
    expect(source.map((review) => review.id)).toEqual([
      "newest",
      "oldest",
      "middle",
    ]);
  });

  it("honors explicit directions and leaves missing timestamps stable at the end", () => {
    const missingA = parsedReview({ id: "missing-a", submitted_at: undefined });
    const dated = parsedReview({
      id: "dated",
      submitted_at: "2026-07-02T00:00:00Z",
    });
    const missingB = parsedReview({ id: "missing-b", submitted_at: undefined });

    expect(
      sortReviewsForQueue([missingA, dated, missingB], "pending", "newest").map(
        (review) => review.id,
      ),
    ).toEqual(["dated", "missing-a", "missing-b"]);
    expect(sortReviewsForQueue([dated], "pending", "oldest")).not.toBe([dated]);
  });
});

describe("safe widget outputs", () => {
  it("allows absolute HTTP(S) widget URLs without credentials", () => {
    expect(
      safePublicWidgetUrl(" https://reviews.example.test/widget?q=1 "),
    ).toBe("https://reviews.example.test/widget?q=1");
    expect(safePublicWidgetUrl("http://localhost:8080/widget")).toBe(
      "http://localhost:8080/widget",
    );
  });

  it("rejects unsafe, relative, credentialed and oversized URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "/api/public/reviews/widget",
      "https://user:secret@example.test/widget",
      "https://",
      "x".repeat(4_097),
      null,
    ]) {
      expect(safePublicWidgetUrl(value)).toBeNull();
    }
  });

  it("validates non-empty bounded embed snippets without rewriting them", () => {
    expect(parseReviewEmbedSnippet("<iframe />")).toEqual({
      ok: true,
      snippet: "<iframe />",
    });
    expect(parseReviewEmbedSnippet("")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(parseReviewEmbedSnippet(" \n ")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(parseReviewEmbedSnippet({ snippet: "wrong shape" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      parseReviewEmbedSnippet("x".repeat(REVIEW_EMBED_MAX_CHARS + 1)),
    ).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("review presentation helpers", () => {
  it("calls the approved publication state Published and preserves unknowns", () => {
    expect(statusLabel("approved")).toBe("Published");
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("future_state")).toBe("future_state");
    expect(statusLabel("")).toBe("—");
    expect(statusBadgeTone("approved")).toBe("success");
    expect(statusBadgeTone("pending")).toBe("warning");
    expect(statusBadgeTone("rejected")).toBe("danger");
    expect(statusBadgeClass("approved")).toBe("badge success");
    expect(isReviewDecidable(parsedReview())).toBe(true);
    expect(isReviewDecidable(parsedReview({ status: "approved" }))).toBe(false);
  });

  it("uses a widget-specific status vocabulary and tone", () => {
    expect(widgetStatusLabel("active")).toBe("Active");
    expect(widgetStatusLabel("draft")).toBe("Draft");
    expect(widgetStatusLabel("paused")).toBe("Paused");
    expect(widgetStatusLabel("future_state")).toBe("future_state");
    expect(widgetStatusBadgeTone("active")).toBe("success");
    expect(widgetStatusBadgeTone("draft")).toBe("warning");
    expect(widgetStatusBadgeTone("archived")).toBe("neutral");
  });

  it("labels known widget types and humanises unknown keys", () => {
    expect(widgetTypeLabel("star_rating")).toBe("Star rating");
    expect(widgetTypeLabel("featured_carousel")).toBe("Featured carousel");
    expect(widgetTypeLabel("qna")).toBe("Q&A");
    expect(widgetTypeLabel("brand_new_type")).toBe("Brand New Type");
  });
});

describe("rating and excerpt helpers", () => {
  it("clamps ratings and always renders exactly five stars", () => {
    expect(clampRating(4.5)).toBe(5);
    expect(clampRating(-3)).toBe(0);
    expect(clampRating(Infinity)).toBe(0);
    expect(starString(3)).toBe("★★★☆☆");
    expect(Array.from(starString(99))).toHaveLength(5);
  });

  it("normalizes whitespace and truncates without splitting graphemes", () => {
    expect(excerpt("Great   product\n\nlove it")).toBe("Great product love it");
    expect(excerpt("👩‍💻works", 1)).toBe("👩‍💻…");
    expect(excerpt("a\u0301b", 1)).toBe("a\u0301…");
    expect(excerpt("anything", 0)).toBe("");
  });

  it("normalizes rating distribution and rejects invalid counts", () => {
    const distribution = ratingDistribution({
      "5": 10,
      "3": 2,
      "1": -1,
    });
    expect(distribution).toEqual([
      { star: 5, count: 10 },
      { star: 4, count: 0 },
      { star: 3, count: 2 },
      { star: 2, count: 0 },
      { star: 1, count: 0 },
    ]);
    expect(ratingDistribution(null).every(({ count }) => count === 0)).toBe(
      true,
    );
  });
});
