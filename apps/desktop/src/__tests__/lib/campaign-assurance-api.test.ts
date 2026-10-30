// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  uuid: "018f47a0-9b7c-7000-8000-000000000001",
}));

vi.mock("../../lib/api-client", () => ({ apiRequest: mocks.apiRequest }));
vi.mock("../../lib/http-fetch", () => ({ newUUIDv7: () => mocks.uuid }));

import {
  applyCampaignAssuranceFinding,
  ASSURANCE_SOURCE_LABELS,
  factContractSummary,
  getCampaignAssuranceEvidence,
  getCampaignContentRevision,
  getLatestCampaignAssurance,
  isExactStrongCampaignETag,
  overrideCampaignAssuranceFinding,
  remediationSummary,
  startCurrentCampaignAssurance,
} from "../../lib/api/campaign-assurance";

describe("Campaign Assurance desktop API paths", () => {
  beforeEach(() => mocks.apiRequest.mockReset());

  it("reads the latest receipt, paged evidence, and exact frozen revision", () => {
    void getLatestCampaignAssurance("campaign/one");
    void getCampaignAssuranceEvidence("campaign/one", "run/two", 200);
    void getCampaignContentRevision("campaign/one", "revision/three");

    expect(mocks.apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/campaigns/campaign%2Fone/assurance",
      "/api/v1/campaigns/campaign%2Fone/assurance-runs/run%2Ftwo/evidence?limit=200&offset=200",
      "/api/v1/campaigns/campaign%2Fone/content-revisions/revision%2Fthree",
    ]);
  });

  it("starts the current exact snapshot without client-authored artifact identities", () => {
    void startCurrentCampaignAssurance("campaign/one");

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%2Fone/assurance-runs",
      {
        method: "POST",
        body: JSON.stringify({ profile: "full", request_id: mocks.uuid }),
      },
      { requireOnline: true, maxAttempts: 3 },
    );
  });

  it("sends a governed decision online with one client transport attempt", () => {
    void overrideCampaignAssuranceFinding("campaign/one", "run/two", "finding/three", {
      decision: "reject",
      reason: "The immutable finding remains valid after operator review.",
    });

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%2Fone/assurance-runs/run%2Ftwo/findings/finding%2Fthree/overrides",
      {
        method: "POST",
        body: JSON.stringify({
          request_id: mocks.uuid,
          decision: "reject",
          reason: "The immutable finding remains valid after operator review.",
        }),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("applies a deterministic repair only against the exact campaign ETag and provenance", async () => {
    mocks.apiRequest.mockResolvedValueOnce({
      data: applyEnvelope("revision-v2", '"campaign-v2"'),
      serverVersion: '"campaign-v2"',
      responseLocation:
        "/api/v1/campaigns/campaign%2Fone/content-revisions/revision-v2",
    });
    const result = await applyCampaignAssuranceFinding(
      "campaign/one",
      "run/two",
      "finding/three",
      '"campaign-v1"',
    );

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%2Fone/assurance-runs/run%2Ftwo/findings/finding%2Fthree/apply",
      {
        method: "POST",
        headers: { "If-Match": '"campaign-v1"' },
        body: JSON.stringify({ request_id: mocks.uuid }),
      },
      { requireOnline: true, maxAttempts: 3 },
    );
    expect(result).toMatchObject({
      data: { data: { revision: { id: "revision-v2" } } },
      serverVersion: '"campaign-v2"',
      responseLocation:
        "/api/v1/campaigns/campaign%2Fone/content-revisions/revision-v2",
    });
  });

  it("refuses every non-exact apply precondition before dispatch", async () => {
    for (const invalid of [
      'W/"campaign-v1"',
      '"campaign-v1", "campaign-v2"',
      ' "campaign-v1"',
      '"campaign-v1"\n',
      '"campaign\u007f-v1"',
      '""',
      "*",
    ]) {
      await expect(
        applyCampaignAssuranceFinding(
          "campaign-one",
          "run-two",
          "finding-three",
          invalid,
        ),
      ).resolves.toMatchObject({
        error: { code: "campaign_etag_required", kind: "invalid_config" },
        retryability: "not-retryable",
      });
      expect(isExactStrongCampaignETag(invalid)).toBe(false);
    }
    expect(isExactStrongCampaignETag('"campaign-v1"')).toBe(true);
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("fails closed when ETag or Location does not prove the returned revision", async () => {
    mocks.apiRequest.mockResolvedValueOnce({
      data: applyEnvelope("revision-v2", '"campaign-v2"'),
      serverVersion: '"campaign-v2"',
      responseLocation:
        "/api/v1/campaigns/campaign-one/content-revisions/different-revision",
    });

    await expect(
      applyCampaignAssuranceFinding(
        "campaign-one",
        "run-two",
        "finding-three",
        '"campaign-v1"',
      ),
    ).resolves.toMatchObject({
      error: {
        code: "campaign_assurance_apply_provenance_invalid",
        kind: "parse",
      },
      retryability: "not-retryable",
    });
  });
});

function applyEnvelope(revisionId: string, campaignETag: string) {
  return {
    measurement: {
      name: "Predicted Agent Comprehension",
      interpretation: "Predicted, not provider-observed.",
      source_classes: [],
    },
    data: {
      application: {},
      revision: { id: revisionId },
      campaign_etag: campaignETag,
      originating_run_state: "stale",
      rerun_required: true,
    },
  };
}

describe("Campaign Assurance desktop presentation helpers", () => {
  it("recovers the exact v1 Fact Contract and remediation fields", () => {
    expect(
      factContractSummary({
        primary_intent: { statement: "Confirm attendance" },
        core_claim: { statement: "The event starts at 09:00 UTC" },
        primary_action: { label: "RSVP" },
        required_facts: [
          { id: "start", display_value: "2026-08-15 09:00 UTC", criticality: "blocking" },
        ],
      }),
    ).toEqual({
      available: true,
      intent: "Confirm attendance",
      claim: "The event starts at 09:00 UTC",
      action: "RSVP",
      facts: ["2026-08-15 09:00 UTC (blocking)"],
    });
    expect(
      remediationSummary({ representation: "text/plain", field: "start" }),
    ).toBe("Update text/plain / start.");
  });

  it("fails closed on absent contracts and separates every source class", () => {
    expect(factContractSummary(undefined).available).toBe(false);
    expect(factContractSummary({ core_claim: {} }).available).toBe(false);
    expect(ASSURANCE_SOURCE_LABELS).toEqual({
      deterministic: "Deterministic",
      modeled: "Modeled prediction",
      controlled_observation: "Controlled observation",
      unavailable: "Unavailable evidence",
    });
  });
});
