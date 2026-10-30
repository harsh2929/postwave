import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createAiRegressionOperationsMethods,
  type AiRegressionOperationsDependencies,
  type AiRegressionRequester,
  type AiRegressionRequestOptions,
  type CaptureGoldenExampleInput,
  type RegressionResult,
  type RegressionSettings,
  type SurfaceResult,
  type TriggerRegressionRunInput,
  type TriggerRegressionRunReceipt,
} from "../../lib/api/ai-regression-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AiRegressionRequestOptions | undefined;
}

type ExactTriggerKeys =
  keyof TriggerRegressionRunInput extends "model_version_tag"
    ? "model_version_tag" extends keyof TriggerRegressionRunInput
      ? true
      : false
    : false;

type CaptureKey = "request_id" | "surface_kind" | "brief" | "approved_output";
type ExactCaptureKeys = keyof CaptureGoldenExampleInput extends CaptureKey
  ? CaptureKey extends keyof CaptureGoldenExampleInput
    ? true
    : false
  : false;

type SurfaceResultKey =
  | "total"
  | "scored"
  | "errors"
  | "passed"
  | "mean_score"
  | "gate_result";
type ExactSurfaceResultKeys = keyof SurfaceResult extends SurfaceResultKey
  ? SurfaceResultKey extends keyof SurfaceResult
    ? true
    : false
  : false;

const METHOD_NAMES = [
  "listGoldenExamples",
  "captureGoldenExample",
  "archiveGoldenExample",
  "triggerRegressionRun",
  "listRegressionRuns",
  "getLatestRegressionRun",
  "getRegressionRun",
  "getRegressionRunResults",
  "getRegressionSettings",
  "updateRegressionSettings",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const GOLDEN_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";
const CAPTURE_REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const VALID_GOLDEN = {
  id: GOLDEN_ID,
  request_id: CAPTURE_REQUEST_ID,
  surface_kind: "campaign_draft",
  brief: "Announce the launch",
  model_id: "manual_reference",
  approval_id: null,
  agent_run_id: null,
  created_at: "2026-07-16T08:00:00Z",
};

const VALID_RUN = {
  id: RUN_ID,
  runtime_provider: "google",
  model_id: "gemini-3-flash",
  model_version_tag: "model-v2",
  prompt_version_tag: "prompt-v7",
  status: "completed",
  total_examples: 1,
  passed_examples: 1,
  scored_examples: 1,
  error_examples: 0,
  fidelity_score_mean: 84,
  fidelity_score_p25: 84,
  gate_result: "pass",
  warn_threshold: 60,
  hard_gate_enabled: false,
  hard_gate_threshold: 70,
  min_examples_for_gate: 1,
  max_attempts: 3,
  attempt_count: 1,
  created_at: "2026-07-16T08:00:00Z",
  completed_at: "2026-07-16T08:01:00Z",
  updated_at: "2026-07-16T08:01:00Z",
};

const VALID_RESULT = {
  id: RESULT_ID,
  attempt_count: 1,
  surface_kind: "campaign_draft",
  severity: "ok",
  fidelity_score: 84,
  scored_at: "2026-07-16T08:01:00Z",
};

const VALID_SETTINGS: RegressionSettings = {
  warn_threshold: 60,
  hard_gate_enabled: false,
  hard_gate_threshold: 70,
  min_examples_for_gate: 5,
};

const VALID_TRIGGER_RECEIPT: TriggerRegressionRunReceipt = {
  run_id: RUN_ID,
  status: "pending",
  runtime: {
    provider: "google",
    model_id: "gemini-3-flash",
    prompt_policy_version: "prompt-v7",
  },
};

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: AiRegressionRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: AiRegressionRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: AiRegressionOperationsDependencies = { request };
  return {
    calls,
    methods: createAiRegressionOperationsMethods(dependencies),
  };
}

function success(data: unknown): ApiResult<unknown> {
  return { data };
}

async function expectContractFailure(
  result: Promise<ApiResult<unknown>>,
): Promise<void> {
  await expect(result).resolves.toMatchObject({
    error: {
      kind: "parse",
      code: "invalid_ai_regression_response_contract",
    },
    retryability: "manual",
  });
}

describe("AI regression operations API extraction contracts", () => {
  it("retains the exact ordered ten-method inventory without eager work", () => {
    const { calls, methods } = createHarness();
    const surfaceKeysMatchTerminalReceipt: ExactSurfaceResultKeys = true;

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(surfaceKeysMatchTerminalReceipt).toBe(true);
  });

  it("preserves golden-example filtering, omission, and capture transports", async () => {
    const { calls, methods } = createHarness();
    const capture: CaptureGoldenExampleInput = {
      request_id: CAPTURE_REQUEST_ID,
      surface_kind: "subject_lab",
      brief: "Announce the launch",
      approved_output: "The launch is here",
    };
    const captureKeysArePublicOnly: ExactCaptureKeys = true;

    await methods.listGoldenExamples();
    await methods.listGoldenExamples({
      surface_kind: "subject/lab",
      limit: 25,
    });
    await methods.listGoldenExamples({ surface_kind: "", limit: 0 });
    await methods.captureGoldenExample(capture);
    await methods.archiveGoldenExample("golden/one");

    expect(captureKeysArePublicOnly).toBe(true);

    expect(calls).toEqual([
      {
        path: "/api/v1/ai-regression/golden-examples",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/ai-regression/golden-examples?surface_kind=subject%2Flab&limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/ai-regression/golden-examples",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/ai-regression/golden-examples",
        init: { method: "POST", body: JSON.stringify(capture) },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/ai-regression/golden-examples/golden%2Fone",
        init: { method: "DELETE" },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("preserves run creation, listing, latest, encoded detail, and result transports", async () => {
    const accepted = VALID_TRIGGER_RECEIPT;
    const { calls, methods } = createHarness([{ data: accepted }]);
    const trigger: TriggerRegressionRunInput = {
      model_version_tag: "model-v2",
    };
    const triggerKeysAreServerAttested: ExactTriggerKeys = true;

    const triggerResponse = await methods.triggerRegressionRun(trigger);
    await methods.listRegressionRuns();
    await methods.listRegressionRuns({ limit: 30 });
    await methods.listRegressionRuns({ limit: 0 });
    await methods.getLatestRegressionRun();
    await methods.getRegressionRun("run/one");
    await methods.getRegressionRunResults("run/two");

    expect(calls).toEqual([
      {
        path: "/api/v1/ai-regression/runs",
        init: { method: "POST", body: JSON.stringify(trigger) },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/ai-regression/runs",
        init: undefined,
        opts: { timeoutMs: 15_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/ai-regression/runs?limit=30",
        init: undefined,
        opts: { timeoutMs: 15_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/ai-regression/runs",
        init: undefined,
        opts: { timeoutMs: 15_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/ai-regression/runs/latest",
        init: undefined,
        opts: { timeoutMs: 15_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/ai-regression/runs/run%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/ai-regression/runs/run%2Ftwo/results",
        init: undefined,
        opts: undefined,
      },
    ]);
    expect(triggerKeysAreServerAttested).toBe(true);
    expect(triggerResponse).toEqual({ data: accepted });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model_version_tag: "model-v2",
    });
  });

  it("preserves settings read and full replacement transports", async () => {
    const { calls, methods } = createHarness();
    const settings: RegressionSettings = {
      warn_threshold: 72,
      hard_gate_enabled: true,
      hard_gate_threshold: 60,
      min_examples_for_gate: 12,
    };

    await methods.getRegressionSettings();
    await methods.updateRegressionSettings(settings);

    expect(calls).toEqual([
      {
        path: "/api/v1/ai-regression/settings",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/ai-regression/settings",
        init: { method: "PUT", body: JSON.stringify(settings) },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("matches required severity and heterogeneous score breakdown wire types", () => {
    const result: RegressionResult = {
      id: "result-one",
      attempt_count: 2,
      surface_kind: "campaign_draft",
      approval_id: null,
      agent_run_id: "agent-run-one",
      source_created_at: "2026-07-15T00:00:00Z",
      snapshotted_at: "2026-07-16T00:00:00Z",
      snapshot_ordinal: 3,
      breakdown: {
        tone: 82,
        model: "voice-v3",
        passed: true,
        details: { distance: 0.18 },
      },
      severity: "ok",
      scored_at: "2026-07-16T00:00:00Z",
    };

    expect(result.severity).toBe("ok");
    expect(result.breakdown).toEqual({
      tone: 82,
      model: "voice-v3",
      passed: true,
      details: { distance: 0.18 },
    });
  });

  it("accepts every complete required success envelope without rewriting it", async () => {
    const { request_id: _requestID, ...goldenWithoutRequestID } = VALID_GOLDEN;
    const responses = [
      success({
        items: [
          VALID_GOLDEN,
          { ...VALID_GOLDEN, request_id: null },
          goldenWithoutRequestID,
        ],
      }),
      success(VALID_GOLDEN),
      success(VALID_TRIGGER_RECEIPT),
      success({ items: [VALID_RUN] }),
      success({ run: VALID_RUN }),
      success(VALID_RUN),
      success({ items: [VALID_RESULT] }),
      success(VALID_SETTINGS),
      success(VALID_SETTINGS),
    ];
    const { methods } = createHarness(responses);

    await expect(methods.listGoldenExamples()).resolves.toEqual(responses[0]);
    await expect(
      methods.captureGoldenExample({
        request_id: CAPTURE_REQUEST_ID,
        surface_kind: "campaign_draft",
        brief: "Announce the launch",
        approved_output: "The launch is here",
      }),
    ).resolves.toEqual(responses[1]);
    await expect(
      methods.triggerRegressionRun({ model_version_tag: "model-v2" }),
    ).resolves.toEqual(responses[2]);
    await expect(methods.listRegressionRuns()).resolves.toEqual(responses[3]);
    await expect(methods.getLatestRegressionRun()).resolves.toEqual(
      responses[4],
    );
    await expect(methods.getRegressionRun(RUN_ID)).resolves.toEqual(
      responses[5],
    );
    await expect(methods.getRegressionRunResults(RUN_ID)).resolves.toEqual(
      responses[6],
    );
    await expect(methods.getRegressionSettings()).resolves.toEqual(
      responses[7],
    );
    await expect(
      methods.updateRegressionSettings(VALID_SETTINGS),
    ).resolves.toEqual(responses[8]);

    const latestNull = createHarness([success({ run: null })]).methods;
    await expect(latestNull.getLatestRegressionRun()).resolves.toEqual({
      data: { run: null },
    });
  });

  it("rejects missing 2xx bodies for every operation that requires an envelope", async () => {
    const invocations = [
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.listGoldenExamples(),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.captureGoldenExample({
          request_id: CAPTURE_REQUEST_ID,
          surface_kind: "campaign_draft",
          brief: "Brief",
          approved_output: "Approved",
        }),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.triggerRegressionRun({ model_version_tag: "model-v2" }),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.listRegressionRuns(),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.getLatestRegressionRun(),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.getRegressionRun(RUN_ID),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.getRegressionRunResults(RUN_ID),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.getRegressionSettings(),
      (methods: ReturnType<typeof createAiRegressionOperationsMethods>) =>
        methods.updateRegressionSettings(VALID_SETTINGS),
    ];

    for (const invoke of invocations) {
      const { methods } = createHarness([success(undefined)]);
      await expectContractFailure(invoke(methods));
    }
  });

  it("rejects malformed list, entity, latest, result, and settings envelopes", async () => {
    const cases: Array<{
      data: unknown;
      invoke: (
        methods: ReturnType<typeof createAiRegressionOperationsMethods>,
      ) => Promise<ApiResult<unknown>>;
    }> = [
      {
        data: { items: {} },
        invoke: (methods) => methods.listGoldenExamples(),
      },
      {
        data: { ...VALID_GOLDEN, id: "not-a-uuid" },
        invoke: (methods) =>
          methods.captureGoldenExample({
            request_id: CAPTURE_REQUEST_ID,
            surface_kind: "campaign_draft",
            brief: "Brief",
            approved_output: "Approved",
          }),
      },
      {
        data: { items: [{ ...VALID_RUN, total_examples: "1" }] },
        invoke: (methods) => methods.listRegressionRuns(),
      },
      {
        data: { run: [] },
        invoke: (methods) => methods.getLatestRegressionRun(),
      },
      {
        data: { id: RUN_ID },
        invoke: (methods) => methods.getRegressionRun(RUN_ID),
      },
      {
        data: { items: [{ ...VALID_RESULT, severity: "unknown" }] },
        invoke: (methods) => methods.getRegressionRunResults(RUN_ID),
      },
      {
        data: { ...VALID_SETTINGS, warn_threshold: Number.NaN },
        invoke: (methods) => methods.getRegressionSettings(),
      },
      {
        data: { ...VALID_SETTINGS, min_examples_for_gate: 0 },
        invoke: (methods) => methods.updateRegressionSettings(VALID_SETTINGS),
      },
    ];

    for (const testCase of cases) {
      const { methods } = createHarness([success(testCase.data)]);
      await expectContractFailure(testCase.invoke(methods));
    }
  });

  it("requires an exact pending trigger receipt with UUID and runtime identity", async () => {
    const malformedReceipts = [
      { ...VALID_TRIGGER_RECEIPT, run_id: "run-one" },
      { ...VALID_TRIGGER_RECEIPT, status: "running" },
      {
        ...VALID_TRIGGER_RECEIPT,
        runtime: { ...VALID_TRIGGER_RECEIPT.runtime, provider: "" },
      },
      {
        ...VALID_TRIGGER_RECEIPT,
        runtime: {
          provider: "google",
          model_id: "gemini-3-flash",
        },
      },
      { ...VALID_TRIGGER_RECEIPT, unexpected: true },
    ];

    for (const receipt of malformedReceipts) {
      const { methods } = createHarness([success(receipt)]);
      await expectContractFailure(
        methods.triggerRegressionRun({ model_version_tag: "model-v2" }),
      );
    }
  });

  it("rejects an invalid capture request identity before issuing a request", async () => {
    const { calls, methods } = createHarness([success(VALID_GOLDEN)]);
    const input: CaptureGoldenExampleInput = {
      request_id: "NOT-A-LOWERCASE-UUID",
      surface_kind: "campaign_draft",
      brief: "Brief",
      approved_output: "Approved",
    };

    await expect(methods.captureGoldenExample(input)).resolves.toEqual({
      error: {
        kind: "invalid_config",
        code: "invalid_ai_regression_capture_request_id",
        message:
          "A lowercase UUID request identity is required before saving this golden reference.",
      },
      retryability: "not-retryable",
      preservedDraft: input,
    });
    expect(calls).toEqual([]);
  });

  it("retains request error identity", async () => {
    const expectedError: ApiErr = {
      error: { kind: "http", status: 503, message: "Unavailable" },
    };
    const { methods } = createHarness([expectedError]);

    await expect(methods.getRegressionSettings()).resolves.toBe(expectedError);
  });
});
