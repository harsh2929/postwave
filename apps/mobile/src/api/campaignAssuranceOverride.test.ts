import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordCampaignAssuranceOverride } from "./campaignAssuranceOverride";

const mocks = vi.hoisted(() => ({
  overrideFinding: vi.fn(),
  operationId: vi.fn(() => "01991f9d-44bb-7aa2-8000-000000000001"),
}));

vi.mock("@/api/client", () => ({
  getClient: () => ({
    client: {
      campaignAssurance: { overrideFinding: mocks.overrideFinding },
    },
  }),
}));
vi.mock("@/lib/offlineMutations", () => ({
  newOfflineOperationId: mocks.operationId,
}));

beforeEach(() => {
  mocks.overrideFinding.mockReset();
  mocks.overrideFinding.mockResolvedValue({ data: {} });
  mocks.operationId.mockClear();
});

describe("mobile Campaign Assurance override API", () => {
  it("records an exact finding-scoped decision with a stable logical request ID", async () => {
    await recordCampaignAssuranceOverride({
      campaignId: "campaign-1",
      runId: "run-1",
      findingId: "finding-1",
      decision: "allow_send",
      reason: "  Specific governed rationale.  ",
    });

    expect(mocks.overrideFinding).toHaveBeenCalledWith(
      "campaign-1",
      "run-1",
      "finding-1",
      {
        request_id: "01991f9d-44bb-7aa2-8000-000000000001",
        decision: "allow_send",
        reason: "Specific governed rationale.",
      },
    );
  });

  it("rejects a blank rationale before making a network call", async () => {
    await expect(
      recordCampaignAssuranceOverride({
        campaignId: "campaign-1",
        runId: "run-1",
        findingId: "finding-1",
        decision: "reject",
        reason: "   ",
      }),
    ).rejects.toThrow("10 to 2000");
    expect(mocks.overrideFinding).not.toHaveBeenCalled();
  });
});
