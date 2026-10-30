import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";

import { CampaignAssuranceSendStatus } from "@/components/campaigns/CampaignAssuranceSendStatus";
import * as AssuranceHook from "@/hooks/useCampaignAssurance";

jest.mock("@/hooks/useCampaignAssurance");
const mockedHook = AssuranceHook as jest.Mocked<typeof AssuranceHook>;

afterEach(() => {
  jest.resetAllMocks();
});

describe("CampaignAssuranceSendStatus", () => {
  it("shows the exact unified status without becoming send authority", async () => {
    mockedHook.useCampaignAssuranceStatus.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        data: {
          detail: {
            run: {
              state: "complete",
              gate_decision: "block",
              terminal_extraction_count: 3,
              required_extraction_count: 3,
              blocking_finding_count: 2,
              overall_score: 71,
              source_hash: "a".repeat(64),
              plan_hash: "b".repeat(64),
              artifact_set_hash: "c".repeat(64),
            },
          },
          applicability: {
            applicable_to_frozen_snapshot: true,
            freshness: "frozen_snapshot_current",
          },
        },
      },
    } as never);
    const view = await render(
      <CampaignAssuranceSendStatus campaignId="campaign-1" visible />,
    );
    expect(view.getByText("Unified pre-send assurance")).toBeTruthy();
    expect(view.getByText("Blocked")).toBeTruthy();
    expect(view.getByText(/Predicted score 71/u)).toBeTruthy();
    expect(view.getByText(/2 blocker/u)).toBeTruthy();
    expect(view.getByText(/queue rechecks the exact revision/u)).toBeTruthy();
    expect(view.getByText(/may refuse this action/u)).toBeTruthy();
  });

  it("does not read absence as passing", async () => {
    mockedHook.useCampaignAssuranceStatus.mockReturnValue({
      isLoading: false,
      isError: false,
      data: null,
    } as never);
    const view = await render(
      <CampaignAssuranceSendStatus campaignId="campaign-1" visible />,
    );
    expect(view.getByText("No receipt")).toBeTruthy();
    expect(view.getByText(/queue may refuse this send/u)).toBeTruthy();
  });
});
