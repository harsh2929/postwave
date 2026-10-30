/**
 * lib/data-operations-api.ts — link rewriting, inbound route matching, tag
 * taxonomy-operation holds, batch verification and audit-sink tests.
 *
 * COVERAGE: this module wires the supported preview, verification, and sink
 * paths. The two legacy taxonomy mutation paths remain deliberately contained:
 *   /api/v1/utm-templates/preview
 *   /api/v1/inbound-routes/preview
 *   /api/v1/tag-taxonomy/rename (release-held; never transported)
 *   /api/v1/tag-taxonomy/merge  (release-held; never transported)
 *   /api/v1/verification/verify-batch
 *   /api/v1/audit-sinks/test
 *
 * THREE THINGS THE RESPONSES SAY THAT A PLAIN RENDER WOULD LOSE:
 *
 * 1. `utm-templates/preview` returns `rewritten` EQUAL TO `original` when no
 *    template is enabled, alongside a template whose `created_at` is Go's zero
 *    time. Showing the rewritten URL alone implies link tagging is working;
 *    it is the sameness that carries the information.
 *
 * 2. `inbound-routes/preview` returns `no_matches: true` with `evaluated: 0`.
 *    Nothing matched because nothing was tried. That is a different fact from
 *    ten routes being evaluated and none matching, and only the second says
 *    anything about the routes.
 *
 * 3. `verification/verify-batch` refuses without an Idempotency-Key, because
 *    "retries cannot repeat billable verification work". The shared client
 *    mints one for every mutation, so calling through `api.post` satisfies it;
 *    a hand-rolled fetch here would be refused, and worse, one that added a
 *    FRESH key per retry would double-bill. This is a reason to go through the
 *    client, not around it.
 */
import { api, ApiError } from "@/lib/api";
import { isNeverTimestamp } from "@/lib/go-zero-time";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export interface UtmPreview {
  original: string;
  rewritten: string;
  templateEnabled: boolean;
  /** True when the template has never been saved (Go zero time). */
  templateNeverConfigured: boolean;
}

export async function previewUtm(url: string): Promise<UtmPreview> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/utm-templates/preview",
    { url },
  );
  const tpl = (r?.template ?? {}) as Record<string, unknown>;
  return {
    original: str(r?.original),
    rewritten: str(r?.rewritten),
    templateEnabled: tpl?.enabled === true,
    templateNeverConfigured: isNeverTimestamp(str(tpl?.created_at)),
  };
}

/** The link came back untouched. */
export function utmLeftUnchanged(p: UtmPreview): boolean {
  return p.original === p.rewritten;
}

export interface RoutePreview {
  matches: unknown[];
  /** How many routes were actually considered. 0 makes `no_matches` vacuous. */
  evaluated: number;
  no_matches: boolean;
}

export async function previewInboundRoute(
  recipient: string,
): Promise<RoutePreview> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/inbound-routes/preview",
    { recipient },
  );
  return {
    matches: asArray(r?.matches),
    evaluated: num(r?.evaluated),
    no_matches: r?.no_matches === true,
  };
}

/** "Nothing matched" is only a statement about the routes if any were tried. */
export function noRoutesToEvaluate(p: RoutePreview): boolean {
  return p.evaluated === 0;
}

/**
 * Legacy taxonomy rename and merge are deterministic server refusals in this
 * deployment. Retained adapters fail before transport so a dormant or stale
 * caller cannot imply that a destructive operation may succeed.
 */
export const TAG_TAXONOMY_MUTATION_RELEASE_HOLD =
  "Tag rename and merge are unavailable until the versioned taxonomy mutation path and subscriber rewrite are release-qualified. No subscriber tags will be changed from this page.";

export class TagTaxonomyMutationUnavailableError extends Error {
  readonly code = "tag_taxonomy_mutation_unavailable";

  constructor() {
    super(TAG_TAXONOMY_MUTATION_RELEASE_HOLD);
    this.name = "TagTaxonomyMutationUnavailableError";
  }
}

function rejectTagTaxonomyMutation<T>(): Promise<T> {
  return Promise.reject(new TagTaxonomyMutationUnavailableError());
}

export function renameTag(_from: string, _to: string): Promise<never> {
  return rejectTagTaxonomyMutation();
}

export function mergeTag(_from: string, _into: string): Promise<never> {
  return rejectTagTaxonomyMutation();
}

/** One synchronous paid provider-latency wave; larger work is durable. */
export const MAX_SYNCHRONOUS_VERIFICATION_BATCH = 8;

const VERIFICATION_STATUSES = new Set([
  "valid",
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
]);

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface VerificationBatchReceipt {
  results: Array<{ email: string; status: string }>;
  usage: {
    total: number;
    cache_hits: number;
    local_filtered: number;
    vendor_verified: number;
    credits_spent: number;
    duplicates: number;
    credits_saved: number;
    savings_ratio: number;
  };
}

export interface VerificationJobReceipt {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  source: "inline";
  total: number;
}

const VERIFICATION_JOB_STATUSES = new Set<VerificationJobReceipt["status"]>([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);

/** A 2xx arrived, but it did not prove which paid intent the server accepted. */
export class VerificationReceiptUncertainError extends Error {
  readonly code = "verification_receipt_uncertain";

  constructor() {
    super(
      "Moosewave returned an incomplete verification receipt, so the billing outcome is uncertain. Refresh Email verification before retrying this unchanged batch.",
    );
    this.name = "VerificationReceiptUncertainError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function parseVerificationBatchReceipt(
  value: unknown,
  emails: string[],
): VerificationBatchReceipt {
  const envelope = record(value);
  const results = Array.isArray(envelope?.results) ? envelope.results : null;
  const usage = record(envelope?.usage);
  if (!results || results.length !== emails.length || !usage) {
    throw new VerificationReceiptUncertainError();
  }

  const parsedResults = results.map((value, index) => {
    const result = record(value);
    const email = typeof result?.email === "string" ? result.email : "";
    const status = typeof result?.status === "string" ? result.status : "";
    if (
      !email ||
      !VERIFICATION_STATUSES.has(status) ||
      canonicalEmail(email) !== canonicalEmail(emails[index] ?? "")
    ) {
      throw new VerificationReceiptUncertainError();
    }
    return { email, status };
  });

  const countFields = [
    "total",
    "cache_hits",
    "local_filtered",
    "vendor_verified",
    "credits_spent",
    "duplicates",
    "credits_saved",
  ] as const;
  if (
    countFields.some((field) => !nonNegativeInteger(usage[field])) ||
    usage.total !== emails.length ||
    typeof usage.savings_ratio !== "number" ||
    !Number.isFinite(usage.savings_ratio) ||
    usage.savings_ratio < 0 ||
    usage.savings_ratio > 1
  ) {
    throw new VerificationReceiptUncertainError();
  }

  return {
    results: parsedResults,
    usage: usage as unknown as VerificationBatchReceipt["usage"],
  };
}

export function parseVerificationJobReceipt(
  value: unknown,
  emails: string[],
): VerificationJobReceipt {
  const job = record(value);
  const total = new Set(emails.map(canonicalEmail).filter(Boolean)).size;
  if (
    typeof job?.id !== "string" ||
    !JOB_ID_PATTERN.test(job.id) ||
    typeof job.status !== "string" ||
    !VERIFICATION_JOB_STATUSES.has(
      job.status as VerificationJobReceipt["status"],
    ) ||
    job.source !== "inline" ||
    !nonNegativeInteger(job.total) ||
    job.total !== total
  ) {
    throw new VerificationReceiptUncertainError();
  }
  return {
    id: job.id,
    status: job.status as VerificationJobReceipt["status"],
    source: "inline",
    total: job.total,
  };
}

/**
 * Batch email verification.
 *
 * The key belongs to the UI's semantic attempt, rather than this transport
 * call. That lets the UI reuse it after a timeout or ambiguous response and
 * rotate it only when the operator starts new work.
 */
export async function verifyBatch(
  emails: string[],
  idempotencyKey: string,
): Promise<VerificationBatchReceipt> {
  const response = await api.post<unknown>(
    "/api/v1/verification/verify-batch",
    { emails },
    {
      idempotencyKey,
      // A ZeroBounce real-time batch may use a 70-second provider window and
      // the API reserves a finite 90-second write envelope. Do not abandon it at the generic
      // 15-second UI deadline and invite a second billable intent.
      timeoutMs: 120_000,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
  return parseVerificationBatchReceipt(response, emails);
}

/**
 * Queue a larger address set on the durable verification ledger. The same
 * caller-owned exact key must be retained after uncertain transport outcomes;
 * a fresh key could authorize a second billable job.
 */
export async function createVerificationJob(
  emails: string[],
  idempotencyKey: string,
): Promise<VerificationJobReceipt> {
  const response = await api.post<unknown>(
    "/api/v1/verification/jobs",
    { source: "inline", emails },
    {
      idempotencyKey,
      timeoutMs: 30_000,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
  return parseVerificationJobReceipt(response, emails);
}

/** Whether an unchanged verification attempt must retain its billing key. */
export function retainVerificationAttemptKey(error: unknown): boolean {
  if (error instanceof VerificationReceiptUncertainError) return true;
  if (!(error instanceof ApiError)) {
    // Unknown failures carry no proof that the request stayed client-side.
    return true;
  }
  if (error.status === 0 || error.status >= 500) return true;
  if (error.status !== 409) return false;
  return (
    error.code === "verification_provider_outcome_ambiguous" ||
    error.code === "verification_usage_outcome_ambiguous" ||
    error.code === "idempotency_key_in_progress"
  );
}

/** The sink kinds this build accepts, as enumerated by the server's refusal. */
export const AUDIT_SINK_KINDS = [
  "s3",
  "datadog",
  "splunk",
  "http",
  "snowflake_shareback",
  "otlp_logs",
] as const;

export async function testAuditSink(kind: string): Promise<unknown> {
  return api.post("/api/v1/audit-sinks/test", { kind });
}

/**
 * Reorders inbound routes.
 *
 * Route order is EVALUATION order — the first match wins — so this is not a
 * cosmetic sort. Requires the full ordered id list; sending a partial list
 * would silently drop the routes left out.
 */
export async function reorderInboundRoutes(
  routeIds: string[],
): Promise<unknown> {
  return api.post("/api/v1/inbound-routes/reorder", { route_ids: routeIds });
}

/**
 * A subscriber's per-event trigger delay preference.
 *
 * Needs BOTH `subscriber_id` and `event_name`. Answers 404 "preference not
 * found" when none is set, which is an ordinary empty state rather than an
 * error — the subscriber simply uses the default delay.
 */
export async function getTriggerDelayPreference(
  subscriberId: string,
  eventName: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await api.get<Record<string, unknown>>(
      `/api/v1/trigger-delay/preferences?subscriber_id=${encodeURIComponent(subscriberId)}&event_name=${encodeURIComponent(eventName)}`,
    );
  } catch (err) {
    if ((err as { code?: string })?.code === "not_found") return null;
    throw err;
  }
}

export interface BuildLookalikeAudienceInput {
  seed_segment_id: string;
  name?: string;
  size: number;
  confidence_threshold?: number | null;
  /** Must be an explicit acknowledgement; the UI never pre-checks it. */
  data_use_acknowledged: true;
}

export interface LookalikeAudienceReceipt {
  id: string;
  name: string;
  seed_segment_id: string;
  size_requested: number;
  member_count: number;
  seed_count: number;
  confidence_threshold: number | null;
  model_version: string;
  status: "pending" | "running" | "ready" | "failed";
  error?: string;
  created_at: string;
  updated_at: string;
}

const LOOKALIKE_STATUSES = new Set<LookalikeAudienceReceipt["status"]>([
  "pending",
  "running",
  "ready",
  "failed",
]);

function lookalikeContractError(): Error {
  return new Error(
    "Moosewave returned an invalid lookalike receipt. No result is being shown; refresh before trying again.",
  );
}

function parseLookalikeReceipt(
  value: unknown,
  input: BuildLookalikeAudienceInput,
): LookalikeAudienceReceipt {
  const row = record(value);
  const confidence = row?.confidence_threshold;
  const requestedConfidence = input.confidence_threshold ?? null;
  if (
    !row ||
    typeof row.id !== "string" ||
    !row.id.trim() ||
    typeof row.name !== "string" ||
    !row.name.trim() ||
    row.seed_segment_id !== input.seed_segment_id ||
    row.size_requested !== input.size ||
    !nonNegativeInteger(row.member_count) ||
    row.member_count > input.size ||
    !nonNegativeInteger(row.seed_count) ||
    row.seed_count < 50 ||
    typeof row.model_version !== "string" ||
    !row.model_version.trim() ||
    typeof row.status !== "string" ||
    !LOOKALIKE_STATUSES.has(row.status as LookalikeAudienceReceipt["status"]) ||
    (confidence !== null &&
      confidence !== undefined &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0.5 ||
        confidence > 1)) ||
    (requestedConfidence === null
      ? confidence !== null && confidence !== undefined
      : confidence !== requestedConfidence) ||
    typeof row.created_at !== "string" ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    typeof row.updated_at !== "string" ||
    !Number.isFinite(Date.parse(row.updated_at)) ||
    (row.error !== undefined && typeof row.error !== "string")
  ) {
    throw lookalikeContractError();
  }
  return {
    id: row.id,
    name: row.name,
    seed_segment_id: row.seed_segment_id,
    size_requested: row.size_requested,
    member_count: row.member_count,
    seed_count: row.seed_count,
    confidence_threshold: typeof confidence === "number" ? confidence : null,
    model_version: row.model_version,
    status: row.status as LookalikeAudienceReceipt["status"],
    ...(typeof row.error === "string" ? { error: row.error } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Build a lookalike only after the caller has shown and captured data use. */
export async function buildLookalikeAudience(
  input: BuildLookalikeAudienceInput,
  opts: { signal?: AbortSignal } = {},
): Promise<LookalikeAudienceReceipt> {
  const name = input.name?.trim();
  if (
    !input.seed_segment_id.trim() ||
    !Number.isInteger(input.size) ||
    input.size < 100 ||
    input.size > 10_000 ||
    input.data_use_acknowledged !== true ||
    (name !== undefined &&
      (name.length === 0 ||
        new TextEncoder().encode(name).byteLength > 120 ||
        /[\u0000-\u001f\u007f]/u.test(name))) ||
    (input.confidence_threshold != null &&
      (!Number.isFinite(input.confidence_threshold) ||
        input.confidence_threshold < 0.5 ||
        input.confidence_threshold > 1))
  ) {
    throw new Error(
      "Check the lookalike seed, size, confidence, and acknowledgement.",
    );
  }
  const body: BuildLookalikeAudienceInput = {
    seed_segment_id: input.seed_segment_id,
    size: input.size,
    confidence_threshold: input.confidence_threshold ?? null,
    data_use_acknowledged: true,
    ...(name ? { name } : {}),
  };
  const response = await api.post<unknown>(
    "/api/v1/audiences/lookalike",
    body,
    {
      signal: opts.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  return parseLookalikeReceipt(response, body);
}
