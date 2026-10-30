import { describe, expect, it } from "vitest";

import {
  campaignAssuranceWebUrl,
  MOBILE_ASSURANCE_SOURCE_LABELS,
  MOBILE_ASSURANCE_SOURCE_ORDER,
  mobileAssuranceVerdict,
  shortAssuranceHash,
  type MobileAssuranceLatestLike,
} from "./campaignAssurance";

function latest(
  overrides: Partial<MobileAssuranceLatestLike["detail"]["run"]> = {},
  applicability: Partial<MobileAssuranceLatestLike["applicability"]> = {},
): MobileAssuranceLatestLike {
  return {
    detail: {
      run: {
        state: "complete",
        gate_decision: "pass",
        terminal_extraction_count: 6,
        required_extraction_count: 6,
        blocking_finding_count: 0,
        ...overrides,
      },
    },
    applicability: {
      applicable_to_frozen_snapshot: true,
      freshness: "frozen_snapshot_current",
      ...applicability,
    },
  };
}

describe("mobileAssuranceVerdict", () => {
  it("only calls a complete, current passing receipt current", () => {
    expect(mobileAssuranceVerdict(latest())).toMatchObject({
      label: "Current receipt",
      tone: "success",
    });
  });

  it("never presents stale, running, incomplete, or blocked work as passing", () => {
    expect(
      mobileAssuranceVerdict(
        latest({}, { applicable_to_frozen_snapshot: false }),
      ).label,
    ).toBe("Stale");
    expect(
      mobileAssuranceVerdict(
        latest({ state: "running", gate_decision: "pending" }),
      ).label,
    ).toBe("Running");
    expect(
      mobileAssuranceVerdict(
        latest({ state: "incomplete", gate_decision: "unavailable" }),
      ).label,
    ).toBe("Incomplete");
    expect(
      mobileAssuranceVerdict(
        latest({ gate_decision: "block", blocking_finding_count: 2 }),
      ),
    ).toMatchObject({ label: "Blocked", tone: "danger" });
  });

  it("keeps warnings visibly distinct from passes", () => {
    expect(
      mobileAssuranceVerdict(latest({ gate_decision: "warn" })),
    ).toMatchObject({ label: "Warnings", tone: "warning" });
  });
});

describe("Campaign Assurance mobile disclosure", () => {
  it("uses the required source-class vocabulary", () => {
    expect(MOBILE_ASSURANCE_SOURCE_LABELS).toEqual({
      deterministic: "Deterministic",
      modeled: "Modeled prediction",
      controlled_observation: "Controlled observation",
      unavailable: "Unavailable evidence",
    });
    expect(MOBILE_ASSURANCE_SOURCE_ORDER).toEqual([
      "deterministic",
      "modeled",
      "controlled_observation",
    ]);
  });

  it("builds an exact configured web deep-link and refuses unsafe ids", () => {
    expect(
      campaignAssuranceWebUrl("https://mail.acme.example", "campaign_123"),
    ).toBe(
      "https://mail.acme.example/app/campaigns/campaign_123#campaign-assurance",
    );
    expect(
      campaignAssuranceWebUrl("https://mail.acme.example", "../../admin"),
    ).toBeNull();
  });

  it("shortens only the visible hash while preserving both ends", () => {
    expect(shortAssuranceHash("0123456789abcdef0123456789")).toBe(
      "0123456…3456789",
    );
    expect(shortAssuranceHash("short-hash")).toBe("short-hash");
  });
});
