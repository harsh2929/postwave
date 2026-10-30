/**
 * lib/maintenance-api.ts — jobs you run on demand, and configuration
 * validators.
 *
 * Sixteen paths desktop reached and no web file did.
 *
 * COVERAGE: this module wires fifteen. CDP transform preview moved to the
 * dedicated strict, input-bearing `cdp-transform-preview-api` laboratory; it
 * cannot be represented honestly by a generic empty-body maintenance button.
 *   /api/v1/spam-trap-guard/run-now
 *   /api/v1/soft-bounce-recovery/run-now
 *   /api/v1/predictive/recompute
 *   /api/v1/firewall/detect
 *   /api/v1/sunset/reengagement/preview
 *   /api/v1/warehouse/validate
 *   /api/v1/warehouse/streaming/validate
 *   /api/v1/omnichannel/validate
 *   /api/v1/social-capture/validate
 *   /api/v1/onsite-growth/validate
 *   /api/v1/dns-health/run-now
 *   /api/v1/events/publish
 *   /api/v1/contact-ratings/recompute
 *   /api/v1/zero-copy-triggers/validate
 *   /api/v1/warehouse/runs/due
 *
 * `valid: true` DOES NOT MEAN "NOTHING TO KNOW". Every validator returns
 * `warnings` beside `errors`, and a warning survives a passing verdict. The
 * live social-capture validator answers `valid: true` with "sms_list_id is
 * missing; social answers will be captured without SMS consent handoff" — a
 * green badge alone would tell an operator their setup is fine while consent
 * is quietly dropped. Warnings are therefore rendered on success, not only on
 * failure.
 *
 * A JOB THAT RAN AND FOUND NOTHING IS NOT A JOB THAT DID NOT RUN.
 * `run-now` returns zero counts plus `completed_at`; the timestamp is what
 * separates "swept, nothing to do" from "never swept". Same for
 * `firewall/detect`, whose `flipped: false` means the detector executed and
 * chose not to change anything.
 */
import { api } from "@/lib/api";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Present on success too. Never gate rendering on `valid === false`. */
  warnings: string[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toValidation(r: unknown): ValidationResult {
  const o = (r ?? {}) as Record<string, unknown>;
  return {
    valid: o.valid === true,
    errors: asArray<string>(o.errors),
    warnings: asArray<string>(o.warnings),
  };
}

/**
 * A validator answers 422 when the payload is invalid. That is a RESULT, not
 * a transport failure, so the body is read rather than thrown away — the
 * errors it carries are the whole point of calling it.
 */
type ValidationPath =
  | "/api/v1/warehouse/validate"
  | "/api/v1/warehouse/streaming/validate"
  | "/api/v1/omnichannel/validate"
  | "/api/v1/social-capture/validate"
  | "/api/v1/onsite-growth/validate"
  | "/api/v1/zero-copy-triggers/validate";

async function validate(
  path: ValidationPath,
  body: unknown,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  try {
    return toValidation(await api.post<unknown>(path, body, { signal }));
  } catch (err) {
    const detail = (err as { details?: unknown })?.details;
    if (detail && typeof detail === "object") return toValidation(detail);
    throw err;
  }
}

export const validateWarehouse = (b: unknown) =>
  validate("/api/v1/warehouse/validate", b);
export const validateWarehouseStreaming = (b: unknown) =>
  validate("/api/v1/warehouse/streaming/validate", b);
export const validateOmnichannel = (b: unknown) =>
  validate("/api/v1/omnichannel/validate", b);
export const validateSocialCapture = (b: unknown) =>
  validate("/api/v1/social-capture/validate", b);

export interface JobResult {
  /** Proof the job executed. Absent means it did not. */
  completed_at: string;
  counts: Record<string, number>;
}

export async function runSpamTrapSweep(
  signal?: AbortSignal,
): Promise<JobResult> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/spam-trap-guard/run-now",
    {},
    { signal },
  );
  return {
    completed_at: str(r?.completed_at),
    counts: { blocklisted: num(r?.blocklisted) },
  };
}

export async function runSoftBounceRecovery(
  signal?: AbortSignal,
): Promise<JobResult> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/soft-bounce-recovery/run-now",
    {},
    { signal },
  );
  return {
    completed_at: str(r?.completed_at),
    counts: {
      recovered: num(r?.recovered),
      expired_suppressions: num(r?.expired_suppressions),
    },
  };
}

export interface RecomputeRun {
  id: string;
  model_key: string;
  /** Results belong to this version; snapshots across versions are not a series. */
  model_version: string;
}

export async function recomputePredictive(
  signal?: AbortSignal,
): Promise<RecomputeRun> {
  const r = await api.post<{ run?: Record<string, unknown> }>(
    "/api/v1/predictive/recompute",
    {},
    { signal },
  );
  const run = (r?.run ?? {}) as Record<string, unknown>;
  return {
    id: str(run?.id),
    model_key: str(run?.model_key),
    model_version: str(run?.model_version),
  };
}

/** `flipped: false` = the detector ran and chose not to change attack mode. */
export async function runFirewallDetect(
  signal?: AbortSignal,
): Promise<{ flipped: boolean }> {
  const r = await api.post<{ flipped?: unknown }>(
    "/api/v1/firewall/detect",
    {},
    { signal },
  );
  return { flipped: r?.flipped === true };
}

export interface ReengagementPreview {
  subject: string;
  preheader: string;
  bodyText: string;
}

export async function previewReengagement(
  signal?: AbortSignal,
): Promise<ReengagementPreview> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/sunset/reengagement/preview",
    {},
    { signal },
  );
  return {
    subject: str(r?.subject),
    preheader: str(r?.preheader),
    bodyText: str(r?.bodyText),
  };
}

/** A passing validation that still has something the operator must know. */
export function validWithCaveats(v: ValidationResult): boolean {
  return v.valid && v.warnings.length > 0;
}

/** Did this job actually execute? Zero counts alone cannot answer that. */
export function jobDidRun(j: JobResult): boolean {
  return j.completed_at.trim() !== "";
}

/**
 * Validates a minimally-complete social-capture configuration.
 *
 * Deliberately a VALID payload: the point of the button is to demonstrate the
 * case where `valid: true` still carries a consent warning, which is the one
 * an errors-only UI drops.
 */
export function validSocialCaptureSample(
  signal?: AbortSignal,
): Promise<ValidationResult> {
  return validate(
    "/api/v1/social-capture/validate",
    { name: "Sample", trigger_phrases: ["hi"] },
    signal,
  );
}

export const validateOnsiteGrowth = (b: unknown, signal?: AbortSignal) =>
  validate("/api/v1/onsite-growth/validate", b, signal);

/** Re-checks DNS for every sending identity. Returns how many were rechecked. */
export async function recheckDns(
  signal?: AbortSignal,
): Promise<{ rechecked: number }> {
  const r = await api.post<{ rechecked?: unknown }>(
    "/api/v1/dns-health/run-now",
    {},
    { signal },
  );
  return { rechecked: num(r?.rechecked) };
}

/**
 * Publishes an event onto the workspace bus.
 *
 * NOT EVERY TOPIC IS PUBLISHABLE FROM A CLIENT. The server keeps an
 * allow-list and refuses anything outside it with reason "policy" and code
 * `topic_not_publishable` — a deliberate boundary, not a misconfiguration, so
 * the caller reports it as a rule rather than as a failure.
 */
export async function publishEvent(
  topic: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ published: true } | { notPublishable: true }> {
  try {
    await api.post("/api/v1/events/publish", { topic, payload }, { signal });
    return { published: true };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "topic_not_publishable") return { notPublishable: true };
    throw err;
  }
}

export interface RecomputeRatings {
  updated: number;
  /** How many subscribers were examined. 0 means the sweep found nobody. */
  scanned: number;
  window_days: number;
}

/**
 * Recomputes contact ratings.
 *
 * `scanned` IS THE DENOMINATOR. "0 updated" over 0 scanned means nobody was
 * eligible; "0 updated" over 4,000 scanned means every rating was already
 * correct. Reporting only `updated` collapses those into the same sentence.
 */
export async function recomputeContactRatings(
  signal?: AbortSignal,
): Promise<RecomputeRatings> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/contact-ratings/recompute",
    {},
    { signal },
  );
  return {
    updated: num(r?.updated),
    scanned: num(r?.scanned),
    window_days: num(r?.window_days),
  };
}

export const validateZeroCopyTrigger = (b: unknown, signal?: AbortSignal) =>
  validate("/api/v1/zero-copy-triggers/validate", b, signal);
