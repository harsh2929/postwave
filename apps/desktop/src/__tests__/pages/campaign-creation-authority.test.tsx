// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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
  createAbTestCampaign: vi.fn(),
  createCampaign: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: { ...actual.api, createCampaign: mocks.createCampaign },
    createABTestCampaign: mocks.createAbTestCampaign,
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    critical: vi.fn(),
    error: mocks.toastError,
    resolveCritical: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../lib/desktop-task-intents", () => ({
  consumeDesktopTaskIntent: vi.fn(),
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
  signalLifecycleOwnerChanged: vi.fn(),
}));

vi.mock("../../lib/telemetry", () => ({ track: vi.fn() }));

vi.mock(
  "../../pages/campaigns/campaign-draft-storage",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../pages/campaigns/campaign-draft-storage")
      >();
    return {
      ...actual,
      deleteCampaignDraft: vi.fn(),
      purgeAmbiguousCampaignDraft: vi.fn(),
      readCampaignDraft: vi.fn(async () => ({ status: "missing" })),
      writeCampaignDraft: vi.fn(
        async (_scope: unknown, draft: unknown) => draft,
      ),
    };
  },
);

import type { CreateCampaignVars } from "../../pages/campaigns/campaigns-page-utils";
import { CampaignCreateOverlays } from "../../pages/campaigns/CampaignCreateOverlays";
import {
  type CampaignCreation,
  useCampaignCreation,
} from "../../pages/campaigns/useCampaignCreation";
import type { CampaignsController } from "../../pages/campaigns/useCampaignsController";
import type { CampaignsData } from "../../pages/campaigns/useCampaignsData";
import type { CampaignsState } from "../../pages/campaigns/useCampaignsState";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: CampaignCreation | null = null;
let queryClient: QueryClient | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  queryClient = null;
});

function stateFixture(): CampaignsState {
  return {
    draft: {
      name: "Launch",
      subject: "Original subject",
      fromEmail: "sender@example.com",
      body: "<p>Hello</p>",
      previewText: "Preview",
    },
    abFromNames: "",
    assistantOpen: false,
    bodyTab: "edit",
    submitting: false,
    submitErr: null,
    createOpen: true,
    labOpen: true,
    errors: { clear: vi.fn(), get: vi.fn(), set: vi.fn() },
    setBodyTab: vi.fn(),
    setAssistantOpen: vi.fn(),
    setAbFromNames: vi.fn(),
    setCreateOpen: vi.fn(),
    setDraft: vi.fn(),
    setLabOpen: vi.fn(),
    setSubmitErr: vi.fn(),
    setSubmitting: vi.fn(),
  } as unknown as CampaignsState;
}

function Probe({
  canMutate,
  state,
}: {
  canMutate: boolean;
  state: CampaignsState;
}): ReactElement {
  latest = useCampaignCreation(
    state,
    { load: vi.fn() } as unknown as CampaignsData,
    canMutate,
    "0123456789abcdef",
  );
  return <div />;
}

function renderProbe(canMutate: boolean, state: CampaignsState): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <Probe canMutate={canMutate} state={state} />
      </QueryClientProvider>,
    );
  });
}

function rerenderProbe(canMutate: boolean, state: CampaignsState): void {
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <Probe canMutate={canMutate} state={state} />
      </QueryClientProvider>,
    );
  });
}

describe("campaign creation role authority", () => {
  it("makes every previously exposed creation entry fail closed after a role downgrade", async () => {
    const state = stateFixture();
    renderProbe(true, state);
    const creationBeforeDowngrade = latest!;
    const openBeforeDowngrade = creationBeforeDowngrade.openCreate;

    rerenderProbe(false, state);

    await act(async () => {
      await creationBeforeDowngrade.submitCreate();
      openBeforeDowngrade();
      creationBeforeDowngrade.runAbTestFromVariants(
        ["Variant one", "Variant two"],
        "test",
      );
      creationBeforeDowngrade.runBandit([
        {
          text: "One",
          axis: "length",
          predicted_open: 0.9,
          ci_low: 0.8,
          ci_high: 1,
          matched_n: 100,
          low_confidence: false,
          below_baseline: false,
        },
        {
          text: "Two",
          axis: "question",
          predicted_open: 0.8,
          ci_low: 0.7,
          ci_high: 0.9,
          matched_n: 100,
          low_confidence: false,
          below_baseline: false,
        },
        {
          text: "Three",
          axis: "emoji",
          predicted_open: 0.7,
          ci_low: 0.6,
          ci_high: 0.8,
          matched_n: 100,
          low_confidence: false,
          below_baseline: false,
        },
      ]);
    });

    const variables: CreateCampaignVars = {
      name: "Launch",
      subject: "Original subject",
      from_email: "sender@example.com",
      body: "<p>Hello</p>",
    };
    await expect(
      creationBeforeDowngrade.createCampaignMut.mutateAsync(variables),
    ).rejects.toThrow("Your role can't create campaigns.");

    expect(mocks.createCampaign).not.toHaveBeenCalled();
    expect(mocks.createAbTestCampaign).not.toHaveBeenCalled();
    expect(state.errors.set).toHaveBeenCalledWith(
      "_form",
      "Your role can't create campaigns.",
    );
    expect(state.setSubmitErr).toHaveBeenCalledWith(
      "Your role can't create campaigns.",
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Your role can't create campaigns.",
    );
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Campaign creation is read-only for your current role",
      detail: "Ask a workspace editor or admin for campaign creation access.",
    });
  });

  it("keeps a recovered viewer draft visible, read-only, and cancellable", () => {
    const state = stateFixture();
    const closeCreate = vi.fn();
    const controller = {
      canMutate: false,
      state,
      creation: {
        closeCreate,
        runAbTestFromVariants: vi.fn(),
        runBandit: vi.fn(),
        submitCreate: vi.fn(),
      },
    } as unknown as CampaignsController;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<CampaignCreateOverlays controller={controller} />);
    });

    const draftInputs = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "#cam-name, #cam-subject, #cam-preview-text, #cam-ab-fromnames, #cam-from, #cam-body",
      ),
    );
    expect(draftInputs).toHaveLength(6);
    expect(draftInputs.every((input) => input.disabled)).toBe(true);
    expect(document.body.textContent).toContain(
      "Ask a workspace editor or admin for campaign creation access.",
    );

    const button = (label: string): HTMLButtonElement =>
      Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      ) as HTMLButtonElement;
    expect(button("✦ Start from a brief").disabled).toBe(true);
    expect(button("Manage domains →").disabled).toBe(true);
    expect(button("Create draft").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);
    act(() => button("Cancel").click());
    expect(closeCreate).toHaveBeenCalledTimes(1);
    expect(state.setDraft).not.toHaveBeenCalled();
  });
});
