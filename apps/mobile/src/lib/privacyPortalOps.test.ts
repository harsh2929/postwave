import { describe, expect, it } from "vitest";

import {
  consentProofTotal,
  DOUBLE_OPTIN_EXTEND_COPY,
  doubleOptinExpiryLabel,
  parseConsentProofSummary,
  parsePendingDoubleOptins,
  parsePrivacyRegions,
  regionInputIssue,
  regionObligationsLine,
} from "./privacyPortalOps";

// The exact shapes privacy_portal/handlers.go writes.
const PORTAL_PAYLOAD = {
  regions: [
    {
      id: "r-1",
      region_code: "EU",
      framework: "gdpr",
      requires_double_optin: true,
      requires_explicit_consent: true,
      do_not_sell_default: false,
      gpc_honored: false,
    },
    { id: "", region_code: "XX" }, // no id — dropped
  ],
  consent_proof_summary: [
    { source: "form", count: 120 },
    { source: "csv_import", count: 30 },
  ],
  dsar_requests: [],
};

describe("parsePrivacyRegions", () => {
  it("reads the server's snake_case region rows", () => {
    const rows = parsePrivacyRegions(PORTAL_PAYLOAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "r-1",
      regionCode: "EU",
      framework: "gdpr",
      requiresDoubleOptIn: true,
    });
  });

  it("returns [] for a payload without regions", () => {
    expect(parsePrivacyRegions({})).toEqual([]);
    expect(parsePrivacyRegions(null)).toEqual([]);
  });
});

describe("regionInputIssue mirrors RegionInput.Validate", () => {
  it("requires a region code", () => {
    expect(regionInputIssue("  ", "gdpr")).toMatch(/region code/i);
  });
  it("rejects a framework outside the server's set", () => {
    expect(regionInputIssue("EU", "hipaa")).toMatch(/framework/i);
  });
  it("accepts the server's set case-insensitively", () => {
    expect(regionInputIssue("EU", "GDPR")).toBeNull();
    expect(regionInputIssue("BR", "lgpd")).toBeNull();
  });
});

describe("regionObligationsLine", () => {
  it("names each flagged obligation", () => {
    const rows = parsePrivacyRegions(PORTAL_PAYLOAD);
    expect(regionObligationsLine(rows[0]!)).toBe(
      "double opt-in · explicit consent",
    );
  });
  it("says so when nothing is flagged", () => {
    const row = {
      id: "r",
      regionCode: "CA",
      framework: "pipeda",
      requiresDoubleOptIn: false,
      requiresExplicitConsent: false,
      doNotSellDefault: false,
      gpcHonored: false,
    };
    expect(regionObligationsLine(row)).toMatch(/No extra obligations/);
  });
});

describe("parseConsentProofSummary", () => {
  it("distinguishes an absent field (null) from an empty one ([])", () => {
    expect(parseConsentProofSummary({ regions: [] })).toBeNull();
    expect(
      parseConsentProofSummary({ consent_proof_summary: [] }),
    ).toEqual([]);
  });
  it("sums the sources", () => {
    const rows = parseConsentProofSummary(PORTAL_PAYLOAD)!;
    expect(consentProofTotal(rows)).toBe(150);
  });
});

describe("parsePendingDoubleOptins", () => {
  it("reads the pending envelope and its cursor", () => {
    const page = parsePendingDoubleOptins({
      pending: [
        {
          id: "p-1",
          email: "a@example.com",
          list_id: "7",
          sent_at: "2026-08-01T00:00:00Z",
          expires_at: "2026-09-30T00:00:00Z",
        },
      ],
      count: 1,
      nextCursor: "abc",
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.email).toBe("a@example.com");
    expect(page.nextCursor).toBe("abc");
  });
  it("returns an empty page for a shapeless payload", () => {
    expect(parsePendingDoubleOptins(undefined)).toEqual({
      rows: [],
      nextCursor: "",
    });
  });
});

describe("doubleOptinExpiryLabel", () => {
  const now = Date.parse("2026-08-29T12:00:00Z");
  it("counts down, names today, and admits expiry", () => {
    expect(doubleOptinExpiryLabel("2026-09-10T12:00:00Z", now)).toBe(
      "expires in 12 days",
    );
    expect(doubleOptinExpiryLabel("2026-08-29T18:00:00Z", now)).toBe(
      "expires today",
    );
    expect(doubleOptinExpiryLabel("2026-08-26T12:00:00Z", now)).toBe(
      "expired 3 days ago",
    );
  });
  it("never fabricates a relative claim from an unparseable stamp", () => {
    expect(doubleOptinExpiryLabel("not-a-date", now)).toBe("not-a-date");
    expect(doubleOptinExpiryLabel("", now)).toBe("no expiry recorded");
  });
});

describe("the extend verb's honesty", () => {
  it("never claims an email was sent", () => {
    expect(DOUBLE_OPTIN_EXTEND_COPY).not.toMatch(/email (was|has been) sent/i);
    expect(DOUBLE_OPTIN_EXTEND_COPY).toMatch(/does not directly send mail/);
  });
});
