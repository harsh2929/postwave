import { describe, expect, it } from "vitest";

import {
  legalHoldErrorMessage,
  legalHoldReasonUsable,
  legalHoldReleaseCopy,
  legalHoldScopeSummary,
  parseAssuranceLegalHold,
  parseAssuranceLegalHolds,
} from "./assuranceLegalHold";

const wire = (extra: Record<string, unknown> = {}) => ({
  id: "hold-1",
  campaign_id: "",
  scope: "tenant",
  reason: "regulator request",
  placed_at: "2026-08-17T09:00:00Z",
  ...extra,
});

describe("parseAssuranceLegalHold", () => {
  it("reads the server's shape", () => {
    expect(parseAssuranceLegalHold(wire())).toEqual({
      id: "hold-1",
      campaignId: "",
      scope: "tenant",
      reason: "regulator request",
      placedAt: "2026-08-17T09:00:00Z",
    });
  });

  it("uses the server's derived scope rather than re-deriving it", () => {
    // handlers.go:78-80 derives `scope` precisely so a reader never infers it from
    // an empty campaign_id.
    expect(
      parseAssuranceLegalHold(wire({ scope: "campaign", campaign_id: "c1" }))
        ?.scope,
    ).toBe("campaign");
  });

  it("fails toward the WIDER scope when the field is missing or junk", () => {
    // Understating blast radius is the dangerous direction: an operator who
    // believes a hold covers one campaign may release it and lose tenant-wide
    // evidence.
    expect(parseAssuranceLegalHold({ id: "h", scope: "nonsense" })?.scope).toBe(
      "tenant",
    );
    expect(parseAssuranceLegalHold({ id: "h" })?.scope).toBe("tenant");
  });

  it("still infers `campaign` when an id is present but the scope is junk", () => {
    expect(
      parseAssuranceLegalHold({ id: "h", campaign_id: "c1", scope: "" })?.scope,
    ).toBe("campaign");
  });

  it("drops a row with no id, which could not be released", () => {
    expect(parseAssuranceLegalHold({ reason: "x" })).toBeNull();
  });
});

describe("parseAssuranceLegalHolds", () => {
  it("reads both envelope shapes and skips junk rows", () => {
    expect(parseAssuranceLegalHolds([wire()])).toHaveLength(1);
    expect(parseAssuranceLegalHolds({ items: [wire()] })).toHaveLength(1);
    expect(parseAssuranceLegalHolds([null, 42, wire()])).toHaveLength(1);
    expect(parseAssuranceLegalHolds(null)).toEqual([]);
  });
});

describe("legalHoldReasonUsable", () => {
  it("requires a reason, as both endpoints do", () => {
    // handlers.go:144 and :179 answer 422 reason_required on a blank reason.
    expect(legalHoldReasonUsable("")).toBe(false);
    expect(legalHoldReasonUsable("   ")).toBe(false);
    expect(legalHoldReasonUsable("regulator request")).toBe(true);
  });
});

describe("legalHoldScopeSummary", () => {
  it("shouts about a tenant-wide hold", () => {
    const summary = legalHoldScopeSummary({
      id: "h",
      campaignId: "",
      scope: "tenant",
      reason: "",
      placedAt: "",
    });
    expect(summary).toContain("EVERY campaign");
  });

  it("names the campaign and says others are still swept", () => {
    const summary = legalHoldScopeSummary({
      id: "h",
      campaignId: "c1",
      scope: "campaign",
      reason: "",
      placedAt: "",
    });
    expect(summary).toContain("c1");
    expect(summary).toContain("still swept");
  });
});

describe("legalHoldReleaseCopy", () => {
  it("says releasing is unrecoverable, in both scopes", () => {
    for (const scope of ["tenant", "campaign"] as const) {
      const copy = legalHoldReleaseCopy({
        id: "h",
        campaignId: scope === "campaign" ? "c1" : "",
        scope,
        reason: "",
        placedAt: "",
      });
      expect(copy.body).toContain("cannot be recovered");
    }
  });

  it("escalates the wording for a tenant-wide release", () => {
    const tenant = legalHoldReleaseCopy({
      id: "h",
      campaignId: "",
      scope: "tenant",
      reason: "",
      placedAt: "",
    });
    expect(tenant.body).toContain("EVERY campaign");
  });
});

describe("legalHoldErrorMessage", () => {
  it("explains why a reason is mandatory rather than just repeating the code", () => {
    expect(legalHoldErrorMessage("reason_required", "x")).toContain(
      "record of why",
    );
  });

  it("falls back for an unknown code", () => {
    expect(legalHoldErrorMessage("teapot", "FALLBACK")).toBe("FALLBACK");
  });
});
