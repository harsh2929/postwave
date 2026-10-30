// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  override: vi.fn(),
  start: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api/campaign-assurance", () => ({
  applyCampaignAssuranceFinding: mocks.apply,
  overrideCampaignAssuranceFinding: mocks.override,
  startCurrentCampaignAssurance: mocks.start,
  ASSURANCE_SOURCE_LABELS: {
    deterministic: "Deterministic",
    modeled: "Modeled prediction",
    controlled_observation: "Controlled observation",
    unavailable: "Unavailable evidence",
  },
  remediationSummary: () => "Change the stored heading.",
  factContractSummary: () => ({
    available: false,
    intent: "",
    claim: "",
    action: "",
    facts: [],
  }),
}));

vi.mock("../../components/campaigns/useCampaignAssurance", () => ({
  useCampaignAssurance: () => ({
    state: readyState(),
    refresh: mocks.refresh,
    loadMore: vi.fn(),
    loadingMore: false,
  }),
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { CampaignAssurancePanel } from "../../components/CampaignAssurancePanel";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.apply.mockReset();
  mocks.override.mockReset();
  mocks.start.mockReset();
  mocks.refresh.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

describe("Campaign Assurance governed apply affordance", () => {
  it("reruns through the server-owned current snapshot workflow", async () => {
    mocks.start.mockResolvedValueOnce({
      data: { data: { required_scenario_count: 3 } },
    });
    render(
      <CampaignAssurancePanel
        campaignId="campaign-1"
        canAdmin={false}
        canEdit
        canApply
        campaignETag={'"campaign:v1"'}
        onCampaignChanged={vi.fn()}
      />,
    );

    await act(async () => {
      button("Rerun full assurance")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.start).toHaveBeenCalledWith("campaign-1");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("3 frozen scenarios"),
    );
  });

  it("does not render an apply control for a viewer", () => {
    render(
      <CampaignAssurancePanel
        campaignId="campaign-1"
        canAdmin={false}
        canEdit={false}
        canApply={false}
        campaignETag={'"campaign:v1"'}
        onCampaignChanged={vi.fn()}
      />,
    );

    expect(button("Apply deterministic repair")).toBeUndefined();
    expect(document.body.textContent).toContain(
      "An editor, admin, or owner may apply",
    );
    expect(document.body.textContent).toContain("Modeled cost (µ-units)");
    expect(document.body.textContent).toContain("1,600");
    expect(document.body.textContent).toContain("exact-cache reuse");
    expect(document.body.textContent).toContain("Invoked-origin receipt");
  });

  it("closes, refreshes, and requires a fresh confirmation after 412", async () => {
    mocks.apply.mockResolvedValueOnce({
      error: { status: 412, message: "stale campaign version" },
      retryability: "not-retryable",
    });
    const onCampaignChanged = vi.fn();
    render(
      <CampaignAssurancePanel
        campaignId="campaign-1"
        canAdmin={false}
        canEdit
        canApply
        campaignETag={'"campaign:v1"'}
        onCampaignChanged={onCampaignChanged}
      />,
    );

    act(() => button("Apply deterministic repair")?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      button("Create repaired revision")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.apply).toHaveBeenCalledWith(
      "campaign-1",
      "run-1",
      "finding-1",
      '"campaign:v1"',
    );
    expect(mocks.apply.mock.calls[0]).toHaveLength(4);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(onCampaignChanged).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("review the finding before trying again"),
    );
  });
});

function render(node: ReactElement): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
}

function readyState() {
  const run = {
    id: "run-1",
    content_revision_id: "revision-1",
    send_plan_id: "plan-1",
    run_no: 1,
    profile: "full",
    state: "complete",
    source_hash: "a".repeat(64),
    plan_hash: "b".repeat(64),
    artifact_set_hash: "c".repeat(64),
    renderer_version: "renderer-v1",
    compiler_version: "compiler-v1",
    analyzer_suite_version: "analyzer-v1",
    model_suite_version: "model-v1",
    prompt_suite_version: "prompt-v1",
    scoring_version: "score-v1",
    gate_policy_version: "gate-v1",
    methodology_version: "method-v1",
    required_extraction_count: 2,
    terminal_extraction_count: 2,
    successful_extraction_count: 2,
    extraction_error_count: 0,
    finding_count: 1,
    blocking_finding_count: 1,
    overall_score: 60,
    score_min: 58,
    score_max: 62,
    gate_decision: "block",
    input_tokens: 10,
    output_tokens: 5,
    cost_microunits: 100,
    max_modeled_cost_microunits: 1600,
    latency_ms: 250,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:01:00Z",
  };
  return {
    status: "ready",
    latest: {
      measurement: {
        name: "Predicted Agent Comprehension",
        interpretation: "Predicted, not provider-observed.",
        source_classes: [
          { class: "deterministic", present: true, meaning: "Static checks." },
          { class: "modeled", present: true, meaning: "Modeled extraction." },
          {
            class: "controlled_observation",
            present: false,
            meaning: "No controlled capture.",
          },
        ],
      },
      data: {
        detail: {
          run,
          manifest: { artifacts: [], configurations: [], targets: [] },
          source_classes: ["deterministic", "modeled"],
        },
        applicability: {
          applicable_to_frozen_snapshot: true,
          freshness: "frozen_snapshot_current",
          basis: "Exact frozen identities match.",
        },
      },
    },
    evidence: {
      run,
      source_classes: ["deterministic", "modeled"],
      extractions: {
        items: [
          {
            id: "extraction-1",
            receipt_hash: "e".repeat(64),
            source_class: "modeled",
            status: "complete",
            model_provider: "google",
            model_id: "gemini",
            model_version: "2026-08-10",
            execution_kind: "cache_reuse",
            reused_from_receipt_hash: "f".repeat(64),
          },
        ],
        total: 1,
      },
      findings: {
        items: [
          {
            id: "finding-1",
            receipt_hash: "d".repeat(64),
            code: "HEADING_LEVEL_SKIP",
            source_class: "deterministic",
            severity: "error",
            blocking: true,
            overridable: false,
            dimension: "structure",
            explanation: "The heading hierarchy skips a level.",
            remediation: {},
            typed_patch: { schema_version: 1 },
          },
        ],
        total: 1,
      },
      overrides: { items: [], total: 0 },
    },
    evidenceError: null,
    revision: null,
    revisionError: null,
  };
}
