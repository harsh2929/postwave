/**
 * regression-helpers — pure logic behind the AI-output regression harness
 * desktop surfaces (VoiceRegressionBadge / ModelChangelogPanel /
 * AIRegressionSettings). JSX-free so the node vitest suite can exercise the
 * severity banding, surface labels, and per-surface aggregation directly.
 *
 * Honest-UI contract: nothing here invents data. severityFromScore mirrors
 * the backend bands exactly (the frozen warning threshold is the pass/ok
 * boundary; only a non-passing score is compared with critical 40). This
 * matches the Go severityFromScore and DriftWarnThreshold. surfaceLabel falls back to a
 * humanised raw key rather than guessing a prettier name for an enum we
 * don't recognise. aggregateBySurface only ever rolls up the rows it was
 * given — never extrapolates.
 */

/** A regression result row, mirroring the api-client RegressionResult. */
export interface RegressionResultLike {
  surface_kind: string;
  fidelity_score?: number | null;
  severity?: string | null;
}

/** Per-surface roll-up shape. */
export interface SurfaceAggregate {
  surface: string;
  total: number;
  scored: number;
  errored: number;
  meanScore: number | null;
}

export interface SurfaceReceiptLike {
  total?: number | null;
  scored?: number | null;
  errors?: number | null;
  passed?: number | null;
  mean_score?: number | null;
  gate_result?: string | null;
}

/** Severity band for a fidelity score. Matches the Go severityFromScore. */
export type Severity = "ok" | "warn" | "critical" | "unscored";

export interface RegressionResultCoverage {
  total: number;
  scored: number;
  errored: number;
  meanScore: number | null;
}

export interface RegressionReceiptProgress {
  total: number;
  scored: number;
  errored: number;
  processed: number;
  remaining: number;
  complete: boolean;
}

export interface FidelityBreakdownView {
  embeddingSimilarity: number;
  stylisticMatch: number;
  vocabularyOverlap: number;
  structuralMatch: number;
  combined: number;
}

export interface RegressionRunLike {
  status?: string | null;
  total_examples?: number | null;
  passed_examples?: number | null;
  scored_examples?: number | null;
  error_examples?: number | null;
  warn_threshold?: number | null;
  hard_gate_enabled?: boolean | null;
  hard_gate_threshold?: number | null;
  min_examples_for_gate?: number | null;
  fidelity_score_mean?: number | null;
  gate_result?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  retry_not_before?: string | null;
  stale_at?: string | null;
  updated_at?: string | null;
}

type RegressionGateResult = "pass" | "fail" | "advisory";

export type RegressionEvidenceState =
  | "queued"
  | "running"
  | "stale"
  | "failed"
  | "incomplete"
  | "unscored"
  | "completed";

export type RegressionFreshnessReason =
  | "server-lease-expired"
  | "client-age-warning";

/** Default advisory bands, matching the voice service constants. */
export const DEFAULT_WARN_THRESHOLD = 60;
export const DEFAULT_CRITICAL_THRESHOLD = 40;
export const DEFAULT_HARD_GATE_THRESHOLD = 70;
/**
 * UI-only fallback threshold. A valid server lease expiry takes precedence;
 * this elapsed-time heuristic is used only when that receipt is unavailable.
 * Callers must label the fallback as client-observed rather than a worker
 * state asserted by the server.
 */
export const REGRESSION_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Map a 0..100 fidelity score into an advisory severity band. The frozen
 * warning threshold is authoritative: a score at or above it is always
 * "ok". Only scores below that pass boundary are compared with the critical
 * threshold. Persisted result severity is preferable because runs do not
 * freeze a critical threshold; when a legacy row needs a fallback, critical
 * remains the fixed Voice default of 40.
 */
export function severityFromScore(
  score: number | null | undefined,
  warnThreshold: number = DEFAULT_WARN_THRESHOLD,
  criticalThreshold?: number,
): Severity {
  if (
    !(
      typeof score === "number" &&
      Number.isFinite(score) &&
      score >= 0 &&
      score <= 100
    )
  ) {
    return "unscored";
  }
  const s = score;
  const warn = Number.isFinite(warnThreshold)
    ? warnThreshold
    : DEFAULT_WARN_THRESHOLD;
  const crit =
    typeof criticalThreshold === "number" && Number.isFinite(criticalThreshold)
      ? criticalThreshold
      : DEFAULT_CRITICAL_THRESHOLD;
  if (s >= warn) return "ok";
  if (s < crit) return "critical";
  return "warn";
}

/** Human label for a surface_kind enum. Unknown values are humanised, not
 * invented — a snake_case key becomes Title Case so a new server surface
 * still renders something truthful. */
export function surfaceLabel(kind: string | null | undefined): string {
  const k = (kind ?? "").trim();
  switch (k) {
    case "campaign_draft":
      return "Campaign draft";
    case "subject_line":
      return "Subject line";
    case "sequence_draft":
      return "Sequence draft";
    case "campaign_summary":
      return "Campaign summary";
    case "reply_intent":
      return "Reply intent";
    default:
      if (!k) return "Unknown";
      return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/**
 * Roll a list of regression results up per surface. Error results (severity
 * === "error" or a missing score) are counted in `total` and `errored` but
 * excluded from `meanScore` — so the UI can honestly show "1 of 5 failed to
 * generate" without skewing the mean. An empty input yields {}.
 */
export function aggregateBySurface(
  results: RegressionResultLike[] | null | undefined,
): Record<string, SurfaceAggregate> {
  const out: Record<string, SurfaceAggregate> = {};
  if (!Array.isArray(results)) return out;
  const sums: Record<string, number> = {};
  for (const r of results) {
    const surface = (r?.surface_kind ?? "").trim() || "unknown";
    if (!out[surface]) {
      out[surface] = {
        surface,
        total: 0,
        scored: 0,
        errored: 0,
        meanScore: null,
      };
      sums[surface] = 0;
    }
    const agg = out[surface];
    agg.total += 1;
    const isError =
      r?.severity === "error" ||
      !(
        typeof r?.fidelity_score === "number" &&
        Number.isFinite(r.fidelity_score)
      );
    if (isError) {
      agg.errored += 1;
    } else {
      agg.scored += 1;
      sums[surface] += r.fidelity_score as number;
    }
  }
  for (const surface of Object.keys(out)) {
    const agg = out[surface];
    agg.meanScore = agg.scored > 0 ? sums[surface] / agg.scored : null;
  }
  return out;
}

/** Roll up exact result coverage without treating missing scores as zeroes. */
export function summarizeRegressionResults(
  results: RegressionResultLike[] | null | undefined,
): RegressionResultCoverage {
  if (!Array.isArray(results) || results.length === 0) {
    return { total: 0, scored: 0, errored: 0, meanScore: null };
  }
  let scored = 0;
  let errored = 0;
  let sum = 0;
  for (const result of results) {
    const score = result?.fidelity_score;
    const hasScore =
      result?.severity !== "error" &&
      typeof score === "number" &&
      Number.isFinite(score);
    if (hasScore) {
      scored += 1;
      sum += score;
    } else {
      errored += 1;
    }
  }
  return {
    total: results.length,
    scored,
    errored,
    meanScore: scored > 0 ? sum / scored : null,
  };
}

/** Derive progress only from persisted server receipt counts. */
export function summarizeRegressionReceipt(
  run: RegressionRunLike,
): RegressionReceiptProgress | null {
  const total = nonNegativeInteger(run.total_examples);
  const scored = nonNegativeInteger(run.scored_examples);
  const errored = nonNegativeInteger(run.error_examples);
  if (total == null || scored == null || errored == null) return null;
  const processed = scored + errored;
  if (processed > total) return null;
  return {
    total,
    scored,
    errored,
    processed,
    remaining: total - processed,
    complete: total > 0 && processed === total,
  };
}

/** Parse the closed v2 fidelity diagnostic without filling legacy gaps. */
export function parseFidelityBreakdown(
  breakdown: Record<string, unknown> | null | undefined,
  score: number | null | undefined,
): FidelityBreakdownView | null {
  if (!breakdown || typeof breakdown !== "object") return null;
  const expectedKeys = [
    "embedding_similarity",
    "stylistic_distance",
    "vocabulary_overlap",
    "structural_match",
    "combined",
  ] as const;
  const keys = Object.keys(breakdown);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(breakdown, key))
  ) {
    return null;
  }
  const embedding = breakdown.embedding_similarity;
  const stylisticDistance = breakdown.stylistic_distance;
  const vocabulary = breakdown.vocabulary_overlap;
  const structural = breakdown.structural_match;
  const combined = breakdown.combined;
  const unitValues = [embedding, stylisticDistance, vocabulary, structural];
  if (
    !unitValues.every(
      (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1,
    ) ||
    typeof combined !== "number" ||
    !Number.isFinite(combined) ||
    combined < 0 ||
    combined > 100 ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    Math.abs(combined - score) > 0.000001
  ) {
    return null;
  }
  return {
    embeddingSimilarity: embedding as number,
    // The historical wire key says "distance", but Voice already stores the
    // positively weighted/inverted similarity value. Preserve it verbatim.
    stylisticMatch: stylisticDistance as number,
    vocabularyOverlap: vocabulary as number,
    structuralMatch: structural as number,
    combined,
  };
}

function finiteThreshold(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

/** Mirror the backend's pure ComputeGate decision for one frozen receipt. */
function expectedGateResult(
  evidence: {
    total: number;
    scored: number;
    errors: number;
    meanScore: number | null;
  },
  policy: RegressionRunLike,
): RegressionGateResult | null {
  const warnThreshold = finiteThreshold(policy.warn_threshold);
  const hardEnabled = policy.hard_gate_enabled;
  // CreateRun stores no hard threshold when hard mode is disabled; the Go
  // settingsFromRun path restores the policy default in that case before
  // calling ComputeGate. A present value must still be bounded.
  const hardThreshold =
    hardEnabled === false && policy.hard_gate_threshold == null
      ? DEFAULT_HARD_GATE_THRESHOLD
      : finiteThreshold(policy.hard_gate_threshold);
  const minimum = nonNegativeInteger(policy.min_examples_for_gate);
  if (
    warnThreshold == null ||
    hardThreshold == null ||
    typeof hardEnabled !== "boolean" ||
    minimum == null ||
    minimum < 1
  ) {
    return null;
  }
  if (
    evidence.scored === 0
      ? evidence.meanScore != null
      : finiteThreshold(evidence.meanScore) == null
  ) {
    return null;
  }
  if (
    evidence.scored === 0 ||
    evidence.errors > 0 ||
    evidence.scored + evidence.errors < evidence.total
  ) {
    return "advisory";
  }
  const mean = evidence.meanScore as number;
  if (hardEnabled) {
    if (evidence.scored < minimum) return "advisory";
    return mean < hardThreshold ? "fail" : "pass";
  }
  return mean < warnThreshold ? "advisory" : "pass";
}

/** Validate one surface receipt against counts and its frozen run policy. */
export function surfaceReceiptIsCoherent(
  receipt: SurfaceReceiptLike | null | undefined,
  policy: RegressionRunLike,
): boolean {
  if (!receipt) return false;
  const total = nonNegativeInteger(receipt.total);
  const scored = nonNegativeInteger(receipt.scored);
  const errors = nonNegativeInteger(receipt.errors);
  const passed = nonNegativeInteger(receipt.passed);
  if (
    total == null ||
    scored == null ||
    errors == null ||
    passed == null ||
    total <= 0 ||
    scored + errors > total ||
    passed > scored ||
    !["pass", "fail", "advisory"].includes(receipt.gate_result ?? "")
  ) {
    return false;
  }
  const meanScore = receipt.mean_score ?? null;
  return (
    expectedGateResult({ total, scored, errors, meanScore }, policy) ===
    receipt.gate_result
  );
}

function parsedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestParsedTime(
  ...values: Array<string | null | undefined>
): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const timestamp = parsedTime(value);
    if (timestamp != null && (latest == null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

export function runIsStale(
  run: RegressionRunLike,
  nowMs: number = Date.now(),
  staleAfterMs: number = REGRESSION_STALE_AFTER_MS,
): boolean {
  return regressionFreshnessReason(run, nowMs, staleAfterMs) !== null;
}

export function regressionFreshnessReason(
  run: RegressionRunLike,
  nowMs: number = Date.now(),
  staleAfterMs: number = REGRESSION_STALE_AFTER_MS,
): RegressionFreshnessReason | null {
  if (run.status !== "pending" && run.status !== "running") return null;
  if (!Number.isFinite(nowMs)) return null;

  const leaseExpiresAt = parsedTime(run.lease_expires_at);
  if (run.status === "running" && leaseExpiresAt != null) {
    return leaseExpiresAt <= nowMs ? "server-lease-expired" : null;
  }

  const retryNotBefore = parsedTime(run.retry_not_before);
  if (
    run.status === "pending" &&
    retryNotBefore != null &&
    retryNotBefore > nowMs
  ) {
    return null;
  }

  const anchor =
    run.status === "running"
      ? latestParsedTime(
          run.heartbeat_at,
          run.updated_at,
          run.started_at,
          run.created_at,
        )
      : latestParsedTime(run.updated_at, run.created_at);
  if (anchor == null) return null;
  const threshold =
    Number.isFinite(staleAfterMs) && staleAfterMs > 0
      ? staleAfterMs
      : REGRESSION_STALE_AFTER_MS;
  return nowMs - anchor >= threshold ? "client-age-warning" : null;
}

export function regressionEvidenceState(
  run: RegressionRunLike,
  nowMs: number = Date.now(),
): RegressionEvidenceState {
  if (runIsStale(run, nowMs)) return "stale";
  if (run.status === "pending") return "queued";
  if (run.status === "running") return "running";
  if (run.status === "failed") return "failed";
  if (run.status !== "completed") return "incomplete";

  const total = nonNegativeInteger(run.total_examples);
  const passed = nonNegativeInteger(run.passed_examples);
  const scored = nonNegativeInteger(run.scored_examples);
  const errored = nonNegativeInteger(run.error_examples);
  const minExamplesForGate = nonNegativeInteger(run.min_examples_for_gate);
  if (
    total == null ||
    passed == null ||
    scored == null ||
    errored == null ||
    total <= 0 ||
    scored + errored > total ||
    passed > scored ||
    parsedTime(run.completed_at) == null ||
    !["pass", "fail", "advisory"].includes(run.gate_result ?? "") ||
    minExamplesForGate == null ||
    minExamplesForGate < 1
  ) {
    return "incomplete";
  }
  const meanScore = run.fidelity_score_mean ?? null;
  const expectedGate = expectedGateResult(
    { total, scored, errors: errored, meanScore },
    run,
  );
  if (expectedGate == null || run.gate_result !== expectedGate) {
    return "incomplete";
  }
  if (scored + errored !== total) return "incomplete";
  if (scored === 0) return "unscored";
  return "completed";
}

/** Explain when a recorded advisory is partial or below the configured N. */
export function advisoryEvidenceContext(run: RegressionRunLike): string | null {
  if (run.gate_result !== "advisory") return null;
  const total = nonNegativeInteger(run.total_examples);
  const scored = nonNegativeInteger(run.scored_examples);
  const errored = nonNegativeInteger(run.error_examples);
  const minimum = nonNegativeInteger(run.min_examples_for_gate);
  if (total != null && scored != null && errored != null) {
    const remaining = Math.max(0, total - scored - errored);
    if (remaining > 0) {
      return `This advisory is partial: ${remaining.toLocaleString()} snapshots remain without a persisted result receipt. It is insufficient, non-authoritative evidence.`;
    }
    if (errored > 0) {
      return `This advisory includes ${errored.toLocaleString()} persisted error receipts. It is insufficient, non-authoritative evidence.`;
    }
  }
  if (
    run.hard_gate_enabled === true &&
    scored != null &&
    minimum != null &&
    scored < minimum
  ) {
    return `This advisory has ${scored.toLocaleString()} scored examples, below the configured minimum of ${minimum.toLocaleString()}. It is insufficient, non-authoritative evidence.`;
  }
  return "This advisory is a recorded, non-authoritative policy evaluation.";
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function evidenceStateLabel(state: RegressionEvidenceState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "stale":
      return "Freshness warning";
    case "failed":
      return "Failed";
    case "incomplete":
      return "Incomplete";
    case "unscored":
      return "Unscored";
    case "completed":
      return "Server completed";
  }
}

export type EvidenceTone = "success" | "warning" | "danger" | "neutral";

export function evidenceStateTone(
  state: RegressionEvidenceState,
): EvidenceTone {
  switch (state) {
    case "completed":
    case "queued":
    case "running":
      return "neutral";
    case "stale":
    case "incomplete":
    case "unscored":
      return "warning";
    case "failed":
      return "danger";
  }
}

/** Human label + tone for a recorded policy outcome. */
export function gateLabel(gate: string | null | undefined): string {
  switch ((gate ?? "").trim()) {
    case "pass":
      return "Recorded pass";
    case "fail":
      return "Recorded concern";
    case "advisory":
      return "Recorded advisory";
    default:
      return "No policy outcome";
  }
}

export type GateTone = "success" | "warning" | "danger" | "neutral";

export function gateTone(gate: string | null | undefined): GateTone {
  switch ((gate ?? "").trim()) {
    case "pass":
      return "success";
    case "advisory":
      return "warning";
    case "fail":
      return "danger";
    default:
      return "neutral";
  }
}
