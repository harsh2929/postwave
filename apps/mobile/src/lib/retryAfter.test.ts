import { describe, expect, it } from "vitest";

import { MAX_RETRY_AFTER_SECONDS, parseRetryAfterSeconds } from "./retryAfter";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

describe("parseRetryAfterSeconds", () => {
  it("reads the delta-seconds form the bruteforce limiter sends", () => {
    expect(parseRetryAfterSeconds("300", NOW)).toBe(300);
  });

  it("reads the HTTP-date form RFC 9110 also allows", () => {
    expect(
      parseRetryAfterSeconds("Sat, 25 Jul 2026 12:02:00 GMT", NOW),
    ).toBe(120);
  });

  it("ignores an absent, blank or malformed header", () => {
    expect(parseRetryAfterSeconds(null, NOW)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfterSeconds("   ", NOW)).toBeUndefined();
    expect(parseRetryAfterSeconds("soon", NOW)).toBeUndefined();
    expect(parseRetryAfterSeconds("-30", NOW)).toBeUndefined();
    expect(parseRetryAfterSeconds("12.5", NOW)).toBeUndefined();
  });

  it("ignores a date already in the past", () => {
    expect(
      parseRetryAfterSeconds("Sat, 25 Jul 2026 11:59:00 GMT", NOW),
    ).toBeUndefined();
  });

  it("treats zero as no cooldown rather than an armed-forever button", () => {
    expect(parseRetryAfterSeconds("0", NOW)).toBeUndefined();
  });

  it("clamps a hostile header so it cannot disable sign-in for a week", () => {
    expect(parseRetryAfterSeconds("99999999", NOW)).toBe(
      MAX_RETRY_AFTER_SECONDS,
    );
    expect(
      parseRetryAfterSeconds("Sat, 25 Jul 2027 12:00:00 GMT", NOW),
    ).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("rejects an absurdly long header value without parsing it", () => {
    expect(parseRetryAfterSeconds("9".repeat(200), NOW)).toBeUndefined();
  });
});
