import { describe, expect, it } from "vitest";

import { WireShapeError } from "./deliverabilityContracts";
import {
  activeVerificationProvider,
  parseVerificationProviders,
  verificationProviderChangeConsequence,
  verificationProviderStatusLine,
  verificationProviderSummary,
  verificationVendorLabel,
  type VerificationProviderConfig,
  type VerificationProvidersView,
} from "./verificationProviders";

const row = (
  extra: Partial<VerificationProviderConfig> = {},
): VerificationProviderConfig => ({
  provider: "zerobounce",
  enabled: true,
  lastBalance: 1240,
  lastBalanceAt: "2026-09-01T00:00:00Z",
  lastError: "",
  lastErrorAt: "",
  updatedAt: "2026-09-01T00:00:00Z",
  ...extra,
});

const view = (
  providers: VerificationProviderConfig[],
  available: string[] = ["zerobounce", "kickbox"],
): VerificationProvidersView => ({ providers, available });

describe("parseVerificationProviders", () => {
  it("keeps the server's configuration state and its available list", () => {
    const parsed = parseVerificationProviders({
      providers: [
        {
          id: "abc",
          provider: "ZeroBounce",
          credential_ref: "zb-primary",
          enabled: true,
          settings: { ip_address: "203.0.113.4", cache_ttl_days: 30 },
          last_balance: 1240,
          last_balance_at: "2026-09-01T00:00:00Z",
          last_error: "The provider connection check failed.",
          last_error_at: "2026-09-02T00:00:00Z",
          updated_at: "2026-09-02T00:00:00Z",
        },
      ],
      available: ["zerobounce", "kickbox"],
    });
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]?.provider).toBe("zerobounce");
    expect(parsed.providers[0]?.enabled).toBe(true);
    expect(parsed.providers[0]?.lastBalance).toBe(1240);
    expect(parsed.providers[0]?.lastError).toBe(
      "The provider connection check failed.",
    );
    expect(parsed.available).toEqual(["zerobounce", "kickbox"]);
  });

  it("never carries the credential handle into the view", () => {
    const parsed = parseVerificationProviders({
      providers: [{ provider: "kickbox", credential_ref: "kb-live-key-ref" }],
      available: [],
    });
    // The parsed row is the whole surface the app can render or cache. A
    // credential-shaped field appearing here would be a leak by construction.
    expect(JSON.stringify(parsed)).not.toContain("kb-live-key-ref");
    expect(Object.keys(parsed.providers[0] ?? {})).not.toContain(
      "credentialRef",
    );
  });

  it("reports an absent balance as unknown rather than zero", () => {
    const parsed = parseVerificationProviders({
      providers: [{ provider: "kickbox", enabled: false }],
    });
    expect(parsed.providers[0]?.lastBalance).toBeNull();
    expect(parsed.providers[0]?.enabled).toBe(false);
  });

  it("rejects a non-object payload and a non-array providers field", () => {
    expect(() => parseVerificationProviders(null)).toThrow(WireShapeError);
    expect(() => parseVerificationProviders({ providers: "many" })).toThrow(
      WireShapeError,
    );
    expect(() => parseVerificationProviders({ providers: [7] })).toThrow(
      WireShapeError,
    );
  });

  it("rejects a non-numeric balance instead of rendering it as unknown", () => {
    expect(() =>
      parseVerificationProviders({
        providers: [{ provider: "kickbox", last_balance: "lots" }],
      }),
    ).toThrow(WireShapeError);
  });

  it("drops an unnamed row rather than offering a write against it", () => {
    const parsed = parseVerificationProviders({
      providers: [{ provider: "   ", enabled: true }],
    });
    expect(parsed.providers).toEqual([]);
  });
});

describe("verificationVendorLabel", () => {
  it("names both vendors the server advertises", () => {
    expect(verificationVendorLabel("zerobounce")).toBe("ZeroBounce");
    expect(verificationVendorLabel("KICKBOX")).toBe("Kickbox");
  });
});

describe("activeVerificationProvider / verificationProviderSummary", () => {
  it("names the enabled vendor", () => {
    const current = view([row({ provider: "kickbox" })]);
    expect(activeVerificationProvider(current)?.provider).toBe("kickbox");
    expect(verificationProviderSummary(current)).toBe(
      "Kickbox is the vendor verifying addresses for this workspace.",
    );
  });

  it("says no mailbox is probed when a configured vendor is switched off", () => {
    const current = view([row({ enabled: false })]);
    expect(activeVerificationProvider(current)).toBeNull();
    expect(verificationProviderSummary(current)).toContain(
      "No vendor is enabled",
    );
    expect(verificationProviderSummary(current)).toContain(
      "no mailbox is probed",
    );
  });

  it("distinguishes 'none configured' from 'configured but off'", () => {
    expect(verificationProviderSummary(view([]))).toContain(
      "No verification vendor is configured",
    );
  });
});

describe("verificationProviderStatusLine", () => {
  it("dates the balance rather than presenting it as live", () => {
    expect(verificationProviderStatusLine(row())).toBe(
      "Enabled · 1,240 credits at the last check.",
    );
  });

  it("says 'not reported' for a null balance, never 0", () => {
    const line = verificationProviderStatusLine(
      row({ enabled: false, lastBalance: null }),
    );
    expect(line).toBe("Configured but off · balance not reported.");
    expect(line).not.toContain("0");
  });
});

describe("verificationProviderChangeConsequence", () => {
  it("states the paid consequence of enabling", () => {
    expect(verificationProviderChangeConsequence("zerobounce", "enable")).toBe(
      "ZeroBounce will verify addresses from now on. Each address it checks spends one of this workspace's provider credits.",
    );
  });

  it("states the silent downgrade of disabling and removing", () => {
    expect(
      verificationProviderChangeConsequence("kickbox", "disable"),
    ).toContain("no mailbox is probed");
    expect(verificationProviderChangeConsequence("kickbox", "remove")).toContain(
      "cannot be recreated from the phone",
    );
  });
});
