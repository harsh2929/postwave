import { describe, expect, it } from "vitest";

import {
  assuranceOverrideAvailability,
  latestAssuranceOverride,
  normalizeAssuranceOverrideReason,
} from "./campaignAssuranceOverride";

const receipt = {
  id: "override-new",
  finding_id: "finding-1",
  decision: "allow_send",
  reason: "Approved for this exact send.",
  created_at: "2026-08-30T12:00:00Z",
};

describe("mobile Campaign Assurance override policy", () => {
  it("offers the action only to an online owner/admin for an overridable finding", () => {
    expect(
      assuranceOverrideAvailability({
        overridable: true,
        existingOverride: undefined,
        effectiveRole: "admin",
        online: true,
      }),
    ).toBe("available");
    expect(
      assuranceOverrideAvailability({
        overridable: true,
        existingOverride: undefined,
        effectiveRole: "owner",
        online: true,
      }),
    ).toBe("available");
    expect(
      assuranceOverrideAvailability({
        overridable: true,
        existingOverride: undefined,
        effectiveRole: "editor",
        online: true,
      }),
    ).toBe("role_handoff");
    expect(
      assuranceOverrideAvailability({
        overridable: false,
        existingOverride: undefined,
        effectiveRole: "owner",
        online: true,
      }),
    ).toBe("policy_blocked");
    expect(
      assuranceOverrideAvailability({
        overridable: true,
        existingOverride: undefined,
        effectiveRole: "owner",
        online: false,
      }),
    ).toBe("offline_handoff");
  });

  it("requires and normalizes the server's 10..2000-character rationale", () => {
    expect(() => normalizeAssuranceOverrideReason("   ")).toThrow("10 to 2000");
    expect(() => normalizeAssuranceOverrideReason("too short")).toThrow(
      "10 to 2000",
    );
    expect(normalizeAssuranceOverrideReason("  specific rationale  ")).toBe(
      "specific rationale",
    );
    expect(() => normalizeAssuranceOverrideReason("x".repeat(2_001))).toThrow(
      "10 to 2000",
    );
  });

  it("renders the latest immutable decision rather than offering a duplicate", () => {
    const latest = latestAssuranceOverride(
      [
        { ...receipt, id: "override-old", created_at: "2026-08-30T10:00:00Z" },
        receipt,
      ] as never,
      "finding-1",
    );
    expect(latest?.id).toBe("override-new");
    expect(
      assuranceOverrideAvailability({
        overridable: true,
        existingOverride: latest,
        effectiveRole: "owner",
        online: true,
      }),
    ).toBe("existing_receipt");
  });
});
