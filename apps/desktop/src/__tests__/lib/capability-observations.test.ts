import { afterEach, describe, expect, it } from "vitest";

import {
  capabilityStateFromApiError,
  clearCapabilityObservation,
  getCapabilityObservation,
  reportCapabilityObservation,
  resetCapabilityObservationsForTests,
} from "../../lib/capability-observations";

afterEach(() => resetCapabilityObservationsForTests());

describe("capability endpoint evidence", () => {
  it("classifies only explicit plan and setup evidence", () => {
    expect(capabilityStateFromApiError({ status: 402 })).toBe("plan-required");
    expect(
      capabilityStateFromApiError({ code: "PROVIDER_NOT_CONFIGURED" }),
    ).toBe("not-configured");
    expect(capabilityStateFromApiError({ status: 403 })).toBeNull();
    expect(capabilityStateFromApiError({ status: 404 })).toBeNull();
    expect(capabilityStateFromApiError({ status: 503 })).toBeNull();
  });

  it("requires endpoint-owner evidence before treating 404/405 as setup absence", () => {
    const evidence = { endpointAbsenceMeansNotConfigured: true } as const;
    expect(capabilityStateFromApiError({ status: 404 }, evidence)).toBe(
      "not-configured",
    );
    expect(capabilityStateFromApiError({ status: 405 }, evidence)).toBe(
      "not-configured",
    );
    expect(
      capabilityStateFromApiError(
        { status: 404 },
        { ...evidence, impact: "partial" },
      ),
    ).toBe("partial-not-configured");
    expect(
      capabilityStateFromApiError(
        { code: "PLAN_REQUIRED" },
        { impact: "partial" },
      ),
    ).toBe("partial-plan-required");
  });

  it("isolates bounded observations by identity and clears them on success", () => {
    reportCapabilityObservation(
      "workspace-a",
      "commerce",
      "plan-required",
      `  ${"x".repeat(600)}  `,
    );
    expect(getCapabilityObservation("workspace-b", "commerce")).toBeNull();
    expect(
      getCapabilityObservation("workspace-a", "commerce")?.reason,
    ).toHaveLength(512);

    reportCapabilityObservation("workspace-a", "commerce", "available", "");
    expect(getCapabilityObservation("workspace-a", "commerce")).toBeNull();
  });

  it("aggregates independent owners without letting one success clear another", () => {
    reportCapabilityObservation(
      "workspace-a",
      "agency",
      "partial-plan-required",
      "Sub-accounts require agency eligibility.",
      "subaccounts",
    );
    reportCapabilityObservation(
      "workspace-a",
      "agency",
      "partial-not-configured",
      "Brand assets require setup.",
      "branding",
    );
    expect(getCapabilityObservation("workspace-a", "agency")).toMatchObject({
      state: "partial-plan-required",
    });

    reportCapabilityObservation(
      "workspace-a",
      "agency",
      "available",
      "",
      "subaccounts",
    );
    expect(getCapabilityObservation("workspace-a", "agency")).toMatchObject({
      state: "partial-not-configured",
      reason: "Brand assets require setup.",
    });

    clearCapabilityObservation("workspace-a", "agency");
    expect(getCapabilityObservation("workspace-a", "agency")).toBeNull();
  });

  it("never retains URLs, identity, or credential-shaped reason text", () => {
    reportCapabilityObservation(
      "workspace-a",
      "helpdesk",
      "not-configured",
      "Bearer secret-token for owner@example.test at https://internal.test",
    );
    const reason = getCapabilityObservation("workspace-a", "helpdesk")?.reason;
    expect(reason).toBe(
      "This capability is currently unavailable. Review setup or access and try again.",
    );
    expect(reason).not.toContain("owner@example.test");
    expect(reason).not.toContain("secret-token");
  });
});
