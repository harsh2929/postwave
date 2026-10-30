import { describe, expect, it } from "vitest";

import {
  SESSION_EXPIRY_MAX_NOTICE_DAYS,
  SESSION_EXPIRY_URGENT_MINUTES,
  sessionExpiryNotice,
} from "./sessionExpiryNotice";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe("sessionExpiryNotice", () => {
  it("says nothing when there is no substantiated deadline", () => {
    // A security row must never invent an expiry it cannot prove.
    expect(sessionExpiryNotice(undefined, NOW)).toBeNull();
    expect(sessionExpiryNotice(null, NOW)).toBeNull();
    expect(sessionExpiryNotice("", NOW)).toBeNull();
    expect(sessionExpiryNotice("   ", NOW)).toBeNull();
    expect(sessionExpiryNotice("not-a-date", NOW)).toBeNull();
    expect(sessionExpiryNotice(12345, NOW)).toBeNull();
  });

  it("says nothing when `now` is unusable", () => {
    expect(sessionExpiryNotice(at(HOUR), Number.NaN)).toBeNull();
    expect(sessionExpiryNotice(at(HOUR), Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("reports an already-expired session as expired and urgent", () => {
    const past = sessionExpiryNotice(at(-1), NOW);
    expect(past).toEqual({
      text: "Session expired",
      spoken: "This session has expired",
      urgent: true,
    });
    // Exactly at the boundary counts as gone, not as "expires in 0 minutes".
    expect(sessionExpiryNotice(at(0), NOW)?.text).toBe("Session expired");
  });

  it("rounds sub-minute remainders UP so it never reads '0 minutes'", () => {
    expect(sessionExpiryNotice(at(1_000), NOW)?.text).toBe(
      "Expires in 1 minute",
    );
    expect(sessionExpiryNotice(at(30_000), NOW)?.text).toBe(
      "Expires in 1 minute",
    );
  });

  it("pluralises correctly at each unit", () => {
    expect(sessionExpiryNotice(at(2 * MINUTE), NOW)?.text).toBe(
      "Expires in 2 minutes",
    );
    expect(sessionExpiryNotice(at(HOUR), NOW)?.text).toBe("Expires in 1 hour");
    expect(sessionExpiryNotice(at(3 * HOUR), NOW)?.text).toBe(
      "Expires in 3 hours",
    );
    expect(sessionExpiryNotice(at(DAY), NOW)?.text).toBe("Expires in 1 day");
    expect(sessionExpiryNotice(at(3 * DAY), NOW)?.text).toBe(
      "Expires in 3 days",
    );
  });

  it("rounds DOWN above an hour so it never promises time that is gone", () => {
    // 119 minutes is 1 hour, not 2 — overstating is the error that costs work.
    expect(sessionExpiryNotice(at(119 * MINUTE), NOW)?.text).toBe(
      "Expires in 1 hour",
    );
    expect(sessionExpiryNotice(at(DAY + 23 * HOUR), NOW)?.text).toBe(
      "Expires in 1 day",
    );
  });

  it("marks urgent exactly at the documented threshold, not past it", () => {
    const boundary = sessionExpiryNotice(
      at(SESSION_EXPIRY_URGENT_MINUTES * MINUTE),
      NOW,
    );
    expect(boundary?.urgent).toBe(true);
    const justOver = sessionExpiryNotice(
      at(SESSION_EXPIRY_URGENT_MINUTES * MINUTE + 1),
      NOW,
    );
    expect(justOver?.urgent).toBe(false);
  });

  it("falls silent beyond the notice horizon", () => {
    const inside = sessionExpiryNotice(
      at(SESSION_EXPIRY_MAX_NOTICE_DAYS * DAY),
      NOW,
    );
    expect(inside?.text).toBe(`Expires in ${SESSION_EXPIRY_MAX_NOTICE_DAYS} days`);
    // "Expires in 87 days" teaches the user to ignore the line that matters
    // at 10 minutes.
    expect(
      sessionExpiryNotice(at(SESSION_EXPIRY_MAX_NOTICE_DAYS * DAY + 1), NOW),
    ).toBeNull();
  });

  it("never compacts the spoken form", () => {
    const notice = sessionExpiryNotice(at(42 * MINUTE), NOW);
    expect(notice?.text).toBe("Expires in 42 minutes");
    expect(notice?.spoken).toBe("This session expires in 42 minutes");
  });
});
