import { describe, expect, it } from "vitest";

import {
  firewallModeLabel,
  identifierTransformSummary,
  isPlatformSurfaceHidden,
  normalizeFeatureFlags,
  normalizeFirewallSettings,
  normalizeIdentifierTransforms,
  normalizeRegion,
  regionLabel,
  residencySummary,
  surgeRuleLabel,
} from "./platformConfig";

describe("normalizeRegion", () => {
  it("reads the regionResponse shape from apps/api/internal/regions", () => {
    expect(
      normalizeRegion({
        data_region: "eu-central-1",
        deployment_region: "eu-central-1",
        matches: true,
      }),
    ).toEqual({
      dataRegion: "eu-central-1",
      deploymentRegion: "eu-central-1",
      matches: true,
    });
  });

  it("never invents a match for a missing payload", () => {
    expect(normalizeRegion(null)).toEqual({
      dataRegion: "",
      deploymentRegion: "",
      matches: false,
    });
  });

  it("treats a non-boolean `matches` as false rather than truthy", () => {
    // A server that ever emitted "true" as a string must not read as a match.
    expect(normalizeRegion({ matches: "true" }).matches).toBe(false);
  });
});

describe("residencySummary", () => {
  it("states the split when data and processing regions differ", () => {
    expect(
      residencySummary({
        dataRegion: "eu-central-1",
        deploymentRegion: "us-east-1",
        matches: false,
      }),
    ).toBe(
      "Data rests in eu-central-1 but this request was served from us-east-1.",
    );
  });

  it("says so plainly when they agree", () => {
    expect(
      residencySummary({
        dataRegion: "us-east-1",
        deploymentRegion: "us-east-1",
        matches: true,
      }),
    ).toBe("Data and processing both stay in us-east-1.");
  });

  it("does not claim a region it was never given", () => {
    expect(
      residencySummary({
        dataRegion: "",
        deploymentRegion: "us-east-1",
        matches: false,
      }),
    ).toBe("This workspace has no recorded data region.");
  });

  it("falls back to Unknown for an unnamed deployment region", () => {
    expect(regionLabel("")).toBe("Unknown");
    expect(
      residencySummary({
        dataRegion: "eu-west-1",
        deploymentRegion: "",
        matches: false,
      }),
    ).toContain("served from Unknown");
  });
});

describe("normalizeFeatureFlags", () => {
  it("reads flag_key, the column name the List handler selects", () => {
    const rows = normalizeFeatureFlags({
      flags: [
        {
          id: "1",
          flag_key: "ai_copilot",
          value: "on",
          note: "beta",
          enabled: true,
          is_default: false,
        },
      ],
      count: 1,
    });
    expect(rows).toEqual([
      {
        key: "ai_copilot",
        value: "on",
        note: "beta",
        enabled: true,
        isDefault: false,
      },
    ]);
  });

  it("keeps the workspace override and drops the platform default twin", () => {
    // The handler's ORDER BY puts `tenant_id IS NULL DESC` last, i.e. the
    // override first, so first-wins is the server's own precedence.
    const rows = normalizeFeatureFlags({
      flags: [
        { flag_key: "ai_copilot", value: "off", enabled: false, is_default: false },
        { flag_key: "ai_copilot", value: "on", enabled: true, is_default: true },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: "off", isDefault: false });
  });

  it("survives a missing flags array and skips keyless rows", () => {
    expect(normalizeFeatureFlags({})).toEqual([]);
    expect(normalizeFeatureFlags({ flags: [{ value: "on" }] })).toEqual([]);
  });
});

describe("normalizeFirewallSettings", () => {
  it("reads the flat Settings object the handler writes", () => {
    expect(
      normalizeFirewallSettings({
        tenant_id: "t1",
        attack_mode_enabled: true,
        auto_attack_mode: true,
        fingerprint_required: false,
        attack_mode_threshold: 70,
        surge_multiplier: 5,
        surge_min_per_hour: 20,
        attack_mode_auto_enabled_at: "2026-07-20T10:00:00Z",
      }),
    ).toEqual({
      attackModeEnabled: true,
      autoAttackMode: true,
      fingerprintRequired: false,
      attackModeThreshold: 70,
      surgeMultiplier: 5,
      surgeMinPerHour: 20,
      autoEnabledAt: "2026-07-20T10:00:00Z",
    });
  });

  it("treats an omitted auto-enable timestamp as null", () => {
    // The Go field is `*time.Time` with omitempty, so it is absent, not empty.
    expect(normalizeFirewallSettings({}).autoEnabledAt).toBeNull();
  });
});

describe("firewallModeLabel", () => {
  const base = {
    attackModeEnabled: false,
    autoAttackMode: false,
    fingerprintRequired: false,
    attackModeThreshold: 0,
    surgeMultiplier: 0,
    surgeMinPerHour: 0,
    autoEnabledAt: null,
  };

  it("distinguishes an automatic escalation from an admin one", () => {
    expect(
      firewallModeLabel({
        ...base,
        attackModeEnabled: true,
        autoEnabledAt: "2026-07-20T10:00:00Z",
      }),
    ).toBe("On — escalated automatically");
    expect(firewallModeLabel({ ...base, attackModeEnabled: true })).toBe(
      "On — enabled by an admin",
    );
  });

  it("distinguishes armed-but-off from plain off", () => {
    expect(firewallModeLabel({ ...base, autoAttackMode: true })).toBe(
      "Off — arms automatically",
    );
    expect(firewallModeLabel(base)).toBe("Off");
  });

  it("describes the surge rule only when automatic escalation is on", () => {
    expect(surgeRuleLabel(base)).toBe("Automatic escalation is off");
    expect(
      surgeRuleLabel({
        ...base,
        autoAttackMode: true,
        surgeMultiplier: 5,
        surgeMinPerHour: 20,
      }),
    ).toBe(
      "Arms above 5× the usual rate, and never below 20 signups an hour",
    );
    expect(surgeRuleLabel({ ...base, autoAttackMode: true })).toBe(
      "Automatic escalation is on, with no thresholds set",
    );
  });
});

describe("identifier transforms", () => {
  it("upper-cases the region code so 'gb' and 'GB' read the same", () => {
    expect(
      normalizeIdentifierTransforms({
        email_normalize_dots: true,
        email_normalize_plus: false,
        phone_e164_format: true,
        phone_default_region: " gb ",
      }),
    ).toEqual({
      emailNormalizeDots: true,
      emailNormalizePlus: false,
      phoneE164Format: true,
      phoneDefaultRegion: "GB",
    });
  });

  it("lists only the rewrites actually in force", () => {
    expect(
      identifierTransformSummary({
        emailNormalizeDots: false,
        emailNormalizePlus: true,
        phoneE164Format: false,
        phoneDefaultRegion: "",
      }),
    ).toEqual(["“+tag” sub-addresses dropped"]);
  });

  it("names the default region only when E.164 coercion is on", () => {
    const withRegion = identifierTransformSummary({
      emailNormalizeDots: false,
      emailNormalizePlus: false,
      phoneE164Format: true,
      phoneDefaultRegion: "US",
    });
    expect(withRegion).toEqual([
      "Phone numbers coerced to E.164, defaulting to US",
    ]);
    expect(
      identifierTransformSummary({
        emailNormalizeDots: false,
        emailNormalizePlus: false,
        phoneE164Format: true,
        phoneDefaultRegion: "",
      }),
    ).toEqual(["Phone numbers coerced to E.164 (international numbers only)"]);
  });

  it("returns an empty list when nothing is rewritten", () => {
    expect(
      identifierTransformSummary({
        emailNormalizeDots: false,
        emailNormalizePlus: false,
        phoneE164Format: false,
        phoneDefaultRegion: "GB",
      }),
    ).toEqual([]);
  });
});

describe("isPlatformSurfaceHidden", () => {
  it("hides entitlement and not-deployed answers, not real failures", () => {
    expect(isPlatformSurfaceHidden(403)).toBe(true);
    expect(isPlatformSurfaceHidden(404)).toBe(true);
    expect(isPlatformSurfaceHidden(501)).toBe(true);
    expect(isPlatformSurfaceHidden(500)).toBe(false);
    expect(isPlatformSurfaceHidden(0)).toBe(false);
    expect(isPlatformSurfaceHidden(429)).toBe(false);
  });
});
