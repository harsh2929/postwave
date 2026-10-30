import { describe, expect, it } from "vitest";

import {
  MINUTES_PER_DAY,
  PUSH_QUIET_HOURS_DEFAULT,
  parsePushQuietHours,
  pushDeviceErrorMessage,
  pushQuietHoursBody,
  pushQuietHoursSavable,
  pushQuietHoursSummary,
  pushQuietHoursWraps,
} from "./pushQuietHours";

const ON = {
  enabled: true,
  startMinute: 1260,
  endMinute: 540,
  timezone: "Europe/London",
};

describe("parsePushQuietHours", () => {
  it("reads the server's shape", () => {
    expect(
      parsePushQuietHours({
        enabled: true,
        start_minute: 1260,
        end_minute: 540,
        timezone: "Europe/London",
      }),
    ).toEqual(ON);
  });

  it("matches migration 1814's defaults when the window is absent", () => {
    // 21:00 -> 09:00, disabled.
    expect(parsePushQuietHours(null)).toEqual({
      enabled: false,
      startMinute: 1260,
      endMinute: 540,
      timezone: "UTC",
    });
    expect(PUSH_QUIET_HOURS_DEFAULT.startMinute).toBe(1260);
    expect(PUSH_QUIET_HOURS_DEFAULT.endMinute).toBe(540);
  });

  it("keeps the fields it got right when one field is nonsense", () => {
    // Per-field defensiveness: telling the user their window is OFF because one
    // unrelated field was malformed would contradict the server.
    const parsed = parsePushQuietHours({
      enabled: true,
      start_minute: 1260,
      end_minute: 99999,
      timezone: "Europe/London",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.startMinute).toBe(1260);
    expect(parsed.endMinute).toBe(PUSH_QUIET_HOURS_DEFAULT.endMinute);
  });

  it("treats a non-boolean enabled as off rather than truthy", () => {
    expect(parsePushQuietHours({ enabled: "yes" }).enabled).toBe(false);
    expect(parsePushQuietHours({ enabled: 1 }).enabled).toBe(false);
  });

  it("rejects a fractional or out-of-range minute", () => {
    expect(parsePushQuietHours({ start_minute: 12.5 }).startMinute).toBe(1260);
    expect(parsePushQuietHours({ start_minute: -1 }).startMinute).toBe(1260);
    expect(
      parsePushQuietHours({ start_minute: MINUTES_PER_DAY }).startMinute,
    ).toBe(1260);
    // 1439 is the last legal minute and must survive.
    expect(parsePushQuietHours({ start_minute: 1439 }).startMinute).toBe(1439);
  });

  it("falls back for a blank timezone", () => {
    expect(parsePushQuietHours({ timezone: "   " }).timezone).toBe("UTC");
    expect(parsePushQuietHours({ timezone: 42 }).timezone).toBe("UTC");
  });
});

describe("pushQuietHoursWraps", () => {
  it("detects the default midnight-crossing window", () => {
    expect(pushQuietHoursWraps(ON)).toBe(true);
  });

  it("is false for a same-day window", () => {
    expect(pushQuietHoursWraps({ ...ON, startMinute: 540, endMinute: 1260 })).toBe(
      false,
    );
  });

  it("treats an equal start and end as wrapping, matching the server predicate", () => {
    expect(pushQuietHoursWraps({ ...ON, startMinute: 600, endMinute: 600 })).toBe(
      true,
    );
  });
});

describe("pushQuietHoursSummary", () => {
  it("says plainly that nothing is held when disabled", () => {
    expect(pushQuietHoursSummary({ ...ON, enabled: false })).toBe(
      "Notifications arrive at any time of day.",
    );
  });

  it("names the span, the wrap and the zone", () => {
    const summary = pushQuietHoursSummary(ON);
    expect(summary).toContain("21:00 – 09:00");
    expect(summary).toContain("wrapping to the next day");
    expect(summary).toContain("Europe/London");
  });

  it("omits the wrap clause for a same-day window", () => {
    const summary = pushQuietHoursSummary({
      ...ON,
      startMinute: 540,
      endMinute: 1260,
    });
    expect(summary).toContain("09:00 – 21:00");
    expect(summary).not.toContain("wrapping");
  });
});

describe("pushQuietHoursSavable", () => {
  it("accepts a legal window", () => {
    expect(pushQuietHoursSavable(ON)).toBe(true);
    expect(
      pushQuietHoursSavable({ ...ON, startMinute: 0, endMinute: 1439 }),
    ).toBe(true);
  });

  it("mirrors the server's 0-1439 bound rather than guessing", () => {
    // quiet_hours.go:182-186 answers 422 outside this range.
    expect(pushQuietHoursSavable({ ...ON, startMinute: -1 })).toBe(false);
    expect(
      pushQuietHoursSavable({ ...ON, startMinute: MINUTES_PER_DAY }),
    ).toBe(false);
    expect(pushQuietHoursSavable({ ...ON, endMinute: MINUTES_PER_DAY })).toBe(
      false,
    );
    expect(pushQuietHoursSavable({ ...ON, endMinute: 12.5 })).toBe(false);
  });

  it("rejects a blank, overlong or control-bearing timezone", () => {
    expect(pushQuietHoursSavable({ ...ON, timezone: "" })).toBe(false);
    expect(pushQuietHoursSavable({ ...ON, timezone: "  " })).toBe(false);
    expect(pushQuietHoursSavable({ ...ON, timezone: "x".repeat(65) })).toBe(
      false,
    );
    expect(pushQuietHoursSavable({ ...ON, timezone: "Europe/Lon\ndon" })).toBe(
      false,
    );
  });

  it("does NOT pretend to validate the IANA name itself", () => {
    // Only the server can, with time.LoadLocation. Claiming otherwise here would
    // reject zones that are actually fine.
    expect(pushQuietHoursSavable({ ...ON, timezone: "Not/AZone" })).toBe(true);
  });
});

describe("pushQuietHoursBody", () => {
  it("sends every field, so a save is never a partial overwrite of a window the user saw", () => {
    expect(pushQuietHoursBody("ab".repeat(32), ON)).toEqual({
      device_key: "ab".repeat(32),
      enabled: true,
      start_minute: 1260,
      end_minute: 540,
      timezone: "Europe/London",
    });
  });

  it("trims the timezone", () => {
    expect(
      pushQuietHoursBody("k", { ...ON, timezone: " Europe/London " }).timezone,
    ).toBe("Europe/London");
  });
});

describe("pushDeviceErrorMessage", () => {
  it("tells an unregistered device to re-register rather than retry", () => {
    expect(pushDeviceErrorMessage("device_not_registered", "x")).toContain(
      "off and on again",
    );
  });

  it("distinguishes a throttle from a rejection", () => {
    const throttled = pushDeviceErrorMessage("test_push_throttled", "x");
    const rejected = pushDeviceErrorMessage("test_push_rejected", "x");
    expect(throttled).not.toBe(rejected);
    expect(throttled).toContain("last minute");
    expect(rejected).toContain("rejected");
  });

  it("gives every documented server code its own sentence", () => {
    const codes = [
      "device_not_registered",
      "invalid_device_key",
      "invalid_quiet_hours",
      "mobile_push_disabled",
      "test_push_throttled",
      "test_push_rejected",
      "test_push_failed",
      "no_session",
    ];
    const seen = codes.map((code) => pushDeviceErrorMessage(code, "FALLBACK"));
    expect(new Set(seen).size).toBe(codes.length);
    for (const message of seen) expect(message).not.toBe("FALLBACK");
  });

  it("falls back for an unknown code instead of inventing a diagnosis", () => {
    expect(pushDeviceErrorMessage("teapot", "FALLBACK")).toBe("FALLBACK");
    expect(pushDeviceErrorMessage("", "FALLBACK")).toBe("FALLBACK");
  });
});

describe("pushQuietHoursSavable mirrors Go hasControl exactly", () => {
  const withChar = (code: number) => ({
    ...ON,
    timezone: `Europe/Lon${String.fromCharCode(code)}don`,
  });

  it("rejects DEL (0x7f), which a naive 0x00-0x1f range misses", () => {
    // sender.go:531-538 is `r < 0x20 || r == 0x7f`. Dropping the 0x7f term would
    // pass this body to a server that answers 422 invalid_quiet_hours.
    expect(pushQuietHoursSavable(withChar(0x7f))).toBe(false);
  });

  it("rejects every code point below 0x20", () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f]) {
      expect(pushQuietHoursSavable(withChar(code))).toBe(false);
    }
  });

  it("still accepts the space just above the control range", () => {
    // 0x20 is NOT a control character to Go, and a zone is trimmed rather than
    // rejected for surrounding whitespace.
    expect(pushQuietHoursSavable({ ...ON, timezone: " Europe/London " })).toBe(
      true,
    );
  });

  it("counts the 64-char timezone limit in BYTES, as Go len() does", () => {
    // 64 two-byte characters is 128 bytes: within .length, over Go's limit.
    expect(pushQuietHoursSavable({ ...ON, timezone: "\u00e9".repeat(64) })).toBe(
      false,
    );
    expect(pushQuietHoursSavable({ ...ON, timezone: "a".repeat(64) })).toBe(true);
  });
});
