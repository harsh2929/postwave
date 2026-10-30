import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRUST_DAYS,
  MAX_TRUST_DAYS,
  TRUST_DURATIONS,
  defaultTrustDuration,
  isTrustDurationDays,
  parseTrustedDevicesPayload,
  resolveTrustDurations,
  totpChallengeBody,
  trustCeilingDays,
  trustConsentLine,
  trustDurationLabel,
  trustRequestFields,
  trustedDeviceLines,
} from "./trustedDeviceContract";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("the owner's three durations", () => {
  it("is exactly 30, 90 and 180 with 180 as the ceiling", () => {
    // The executable statement of the product decision. Widening the set,
    // adding a custom value, or slipping in a longer option fails HERE first.
    expect([...TRUST_DURATIONS]).toEqual([30, 90, 180]);
    expect(MAX_TRUST_DAYS).toBe(180);
    expect(Math.max(...TRUST_DURATIONS)).toBe(MAX_TRUST_DAYS);
    // The preselected option is the SHORTEST, not the longest.
    expect(DEFAULT_TRUST_DAYS).toBe(Math.min(...TRUST_DURATIONS));
  });

  it("rejects every value outside the set", () => {
    for (const days of TRUST_DURATIONS) {
      expect(isTrustDurationDays(days)).toBe(true);
    }
    for (const bad of [
      0, -1, -180, 1, 29, 31, 89, 91, 179, 181, 365, 3650, Infinity, NaN,
    ]) {
      expect(isTrustDurationDays(bad)).toBe(false);
    }
    for (const bad of ["30", "180", null, undefined, {}, [30], true]) {
      expect(isTrustDurationDays(bad)).toBe(false);
    }
  });
});

describe("resolveTrustDurations", () => {
  it("lets the server NARROW the choice", () => {
    expect(resolveTrustDurations([30, 90])).toEqual([30, 90]);
    expect(resolveTrustDurations([180])).toEqual([180]);
    // Client order wins, so the picker is never reordered by the wire.
    expect(resolveTrustDurations([180, 30])).toEqual([30, 180]);
  });

  it("never lets the server WIDEN it", () => {
    // A server that starts advertising 365 — bug, rollback, or hostile
    // response — must not be able to make this app offer it.
    expect(resolveTrustDurations([30, 90, 180, 365])).toEqual([30, 90, 180]);
    expect(resolveTrustDurations([365, 730])).toEqual([30, 90, 180]);
    expect(resolveTrustDurations([0])).toEqual([30, 90, 180]);
  });

  it("falls back to the full set for junk, so the picker is never empty", () => {
    for (const junk of [undefined, null, "30,90", {}, [], ["30"]]) {
      expect(resolveTrustDurations(junk)).toEqual([30, 90, 180]);
    }
  });

  it("reports the ceiling actually on offer, never more", () => {
    expect(trustCeilingDays([30, 90, 180])).toBe(180);
    expect(trustCeilingDays([30, 90])).toBe(90);
    expect(trustCeilingDays([30])).toBe(30);
    // An empty list falls back to the constant, so the line never renders a
    // ceiling of "undefined days".
    expect(trustCeilingDays([])).toBe(MAX_TRUST_DAYS);
    // End to end from a hostile payload: 365 is stripped before it can be
    // rendered as this app's advertised maximum.
    expect(
      trustCeilingDays(
        parseTrustedDevicesPayload({ allowed_durations: [30, 365] })
          .allowedDurations,
      ),
    ).toBe(30);
  });

  it("preselects the shortest AVAILABLE option", () => {
    expect(defaultTrustDuration([30, 90, 180])).toBe(30);
    expect(defaultTrustDuration([90, 180])).toBe(90);
    expect(defaultTrustDuration([180])).toBe(180);
    expect(defaultTrustDuration([])).toBe(30);
  });
});

describe("trustRequestFields", () => {
  it("emits nothing unless the user opted in", () => {
    expect(trustRequestFields(false, 90)).toEqual({});
    expect(trustRequestFields(false, 365)).toEqual({});
  });

  it("emits the approved durations verbatim", () => {
    expect(trustRequestFields(true, 30)).toEqual({
      trust_device: true,
      trust_days: 30,
    });
    expect(trustRequestFields(true, 180)).toEqual({
      trust_device: true,
      trust_days: 180,
    });
  });

  it("OMITS rather than coerces an unapproved duration", () => {
    // Coercing 365 down to 180 would remember the device for a window the
    // user never agreed to; coercing up is unthinkable. Asking for no trust
    // at all is the only honest third option.
    for (const bad of [365, 181, 0, -1, 3650, undefined, null, "90"]) {
      expect(trustRequestFields(true, bad)).toEqual({});
    }
  });
});

describe("totpChallengeBody", () => {
  it("carries the code and nothing else by default", () => {
    expect(totpChallengeBody({ code: "123456" })).toEqual({ code: "123456" });
    expect(totpChallengeBody({ recovery_code: " abcd-efgh " })).toEqual({
      recovery_code: "abcd-efgh",
    });
  });

  it("drops blank credentials instead of sending empty strings", () => {
    expect(totpChallengeBody({ code: "   ", recovery_code: "" })).toEqual({});
  });

  it("attaches trust only on an explicit, approved opt-in", () => {
    expect(
      totpChallengeBody({ code: "123456", trust_device: true, trust_days: 90 }),
    ).toEqual({ code: "123456", trust_device: true, trust_days: 90 });
    // 365 is the value the product decision names explicitly. It must never
    // reach the wire.
    expect(
      totpChallengeBody({ code: "123456", trust_device: true, trust_days: 365 }),
    ).toEqual({ code: "123456" });
    // A duration without the opt-in is not an opt-in.
    expect(totpChallengeBody({ code: "123456", trust_days: 180 })).toEqual({
      code: "123456",
    });
  });
});

describe("copy", () => {
  it("labels durations and states what is being given up", () => {
    expect(trustDurationLabel(30)).toBe("30 days");
    expect(trustDurationLabel(180)).toBe("180 days");
    expect(trustConsentLine(90)).toContain("90 days");
    expect(trustConsentLine(90)).toContain("Settings");
  });
});

describe("trustedDeviceLines", () => {
  it("reports the chosen duration and a floored expiry", () => {
    const lines = trustedDeviceLines(
      {
        trust_days: 90,
        expires_at: new Date(NOW + 12 * DAY + 3600_000).toISOString(),
        last_used_at: new Date(NOW - 3 * DAY).toISOString(),
      },
      NOW,
    );
    expect(lines.duration).toBe("Trusted for 90 days");
    expect(lines.expiry).toBe("Expires in 12 days");
    expect(lines.lastUsed).toBe("Last used 3 days ago");
  });

  it("says Expired rather than counting backwards", () => {
    const lines = trustedDeviceLines(
      { trust_days: 30, expires_at: new Date(NOW - DAY).toISOString() },
      NOW,
    );
    expect(lines.expiry).toBe("Expired");
  });

  it("singularises and handles the sub-day window", () => {
    expect(
      trustedDeviceLines({ expires_at: new Date(NOW + DAY + 1).toISOString() }, NOW)
        .expiry,
    ).toBe("Expires in 1 day");
    expect(
      trustedDeviceLines({ expires_at: new Date(NOW + 3600_000).toISOString() }, NOW)
        .expiry,
    ).toBe("Expires today");
  });

  it("treats a MISSING last-use as absence, never as zero", () => {
    // The trap this guards: a never-used record rendering as an epoch date, or
    // as "used just now", on the one screen that tells you what can currently
    // skip your second factor.
    for (const missing of [undefined, null, "", "   ", "not-a-date", 0]) {
      expect(
        trustedDeviceLines({ trust_days: 30, last_used_at: missing }, NOW)
          .lastUsed,
      ).toBe("Not used yet");
    }
    expect(
      trustedDeviceLines(
        { last_used_at: new Date(NOW - 3600_000).toISOString() },
        NOW,
      ).lastUsed,
    ).toBe("Last used today");
  });

  it("degrades an unreadable expiry to an em dash, not to a guess", () => {
    for (const bad of [undefined, null, "", "tomorrow", 12345]) {
      expect(trustedDeviceLines({ expires_at: bad }, NOW).expiry).toBe("—");
    }
  });

  it("does not claim a duration the server did not send", () => {
    expect(trustedDeviceLines({ trust_days: 365 }, NOW).duration).toBe(
      "Trusted device",
    );
    expect(trustedDeviceLines({}, NOW).duration).toBe("Trusted device");
  });
});

describe("parseTrustedDevicesPayload", () => {
  const row = {
    id: "abc",
    trust_days: 90,
    issued_at: "2026-07-01T00:00:00Z",
    expires_at: "2026-09-29T00:00:00Z",
    current: true,
  };

  it("keeps well-formed rows and the server policy", () => {
    const out = parseTrustedDevicesPayload({
      trusted_devices: [row],
      allowed: true,
      allowed_durations: [30, 90, 180],
    });
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0]?.id).toBe("abc");
    expect(out.allowed).toBe(true);
    expect(out.allowedDurations).toEqual([30, 90, 180]);
  });

  it("drops rows it cannot identify rather than rendering a dead credential", () => {
    const out = parseTrustedDevicesPayload({
      trusted_devices: [
        row,
        { ...row, id: "" },
        { ...row, id: 7 },
        { ...row, current: "yes" },
        { ...row, expires_at: undefined },
        { ...row, last_used_at: 0 },
        null,
        "nope",
      ],
      allowed: true,
    });
    expect(out.devices.map((d) => d.id)).toEqual(["abc"]);
  });

  it("treats an absent policy as NOT allowed", () => {
    // An unreadable policy field must never read as permission for a feature
    // whose job is to enforce MFA less often.
    for (const body of [{}, { allowed: "true" }, { allowed: 1 }, null]) {
      expect(parseTrustedDevicesPayload(body).allowed).toBe(false);
    }
  });

  it("still narrows the durations the server advertises", () => {
    expect(
      parseTrustedDevicesPayload({ allowed_durations: [30, 365] })
        .allowedDurations,
    ).toEqual([30]);
  });

  it("survives a non-array device list", () => {
    expect(
      parseTrustedDevicesPayload({ trusted_devices: "boom" }).devices,
    ).toEqual([]);
  });
});
