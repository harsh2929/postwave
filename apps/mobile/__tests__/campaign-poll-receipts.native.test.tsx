import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";

import { CampaignPollReceiptsCard } from "@/components/campaigns/CampaignPollReceiptsCard";
import * as PollHook from "@/hooks/useCampaignPollReceipts";

jest.mock("@/hooks/useCampaignPollReceipts");

const mockedHook = PollHook as jest.Mocked<typeof PollHook>;
const receipt = {
  definition: {
    id: "22222222-2222-4222-8222-222222222222",
    campaignId: "11111111-1111-4111-8111-111111111111",
    contentRevisionId: "33333333-3333-4333-8333-333333333333",
    contentRevisionSourceHash: "a".repeat(64),
    pollContractSha256: "b".repeat(64),
    pollKey: "launch-rsvp",
    question: "Will you attend?",
    twoStepRequired: true,
    closesAt: null,
    options: [
      { optionKey: "yes", label: "Yes", position: 0 },
      { optionKey: "no", label: "No", position: 1 },
    ],
    createdAt: "2026-08-30T10:00:00Z",
  },
  tally: {
    pollId: "22222222-2222-4222-8222-222222222222",
    pollKey: "launch-rsvp",
    contentRevisionId: "33333333-3333-4333-8333-333333333333",
    question: "Will you attend?",
    options: [
      { optionKey: "yes", label: "Yes", counted: 7 },
      { optionKey: "no", label: "No", counted: 2 },
    ],
    machineExcluded: 3,
    unclassifiedExcluded: 4,
    voidedMultiOption: 1,
    supersededChoices: 2,
    previewedOnly: 0,
    submissionReceipts: 19,
  },
};

afterEach(() => {
  jest.resetAllMocks();
});

describe("CampaignPollReceiptsCard", () => {
  it("renders observed outcomes, excluded populations, and revision receipts", async () => {
    mockedHook.useCampaignPollReceipts.mockReturnValue({
      data: [receipt],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as never);
    const view = await render(
      <CampaignPollReceiptsCard
        campaignId={receipt.definition.campaignId}
        hasSemanticPoll
      />,
    );
    expect(view.getByText("Observed outcomes")).toBeTruthy();
    expect(view.getByText(/not predicted engagement/u)).toBeTruthy();
    expect(view.getByText("Two-step confirmation")).toBeTruthy();
    expect(view.getByLabelText("Machine excluded: 3")).toBeTruthy();
    expect(view.getByLabelText("Unclassified excluded: 4")).toBeTruthy();
    expect(
      view.getByLabelText("Immutable submission receipts: 19"),
    ).toBeTruthy();
    expect(
      view.getByLabelText(
        `Frozen revision: ${receipt.definition.contentRevisionId}`,
      ),
    ).toBeTruthy();
    expect(
      view.getByLabelText(
        `Poll contract SHA-256: ${receipt.definition.pollContractSha256}`,
      ),
    ).toBeTruthy();
  });

  it("hands off authoring instead of guessing the frozen revision", async () => {
    mockedHook.useCampaignPollReceipts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as never);
    const view = await render(
      <CampaignPollReceiptsCard
        campaignId={receipt.definition.campaignId}
        hasSemanticPoll
      />,
    );
    expect(
      view.getByText(/does not guess the frozen revision/u),
    ).toBeTruthy();
    expect(view.getByText(/web or desktop/u)).toBeTruthy();
  });

  it("does not call a single-step legacy contract scanner-safe", async () => {
    mockedHook.useCampaignPollReceipts.mockReturnValue({
      data: [
        {
          ...receipt,
          definition: { ...receipt.definition, twoStepRequired: false },
        },
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as never);
    const view = await render(
      <CampaignPollReceiptsCard
        campaignId={receipt.definition.campaignId}
        hasSemanticPoll
      />,
    );
    expect(
      view.getByText("Single-step — scanner safety not assured"),
    ).toBeTruthy();
  });
});
