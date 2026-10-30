// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  confirmWrite: vi.fn(),
}));
vi.mock("@/lib/campaign-write-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-write-authority")>()),
  confirmFreshCampaignWriteAuthority: mocks.confirmWrite,
}));
vi.mock("@/lib/campaign-polls-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-polls-api")>()),
  listCampaignPollReceipts: mocks.list,
  materializeCurrentCampaignPolls: mocks.materialize,
}));

import { CampaignPollReceiptsPanel } from "@/components/campaigns/campaign-poll-receipts-panel";
import type { MeResponse } from "@/lib/auth-api";

const IDENTITY: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

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
  mocks.confirmWrite.mockReset();
  mocks.confirmWrite.mockResolvedValue(undefined);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("CampaignPollReceiptsPanel", () => {
  it("labels observed outcomes and every excluded population beside provenance", async () => {
    mocks.list.mockResolvedValue([receipt]);
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
    expect(document.body.textContent).toContain("Two-step confirmation");
    expect(document.body.textContent).toContain("Frozen revision");
    expect(document.body.textContent).toContain("Poll contract SHA-256");
    expect(document.body.textContent).toContain(
      "Freeze current revision and materialize polls",
    );
  });

  it("offers exact freeze-to-two-step materialization for saved semantic polls", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.materialize.mockResolvedValue({
      revision: {
        revisionId: receipt.definition.contentRevisionId,
        campaignId: receipt.definition.campaignId,
        sourceHash: receipt.definition.contentRevisionSourceHash,
        pollKeys: [receipt.definition.pollKey],
      },
      definitions: [receipt.definition],
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
    const options = mocks.materialize.mock.calls[0]?.[1] as
      | { beforeWrite?: () => Promise<void> }
      | undefined;
    await options?.beforeWrite?.();
    expect(mocks.confirmWrite).toHaveBeenCalledWith(IDENTITY);
  });

  it("explains why unsaved draft polls cannot be frozen", async () => {
    mocks.list.mockResolvedValue([receipt]);
    renderPanel(true, false, "Save the campaign first.");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Save the campaign first."),
    );
    expect(document.body.textContent).not.toContain(
      "Freeze current revision and materialize polls",
    );
  });

  it("offers an explicit retry when receipt verification is unknown", async () => {
    mocks.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);
    renderPanel(true, false, "Use web or desktop after reconnecting.");
    await waitFor(() =>
      expect(document.body.textContent).toContain("unknown, not zero"),
    );
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Retry receipt"),
    );
    await act(async () => retry?.click());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it("does not call a single-step legacy contract scanner-safe", async () => {
    mocks.list.mockResolvedValue([
      {
        ...receipt,
        definition: { ...receipt.definition, twoStepRequired: false },
      },
    ]);
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <CampaignPollReceiptsPanel
          campaignId="11111111-1111-4111-8111-111111111111"
          tenantId="tenant"
          role="editor"
          hasSemanticPoll={hasSemanticPoll}
          canConfigure={canConfigure}
          configurationBlockedReason={configurationBlockedReason}
          identity={IDENTITY}
        />
      </QueryClientProvider>,
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
