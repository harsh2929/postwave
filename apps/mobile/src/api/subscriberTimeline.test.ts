import { describe, expect, it, vi } from "vitest";

// The module pulls in the RN-bound SDK client factory; the tests here only
// exercise the pure helpers.
vi.mock("@/api/sdkClient", () => ({ getClient: vi.fn() }));

// eslint-disable-next-line import/first
import {
  errorStatus,
  isTimelineUnavailableStatus,
  TIMELINE_AUTO_PAGE_LIMIT,
  TIMELINE_PAGE_SIZE,
  timelinePath,
} from "./subscriberTimeline";

describe("timelinePath", () => {
  it("omits the cursor on the first page", () => {
    expect(timelinePath("abc", null)).toBe(
      `/api/v1/subscribers/abc/timeline?limit=${TIMELINE_PAGE_SIZE}`,
    );
  });

  it("sends the opaque cursor as `cursor`, never as `before`", () => {
    // `pagination.next_cursor` is base64(JSON) — the server's `before`
    // parameter is parsed with time.Parse(RFC3339) and answers 400
    // bad_before for anything else, which silently truncated the timeline
    // at page 1.
    const nextCursor = "eyJhdCI6IjIwMjYtMDEtMDFUMDA6MDA6MDBaIn0";
    const path = timelinePath("abc", nextCursor);
    expect(path).toContain(`cursor=${nextCursor}`);
    expect(path).not.toContain("before=");
  });

  it("percent-encodes an id that is not URL-safe", () => {
    // The route param falls back to an EMAIL when a row has no id.
    expect(timelinePath("a b@c.com", null)).toContain(
      "/api/v1/subscribers/a%20b%40c.com/timeline",
    );
  });

  it("encodes a cursor containing reserved characters", () => {
    const path = timelinePath("abc", "2026-01-01T00:00:00Z|17");
    expect(path).toContain("cursor=2026-01-01T00%3A00%3A00Z%7C17");
  });
});

describe("isTimelineUnavailableStatus", () => {
  it("treats only 'endpoint not present' statuses as unavailable", () => {
    expect(isTimelineUnavailableStatus(404)).toBe(true);
    expect(isTimelineUnavailableStatus(405)).toBe(true);
    expect(isTimelineUnavailableStatus(501)).toBe(true);
  });

  it("does NOT swallow a real failure as 'unavailable'", () => {
    // A 500 or a 401 must reach the user as an error, not as a muted
    // "this deployment doesn't support timelines" notice.
    for (const status of [0, 401, 403, 429, 500, 502, 503]) {
      expect(isTimelineUnavailableStatus(status)).toBe(false);
    }
  });
});

describe("errorStatus", () => {
  it("reads a numeric status off an SDK error", () => {
    expect(errorStatus({ status: 503 })).toBe(503);
  });

  it("reads a numeric-string status", () => {
    expect(errorStatus({ status: "404" })).toBe(404);
  });

  it("returns 0 for anything without a usable status", () => {
    expect(errorStatus(new Error("network"))).toBe(0);
    expect(errorStatus(null)).toBe(0);
    expect(errorStatus(undefined)).toBe(0);
    expect(errorStatus("boom")).toBe(0);
    expect(errorStatus({ status: "not-a-number" })).toBe(0);
  });
});

describe("paging constants", () => {
  it("bounds auto-paging well below unbounded accumulation", () => {
    expect(TIMELINE_AUTO_PAGE_LIMIT).toBeGreaterThan(1);
    expect(TIMELINE_AUTO_PAGE_LIMIT * TIMELINE_PAGE_SIZE).toBeLessThanOrEqual(
      1000,
    );
  });
});
