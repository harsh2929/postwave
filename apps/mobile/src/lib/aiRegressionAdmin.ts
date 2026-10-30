/**
 * lib/aiRegressionAdmin.ts — the three admin verbs on the regression harness.
 *
 *   PUT  /api/v1/ai-regression/settings         admin — warn threshold +
 *        the RECORDING POLICY (whether the hard gate is in force, at what
 *        score, and the minimum sample it needs before it may block).
 *   POST /api/v1/ai-regression/runs             admin — trigger one replay.
 *   POST /api/v1/ai-regression/golden-examples  admin — save a reference.
 *
 * WHAT "RECORDING POLICY" MEANS HERE, precisely, because the copy must not
 * overclaim: ComputeGate (types.go) treats hard_gate_enabled + a scored count
 * at or above min_examples_for_gate as the only condition under which a run
 * may return `fail`. Below that bar the outcome is `advisory` no matter how
 * bad the mean is. So turning the hard gate on does NOT block a deployment by
 * itself; it changes how an outcome is RECORDED. The sheet says that.
 *
 * THREE REFUSALS THE TRIGGER HAS, all of which are correct behaviour rather
 * than faults, and each of which the server writes a sentence for:
 *   422 no_golden_examples             — nothing to replay
 *   409 run_in_flight                  — one is already running
 *   503 regression_executor_unavailable — the executor is not configured
 * The server's sentence is rendered verbatim; only a missing one falls back.
 *
 * request_id ON A GOLDEN EXAMPLE IS MANDATORY and must be a LOWERCASE UUID
 * (handlers.go CaptureGolden → 422 invalid_golden_request_id). It is generated
 * at the transport edge, not here — this module only proves the shape, so the
 * check stays node-testable.
 *
 * No react-native / expo import: vitest runs this in node.
 */

/** ai_regression.IsValidSurfaceKind, in the order the server names them. */
export const REGRESSION_SURFACE_KINDS = [
  "campaign_draft",
  "subject_line",
  "sequence_draft",
  "campaign_summary",
  "reply_intent",
] as const;
export type RegressionSurfaceKind = (typeof REGRESSION_SURFACE_KINDS)[number];

/** ai_regression Default* constants (types.go:72-74). */
export const REGRESSION_DEFAULT_WARN_THRESHOLD = 60;
export const REGRESSION_DEFAULT_HARD_GATE_THRESHOLD = 70;
export const REGRESSION_DEFAULT_MIN_EXAMPLES = 5;
/** validateSettings' upper bound on min_examples_for_gate (math.MaxInt32). */
export const REGRESSION_MAX_MIN_EXAMPLES = 2147483647;
/** maxBriefLen / maxOutputLen (types.go:85-86). */
export const GOLDEN_BRIEF_MAX = 8000;
export const GOLDEN_OUTPUT_MAX = 32000;
/** validBoundedText's cap on model_version_tag (handlers.go TriggerRun). */
export const RUN_MODEL_TAG_MAX = 160;

export interface RegressionSettingsWire {
  warn_threshold?: number;
  hard_gate_enabled?: boolean;
  hard_gate_threshold?: number;
  min_examples_for_gate?: number;
}

export interface RegressionSettingsView {
  warnThreshold: number;
  hardGateEnabled: boolean;
  hardGateThreshold: number;
  minExamplesForGate: number;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The GET answers a full settings object (the store substitutes
 * DefaultSettings for a tenant with no row), so a missing field means a
 * malformed body, not "unset" — the documented default is the honest stand-in
 * either way.
 */
export function parseRegressionSettings(
  payload: unknown,
): RegressionSettingsView {
  const rec =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as RegressionSettingsWire)
      : {};
  return {
    warnThreshold: num(rec.warn_threshold, REGRESSION_DEFAULT_WARN_THRESHOLD),
    hardGateEnabled: rec.hard_gate_enabled === true,
    hardGateThreshold: num(
      rec.hard_gate_threshold,
      REGRESSION_DEFAULT_HARD_GATE_THRESHOLD,
    ),
    minExamplesForGate: num(
      rec.min_examples_for_gate,
      REGRESSION_DEFAULT_MIN_EXAMPLES,
    ),
  };
}

export type SettingsBuild =
  | { ok: true; body: Required<RegressionSettingsWire>; error: null }
  | { ok: false; body: null; error: string };

function parseNumberField(raw: string): number | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  // Number("") is 0 and Number(" 1 ") is 1; both would smuggle a value the
  // operator did not type. An explicit numeric shape is required.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Client mirror of validateSettings (handlers.go:360-371). The PUT replaces
 * the WHOLE settings object — there is no partial merge on the server — so
 * every field is sent, seeded from the fetched values.
 */
export function buildSettingsPut(draft: {
  warnThreshold: string;
  hardGateEnabled: boolean;
  hardGateThreshold: string;
  minExamplesForGate: string;
}): SettingsBuild {
  const warn = parseNumberField(draft.warnThreshold);
  if (warn === null || warn < 0 || warn > 100) {
    return {
      ok: false,
      body: null,
      error: "warn_threshold must be between 0 and 100",
    };
  }
  const hard = parseNumberField(draft.hardGateThreshold);
  if (hard === null || hard < 0 || hard > 100) {
    return {
      ok: false,
      body: null,
      error: "hard_gate_threshold must be between 0 and 100",
    };
  }
  const minExamples = parseNumberField(draft.minExamplesForGate);
  if (
    minExamples === null ||
    !Number.isInteger(minExamples) ||
    minExamples < 1 ||
    minExamples > REGRESSION_MAX_MIN_EXAMPLES
  ) {
    return {
      ok: false,
      body: null,
      error: `min_examples_for_gate must be between 1 and ${REGRESSION_MAX_MIN_EXAMPLES}`,
    };
  }
  return {
    ok: true,
    error: null,
    body: {
      warn_threshold: warn,
      hard_gate_enabled: draft.hardGateEnabled === true,
      hard_gate_threshold: hard,
      min_examples_for_gate: minExamples,
    },
  };
}

/** True when the draft would change nothing — a save that saves nothing is noise. */
export function settingsUnchanged(
  current: RegressionSettingsView,
  body: Required<RegressionSettingsWire>,
): boolean {
  return (
    current.warnThreshold === body.warn_threshold &&
    current.hardGateEnabled === body.hard_gate_enabled &&
    current.hardGateThreshold === body.hard_gate_threshold &&
    current.minExamplesForGate === body.min_examples_for_gate
  );
}

/**
 * One sentence saying what the policy currently DOES, so the toggle is not
 * read as "blocks releases". Mirrors ComputeGate's eligibility rule.
 */
export function recordingPolicySentence(s: RegressionSettingsView): string {
  if (!s.hardGateEnabled) {
    return `Advisory only: a run scoring under ${s.warnThreshold} is recorded as a warning, and no run can be recorded as a failure.`;
  }
  return `A run with at least ${s.minExamplesForGate} scored examples is recorded as a failure below ${s.hardGateThreshold}; anything smaller stays advisory.`;
}

export type RunTriggerBuild =
  | { ok: true; body: { model_version_tag: string }; error: null }
  | { ok: false; body: null; error: string };

/**
 * model_version_tag is the operator's correlation label. validBoundedText
 * rejects empty, over-160-rune and CONTROL-CHARACTER values, so a pasted tag
 * carrying a newline is caught here rather than as an opaque 422.
 */
export function buildTriggerRunBody(tag: string): RunTriggerBuild {
  const trimmed = typeof tag === "string" ? tag.trim() : "";
  if (!trimmed) {
    return { ok: false, body: null, error: "model_version_tag is required" };
  }
  if ([...trimmed].length > RUN_MODEL_TAG_MAX) {
    return {
      ok: false,
      body: null,
      error: `Label is too long (max ${RUN_MODEL_TAG_MAX} characters).`,
    };
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return {
      ok: false,
      body: null,
      error: "Label cannot contain line breaks or control characters.",
    };
  }
  return { ok: true, body: { model_version_tag: trimmed }, error: null };
}

export interface GoldenExampleBody {
  surface_kind: string;
  brief: string;
  approved_output: string;
  request_id: string;
}

export type GoldenBuild =
  | { ok: true; body: GoldenExampleBody; error: null }
  | { ok: false; body: null; error: string };

/** The server's own regex for request_id: a lowercase, canonical UUID. */
export const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Client mirror of validateCapture, plus the request_id shape check the
 * handler runs BEFORE it (so a bad id is caught first here too).
 *
 * The server trims the brief and normalises the output; the same trim runs
 * here so the length a person sees is the length the server measures.
 */
export function buildGoldenExampleBody(input: {
  surfaceKind: string;
  brief: string;
  approvedOutput: string;
  requestId: string;
}): GoldenBuild {
  const requestId =
    typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!LOWERCASE_UUID.test(requestId)) {
    return {
      ok: false,
      body: null,
      error:
        "A secure reference identifier is unavailable. Nothing was submitted.",
    };
  }
  const surface = typeof input.surfaceKind === "string" ? input.surfaceKind : "";
  const validSurface = REGRESSION_SURFACE_KINDS.find((k) => k === surface);
  if (!validSurface) {
    return {
      ok: false,
      body: null,
      error:
        "surface_kind must be one of campaign_draft, subject_line, sequence_draft, campaign_summary, reply_intent",
    };
  }
  const brief = (typeof input.brief === "string" ? input.brief : "").trim();
  const briefLen = [...brief].length;
  if (briefLen < 1 || briefLen > GOLDEN_BRIEF_MAX) {
    return {
      ok: false,
      body: null,
      error: `brief must be between 1 and ${GOLDEN_BRIEF_MAX} characters`,
    };
  }
  const output = (
    typeof input.approvedOutput === "string" ? input.approvedOutput : ""
  ).trim();
  const outputLen = [...output].length;
  if (outputLen < 1 || outputLen > GOLDEN_OUTPUT_MAX) {
    return {
      ok: false,
      body: null,
      error: `approved_output must be between 1 and ${GOLDEN_OUTPUT_MAX} characters`,
    };
  }
  return {
    ok: true,
    error: null,
    body: {
      surface_kind: validSurface,
      brief,
      approved_output: output,
      request_id: requestId,
    },
  };
}

/** Human label for a surface kind (shared with the evidence workspace). */
export function surfaceKindLabel(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "Unknown surface";
  const known: Record<string, string> = {
    campaign_draft: "Campaign draft",
    subject_line: "Subject line",
    sequence_draft: "Sequence draft",
    campaign_summary: "Campaign summary",
    reply_intent: "Reply intent",
  };
  const label = known[raw];
  if (label) return label;
  const words = raw.split(/[_-]+/).filter(Boolean);
  const [first, ...rest] = words;
  if (!first) return "Unknown surface";
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/**
 * The trigger's refusals. The server writes a sentence for each of them, so
 * that sentence wins; the code only decides the fallback when a body is
 * missing (a proxy, a timeout) and whether the press may be repeated.
 */
export function regressionTriggerFailure(
  status: number,
  code: string | undefined,
  message: string | undefined,
): { message: string; retryable: boolean } {
  const server = message?.trim();
  const normalized = (code ?? "").trim();
  if (status === 409 || normalized === "run_in_flight") {
    return {
      message:
        server || "a regression run is already in progress for this tenant",
      // Pressing again cannot start a second run; the answer is to wait.
      retryable: false,
    };
  }
  if (normalized === "no_golden_examples") {
    return {
      message:
        server ||
        "no golden examples captured yet — approve AI outputs to build your regression set",
      retryable: false,
    };
  }
  if (normalized === "regression_executor_unavailable" || status === 503) {
    return {
      message: server || "the regression executor is not configured",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      message: "Only an admin can trigger a regression run.",
      retryable: false,
    };
  }
  if (status === 422) {
    return { message: server || "That run was rejected.", retryable: false };
  }
  return { message: server || "Couldn't start the run.", retryable: true };
}

/** Settings / golden-example writes. Both are admin-only. */
export function regressionAdminErrorMessage(
  status: number,
  message: string | undefined,
): string {
  if (status === 403) {
    return "Regression administration is admin-only.";
  }
  if (status === 404 || status === 405 || status === 501) {
    return "This deployment doesn't run the AI regression harness.";
  }
  return message?.trim() || "That didn't go through.";
}
