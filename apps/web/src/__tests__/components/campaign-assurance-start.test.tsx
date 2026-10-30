// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from "react";
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

import { setOnlineStatusForTest } from "@/lib/online-manager";

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;

    constructor(status: number) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  }
  return {
    ApiError,
    start: vi.fn(),
    refetch: vi.fn(),
    evidenceRefetch: vi.fn(),
    fetchNextPage: vi.fn(),
    invalidate: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    confirmWrite: vi.fn(),
    latestResult: undefined as unknown,
    evidenceResult: undefined as unknown,
  };
});

vi.mock("@/lib/campaign-write-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-write-authority")>()),
  confirmFreshCampaignWriteAuthority: mocks.confirmWrite,
}));

vi.mock("@/lib/api", () => ({
  ApiError: mocks.ApiError,
  apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/lib/campaign-assurance-api", () => ({
  startCurrentCampaignAssurance: mocks.start,
  applyCampaignAssuranceFinding: vi.fn(),
  getCampaignAssuranceEvidence: vi.fn(),
  getCampaignContentRevision: vi.fn(),
  getLatestCampaignAssurance: vi.fn(),
  isCampaignAssuranceNotEnabled: () => false,
  overrideCampaignAssuranceFinding: vi.fn(),
  CAMPAIGN_ASSURANCE_SOURCE_LABELS: {
    deterministic: "Deterministic",
    modeled: "Modeled prediction",
    controlled_observation: "Controlled observation",
    unavailable: "Unavailable",
  },
  CampaignAssuranceApplyProvenanceError: class extends Error {},
  factContractSummary: () => ({
    available: false,
    intent: "",
    claim: "",
    action: "",
    facts: [],
  }),
  remediationSummary: () => "",
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useInfiniteQuery: () =>
    mocks.evidenceResult ?? {
      data: undefined,
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isError: false,
      refetch: mocks.evidenceRefetch,
      fetchNextPage: mocks.fetchNextPage,
      hasNextPage: false,
    },
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    if (options.queryKey.includes("content-revision")) {
      return { data: undefined, isPending: false, isError: false };
    }
    if (mocks.latestResult) return mocks.latestResult;
    return {
      data: undefined,
      isPending: false,
      isError: true,
      error: new mocks.ApiError(404),
      refetch: mocks.refetch,
    };
  },
}));

import { CampaignAssurancePanel } from "@/app/(dashboard)/app/campaigns/[id]/campaign-assurance-panel";
import type { MeResponse } from "@/lib/auth-api";

const IDENTITY: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
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

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  for (const mock of [
    mocks.start,
    mocks.refetch,
    mocks.evidenceRefetch,
    mocks.fetchNextPage,
    mocks.invalidate,
    mocks.toastError,
    mocks.toastSuccess,
    mocks.confirmWrite,
  ])
    mock.mockReset();
  mocks.latestResult = undefined;
  mocks.evidenceResult = undefined;
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue(undefined);
  mocks.confirmWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("Campaign Assurance current-snapshot control", () => {
  it("starts the server-owned full scenario run and refreshes its receipt", async () => {
    mocks.start.mockResolvedValueOnce({
      data: { required_scenario_count: 4 },
    });
    renderPanel(true);

    await act(async () => {
      button("Run full assurance")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.start).toHaveBeenCalledWith("campaign-1");
    expect(mocks.confirmWrite).toHaveBeenCalledWith(IDENTITY);
    expect(mocks.confirmWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0]!,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith({
      queryKey: ["campaign", "tenant-1", "editor", "campaign-1"],
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("4 frozen scenarios"),
    );
  });

  it("cannot certify stale local edits", () => {
    renderPanel(false);

    const control = button("Save or discard local edits first");
    expect(control?.disabled).toBe(true);
    act(() => control?.click());
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("renders a loaded immutable receipt and paginates its finding evidence", async () => {
    mocks.latestResult = loadedLatestResult();
    mocks.evidenceResult = {
      data: {
        pages: [
          {
            data: {
              run: loadedLatestResult().data.data.detail.run,
              source_classes: ["deterministic"],
              extractions: pageOf([], 1),
              findings: pageOf(
                [
                  {
                    id: "finding-1",
                    receipt_hash: "finding-receipt",
                    code: "HEADING_LEVEL_SKIP",
                    source_class: "deterministic",
                    severity: "high",
                    blocking: true,
                    overridable: true,
                    dimension: "accessibility",
                    explanation: "A heading level is skipped.",
                    remediation: {},
                    typed_patch: { version: "TypedPatchV1" },
                    created_at: "2026-08-25T09:00:00Z",
                  },
                ],
                1,
              ),
              overrides: pageOf([], 1),
            },
          },
        ],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isError: false,
      refetch: mocks.evidenceRefetch,
      fetchNextPage: mocks.fetchNextPage,
      hasNextPage: true,
      // A manual "load more" is refused unless the query is enabled.
      isEnabled: true,
    };
    renderPanel(true);

    expect(document.body.textContent).toContain("Immutable receipt");
    expect(document.body.textContent).toContain("HEADING_LEVEL_SKIP");
    await act(async () => button("Load more immutable evidence")?.click());
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("keeps an evidence-fetch failure explicit and offers a direct retry", async () => {
    mocks.latestResult = loadedLatestResult();
    mocks.evidenceResult = {
      data: undefined,
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isError: true,
      refetch: mocks.evidenceRefetch,
      fetchNextPage: mocks.fetchNextPage,
      hasNextPage: false,
    };
    renderPanel(true);

    const alert = Array.from(
      document.querySelectorAll<HTMLElement>('[role="alert"]'),
    ).find((candidate) =>
      candidate.textContent?.includes(
        "Could not load the immutable finding receipts.",
      ),
    );
    expect(alert?.textContent).toContain(
      "Could not load the immutable finding receipts.",
    );
    await act(async () => button("Retry evidence")?.click());
    expect(mocks.evidenceRefetch).toHaveBeenCalledTimes(1);
  });
});

function pageOf<T>(items: T[], nextOffset?: number) {
  return {
    items,
    offset: 0,
    limit: 1,
    total: nextOffset === undefined ? items.length : items.length + 1,
    ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
  };
}

function loadedLatestResult() {
  const run = {
    id: "run-1",
    campaign_id: "campaign-1",
    content_revision_id: "revision-1",
    send_plan_id: "plan-1",
    run_no: 2,
    profile: "full",
    state: "complete",
    source_hash: "source-hash",
    plan_hash: "plan-hash",
    artifact_set_hash: "artifact-hash",
    coverage_manifest_hash: "coverage-hash",
    configuration_manifest_hash: "configuration-hash",
    target_manifest_hash: "target-hash",
    renderer_version: "renderer-v1",
    compiler_version: "compiler-v1",
    analyzer_suite_version: "analyzer-v1",
    model_suite_version: "model-v1",
    prompt_suite_version: "prompt-v1",
    normalization_version: "normalization-v1",
    scoring_version: "scoring-v1",
    gate_policy_version: "gate-v1",
    methodology_version: "method-v1",
    required_extraction_count: 1,
    terminal_extraction_count: 1,
    successful_extraction_count: 1,
    extraction_error_count: 0,
    finding_count: 1,
    blocking_finding_count: 1,
    overall_score: 72,
    score_min: 70,
    score_max: 74,
    score_spread: 4,
    agreement: 0.94,
    gate_decision: "block",
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:01:00Z",
    completed_at: "2026-08-25T09:01:00Z",
  };
  return {
    data: {
      measurement: {
        name: "Predicted Agent Comprehension",
        interpretation: "Exact frozen-snapshot evidence.",
        source_classes: [
          {
            class: "deterministic",
            present: true,
            meaning: "Static structural evidence.",
          },
          {
            class: "modeled",
            present: false,
            meaning: "Modeled evidence unavailable.",
          },
          {
            class: "controlled_observation",
            present: false,
            meaning: "No controlled observation.",
          },
        ],
      },
      data: {
        detail: {
          run,
          manifest: {
            run,
            artifacts: [],
            configurations: [],
            targets: [],
          },
          source_classes: ["deterministic"],
        },
        applicability: {
          applicable_to_frozen_snapshot: true,
          freshness: "frozen_snapshot_current",
          basis: "All receipt identities match.",
        },
      },
    },
    isPending: false,
    isError: false,
    error: null,
    refetch: mocks.refetch,
  };
}

function renderPanel(canApply: boolean): void {
  render(
    createElement(CampaignAssurancePanel, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      role: "editor",
      canOverride: false,
      canEdit: true,
      canApply,
      campaignETag: '"campaign-v1"',
      identity: IDENTITY,
    }),
  );
}

function render(node: ReactElement): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
}
