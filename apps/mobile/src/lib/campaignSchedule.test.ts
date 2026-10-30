import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SCHEDULE_PAST_GRACE_MS,
  isScheduleInPast,
  localEquivalentLabel,
  personalizedSendWarning,
  resolvedTimeZone,
  scheduleConfirmLine,
} from "./campaignSchedule";

describe("isScheduleInPast", () => {
  const now = Date.parse("2026-07-25T14:00:00.000Z");

  it("is false for a future time", () => {
    expect(isScheduleInPast(new Date(now + 60_000), now)).toBe(false);
  });

  it("tolerates a small clock skew", () => {
    expect(
      isScheduleInPast(new Date(now - SCHEDULE_PAST_GRACE_MS + 1), now),
    ).toBe(false);
  });

  it("is true once the picked time has genuinely passed", () => {
    expect(
      isScheduleInPast(new Date(now - SCHEDULE_PAST_GRACE_MS - 1), now),
    ).toBe(true);
  });

  it("RE-EVALUATES against the clock passed in — the stale-guard bug", () => {
    // Picked 14:00 while it was 13:59: allowed.
    const picked = new Date(Date.parse("2026-07-25T14:00:00.000Z"));
    expect(isScheduleInPast(picked, Date.parse("2026-07-25T13:59:00.000Z"))).toBe(
      false,
    );
    // Interrupted; tapping Save at 14:05 must now be rejected.
    expect(isScheduleInPast(picked, Date.parse("2026-07-25T14:05:00.000Z"))).toBe(
      true,
    );
  });

  it("treats an invalid date as past rather than letting it through", () => {
    expect(isScheduleInPast(new Date("nope"), now)).toBe(true);
  });
});

describe("scheduleConfirmLine", () => {
  it("always states the zone so it cannot be confused with the UTC hint", () => {
    const line = scheduleConfirmLine(
      new Date("2026-07-25T09:00:00.000Z"),
      "Europe/Lisbon",
    );
    expect(line).toContain("Will send:");
    expect(line).toContain("(Europe/Lisbon)");
  });

  it("degrades gracefully when the runtime reports no zone", () => {
    const line = scheduleConfirmLine(new Date("2026-07-25T09:00:00.000Z"), null);
    expect(line).toContain("Will send:");
    expect(line).not.toContain("(");
  });
});

describe("resolvedTimeZone", () => {
  it("returns a string or null, never throws", () => {
    const zone = resolvedTimeZone();
    expect(zone === null || typeof zone === "string").toBe(true);
  });
});

describe("localEquivalentLabel", () => {
  it("returns null for an absent or malformed timestamp", () => {
    expect(localEquivalentLabel(null)).toBeNull();
    expect(localEquivalentLabel(undefined)).toBeNull();
    expect(localEquivalentLabel("not-a-date")).toBeNull();
  });

  // ── ONE CASE PER DEVICE ZONE, NOT PER MACHINE (TESTS-9) ─────────────────
  // The function decides "same clock, say nothing" by comparing getHours
  // with getUTCHours, and both follow the PROCESS zone. The old cases read
  // whatever zone the runner had and branched on the answer, so CI's UTC
  // runner only ever checked the null path and a laptop only the other one:
  // deleting the UTC guard stayed green everywhere, and dropping the zone
  // name or the "your time" fallback stayed green on CI. Each case below
  // pins its own zone, so every branch runs on every machine.
  //
  // 09:00 UTC is 14:30 in Kolkata (+05:30, no DST): the half-hour offset
  // also catches a label that rendered the UTC clock or rounded the hour.
  const ISO = "2026-07-25T09:00:00.000Z";

  /**
   * The function as a device in `tz` runs it. Node re-reads TZ when it is
   * assigned; the module reset is for lib/format, whose cached Intl
   * formatters keep the zone they were built in.
   */
  async function onHost(tz: string) {
    vi.stubEnv("TZ", tz);
    vi.resetModules();
    return (await import("./campaignSchedule")).localEquivalentLabel;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("states the local clock and the zone name on a device outside UTC", async () => {
    const label = await onHost("Asia/Kolkata");
    // `\s`: newer ICU puts a narrow no-break space before the day period.
    expect(label(ISO, "Asia/Kolkata")).toMatch(/^2:30\sPM Asia\/Kolkata$/u);
  });

  it("says nothing extra on a UTC device — no '9:00 AM UTC (9:00 AM your time)'", async () => {
    const label = await onHost("UTC");
    expect(label(ISO, "UTC")).toBeNull();
    expect(label(ISO, null)).toBeNull();
  });

  it("falls back to 'your time' when the runtime reports no zone name", async () => {
    const label = await onHost("Asia/Kolkata");
    expect(label(ISO, null)).toMatch(/^2:30\sPM your time$/u);
  });
});

describe("personalizedSendWarning", () => {
  it("warns only when per-recipient optimization is configured", () => {
    expect(personalizedSendWarning({ per_recipient_optimize: true })).toContain(
      "best time",
    );
    expect(personalizedSendWarning({ per_recipient_optimize: false })).toBeNull();
    expect(personalizedSendWarning({})).toBeNull();
  });
});
