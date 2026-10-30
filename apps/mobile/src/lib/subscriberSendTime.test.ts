import { describe, expect, it } from "vitest";

import {
  classifySendTimeFailure,
  computedAt,
  decodeBestHourOfWeek,
  insufficientMessage,
  nextBestSendInstant,
} from "./subscriberSendTime";

describe("decodeBestHourOfWeek — hour of WEEK, not hour of day", () => {
  it("puts Sunday at 0, matching Go's time.Weekday", () => {
    expect(decodeBestHourOfWeek(0)).toEqual({
      hourOfWeek: 0,
      weekdayUTC: 0,
      hourUTC: 0,
      utcLabel: "Sunday 00:00 UTC",
    });
  });

  it("decodes a mid-week hour", () => {
    // Tuesday = weekday 2 → 2*24 + 14 = 62
    expect(decodeBestHourOfWeek(62)).toMatchObject({
      weekdayUTC: 2,
      hourUTC: 14,
      utcLabel: "Tuesday 14:00 UTC",
    });
  });

  it("decodes the last hour of the week", () => {
    expect(decodeBestHourOfWeek(167)).toMatchObject({
      weekdayUTC: 6,
      hourUTC: 23,
      utcLabel: "Saturday 23:00 UTC",
    });
  });

  it("refuses a negative value rather than rendering Sunday midnight", () => {
    // The handler 404s on <0, so a negative reaching the client means a
    // gateway that did not — it must not become a plausible-looking time.
    expect(decodeBestHourOfWeek(-1)).toBeNull();
  });

  it("refuses out-of-range and non-integers", () => {
    expect(decodeBestHourOfWeek(168)).toBeNull();
    expect(decodeBestHourOfWeek(14.5)).toBeNull();
    expect(decodeBestHourOfWeek("14")).toBeNull();
    expect(decodeBestHourOfWeek(undefined)).toBeNull();
  });
});

describe("nextBestSendInstant", () => {
  it("lands on the same hour-of-week the server computed", () => {
    // 2026-07-25T12:34:00Z is a Saturday.
    const now = new Date("2026-07-25T12:34:00Z");
    expect(now.getUTCDay()).toBe(6);
    const next = nextBestSendInstant(62, now); // Tuesday 14:00 UTC
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(2);
    expect(next!.getUTCHours()).toBe(14);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("wraps forward across the week boundary", () => {
    const now = new Date("2026-07-25T12:34:00Z"); // Saturday 12:xx
    const next = nextBestSendInstant(0, now); // Sunday 00:00
    expect(next!.toISOString()).toBe("2026-07-26T00:00:00.000Z");
  });

  it("returns the START of the current hour when the bucket already matches", () => {
    const now = new Date("2026-07-25T12:34:00Z"); // Saturday 12:xx → 6*24+12=156
    const next = nextBestSendInstant(156, now);
    expect(next!.toISOString()).toBe("2026-07-25T12:00:00.000Z");
  });

  it("is null for an out-of-range hour", () => {
    expect(nextBestSendInstant(-1)).toBeNull();
    expect(nextBestSendInstant(168)).toBeNull();
  });
});

describe("computedAt", () => {
  it("treats Go's zero time as absent", () => {
    expect(computedAt("0001-01-01T00:00:00Z")).toBeNull();
  });

  it("keeps a real instant", () => {
    expect(computedAt("2026-07-01T09:00:00Z")).toBe("2026-07-01T09:00:00Z");
  });

  it("is null for junk", () => {
    expect(computedAt("")).toBeNull();
    expect(computedAt("soon")).toBeNull();
    expect(computedAt(undefined)).toBeNull();
  });
});

describe("classifySendTimeFailure", () => {
  it("separates 'not enough signal' from 'no such subscriber'", () => {
    expect(classifySendTimeFailure(404, "insufficient_data")).toBe(
      "insufficient",
    );
    expect(classifySendTimeFailure(404, "not_found")).toBe("missing");
  });

  it("recovers the insufficient case from the BARE error body", () => {
    // The handler writes {"error":"insufficient_data"} — a string, not the
    // {"error":{"code":…}} envelope — so `code` may never reach the client.
    expect(
      classifySendTimeFailure(404, undefined, { error: "insufficient_data" }),
    ).toBe("insufficient");
  });

  it("names a 403 so the card can say 'admin only' instead of 'failed'", () => {
    expect(classifySendTimeFailure(403, "insufficient_role")).toBe("forbidden");
  });

  it("treats everything else as a real error", () => {
    expect(classifySendTimeFailure(500, undefined)).toBe("error");
    expect(classifySendTimeFailure(0, undefined)).toBe("error");
  });
});

describe("insufficientMessage", () => {
  it("names the threshold the handler reported", () => {
    expect(insufficientMessage(5)).toContain("at least 5");
  });

  it("stays honest when the threshold is missing", () => {
    expect(insufficientMessage(undefined)).not.toMatch(/at least/);
    expect(insufficientMessage(undefined)).toMatch(/not enough opens/i);
  });
});
