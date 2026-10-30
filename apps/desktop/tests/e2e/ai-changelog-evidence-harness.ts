import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Request,
  Route,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";

import type {
  RegressionResult,
  RegressionRun,
  SurfaceResult,
} from "../../src/lib/api-client";
import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export type AIChangelogEvidenceMode = "source" | "optimized";
export type AIChangelogRole = "admin" | "viewer";
export type EndpointMode = "success" | "error" | "deferred";

export type RegressionRunFixture = RegressionRun;
type SurfaceReceiptFixture = SurfaceResult;

export interface RegressionResultFixture extends RegressionResult {
  example_id: string;
  brief: string;
  approved_output: string;
  source_model_id: string;
  voice_profile_version: string;
  source_created_at: string;
  snapshotted_at: string;
  snapshot_ordinal: number;
  breakdown?: {
    embedding_similarity: number;
    stylistic_distance: number;
    vocabulary_overlap: number;
    structural_match: number;
    combined: number;
  };
}

export interface AIChangelogRequestEvidence {
  body: string | null;
  method: string;
  order: number;
  pathname: string;
  search: string;
}

interface A11yViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

interface A11yRun {
  label: string;
  selector: string;
  violations: A11yViolation[];
}

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

export interface AIChangelogHarness {
  a11yRuns: A11yRun[];
  assetFailures: string[];
  expectedHttpFailures: string[];
  maximumConcurrentRequests: Record<string, number>;
  observedHttpFailures: Array<{ pathname: string; status: number }>;
  requests: AIChangelogRequestEvidence[];
  runtimeErrors: string[];
  unauthorizedAdminRequests: string[];
  unexpectedRequests: string[];
  activeRequestCount: (pathname: string) => number;
  releaseEndpoint: (pathname: string, nextMode?: EndpointMode) => void;
  setEndpointMode: (pathname: string, mode: EndpointMode) => void;
  setEndpointPayload: (pathname: string, payload: unknown) => void;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

function evidenceMode(): AIChangelogEvidenceMode {
  const mode = process.env["PW_EVIDENCE_MODE"] ?? "optimized";
  if (mode !== "source" && mode !== "optimized") {
    throw new Error(`Unsupported AI Changelog evidence mode: ${mode}`);
  }
  return mode;
}

const EVIDENCE_MODE = evidenceMode();
const EVIDENCE_ROOT = fileURLToPath(
  new URL(
    "../../../../.audit-screenshots/ai-changelog-evidence/",
    import.meta.url,
  ),
);
const EVIDENCE_DIR = join(EVIDENCE_ROOT, EVIDENCE_MODE);
const DECLARED_PLAYWRIGHT_TEST_COUNT = 10;

export const AI_CHANGELOG_FIXED_TIME = "2026-08-09T09:00:00.000Z";
export const AI_CHANGELOG_TENANT_ID = "ac000000-0000-4000-8000-000000000001";
export const AI_CHANGELOG_SECRET_CANARY =
  "ai-regression-internal-provider-secret-must-not-render";
export const AI_CHANGELOG_FIXTURE_IDS = {
  runPending: "11000000-0000-4000-8000-000000000001",
  runRunning: "11000000-0000-4000-8000-000000000002",
  runStale: "11000000-0000-4000-8000-000000000003",
  runRetry: "11000000-0000-4000-8000-000000000004",
  runFailed: "11000000-0000-4000-8000-000000000005",
  runCompletedPass: "11000000-0000-4000-8000-000000000006",
  runCompletedMixed: "11000000-0000-4000-8000-000000000007",
  runCompletedAdvisory: "11000000-0000-4000-8000-000000000008",
  runCompletedConcern: "11000000-0000-4000-8000-000000000009",
  runIncomplete: "11000000-0000-4000-8000-00000000000a",
  runUnscored: "11000000-0000-4000-8000-00000000000b",
  runPolling: "11000000-0000-4000-8000-00000000000c",
  runRequested: "11000000-0000-4000-8000-00000000000d",
  resultPassCampaign: "12000000-0000-4000-8000-000000000001",
  resultPassSubject: "12000000-0000-4000-8000-000000000002",
  resultErrorSequence: "12000000-0000-4000-8000-000000000003",
  goldenCampaign: "13000000-0000-4000-8000-000000000001",
  goldenSubject: "13000000-0000-4000-8000-000000000002",
  goldenSequence: "13000000-0000-4000-8000-000000000003",
  goldenSettingsCampaign: "13000000-0000-4000-8000-000000000004",
  goldenSettingsSubject: "13000000-0000-4000-8000-000000000005",
  goldenManual: "13000000-0000-4000-8000-000000000006",
  approvalCampaign: "14000000-0000-4000-8000-000000000001",
  approvalSubject: "14000000-0000-4000-8000-000000000002",
  approvalSequence: "14000000-0000-4000-8000-000000000003",
  approvalSettingsCampaign: "14000000-0000-4000-8000-000000000004",
  approvalSettingsSubject: "14000000-0000-4000-8000-000000000005",
  agentCampaign: "15000000-0000-4000-8000-000000000001",
  agentSubject: "15000000-0000-4000-8000-000000000002",
  agentSettingsCampaign: "15000000-0000-4000-8000-000000000003",
  routine: "16000000-0000-4000-8000-000000000001",
  routineRun: "16000000-0000-4000-8000-000000000002",
} as const;
export const APPROVED_LONG_EVIDENCE =
  "APPROVED · Launch café ☕ — नमस्ते — こんにちは — مرحبًا\n\n" +
  '<strong data-proof="approved-literal">Keep this markup literal</strong>\n' +
  "<script>window.__aiRegressionMarkupExecuted = true</script>\n\n" +
  "Use exact evidence, name uncertainty, and leave the final release decision with the accountable operator. ".repeat(
    8,
  );
export const REPLAYED_LONG_EVIDENCE =
  "REPLAYED · Launch café ☕ — नमस्ते — こんにちは — مرحبًا\n\n" +
  '<em data-proof="replayed-literal">This is generated text, not HTML</em>\n\n' +
  "Show the recorded score, preserve the approved reference, and make every difference inspectable before anyone acts. ".repeat(
    8,
  );

const BREAKDOWN_KEYS = [
  "combined",
  "embedding_similarity",
  "structural_match",
  "stylistic_distance",
  "vocabulary_overlap",
] as const;

function deferredGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function surfaceReceipt(
  score: number | null,
  options: {
    errors?: number;
    gate?: "pass" | "fail" | "advisory";
    passed?: number;
    scored?: number;
    total?: number;
  } = {},
): SurfaceReceiptFixture {
  const total = options.total ?? 1;
  const scored = options.scored ?? (score === null ? 0 : 1);
  return {
    total,
    scored,
    errors: options.errors ?? total - scored,
    passed: options.passed ?? (score !== null && score >= 60 ? 1 : 0),
    mean_score: score,
    gate_result: options.gate ?? "advisory",
  };
}

function run(
  id: string,
  modelTag: string,
  overrides: Partial<RegressionRunFixture>,
): RegressionRunFixture {
  return {
    id,
    runtime_provider: "google",
    model_id: "gemini-3-flash-preview",
    model_version_tag: modelTag,
    prompt_version_tag: "voice-regression-replay-v2",
    status: "pending",
    total_examples: 3,
    passed_examples: 0,
    scored_examples: 0,
    error_examples: 0,
    warn_threshold: 60,
    hard_gate_enabled: true,
    hard_gate_threshold: 55,
    min_examples_for_gate: 2,
    max_attempts: 3,
    created_at: "2026-08-09T08:50:00.000Z",
    snapshot_frozen_at: "2026-08-09T08:50:00.020Z",
    attempt_count: 0,
    updated_at: "2026-08-09T08:50:00.000Z",
    ...overrides,
  };
}

export const COMPLETED_PASS_RUN = run(
  AI_CHANGELOG_FIXTURE_IDS.runCompletedPass,
  "candidate-pass@2026-08-09",
  {
    status: "completed",
    total_examples: 2,
    passed_examples: 2,
    scored_examples: 2,
    error_examples: 0,
    fidelity_score_mean: 87.5,
    fidelity_score_p25: 83,
    gate_result: "pass",
    attempt_count: 1,
    started_at: "2026-08-09T08:47:00.000Z",
    completed_at: "2026-08-09T08:48:00.000Z",
    heartbeat_at: "2026-08-09T08:47:45.000Z",
    created_at: "2026-08-09T08:46:00.000Z",
    updated_at: "2026-08-09T08:48:00.000Z",
    by_surface: {
      campaign_draft: surfaceReceipt(92, { gate: "advisory" }),
      subject_line: surfaceReceipt(83, { gate: "advisory" }),
    },
  },
);

const RESULT_FIXTURES: RegressionResultFixture[] = [
  {
    id: AI_CHANGELOG_FIXTURE_IDS.resultPassCampaign,
    example_id: AI_CHANGELOG_FIXTURE_IDS.goldenCampaign,
    attempt_count: 1,
    surface_kind: "campaign_draft",
    brief:
      "Prepare an inspectable launch update without inventing deployment authority.",
    approved_output: APPROVED_LONG_EVIDENCE,
    source_model_id: "approved-model-2026-07",
    voice_profile_version: "voice-profile-v17",
    approval_id: AI_CHANGELOG_FIXTURE_IDS.approvalCampaign,
    agent_run_id: AI_CHANGELOG_FIXTURE_IDS.agentCampaign,
    source_created_at: "2026-07-12T10:20:00.000Z",
    snapshotted_at: "2026-08-09T08:46:00.050Z",
    snapshot_ordinal: 1,
    replayed_output: REPLAYED_LONG_EVIDENCE,
    fidelity_score: 92,
    breakdown: {
      embedding_similarity: 0.94,
      stylistic_distance: 0.9,
      vocabulary_overlap: 0.91,
      structural_match: 0.93,
      combined: 92,
    },
    severity: "ok",
    scored_at: "2026-08-09T08:47:20.000Z",
  },
  {
    id: AI_CHANGELOG_FIXTURE_IDS.resultPassSubject,
    example_id: AI_CHANGELOG_FIXTURE_IDS.goldenSubject,
    attempt_count: 1,
    surface_kind: "subject_line",
    brief: "Write a specific subject line for the readiness review.",
    approved_output: "A calmer final review before launch",
    source_model_id: "approved-model-2026-07",
    voice_profile_version: "voice-profile-v17",
    approval_id: AI_CHANGELOG_FIXTURE_IDS.approvalSubject,
    agent_run_id: AI_CHANGELOG_FIXTURE_IDS.agentSubject,
    source_created_at: "2026-07-13T10:20:00.000Z",
    snapshotted_at: "2026-08-09T08:46:00.060Z",
    snapshot_ordinal: 2,
    replayed_output: "Three checks before your next launch",
    fidelity_score: 83,
    breakdown: {
      embedding_similarity: 0.84,
      stylistic_distance: 0.82,
      vocabulary_overlap: 0.8,
      structural_match: 0.86,
      combined: 83,
    },
    severity: "ok",
    scored_at: "2026-08-09T08:47:30.000Z",
  },
  {
    id: AI_CHANGELOG_FIXTURE_IDS.resultErrorSequence,
    example_id: AI_CHANGELOG_FIXTURE_IDS.goldenSequence,
    attempt_count: 1,
    surface_kind: "sequence_draft",
    brief: "Build a two-step lifecycle sequence from the approved reference.",
    approved_output:
      "Step one: name the outcome. Step two: offer one next step.",
    source_model_id: "approved-model-2026-07",
    voice_profile_version: "voice-profile-v17",
    approval_id: AI_CHANGELOG_FIXTURE_IDS.approvalSequence,
    source_created_at: "2026-07-14T10:20:00.000Z",
    snapshotted_at: "2026-08-09T08:46:00.070Z",
    snapshot_ordinal: 3,
    severity: "error",
    error_code: "generation_timeout",
    error_message: "The replay did not return a bounded output in time.",
    scored_at: "2026-08-09T08:47:40.000Z",
  },
];

export const COMPLETED_PASS_RESULTS = RESULT_FIXTURES.slice(0, 2);
export const MIXED_RESULTS = [RESULT_FIXTURES[0], RESULT_FIXTURES[2]];

export const MIXED_ADVISORY_RUN = run(
  AI_CHANGELOG_FIXTURE_IDS.runCompletedMixed,
  "candidate-mixed@2026-08-09",
  {
    status: "completed",
    total_examples: 2,
    passed_examples: 1,
    scored_examples: 1,
    error_examples: 1,
    fidelity_score_mean: 92,
    fidelity_score_p25: 92,
    gate_result: "advisory",
    attempt_count: 1,
    started_at: "2026-08-09T08:42:00.000Z",
    completed_at: "2026-08-09T08:44:00.000Z",
    heartbeat_at: "2026-08-09T08:43:45.000Z",
    created_at: "2026-08-09T08:41:00.000Z",
    updated_at: "2026-08-09T08:44:00.000Z",
    by_surface: {
      campaign_draft: surfaceReceipt(92, { gate: "advisory" }),
      sequence_draft: surfaceReceipt(null, {
        errors: 1,
        gate: "advisory",
        passed: 0,
        scored: 0,
      }),
    },
  },
);

export const LIFECYCLE_RUNS: RegressionRunFixture[] = [
  run(AI_CHANGELOG_FIXTURE_IDS.runPending, "candidate-pending@2026-08-09", {
    created_at: "2026-08-09T08:58:30.000Z",
    updated_at: "2026-08-09T08:58:30.000Z",
  }),
  run(AI_CHANGELOG_FIXTURE_IDS.runRunning, "candidate-running@2026-08-09", {
    status: "running",
    total_examples: 10,
    passed_examples: 4,
    scored_examples: 4,
    attempt_count: 1,
    started_at: "2026-08-09T08:56:00.000Z",
    heartbeat_at: "2026-08-09T08:59:30.000Z",
    lease_expires_at: "2026-08-09T09:04:30.000Z",
    updated_at: "2026-08-09T08:59:30.000Z",
  }),
  run(AI_CHANGELOG_FIXTURE_IDS.runStale, "candidate-stale@2026-08-09", {
    status: "running",
    attempt_count: 2,
    started_at: "2026-08-09T08:35:00.000Z",
    heartbeat_at: "2026-08-09T08:49:00.000Z",
    lease_expires_at: "2026-08-09T08:54:00.000Z",
    updated_at: "2026-08-09T08:49:00.000Z",
  }),
  run(AI_CHANGELOG_FIXTURE_IDS.runRetry, "candidate-retry@2026-08-09", {
    attempt_count: 2,
    retry_not_before: "2026-08-09T09:05:00.000Z",
    stale_at: "2026-08-09T08:57:00.000Z",
    updated_at: "2026-08-09T08:57:00.000Z",
  }),
  run(AI_CHANGELOG_FIXTURE_IDS.runFailed, "candidate-failed@2026-08-09", {
    status: "failed",
    total_examples: 3,
    scored_examples: 1,
    error_examples: 2,
    passed_examples: 1,
    attempt_count: 3,
    started_at: "2026-08-09T08:20:00.000Z",
    completed_at: "2026-08-09T08:25:00.000Z",
    error_code: "provider_unavailable",
    error_message:
      "Replay stopped after the configured attempts; retry after provider recovery.",
    updated_at: "2026-08-09T08:25:00.000Z",
  }),
  COMPLETED_PASS_RUN,
  MIXED_ADVISORY_RUN,
  run(
    AI_CHANGELOG_FIXTURE_IDS.runCompletedAdvisory,
    "candidate-advisory@2026-08-09",
    {
      status: "completed",
      total_examples: 2,
      scored_examples: 2,
      passed_examples: 1,
      fidelity_score_mean: 56,
      fidelity_score_p25: 52,
      gate_result: "advisory",
      hard_gate_enabled: false,
      hard_gate_threshold: 55,
      attempt_count: 1,
      started_at: "2026-08-09T08:10:00.000Z",
      completed_at: "2026-08-09T08:12:00.000Z",
      updated_at: "2026-08-09T08:12:00.000Z",
      by_surface: {
        campaign_summary: surfaceReceipt(56, {
          gate: "advisory",
          passed: 1,
          scored: 2,
          total: 2,
        }),
      },
    },
  ),
  run(
    AI_CHANGELOG_FIXTURE_IDS.runCompletedConcern,
    "candidate-concern@2026-08-09",
    {
      status: "completed",
      total_examples: 2,
      scored_examples: 2,
      passed_examples: 0,
      fidelity_score_mean: 37,
      fidelity_score_p25: 34,
      gate_result: "fail",
      attempt_count: 1,
      started_at: "2026-08-09T08:00:00.000Z",
      completed_at: "2026-08-09T08:02:00.000Z",
      updated_at: "2026-08-09T08:02:00.000Z",
      by_surface: {
        reply_intent: surfaceReceipt(37, {
          gate: "fail",
          passed: 0,
          scored: 2,
          total: 2,
        }),
      },
    },
  ),
  run(
    AI_CHANGELOG_FIXTURE_IDS.runIncomplete,
    "candidate-incomplete@2026-08-09",
    {
      status: "completed",
      total_examples: 3,
      scored_examples: 2,
      error_examples: 0,
      passed_examples: 2,
      fidelity_score_mean: 88,
      fidelity_score_p25: 86,
      gate_result: "advisory",
      attempt_count: 1,
      completed_at: "2026-08-09T07:50:00.000Z",
      updated_at: "2026-08-09T07:50:00.000Z",
    },
  ),
  run(AI_CHANGELOG_FIXTURE_IDS.runUnscored, "candidate-unscored@2026-08-09", {
    status: "completed",
    total_examples: 2,
    scored_examples: 0,
    error_examples: 2,
    passed_examples: 0,
    gate_result: "advisory",
    attempt_count: 1,
    completed_at: "2026-08-09T07:40:00.000Z",
    updated_at: "2026-08-09T07:40:00.000Z",
    by_surface: {
      sequence_draft: surfaceReceipt(null, {
        errors: 2,
        gate: "advisory",
        passed: 0,
        scored: 0,
        total: 2,
      }),
    },
  }),
];

export const GOLDEN_EXAMPLES = [
  {
    id: AI_CHANGELOG_FIXTURE_IDS.goldenSettingsCampaign,
    surface_kind: "campaign_draft",
    brief:
      "Explain the final launch review with evidence, uncertainty, and one clear next step.",
    model_id: "approved-model-2026-07",
    approval_id: AI_CHANGELOG_FIXTURE_IDS.approvalSettingsCampaign,
    agent_run_id: AI_CHANGELOG_FIXTURE_IDS.agentSettingsCampaign,
    created_at: "2026-07-20T12:00:00.000Z",
  },
  {
    id: AI_CHANGELOG_FIXTURE_IDS.goldenSettingsSubject,
    surface_kind: "subject_line",
    brief: "Write a specific subject line without urgency theater.",
    model_id: "approved-model-2026-07",
    approval_id: AI_CHANGELOG_FIXTURE_IDS.approvalSettingsSubject,
    created_at: "2026-07-21T12:00:00.000Z",
  },
] as const;

const AGENT_TRUST_ROUTINE = {
  id: AI_CHANGELOG_FIXTURE_IDS.routine,
  name: "Weekly evidence-led re-engagement",
  prompt: "Draft a calm re-engagement campaign for lapsed readers.",
  kind: "draft_campaign",
  schedule: "weekly",
  require_approval: true,
  enabled: true,
  has_active_run: false,
  last_run_at: "2026-08-09T08:52:00.000Z",
  created_at: "2026-07-09T08:00:00.000Z",
  updated_at: "2026-08-09T08:52:00.000Z",
} as const;

const AGENT_TRUST_RUN = {
  id: AI_CHANGELOG_FIXTURE_IDS.routineRun,
  routine_id: AI_CHANGELOG_FIXTURE_IDS.routine,
  status: "succeeded",
  output_kind: "campaign",
  output_ref: "17000000-0000-4000-8000-000000000001",
  prompt_used: "Draft a calm re-engagement campaign for lapsed readers.",
  context_used: "Audience: readers inactive for 90 days.",
  reasoning:
    "A low-pressure, evidence-led reminder preserves trust while giving the reader one clear next step.",
  draft_preview: {
    kind: "campaign",
    name: "A useful update when you are ready",
    subject: "Three thoughtful reads you may have missed",
    preview_text: "A calm recap, with no manufactured urgency.",
    body: "Here are three recent pieces selected for their practical value.",
  },
  started_at: "2026-08-09T08:51:00.000Z",
  finished_at: "2026-08-09T08:52:00.000Z",
} as const;

const DEFAULT_PAYLOADS: Readonly<Record<string, unknown>> = {
  "/api/v1/ai-regression/runs": { items: LIFECYCLE_RUNS },
  [`/api/v1/ai-regression/runs/${AI_CHANGELOG_FIXTURE_IDS.runCompletedPass}/results`]:
    {
      items: COMPLETED_PASS_RESULTS,
    },
  [`/api/v1/ai-regression/runs/${AI_CHANGELOG_FIXTURE_IDS.runCompletedMixed}/results`]:
    {
      items: MIXED_RESULTS,
    },
  "/api/v1/ai-regression/settings": {
    warn_threshold: 60,
    hard_gate_enabled: true,
    hard_gate_threshold: 55,
    min_examples_for_gate: 2,
  },
  "/api/v1/ai-regression/golden-examples": { items: GOLDEN_EXAMPLES },
};

function validateClosedBreakdowns(results: RegressionResultFixture[]): void {
  for (const result of results) {
    if (!result.breakdown) continue;
    const keys = Object.keys(result.breakdown).sort();
    if (JSON.stringify(keys) !== JSON.stringify(BREAKDOWN_KEYS)) {
      throw new Error(
        `Result ${result.id} has an open or incomplete breakdown.`,
      );
    }
    const values = Object.entries(result.breakdown);
    for (const [key, value] of values) {
      const upper = key === "combined" ? 100 : 1;
      if (!Number.isFinite(value) || value < 0 || value > upper) {
        throw new Error(`Result ${result.id} has invalid ${key}.`);
      }
    }
    if (
      Math.abs(result.breakdown.combined - (result.fidelity_score ?? -1)) >
      0.001
    ) {
      throw new Error(`Result ${result.id} combined score is not canonical.`);
    }
  }
}

function validateWireFixtures(): void {
  const runs = JSON.parse(JSON.stringify(LIFECYCLE_RUNS)) as Array<
    Record<string, unknown>
  >;
  for (const runFixture of runs) {
    if (Object.values(runFixture).includes(null)) {
      throw new Error(
        `Run ${String(runFixture["id"])} emitted null for an omitempty field.`,
      );
    }
    const total = runFixture["total_examples"];
    const scored = runFixture["scored_examples"];
    const errors = runFixture["error_examples"];
    if (
      typeof total !== "number" ||
      typeof scored !== "number" ||
      typeof errors !== "number" ||
      scored + errors > total
    ) {
      throw new Error(`Run ${String(runFixture["id"])} has invalid counts.`);
    }
    const surfaces = runFixture["by_surface"] as
      | Record<string, SurfaceReceiptFixture>
      | undefined;
    for (const [surfaceKind, surface] of Object.entries(surfaces ?? {})) {
      const processed = surface.scored + surface.errors;
      if (
        processed > surface.total ||
        surface.passed > surface.scored ||
        (surface.scored === 0
          ? surface.mean_score !== null
          : typeof surface.mean_score !== "number")
      ) {
        throw new Error(
          `Run ${String(runFixture["id"])} has invalid ${surfaceKind} receipt.`,
        );
      }
    }
  }

  const results = JSON.parse(JSON.stringify(RESULT_FIXTURES)) as Array<
    Record<string, unknown>
  >;
  for (const result of results) {
    const errorReceipt = result["severity"] === "error";
    const hasScore = typeof result["fidelity_score"] === "number";
    const hasBreakdown = typeof result["breakdown"] === "object";
    if (errorReceipt === (hasScore || hasBreakdown)) {
      throw new Error(
        `Result ${String(result["id"])} violates scored/error wire nullability.`,
      );
    }
    for (const required of [
      "example_id",
      "brief",
      "approved_output",
      "source_model_id",
      "snapshotted_at",
      "snapshot_ordinal",
    ]) {
      if (!(required in result)) {
        throw new Error(
          `Result ${String(result["id"])} omitted frozen ${required}.`,
        );
      }
    }
  }
}

validateClosedBreakdowns(RESULT_FIXTURES);
validateWireFixtures();

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function authPayload(role: AIChangelogRole): Record<string, unknown> {
  return {
    user_id: `ai-changelog-${role}`,
    tenant_id: AI_CHANGELOG_TENANT_ID,
    email: `${role}@ai-changelog.example.invalid`,
    role,
    effective_role: role,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "AI Changelog Evidence",
    workspace_slug: "ai-changelog-evidence",
  };
}

function requestEvidence(
  request: Request,
  order: number,
): AIChangelogRequestEvidence {
  const url = new URL(request.url());
  return {
    body: request.postData() ?? null,
    method: request.method(),
    order,
    pathname: url.pathname,
    search: url.search,
  };
}

function allowedMethod(pathname: string, method: string): boolean {
  if (pathname === "/api/v1/ai-regression/runs") {
    return method === "GET" || method === "POST";
  }
  if (pathname === "/api/v1/ai-regression/settings") {
    return method === "GET" || method === "PUT";
  }
  if (pathname === "/api/v1/ai-regression/golden-examples") {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/v1\/ai-regression\/golden-examples\/[^/]+$/u.test(pathname)) {
    return method === "DELETE";
  }
  return (
    /^\/api\/v1\/ai-regression\/runs\/[^/]+(?:\/results)?$/u.test(pathname) &&
    method === "GET"
  );
}

function requiresAdmin(pathname: string, method: string): boolean {
  return method !== "GET" || pathname === "/api/v1/ai-regression/settings";
}

function errorBody(): Record<string, unknown> {
  return {
    error: {
      code: "regression_evidence_unavailable",
      message:
        "Regression evidence is temporarily unavailable. Retry after the service recovers.",
      details: { diagnostic: AI_CHANGELOG_SECRET_CANARY },
    },
  };
}

function successStatus(pathname: string, method: string): number {
  if (method === "DELETE") return 204;
  if (method === "POST" && pathname.endsWith("/runs")) return 202;
  if (method === "POST" && pathname.endsWith("/golden-examples")) return 201;
  return 200;
}

function mutationPayload(request: Request): unknown {
  const pathname = new URL(request.url()).pathname;
  const raw = request.postData() ?? "{}";
  const body = JSON.parse(raw) as Record<string, unknown>;
  if (request.method() === "POST" && pathname.endsWith("/runs")) {
    return {
      run_id: AI_CHANGELOG_FIXTURE_IDS.runRequested,
      status: "pending",
      runtime: {
        provider: "google",
        model_id: "gemini-3-flash-preview",
        prompt_policy_version: "voice-regression-replay-v2",
      },
    };
  }
  if (request.method() === "POST" && pathname.endsWith("/golden-examples")) {
    return {
      id: AI_CHANGELOG_FIXTURE_IDS.goldenManual,
      request_id: body["request_id"],
      surface_kind: body["surface_kind"],
      brief: body["brief"],
      model_id: "manual_reference",
      created_at: AI_CHANGELOG_FIXED_TIME,
    };
  }
  if (request.method() === "PUT" && pathname.endsWith("/settings")) {
    return body;
  }
  return undefined;
}

function payloadFor(
  pathname: string,
  request: Request,
  payloads: Map<string, unknown>,
): unknown {
  const mutation = mutationPayload(request);
  if (mutation !== undefined) return mutation;
  if (payloads.has(pathname)) return payloads.get(pathname);
  const defaultPayload = DEFAULT_PAYLOADS[pathname];
  if (defaultPayload !== undefined) return defaultPayload;
  if (/^\/api\/v1\/ai-regression\/runs\/[^/]+\/results$/u.test(pathname)) {
    return { items: [] };
  }
  const directRun = pathname.match(
    /^\/api\/v1\/ai-regression\/runs\/([^/]+)$/u,
  );
  if (directRun) {
    return LIFECYCLE_RUNS.find((candidate) => candidate.id === directRun[1]);
  }
  return undefined;
}

export async function installAIChangelogHarness(
  page: Page,
  role: AIChangelogRole,
  initialModes: Partial<Record<string, EndpointMode>> = {},
): Promise<AIChangelogHarness> {
  const endpointModes = new Map<string, EndpointMode>();
  for (const [pathname, mode] of Object.entries(initialModes)) {
    if (mode) endpointModes.set(pathname, mode);
  }
  const payloads = new Map<string, unknown>();
  const gates = new Map<string, DeferredGate[]>();
  const active = new Map<string, number>();
  const harness: AIChangelogHarness = {
    a11yRuns: [],
    assetFailures: [],
    expectedHttpFailures: [],
    maximumConcurrentRequests: {},
    observedHttpFailures: [],
    requests: [],
    runtimeErrors: [],
    unauthorizedAdminRequests: [],
    unexpectedRequests: [],
    activeRequestCount(pathname) {
      return active.get(pathname) ?? 0;
    },
    releaseEndpoint(pathname, nextMode = "success") {
      endpointModes.set(pathname, nextMode);
      if (nextMode === "error") harness.expectedHttpFailures.push(pathname);
      for (const gate of gates.get(pathname) ?? []) gate.release();
      gates.delete(pathname);
    },
    setEndpointMode(pathname, mode) {
      endpointModes.set(pathname, mode);
      if (mode === "error") harness.expectedHttpFailures.push(pathname);
    },
    setEndpointPayload(pathname, payload) {
      payloads.set(pathname, payload);
    },
  };

  for (const [pathname, mode] of endpointModes) {
    if (mode === "error") harness.expectedHttpFailures.push(pathname);
  }

  page.on("pageerror", (error) => harness.runtimeErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const locationUrl = message.location().url;
    if (
      message.text().startsWith("Failed to load resource:") &&
      locationUrl &&
      harness.expectedHttpFailures.includes(new URL(locationUrl).pathname)
    ) {
      return;
    }
    harness.runtimeErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith("/api/v1/ai-regression/")) return;
    harness.observedHttpFailures.push({ pathname, status: response.status() });
  });
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/assets/")) {
      harness.assetFailures.push(
        `${pathname}: ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });

  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === "/api/v1/auth/me") {
      await json(route, authPayload(role));
      return;
    }
    if (pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@ai-changelog.example.invalid`,
        tenant: "AI Changelog Evidence",
        role,
      });
      return;
    }
    if (pathname === "/api/v1/api-keys/me") {
      await json(route, {
        tenant_id: AI_CHANGELOG_TENANT_ID,
        tenant_slug: "ai-changelog-evidence",
        scopes: role === "admin" ? ["admin"] : ["read:reports"],
        actor: `${role}@ai-changelog.example.invalid`,
      });
      return;
    }
    const auxiliaryAgentRunsPath = `/api/v1/agent-routines/${AI_CHANGELOG_FIXTURE_IDS.routine}/runs`;
    const ownedAuxiliaryRequest =
      pathname === "/api/v1/agent-routines" ||
      pathname === auxiliaryAgentRunsPath ||
      pathname === "/api/v1/mcp/executions";
    if (ownedAuxiliaryRequest) {
      const evidence = requestEvidence(request, harness.requests.length + 1);
      harness.requests.push(evidence);
      const exactQuery =
        pathname === "/api/v1/mcp/executions"
          ? url.search === "?limit=8"
          : url.search === "";
      const payload = payloads.get(pathname);
      if (request.method() !== "GET" || !exactQuery || payload === undefined) {
        harness.unexpectedRequests.push(
          `${request.method()} ${pathname}${url.search} (unmocked Agent Trust request)`,
        );
        await json(route, errorBody(), 501);
        return;
      }
      await json(route, payload);
      return;
    }

    if (!pathname.startsWith("/api/v1/ai-regression/")) {
      await route.fallback();
      return;
    }

    const evidence = requestEvidence(request, harness.requests.length + 1);
    harness.requests.push(evidence);
    if (!allowedMethod(pathname, request.method())) {
      harness.unexpectedRequests.push(
        `${request.method()} ${pathname}${url.search} (method or route mismatch)`,
      );
      await json(route, errorBody(), 405);
      return;
    }
    if (role === "viewer" && requiresAdmin(pathname, request.method())) {
      harness.unauthorizedAdminRequests.push(`${request.method()} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "forbidden",
            message: "Administrator access required.",
          },
        },
        403,
      );
      return;
    }

    const count = (active.get(pathname) ?? 0) + 1;
    active.set(pathname, count);
    harness.maximumConcurrentRequests[pathname] = Math.max(
      harness.maximumConcurrentRequests[pathname] ?? 0,
      count,
    );
    try {
      const initialMode = endpointModes.get(pathname) ?? "success";
      if (initialMode === "deferred") {
        const gate = deferredGate();
        gates.set(pathname, [...(gates.get(pathname) ?? []), gate]);
        await gate.promise;
      }
      const mode = endpointModes.get(pathname) ?? "success";
      if (mode === "error") {
        await json(route, errorBody(), 503);
        return;
      }
      const payload = payloadFor(pathname, request, payloads);
      if (payload === undefined && request.method() !== "DELETE") {
        harness.unexpectedRequests.push(
          `${request.method()} ${pathname}${url.search} (unmocked AI request)`,
        );
        await json(route, errorBody(), 501);
        return;
      }
      const status = successStatus(pathname, request.method());
      if (status === 204) {
        await route.fulfill({ status });
      } else {
        await json(route, payload, status);
      }
    } finally {
      active.set(pathname, Math.max(0, (active.get(pathname) ?? 1) - 1));
    }
  });

  return harness;
}

export async function openAIChangelog(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    initialModes?: Partial<Record<string, EndpointMode>>;
    role?: AIChangelogRole;
    runs?: RegressionRunFixture[];
    theme?: "system" | "dark" | "light";
    width?: number;
    height?: number;
  } = {},
): Promise<AIChangelogHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  await page.addInitScript(
    ({
      identityRole,
      tenantId,
    }: {
      identityRole: AIChangelogRole;
      tenantId: string;
    }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: `ai-changelog-${identityRole}`,
          tenant_id: tenantId,
          role: identityRole,
          effective_role: identityRole,
          auth_provider: "password",
        }),
      );
      window.localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date().toISOString(),
      );
    },
    { identityRole: role, tenantId: AI_CHANGELOG_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(AI_CHANGELOG_FIXED_TIME));
  const harness = await installAIChangelogHarness(
    page,
    role,
    options.initialModes,
  );
  if (options.runs) {
    harness.setEndpointPayload("/api/v1/ai-regression/runs", {
      items: options.runs,
    });
  }
  await page.goto("/app/ai-changelog");
  await waitForPrimaryNavigation(page, 30_000);
  await expect(
    page.getByRole("heading", { name: "AI Changelog", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("model-changelog-panel")).toBeVisible();
  return harness;
}

export async function openAIRegressionSettings(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    role?: AIChangelogRole;
    theme?: "system" | "dark" | "light";
    width?: number;
    height?: number;
  } = {},
): Promise<AIChangelogHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  await page.addInitScript(
    ({
      identityRole,
      tenantId,
    }: {
      identityRole: AIChangelogRole;
      tenantId: string;
    }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: `ai-changelog-${identityRole}`,
          tenant_id: tenantId,
          role: identityRole,
          effective_role: identityRole,
          auth_provider: "password",
        }),
      );
      window.localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date().toISOString(),
      );
    },
    { identityRole: role, tenantId: AI_CHANGELOG_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(AI_CHANGELOG_FIXED_TIME));
  const harness = await installAIChangelogHarness(page, role);
  await page.goto("/app/settings");
  await waitForPrimaryNavigation(page, 30_000);
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  const section = aiRegressionSettingsSection(page);
  await expect(section).toBeVisible();
  await expect(section.getByTestId("ai-regression-settings")).toBeVisible();
  await scrollTargetIntoFrame(page, section);
  return harness;
}

export async function openAgentTrustVoiceEvidence(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
): Promise<AIChangelogHarness> {
  await setTheme(page, "dark");
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await bootApp(page);
  await page.addInitScript(
    ({ tenantId }: { tenantId: string }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: "ai-changelog-admin",
          tenant_id: tenantId,
          role: "admin",
          effective_role: "admin",
          auth_provider: "password",
        }),
      );
      window.localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date().toISOString(),
      );
    },
    { tenantId: AI_CHANGELOG_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(AI_CHANGELOG_FIXED_TIME));
  const harness = await installAIChangelogHarness(page, "admin");
  harness.setEndpointPayload("/api/v1/ai-regression/runs/latest", {
    run: LIFECYCLE_RUNS[0],
  });
  harness.setEndpointPayload("/api/v1/agent-routines", {
    items: [AGENT_TRUST_ROUTINE],
  });
  harness.setEndpointPayload(
    `/api/v1/agent-routines/${AI_CHANGELOG_FIXTURE_IDS.routine}/runs`,
    { items: [AGENT_TRUST_RUN] },
  );
  harness.setEndpointPayload("/api/v1/mcp/executions", { rows: [] });

  await page.goto("/app/ai?tab=routines");
  await waitForPrimaryNavigation(page, 30_000);
  await expect(
    page.getByRole("heading", { name: "Moosewave AI", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Routines", level: 3 }),
  ).toBeVisible();
  return harness;
}

export function aiRegressionSettingsSection(page: Page): Locator {
  return page.locator(".settings-section").filter({
    has: page.getByRole("heading", {
      name: "AI regression evidence",
      level: 2,
    }),
  });
}

export async function scrollTargetIntoFrame(
  page: Page,
  target: Locator,
  viewportTop = 84,
): Promise<void> {
  await expect(page.locator(".content")).toBeVisible();
  await expect(target).toBeVisible();
  await target.evaluate(async (element, top) => {
    const owner = document.querySelector<HTMLElement>(".content");
    if (!owner) throw new Error("Missing shell content scroll owner.");
    const requested = Math.max(
      0,
      element.getBoundingClientRect().top + owner.scrollTop - top,
    );
    owner.scrollTo({ top: requested, behavior: "instant" });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, viewportTop);
}

export async function expectNoAIChangelogOverflow(
  page: Page,
  selector = ".ai-evidence-workspace",
  options: { includeShell?: boolean } = {},
): Promise<void> {
  const overflow = await page.evaluate((rootSelector) => {
    const content = document.querySelector<HTMLElement>(".content");
    const root = document.querySelector<HTMLElement>(rootSelector);
    const contentRight = content?.getBoundingClientRect().right ?? 0;
    const offenders = content
      ? [...content.querySelectorAll<HTMLElement>("*")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              className: element.className,
              right: Math.round(rect.right),
              selector:
                element.dataset.testid ??
                element.getAttribute("aria-label") ??
                element.tagName.toLowerCase(),
              width: Math.round(rect.width),
            };
          })
          .filter((candidate) => candidate.right > contentRight + 1)
          .sort((left, right) => right.right - left.right)
          .slice(0, 8)
      : [];
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      contentClientWidth: content?.clientWidth ?? null,
      contentScrollWidth: content?.scrollWidth ?? null,
      document: document.documentElement.scrollWidth - window.innerWidth,
      offenders,
      root: root
        ? root.scrollWidth - root.clientWidth
        : Number.POSITIVE_INFINITY,
      windowScroll: window.scrollX,
    };
  }, selector);
  if (options.includeShell ?? true) {
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(
      overflow.content,
      JSON.stringify(overflow, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(overflow.document).toBeLessThanOrEqual(1);
  }
  expect(overflow.root).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function auditAIChangelogA11y(
  page: Page,
  harness: AIChangelogHarness,
  label: string,
  selector = ".ai-evidence-workspace",
  options: { includeColorContrast?: boolean } = {},
): Promise<A11yViolation[]> {
  await expect(page.locator(selector)).toBeVisible();
  if (!(await page.evaluate(() => "axe" in window))) {
    await page.addScriptTag({ content: AXE_SOURCE });
  }
  const violations = await page.evaluate(
    async ({ includeColorContrast, rootSelector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: string,
              options: unknown,
            ) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{
                  target: string[];
                  failureSummary?: string;
                }>;
              }>;
            }>;
          };
        }
      ).axe;
      const result = await axe.run(rootSelector, {
        resultTypes: ["violations"],
        rules: includeColorContrast
          ? undefined
          : { "color-contrast": { enabled: false } },
        runOnly: {
          type: "tag",
          values: [
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "wcag22a",
            "wcag22aa",
          ],
        },
      });
      return result.violations
        .filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        )
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failureSummary: node.failureSummary,
          })),
        }));
    },
    {
      includeColorContrast: options.includeColorContrast ?? true,
      rootSelector: selector,
    },
  );
  harness.a11yRuns.push({ label, selector, violations });
  return violations;
}

export async function expectAIChangelogReducedMotion(
  page: Page,
  selector = ".ai-evidence-workspace",
): Promise<void> {
  const running = await page.locator(selector).evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running")
      .map((animation) => animation.effect?.getComputedTiming().duration ?? 0),
  );
  expect(running).toEqual([]);
}

export async function expectAIChangelogSafety(
  page: Page,
  harness: AIChangelogHarness,
): Promise<void> {
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.unauthorizedAdminRequests).toEqual([]);
  expect(harness.assetFailures).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  expect(
    harness.observedHttpFailures.filter(
      ({ pathname }) => !harness.expectedHttpFailures.includes(pathname),
    ),
  ).toEqual([]);
  for (const pathname of new Set(harness.expectedHttpFailures)) {
    expect(
      harness.observedHttpFailures.some(
        (failure) => failure.pathname === pathname,
      ),
    ).toBe(true);
  }
  expect(harness.requests.map(({ order }) => order)).toEqual(
    harness.requests.map((_, index) => index + 1),
  );
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain(AI_CHANGELOG_SECRET_CANARY);
  expect(rendered).not.toContain("Safe to deploy");
  expect(rendered).not.toContain("Deployment blocked");
  expect(JSON.stringify(harness.requests)).not.toContain("test-key");
}

export async function captureAIChangelogEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness: AIChangelogHarness,
): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  const screenshotPath = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({
    path: screenshotPath,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });

  const metadata = testInfo.config.metadata as Record<string, unknown>;
  const baseCommitSha =
    typeof metadata["aiChangelogBaseCommitSha"] === "string"
      ? metadata["aiChangelogBaseCommitSha"]
      : "unavailable";
  const media = await page.evaluate(() => ({
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    viewport: { width: innerWidth, height: innerHeight },
  }));
  const layout = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const aiWorkspace = document.querySelector<HTMLElement>(
      ".ai-evidence-workspace",
    );
    const settings = document.querySelector<HTMLElement>(
      '[data-testid="ai-regression-settings"]',
    );
    const target = aiWorkspace ?? settings;
    return {
      bodyOverflow: document.body.scrollWidth - innerWidth,
      contentOverflow: content
        ? content.scrollWidth - content.clientWidth
        : null,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      targetOverflow: target ? target.scrollWidth - target.clientWidth : null,
    };
  });
  const receipt = {
    schemaVersion: 1,
    evidenceMode: EVIDENCE_MODE,
    baseCommitSha,
    command:
      `PW_EVIDENCE_MODE=${EVIDENCE_MODE} pnpm exec playwright test ` +
      "--config tests/e2e/ai-changelog.playwright.config.ts",
    declaredPlaywrightTestCount: DECLARED_PLAYWRIGHT_TEST_COUNT,
    fixedTimeUtc: AI_CHANGELOG_FIXED_TIME,
    timezoneId: "UTC",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    project: testInfo.project.name,
    report: `../reports/${EVIDENCE_MODE}.json`,
  };
  await writeFile(
    join(EVIDENCE_DIR, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, "command-receipt.json"),
    `${JSON.stringify(
      {
        ...receipt,
        webServerCommand:
          EVIDENCE_MODE === "source"
            ? "pnpm exec vite --port 1461 --strictPort"
            : "pnpm exec vite build && pnpm exec vite preview --port 1462 --strictPort",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, `${name}.requests.json`),
    `${JSON.stringify(harness.requests, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, `${name}.quality.json`),
    `${JSON.stringify(
      {
        name,
        media,
        layout,
        requestCount: harness.requests.length,
        maximumConcurrentRequests: harness.maximumConcurrentRequests,
        a11yRuns: harness.a11yRuns,
        runtimeErrors: harness.runtimeErrors,
        assetFailures: harness.assetFailures,
        unexpectedRequests: harness.unexpectedRequests,
        unauthorizedAdminRequests: harness.unauthorizedAdminRequests,
        observedHttpFailures: harness.observedHttpFailures,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
