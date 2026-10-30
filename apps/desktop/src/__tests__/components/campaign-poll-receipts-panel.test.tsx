// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  materialize: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("../../lib/campaign-polls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/campaign-polls")>()),
  listCampaignPollReceipts: mocks.list,
  materializeCurrentCampaignPolls: mocks.materialize,
}));
vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import { CampaignPollReceiptsPanel } from "../../components/campaigns/CampaignPollReceiptsPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
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

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mocks.list.mockReset();
  mocks.materialize.mockReset();
  mocks.toastSuccess.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("CampaignPollReceiptsPanel", () => {
  it("renders observed exclusions and immutable revision provenance", async () => {
    mocks.list.mockResolvedValue({ data: [receipt] });
    renderPanel(true, true);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Will you attend?"),
    );
    expect(document.body.textContent).toContain("Observed outcomes");
    expect(document.body.textContent).toContain("not predicted engagement");
    expect(document.body.textContent).toContain("Machine excluded3");
    expect(document.body.textContent).toContain("Unclassified excluded4");
    expect(document.body.textContent).toContain(
      "Immutable submission receipts19",
    );
    expect(document.body.textContent).toContain("Poll contract SHA-256");
    expect(document.body.textContent).toContain(
      "Freeze current revision and materialize polls",
    );
  });

  it("freezes and materializes saved semantic polls through the exact two-step path", async () => {
    mocks.list.mockResolvedValue({ data: [] });
    mocks.materialize.mockResolvedValue({
      data: {
        revision: {
          revisionId: receipt.definition.contentRevisionId,
          campaignId: receipt.definition.campaignId,
          sourceHash: receipt.definition.contentRevisionSourceHash,
          pollKeys: [receipt.definition.pollKey],
        },
        definitions: [receipt.definition],
      },
    });
    renderPanel(true, true);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No immutable poll"),
    );
    expect(document.body.textContent).toContain(
      "Question and option content stays server-owned",
    );
    const action = Array.from(document.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent?.trim() ===
        "Freeze current revision and materialize polls",
    );
    await act(async () => action?.click());
    await waitFor(() => expect(mocks.materialize).toHaveBeenCalledTimes(1));
  });

  it("keeps unsaved local poll keys out of the mutation", async () => {
    mocks.list.mockResolvedValue({ data: [receipt] });
    renderPanel(true, false, "Save and close the campaign editor first.");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Save and close the campaign editor first.",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "Freeze current revision and materialize polls",
    );
  });

  it("does not call a single-step legacy contract scanner-safe", async () => {
    mocks.list.mockResolvedValue({
      data: [
        {
          ...receipt,
          definition: { ...receipt.definition, twoStepRequired: false },
        },
      ],
    });
    renderPanel(true, true);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Single-step — scanner safety not assured",
      ),
    );
  });
});

function renderPanel(
  hasSemanticPoll: boolean,
  canConfigure: boolean,
  configurationBlockedReason?: string,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <CampaignPollReceiptsPanel
        campaignId="11111111-1111-4111-8111-111111111111"
        hasSemanticPoll={hasSemanticPoll}
        canConfigure={canConfigure}
        configurationBlockedReason={configurationBlockedReason}
      />,
    );
  });
}

async function waitFor(assertion: () => void) {
  let error: unknown;
  for (let index = 0; index < 30; index += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
      await act(
        async () =>
          void (await new Promise((resolve) => setTimeout(resolve, 0))),
      );
    }
  }
  throw error;
}
