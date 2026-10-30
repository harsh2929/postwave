// Tests the centralized blog date formatter. Every blog surface (RSS
// feed, post header, sitemap) depends on this; a regression where the
// timezone slips back to the runner's local zone produces off-by-one
// dates on the published feed.

import { describe, expect, it } from "vitest";

import { formatBlogDate } from "@/lib/blog";

describe("formatBlogDate", () => {
  it("renders YYYY-MM-DD as 'Month D, YYYY' in UTC", () => {
    expect(formatBlogDate("2026-04-22")).toBe("April 22, 2026");
  });

  it("does not slip a day for midnight-UTC inputs in negative-offset runners", () => {
    // 2026-01-01 in UTC must remain "January 1, 2026" no matter
    // what TZ the test runner is in. The implementation forces UTC
    // via the timeZone option.
    expect(formatBlogDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("renders December correctly", () => {
    expect(formatBlogDate("2026-12-31")).toBe("December 31, 2026");
  });
});
