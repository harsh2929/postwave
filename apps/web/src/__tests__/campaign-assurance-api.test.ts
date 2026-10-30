// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  uuid: "018f47a0-9b7c-7000-8000-000000000001",
}));

vi.mock("@/lib/api", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/lib/http-fetch", () => ({ newUUIDv7: () => mocks.uuid }));

import {
  applyCampaignAssuranceFinding,
  CampaignAssuranceApplyProvenanceError,
  CAMPAIGN_ASSURANCE_SOURCE_LABELS,
  factContractSummary,
  getCampaignAssuranceEvidence,
  getCampaignContentRevision,
  getLatestCampaignAssurance,
  overrideCampaignAssuranceFinding,
  remediationSummary,
  startCurrentCampaignAssurance,
} from "@/lib/campaign-assurance-api";
import {
  getCampaign,
  getCampaignETag,
  isExactStrongCampaignETag,
} from "@/lib/campaigns-api";

describe("Campaign Assurance web API paths", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  it("reads the latest receipt, paged evidence, and exact frozen revision", () => {
    void getLatestCampaignAssurance("campaign/one");
    void getCampaignAssuranceEvidence("campaign/one", "run/two", 200);
    void getCampaignContentRevision("campaign/one", "revision/three");

    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/campaigns/campaign%2Fone/assurance",
      "/api/v1/campaigns/campaign%2Fone/assurance-runs/run%2Ftwo/evidence?limit=200&offset=200",
      "/api/v1/campaigns/campaign%2Fone/content-revisions/revision%2Fthree",
    ]);
  });

  it("starts the current exact snapshot without client-authored artifact identities", () => {
    void startCurrentCampaignAssurance("campaign/one");

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%2Fone/assurance-runs",
      { profile: "full", request_id: mocks.uuid },
      { requireOnline: true, maxAttempts: 3 },
    );
  });

  it("offers apply only from a strong ETag captured with campaign content", async () => {
    mocks.get.mockImplementationOnce(
      async (_path: string, options: { onResponse: (response: Response) => void }) => {
        options.onResponse(
          new Response(null, { status: 200, headers: { ETag: '"campaign-v1"' } }),
        );
        return { id: "campaign-etag", name: "Campaign" };
      },
    );
    await getCampaign("campaign-etag");
    expect(getCampaignETag("campaign-etag")).toBe('"campaign-v1"');

    mocks.get.mockImplementationOnce(
      async (_path: string, options: { onResponse: (response: Response) => void }) => {
        options.onResponse(
          new Response(null, { status: 200, headers: { ETag: 'W/"campaign-v2"' } }),
        );
        return { id: "campaign-weak-etag", name: "Campaign" };
      },
    );
    await getCampaign("campaign-weak-etag");
    expect(getCampaignETag("campaign-weak-etag")).toBeNull();

    for (const invalid of [
      '"campaign-v1", "campaign-v2"',
      ' "campaign-v1"',
      '"campaign-v1"\n',
      '"campaign\u007f-v1"',
      '""',
      "*",
    ]) {
      expect(isExactStrongCampaignETag(invalid)).toBe(false);
    }
    expect(isExactStrongCampaignETag('"campaign-v1"')).toBe(true);
  });

  it("sends a governed decision with a stable request identity and no offline queue", () => {
    void overrideCampaignAssuranceFinding("campaign/one", "run/two", "finding/three", {
      decision: "allow_send",
      reason: "The named owner reviewed the immutable finding receipt.",
    });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%2Fone/assurance-runs/run%2Ftwo/findings/finding%2Fthree/overrides",
      {
        request_id: mocks.uuid,
        decision: "allow_send",
        reason: "The named owner reviewed the immutable finding receipt.",
      },
      { requireOnline: true },
    );
  });

  it("applies only against the exact ETag and preserves response provenance", async () => {
    mocks.get.mockImplementationOnce(
      async (_path: string, options: { onResponse: (response: Response) => void }) => {
        options.onResponse(
          new Response(null, { status: 200, headers: { ETag: '"campaign-v1"' } }),
        );
        return { id: "campaign/one", name: "Campaign" };
      },
    );
    await getCampaign("campaign/one");
    expect(getCampaignETag("campaign/one")).toBe('"campaign-v1"');

    mocks.post.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse: (response: Response) => void }) => {
        options.onResponse(
          new Response(null, {
            status: 201,
            headers: {
              ETag: '"campaign-v2"',
              Location: "/api/v1/campaigns/campaign%2Fone/content-revisions/revision-v2",
            },
          }),
        );
        return {
          measurement: {
            name: "Predicted Agent Comprehension",
            interpretation: "Predicted, not provider-observed.",
            source_classes: [],
          },
          data: {
            application: {},
            revision: { id: "revision-v2" },
            campaign_etag: '"campaign-v2"',
            originating_run_state: "stale",
            rerun_required: true,
          },
        };
      },
    );

    const result = await applyCampaignAssuranceFinding(
      "campaign/one",
      "run/two",
      "finding/three",
      '"campaign-v1"',
    );

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%2Fone/assurance-runs/run%2Ftwo/findings/finding%2Fthree/apply",
      { request_id: mocks.uuid },
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 3,
        headers: { "If-Match": '"campaign-v1"' },
      }),
    );
    expect(result).toMatchObject({
      campaignETag: '"campaign-v2"',
      location: "/api/v1/campaigns/campaign%2Fone/content-revisions/revision-v2",
      receipt: {
        data: {
          originating_run_state: "stale",
          rerun_required: true,
        },
      },
    });
    expect(getCampaignETag("campaign/one")).toBeNull();
  });

  it("refuses weak apply preconditions before dispatch", async () => {
    for (const invalid of [
      'W/"campaign-v1"',
      '"campaign-v1", "campaign-v2"',
      ' "campaign-v1"',
      '"campaign-v1"\n',
      "*",
    ]) {
      await expect(
        applyCampaignAssuranceFinding(
          "campaign-one",
          "run-two",
          "finding-three",
          invalid,
        ),
      ).rejects.toThrow("strong campaign ETag");
    }
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("fails closed when response Location does not identify the returned revision", async () => {
    mocks.post.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse: (response: Response) => void }) => {
        options.onResponse(
          new Response(null, {
            status: 201,
            headers: {
              ETag: '"campaign-v2"',
              Location: "/api/v1/campaigns/campaign-one/content-revisions/a-different-revision",
            },
          }),
        );
        return {
          measurement: {
            name: "Predicted Agent Comprehension",
            interpretation: "Predicted, not provider-observed.",
            source_classes: [],
          },
          data: {
            application: {},
            revision: { id: "revision-v2" },
            campaign_etag: '"campaign-v2"',
            originating_run_state: "stale",
            rerun_required: true,
          },
        };
      },
    );

    await expect(
      applyCampaignAssuranceFinding(
        "campaign-one",
        "run-two",
        "finding-three",
        '"campaign-v1"',
      ),
    ).rejects.toBeInstanceOf(CampaignAssuranceApplyProvenanceError);
  });
});

describe("Campaign Assurance web presentation helpers", () => {
  it("recovers the exact v1 Fact Contract fields", () => {
    expect(
      factContractSummary({
        primary_intent: { statement: "Invite members" },
        core_claim: { statement: "Registration closes Friday" },
        primary_action: { label: "Register now" },
        required_facts: [
          { id: "deadline", display_value: "2026-08-14 17:00 UTC", criticality: "blocking" },
        ],
      }),
    ).toEqual({
      available: true,
      intent: "Invite members",
      claim: "Registration closes Friday",
      action: "Register now",
      facts: [
        {
          id: "deadline",
          value: "2026-08-14 17:00 UTC",
          criticality: "blocking",
        },
      ],
    });
  });

  it("fails closed on absent contracts and explains typed remediation", () => {
    expect(factContractSummary(null).available).toBe(false);
    expect(factContractSummary({ primary_intent: {} }).available).toBe(false);
    expect(
      remediationSummary({ representation: "text/plain", field: "deadline" }),
    ).toBe("Update text/plain / deadline.");
  });

  it("keeps modeled, observed, deterministic, and unavailable vocabulary distinct", () => {
    expect(CAMPAIGN_ASSURANCE_SOURCE_LABELS).toEqual({
      deterministic: "Deterministic",
      modeled: "Modeled prediction",
      controlled_observation: "Controlled observation",
      unavailable: "Unavailable evidence",
    });
  });
});
