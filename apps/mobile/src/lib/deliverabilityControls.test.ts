import { describe, expect, it } from "vitest";

import {
  isSendWindowTier,
  parseSendWindow,
  pushSummary,
  sendWindowSummary,
} from "./deliverabilityControls";
import type { PushSuppressionRow } from "./pushSuppressions";

describe("parseSendWindow", () => {
  it("reads the GET envelope, which wraps the policy", () => {
    const policy = parseSendWindow({
      policy: {
        start_local: "09:00",
        end_local: "17:30",
        timezone: "Europe/Berlin",
        weekday_bitmap: 62,
        weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        enforcement: "block",
      },
    });
    expect(policy?.startLocal).toBe("09:00");
    expect(policy?.enforcement).toBe("block");
    expect(policy?.weekdays).toHaveLength(5);
  });

  it("reads the PUT response, which returns the policy BARE", () => {
    // The two verbs disagree on the envelope (send_window.go:117 vs :200).
    // Missing this asymmetry would leave the card showing the pre-write value
    // after a successful flip.
    const policy = parseSendWindow({
      start_local: "22:00",
      end_local: "23:00",
      timezone: "UTC",
      weekday_bitmap: 127,
      enforcement: "warn",
    });
    expect(policy?.enforcement).toBe("warn");
    expect(policy?.timezone).toBe("UTC");
  });

  it("treats `{policy: null}` as 'no policy', not as a broken response", () => {
    expect(parseSendWindow({ policy: null })).toBeNull();
    expect(parseSendWindow(null)).toBeNull();
  });

  it("falls back to warn on an enforcement value it does not recognise", () => {
    const policy = parseSendWindow({
      start_local: "09:00",
      end_local: "10:00",
      enforcement: "annihilate",
    });
    // Defaulting to `block` would refuse sends the server allows; defaulting to
    // `off` would claim nothing is enforced. `warn` is the honest middle and
    // matches the server's own default.
    expect(policy?.enforcement).toBe("warn");
  });

  it("refuses a policy with no window — a half-row is worse than none", () => {
    expect(
      parseSendWindow({ start_local: "09:00", enforcement: "off" }),
    ).toBeNull();
  });
});

describe("isSendWindowTier", () => {
  it("accepts exactly the three tiers the server validates", () => {
    expect(isSendWindowTier("block")).toBe(true);
    expect(isSendWindowTier("warn")).toBe(true);
    expect(isSendWindowTier("off")).toBe(true);
    expect(isSendWindowTier("blocked")).toBe(false);
    expect(isSendWindowTier(undefined)).toBe(false);
  });
});

describe("sendWindowSummary", () => {
  const base = {
    startLocal: "09:00",
    endLocal: "17:00",
    timezone: "America/New_York",
    weekdayBitmap: 62,
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  };

  it("gives the loud tone to the tier that REFUSES work", () => {
    const blocking = sendWindowSummary({ ...base, enforcement: "block" });
    expect(blocking?.tone).toBe("danger");
    expect(blocking?.effect).toMatch(/refused/);

    const warning = sendWindowSummary({ ...base, enforcement: "warn" });
    expect(warning?.tone).toBe("warning");
    expect(warning?.effect).toMatch(/go out/);

    const off = sendWindowSummary({ ...base, enforcement: "off" });
    expect(off?.tone).toBe("neutral");
    expect(off?.effect).toMatch(/not enforced/);
  });

  it("states the window with its timezone — 09:00 alone means nothing", () => {
    const summary = sendWindowSummary({ ...base, enforcement: "warn" });
    expect(summary?.windowLine).toBe(
      "09:00–17:00 America/New_York · Mon, Tue, Wed, Thu, Fri",
    );
  });

  it("collapses a full week to 'every day' rather than listing seven", () => {
    const summary = sendWindowSummary({
      ...base,
      weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      enforcement: "off",
    });
    expect(summary?.windowLine).toContain("every day");
  });

  it("returns null when there is no policy", () => {
    expect(sendWindowSummary(null)).toBeNull();
    expect(sendWindowSummary(undefined)).toBeNull();
  });
});

describe("push suppressions", () => {
  const base: Omit<PushSuppressionRow, "id" | "platform" | "reason"> = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    deviceTokenHash: "0123456789abcdef",
    source: "provider",
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: "2026-08-29T09:00:00Z",
    version: 1,
    reversible: false,
    lockedReason: "provider_authority",
  };
  const rows: PushSuppressionRow[] = [
    { ...base, id: "1", platform: "apns", reason: "unregistered" },
    { ...base, id: "2", platform: "apns", reason: "expired" },
    { ...base, id: "3", platform: "fcm", reason: "unregistered" },
  ];

  it("rolls up by platform and reason, largest first", () => {
    const summary = pushSummary(rows);
    expect(summary.total).toBe(3);
    expect(summary.platforms[0]).toEqual({
      key: "apns",
      label: "iOS",
      count: 2,
    });
    expect(summary.platforms[1]?.label).toBe("Android");
    expect(summary.reasons[0]).toEqual({
      key: "unregistered",
      label: "Token unregistered",
      count: 2,
    });
  });

  it("is stable for an empty list", () => {
    expect(pushSummary([])).toEqual({ total: 0, platforms: [], reasons: [] });
  });
});
