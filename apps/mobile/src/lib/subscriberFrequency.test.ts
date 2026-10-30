/**
 * subscriberFrequency — the SUB-132 per-person cadence rules.
 *
 * The one rule worth defending hardest: a FUTURE paused_until silences every
 * cadence, so the summary must say "paused" even when the stored preference
 * says weekly — reporting a cadence about someone no send will reach is a lie
 * in the reassuring direction. Plus the wire bodies (server vocabulary, key
 * for key) and the local 1..365 bound that mirrors the server's 422.
 */
import { describe, expect, it } from "vitest";

import {
  buildClearPauseBody,
  buildFrequencyPreferenceBody,
  buildPauseDaysBody,
  frequencyPauseActive,
  frequencyStateFromSubscriber,
  frequencySummary,
} from "./subscriberFrequency";

const NOW = Date.parse("2026-08-30T12:00:00Z");
const FUTURE = "2026-09-15T00:00:00Z";
const PAST = "2026-08-01T00:00:00Z";

describe("frequencyStateFromSubscriber", () => {
  it("reads the two SUB-132 fields off the detail row", () => {
    expect(
      frequencyStateFromSubscriber({
        frequency_preference: "monthly",
        paused_until: FUTURE,
      }),
    ).toEqual({ preference: "monthly", pausedUntil: FUTURE });
  });

  it("treats junk, absent fields and unknown vocab as the default state", () => {
    expect(frequencyStateFromSubscriber(null)).toEqual({
      preference: "default",
      pausedUntil: null,
    });
    expect(
      frequencyStateFromSubscriber({
        frequency_preference: "hourly",
        paused_until: "",
      }),
    ).toEqual({ preference: "default", pausedUntil: null });
  });
});

describe("frequencyPauseActive — the send-time truth", () => {
  it("a named 'paused' preference is paused regardless of expiry", () => {
    expect(
      frequencyPauseActive({ preference: "paused", pausedUntil: null }, NOW),
    ).toBe(true);
  });

  it("a FUTURE paused_until pauses even a 'weekly' preference", () => {
    expect(
      frequencyPauseActive({ preference: "weekly", pausedUntil: FUTURE }, NOW),
    ).toBe(true);
  });

  it("an EXPIRED paused_until does not pause", () => {
    expect(
      frequencyPauseActive({ preference: "weekly", pausedUntil: PAST }, NOW),
    ).toBe(false);
  });
});

describe("frequencySummary — one sentence about what send-time will do", () => {
  it("says paused (not weekly) while a future expiry is in force", () => {
    const s = frequencySummary(
      { preference: "weekly", pausedUntil: FUTURE },
      NOW,
    );
    expect(s).toMatch(/^Paused — excluded from every send until /);
    expect(s).not.toMatch(/week/i);
  });

  it("states the cap for an unpaused cadence", () => {
    expect(
      frequencySummary({ preference: "monthly", pausedUntil: PAST }, NOW),
    ).toBe("Capped at one send per month, on top of workspace caps.");
    expect(
      frequencySummary({ preference: "default", pausedUntil: null }, NOW),
    ).toBe("No personal cap — workspace frequency caps still apply.");
  });
});

describe("wire bodies — server vocabulary, key for key", () => {
  it("cadence choice", () => {
    expect(buildFrequencyPreferenceBody("weekly")).toEqual({
      frequency_preference: "weekly",
    });
  });

  it("pause_days inside 1..365; null outside (mirrors the server's 422)", () => {
    expect(buildPauseDaysBody(30)).toEqual({ pause_days: 30 });
    expect(buildPauseDaysBody(0)).toBeNull();
    expect(buildPauseDaysBody(366)).toBeNull();
    expect(buildPauseDaysBody(2.5)).toBeNull();
    expect(buildPauseDaysBody(Number.NaN)).toBeNull();
  });

  it("clearing the expiry", () => {
    expect(buildClearPauseBody()).toEqual({ clear_paused_until: true });
  });
});
