import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBSCRIBER_SORT,
  SUBSCRIBER_SORTS,
  subscriberSortAccessibilityLabel,
  subscriberSortByKey,
} from "./subscriberSort";

/**
 * The server's allow-list, transcribed from normalizeSort
 * (apps/api/internal/subscribers/repo_helpers.go). Anything outside it is
 * silently coerced to updated_at, so an option the server does not know
 * would LOOK like it sorted and quietly return default order.
 */
const SERVER_SORT_ALLOWLIST = new Set([
  "email",
  "status",
  "mailchimp_status",
  "joined",
  "created_at",
  "engagement",
  "engagement_score",
  "first_name",
  "last_name",
  "churn",
  "churn_score",
  "rating",
  "updated_at",
]);

describe("SUBSCRIBER_SORTS", () => {
  it("only offers columns the server actually honours", () => {
    for (const option of SUBSCRIBER_SORTS) {
      expect(SERVER_SORT_ALLOWLIST.has(option.sort)).toBe(true);
    }
  });

  it("only sends an order the server parses", () => {
    for (const option of SUBSCRIBER_SORTS) {
      expect(["asc", "desc"]).toContain(option.order);
    }
  });

  it("has unique preference keys", () => {
    const keys = SUBSCRIBER_SORTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("defaults to the server's own default so the first paint matches", () => {
    expect(DEFAULT_SUBSCRIBER_SORT.sort).toBe("updated_at");
    expect(DEFAULT_SUBSCRIBER_SORT.order).toBe("desc");
  });
});

describe("subscriberSortByKey", () => {
  it("resolves a known key", () => {
    expect(subscriberSortByKey("churn").sort).toBe("churn");
    expect(subscriberSortByKey("joined_asc").order).toBe("asc");
  });

  it("falls back for a preference written by an older build", () => {
    expect(subscriberSortByKey("clv")).toBe(DEFAULT_SUBSCRIBER_SORT);
    expect(subscriberSortByKey("")).toBe(DEFAULT_SUBSCRIBER_SORT);
  });
});

describe("subscriberSortAccessibilityLabel", () => {
  it("speaks the active sort and what the control does", () => {
    expect(subscriberSortAccessibilityLabel("churn")).toBe(
      "Sort order: Highest churn risk. Opens the sort options",
    );
  });
});
