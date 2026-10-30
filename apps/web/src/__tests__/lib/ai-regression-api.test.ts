// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  uuid: "77777777-7777-4777-8777-777777777777",
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    delete: mocks.delete,
  },
}));
vi.mock("@/lib/http-fetch", () => ({ newUUIDv7: () => mocks.uuid }));

import {
  captureGoldenExample,
  getAiRegressionSettings,
  listAiRegressionRunResults,
  listAiRegressionRuns,
  listGoldenExamples,
  newGoldenCaptureRequestId,
  triggerAiRegressionRun,
  updateAiRegressionSettings,
} from "@/lib/ai-regression-api";

const EXAMPLE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";

const settingsWire = {
  warn_threshold: 60,
  hard_gate_enabled: true,
  hard_gate_threshold: 70,
  min_examples_for_gate: 5,
};
const goldenWire = {
  id: EXAMPLE_ID,
  surface_kind: "campaign_draft",
  brief: "Draft a launch campaign.",
  model_id: "manual_reference",
  request_id: mocks.uuid,
  created_at: "2026-08-30T10:00:00Z",
};
const runWire = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  runtime_provider: "google",
  model_id: "gemini-3-flash-preview",
  model_version_tag: "candidate-7",
  prompt_version_tag: "voice-regression-replay-v2",
  status: "completed",
  total_examples: 1,
  passed_examples: 1,
  scored_examples: 1,
  error_examples: 0,
  fidelity_score_mean: 88,
  fidelity_score_p25: 88,
  gate_result: "pass",
  warn_threshold: 60,
  hard_gate_enabled: true,
  hard_gate_threshold: 70,
  min_examples_for_gate: 1,
  max_attempts: 3,
  by_surface: {
    campaign_draft: {
      total: 1,
      scored: 1,
      errors: 0,
      passed: 1,
      mean_score: 88,
      gate_result: "pass",
    },
  },
  created_at: "2026-08-30T10:00:00Z",
  completed_at: "2026-08-30T10:01:00Z",
  attempt_count: 1,
  updated_at: "2026-08-30T10:01:00Z",
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe("AI regression web client", () => {
  it("strictly decodes settings and fails closed instead of coercing malformed thresholds", async () => {
    mocks.get.mockResolvedValue(settingsWire);
    await expect(getAiRegressionSettings()).resolves.toEqual({
      warnThreshold: 60,
      hardGateEnabled: true,
      hardGateThreshold: 70,
      minExamplesForGate: 5,
    });
    mocks.get.mockResolvedValue({ ...settingsWire, warn_threshold: "60" });
    await expect(getAiRegressionSettings()).rejects.toThrow(/out of range/u);
  });

  it("bounds and strictly parses golden metadata", async () => {
    mocks.get.mockResolvedValue({ items: [goldenWire] });
    await expect(listGoldenExamples()).resolves.toMatchObject([
      { id: EXAMPLE_ID, surfaceKind: "campaign_draft", requestId: mocks.uuid },
    ]);
    mocks.get.mockResolvedValue({
      items: [{ ...goldenWire, approved_output: "must never be listed" }],
    });
    await expect(listGoldenExamples()).rejects.toThrow(/unexpected field/u);
  });

  it("captures with a stable idempotency key and no offline/transport retry", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue(goldenWire);
    expect(newGoldenCaptureRequestId()).toBe(mocks.uuid);
    await expect(
      captureGoldenExample(
        {
          requestId: mocks.uuid,
          surfaceKind: "campaign_draft",
          brief: " Draft a launch campaign. ",
          approvedOutput: " Approved copy. ",
        },
        signal,
      ),
    ).resolves.toMatchObject({ requestId: mocks.uuid });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/ai-regression/golden-examples",
      {
        request_id: mocks.uuid,
        surface_kind: "campaign_draft",
        brief: "Draft a launch campaign.",
        approved_output: "Approved copy.",
      },
      { requireOnline: true, maxAttempts: 1, signal },
    );
  });

  it("replaces complete settings online and validates the full receipt", async () => {
    mocks.put.mockResolvedValue(settingsWire);
    await updateAiRegressionSettings({
      warnThreshold: 60,
      hardGateEnabled: true,
      hardGateThreshold: 70,
      minExamplesForGate: 5,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/ai-regression/settings",
      settingsWire,
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("strictly parses run lifecycle and rejects an impossible status", async () => {
    mocks.get.mockResolvedValue({ items: [runWire()] });
    await expect(listAiRegressionRuns()).resolves.toMatchObject([
      {
        id: RUN_ID,
        status: "completed",
        gateResult: "pass",
        fidelityScoreMean: 88,
      },
    ]);
    mocks.get.mockResolvedValue({ items: [runWire({ status: "done" })] });
    await expect(listAiRegressionRuns()).rejects.toThrow(/invalid value/u);
  });

  it("queues only an operator label and verifies server-attested runtime identity", async () => {
    mocks.post.mockResolvedValue({
      run_id: RUN_ID,
      status: "pending",
      runtime: {
        provider: "google",
        model_id: "gemini-3-flash-preview",
        prompt_policy_version: "voice-regression-replay-v2",
      },
    });
    await expect(
      triggerAiRegressionRun(" candidate-7 "),
    ).resolves.toMatchObject({
      runId: RUN_ID,
      status: "pending",
      runtime: { provider: "google" },
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/ai-regression/runs",
      { model_version_tag: "candidate-7" },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("parses immutable per-reference comparison evidence", async () => {
    mocks.get.mockResolvedValue({
      items: [
        {
          id: RESULT_ID,
          example_id: EXAMPLE_ID,
          attempt_count: 1,
          surface_kind: "campaign_draft",
          snapshot_ordinal: 1,
          brief: "Draft a launch campaign.",
          approved_output: "Approved copy.",
          replayed_output: "Replayed copy.",
          fidelity_score: 88,
          breakdown: {
            embedding_similarity: 0.9,
            stylistic_distance: 0.8,
            vocabulary_overlap: 0.7,
            structural_match: 0.6,
            combined: 88,
          },
          severity: "ok",
          scored_at: "2026-08-30T10:01:00Z",
        },
      ],
    });
    await expect(listAiRegressionRunResults(RUN_ID)).resolves.toMatchObject([
      {
        approvedOutput: "Approved copy.",
        replayedOutput: "Replayed copy.",
        breakdown: { combined: 88 },
      },
    ]);
  });
});
