import { describe, expect, it } from "vitest";

import {
  clampRating,
  isDecidable,
  moderationCopy,
  moderationSuccessMessage,
  orderForQueue,
  parseReview,
  parseReviewList,
  parseReviewReply,
  ratingLabel,
  ratingStars,
  replyDraftState,
  REPLY_MAX_CHARACTERS,
  reviewPreview,
  reviewQueueCounts,
  reviewStatusPresentation,
  reviewerLabel,
  type MobileReview,
} from "./reviewQueue";

function review(overrides: Partial<MobileReview> = {}): MobileReview {
  return {
    id: "r1",
    productId: "p1",
    reviewerName: "Ada",
    rating: 4,
    title: "Great",
    body: "Works well",
    status: "pending",
    verifiedBuyer: false,
    incentivized: false,
    featured: false,
    sourcePlatform: "postwave",
    moderationReason: "",
    submittedAt: "2026-07-01T00:00:00Z",
    publishedAt: null,
    replies: null,
    ...overrides,
  };
}

describe("parseReviewList", () => {
  it("reads the server's {items:[…]} envelope", () => {
    const rows = parseReviewList({
      items: [
        { id: "a", rating: 5, status: "pending" },
        { id: "b", rating: 1, status: "approved" },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("accepts a bare array so an envelope change cannot silently empty the queue", () => {
    expect(parseReviewList([{ id: "a" }])).toHaveLength(1);
  });

  it("drops rows with no id rather than rendering an unactionable row", () => {
    expect(parseReviewList({ items: [{ rating: 5 }, { id: "" }] })).toEqual([]);
  });

  it("returns [] for a null / unexpected payload", () => {
    expect(parseReviewList(null)).toEqual([]);
    expect(parseReviewList({ data: [{ id: "a" }] })).toEqual([]);
  });
});

describe("parseReview", () => {
  it("distinguishes 'replies not loaded' from 'no replies'", () => {
    // The LIST read never selects replies (repo.go ListReviews), so absent
    // must not be reported as an empty set.
    expect(parseReview({ id: "a" })?.replies).toBeNull();
    expect(parseReview({ id: "a", public_replies: [] })?.replies).toEqual([]);
  });

  it("parses replies from the single-review read", () => {
    const parsed = parseReview({
      id: "a",
      public_replies: [
        { id: "x", body: "Thanks!", author: "", created_at: "2026-07-02T10:00:00Z" },
        { id: "", body: "dropped" },
      ],
    });
    expect(parsed?.replies).toEqual([
      {
        id: "x",
        author: "Store owner",
        body: "Thanks!",
        status: "published",
        createdAt: "2026-07-02T10:00:00Z",
      },
    ]);
  });

  it("treats Go's zero time as absent rather than as the year 1", () => {
    const parsed = parseReview({
      id: "a",
      published_at: "0001-01-01T00:00:00Z",
      submitted_at: "not a date",
    });
    expect(parsed?.publishedAt).toBeNull();
    expect(parsed?.submittedAt).toBeNull();
  });

  it("defaults a missing status to pending, never to approved", () => {
    expect(parseReview({ id: "a" })?.status).toBe("pending");
  });

  it("coerces only literal true for the authenticity flags", () => {
    const parsed = parseReview({ id: "a", verified_buyer: "yes", featured: 1 });
    expect(parsed?.verifiedBuyer).toBe(false);
    expect(parsed?.featured).toBe(false);
  });
});

describe("parseReviewReply", () => {
  it("requires an id and a body", () => {
    expect(parseReviewReply({ id: "x" })).toBeNull();
    expect(parseReviewReply({ body: "hi" })).toBeNull();
  });
});

describe("clampRating", () => {
  it("clamps out-of-range and non-numeric ratings", () => {
    expect(clampRating(9)).toBe(5);
    expect(clampRating(-3)).toBe(0);
    expect(clampRating(4.6)).toBe(5);
    expect(clampRating("3")).toBe(3);
    expect(clampRating(null)).toBe(0);
    expect(clampRating(Number.NaN)).toBe(0);
  });
});

describe("ratingStars / ratingLabel", () => {
  it("always renders five glyphs", () => {
    expect(ratingStars(3)).toBe("★★★☆☆");
    expect(ratingStars(0)).toBe("☆☆☆☆☆");
    expect(ratingStars(99)).toBe("★★★★★");
  });

  it("gives screen readers words instead of glyphs", () => {
    expect(ratingLabel(1)).toBe("1 star out of 5");
    expect(ratingLabel(4)).toBe("4 stars out of 5");
  });
});

describe("reviewStatusPresentation", () => {
  it("maps the server's statuses", () => {
    expect(reviewStatusPresentation("approved")).toEqual({
      label: "Published",
      tone: "success",
    });
    expect(reviewStatusPresentation("PENDING").tone).toBe("warning");
    expect(reviewStatusPresentation("spam").tone).toBe("danger");
  });

  it("never lets an unknown status read as approved", () => {
    const unknown = reviewStatusPresentation("quarantined");
    expect(unknown.label).toBe("quarantined");
    expect(unknown.tone).toBe("neutral");
    expect(reviewStatusPresentation("  ").label).toBe("Unknown");
  });
});

describe("reviewPreview / reviewerLabel", () => {
  it("prefers the title and collapses whitespace", () => {
    expect(reviewPreview(review({ title: "A\n  B" }))).toBe("A B");
  });

  it("falls back to the body, then to an honest placeholder", () => {
    expect(reviewPreview(review({ title: "", body: "Body text" }))).toBe(
      "Body text",
    );
    expect(reviewPreview(review({ title: "", body: "" }))).toBe(
      "No written review",
    );
  });

  it("truncates to the requested length", () => {
    const long = reviewPreview(review({ title: "x".repeat(200) }), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });

  it("labels an unnamed reviewer as Anonymous", () => {
    expect(reviewerLabel(review({ reviewerName: "" }))).toBe("Anonymous");
  });
});

describe("reviewQueueCounts", () => {
  it("counts only the three triage statuses", () => {
    expect(
      reviewQueueCounts([
        review({ status: "pending" }),
        review({ status: "Pending" }),
        review({ status: "approved" }),
        review({ status: "spam" }),
      ]),
    ).toEqual({ pending: 2, approved: 1, rejected: 0 });
  });
});

describe("orderForQueue", () => {
  const older = review({ id: "old", submittedAt: "2026-01-01T00:00:00Z" });
  const newer = review({ id: "new", submittedAt: "2026-06-01T00:00:00Z" });

  it("serves the longest-waiting review first in the pending queue", () => {
    expect(orderForQueue([newer, older], "pending").map((r) => r.id)).toEqual([
      "old",
      "new",
    ]);
  });

  it("keeps decided lists newest-first, matching the server's order", () => {
    expect(orderForQueue([older, newer], "approved").map((r) => r.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("sorts undated rows last so junk data never heads the work queue", () => {
    const undated = review({ id: "undated", submittedAt: null });
    expect(
      orderForQueue([undated, newer, older], "pending").map((r) => r.id),
    ).toEqual(["old", "new", "undated"]);
  });

  it("does not mutate its input", () => {
    const rows = [newer, older];
    orderForQueue(rows, "pending");
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("isDecidable", () => {
  it("is true only for pending", () => {
    expect(isDecidable(review({ status: "pending" }))).toBe(true);
    expect(isDecidable(review({ status: " Pending " }))).toBe(true);
    expect(isDecidable(review({ status: "approved" }))).toBe(false);
  });
});

describe("replyDraftState", () => {
  it("blocks offline with an explanation instead of failing late", () => {
    const state = replyDraftState("hello", { sending: false, online: false });
    expect(state.canSend).toBe(false);
    expect(state.reason).toMatch(/offline/i);
  });

  it("blocks an empty or whitespace-only draft with no scolding copy", () => {
    expect(replyDraftState("   ", { sending: false, online: true })).toEqual({
      canSend: false,
      reason: null,
      characters: 3,
    });
  });

  it("blocks while a send is in flight", () => {
    expect(
      replyDraftState("hi", { sending: true, online: true }).canSend,
    ).toBe(false);
  });

  it("enforces the length cap client-side", () => {
    const state = replyDraftState("x".repeat(REPLY_MAX_CHARACTERS + 1), {
      sending: false,
      online: true,
    });
    expect(state.canSend).toBe(false);
    expect(state.reason).toMatch(/capped/i);
  });

  it("allows a normal draft", () => {
    expect(replyDraftState("Thanks!", { sending: false, online: true })).toEqual(
      { canSend: true, reason: null, characters: 7 },
    );
  });
});

describe("moderationCopy", () => {
  it("tells the operator that approving publishes publicly", () => {
    const copy = moderationCopy("approve", review({ reviewerName: "Ada" }));
    expect(copy.title).toBe("Publish Ada's review?");
    expect(copy.consequence).toMatch(/publicly visible/i);
    expect(copy.destructive).toBe(false);
  });

  it("states the one-way nature of reject, since no endpoint restores pending", () => {
    const copy = moderationCopy("reject", review());
    expect(copy.message).toMatch(/cannot be returned to the queue/i);
    expect(copy.destructive).toBe(true);
  });

  it("uses Anonymous when there is no reviewer name", () => {
    expect(moderationCopy("approve", review({ reviewerName: "" })).title).toBe(
      "Publish Anonymous's review?",
    );
  });
});

describe("moderationSuccessMessage", () => {
  it("reports what actually happened", () => {
    expect(moderationSuccessMessage("approve", review())).toBe(
      "Published Ada's review.",
    );
    expect(moderationSuccessMessage("reject", review())).toBe(
      "Rejected Ada's review.",
    );
  });
});
