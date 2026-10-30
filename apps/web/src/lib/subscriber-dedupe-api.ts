// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-037 — typed client for duplicate detection + the reviewed-merge flow.
//
// The merge is DESTRUCTIVE and IRREVERSIBLE: the survivor (primary) keeps its
// scalar values on every conflict and receives the duplicate's children; the
// duplicate is tombstoned and its differing values are permanently discarded.
// So the UI always previews first: POST /merge/apply with dry_run=true returns
// the exact server-computed plan (conflicts + status/consent resolution +
// counts) and a plan_fingerprint; the apply re-posts with that fingerprint so
// the committed plan is byte-identical to the one the operator reviewed.

import { api } from "./api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/u;

const dedupeRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const dedupeTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));
const dedupeUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);
const dedupeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export class SubscriberDedupeContractError extends Error {
  constructor() {
    super("The duplicate review service returned an invalid response.");
    this.name = "SubscriberDedupeContractError";
  }
}

// --- scan types (mirror internal/subscriber_dedupe/scan.go JSON tags) ---

export interface DuplicateEvidence {
  kind: string;
  confidence: number;
  reason: string;
}

export interface DuplicateScan {
  scan_id: string;
  status: string;
  subscriber_count: number;
  candidate_count: number;
  created_at: string;
  completed_at?: string;
  expires_at: string;
  complete: boolean;
}

export interface DuplicatePair {
  primary_id: string;
  primary_email: string;
  duplicate_id: string;
  duplicate_email: string;
  primary_updated_at: string;
  duplicate_updated_at: string;
  kind: string;
  confidence: number;
  evidence: DuplicateEvidence[];
  stale: boolean;
}

export interface DuplicateScanPage {
  scan: DuplicateScan;
  pairs: DuplicatePair[];
  count: number;
  next_cursor?: string;
  complete: boolean;
}

// --- reviewed-merge types (mirror internal/merge/apply.go) ---

export interface MergeConflict {
  field: string;
  primary_value: unknown;
  duplicate_value: unknown;
  /** "primary_wins" | "most_restrictive_wins" */
  resolution: string;
}

export interface MergePlan {
  tags: string[];
  custom_fields: Record<string, unknown>;
  status: string;
  consent_timestamp?: string;
  gdpr_permissions: Record<string, unknown>[];
  conflicts: MergeConflict[];
  preserved_on_duplicate: string[];
}

export interface MergeApplyResponse {
  primary_id: string;
  duplicate_id: string;
  dry_run: boolean;
  plan: MergePlan;
  events_moved: number;
  suppressions_moved: number;
  loser_soft_deleted: boolean;
  primary_updated_at: string;
  duplicate_updated_at: string;
  plan_fingerprint: string;
}

// MergeTarget is the minimal pair identity + revisions the apply endpoint needs.
export interface MergeTarget {
  scanId: string;
  primaryId: string;
  duplicateId: string;
  primaryUpdatedAt: string;
  duplicateUpdatedAt: string;
}

export type SelectedDuplicatePairIds = readonly [string, string];

/**
 * Builds the privacy-minimal handoff from the audience table to duplicate
 * review. Only opaque subscriber UUIDs enter browser history; emails and row
 * revisions always come from the tenant-bound scan manifest.
 */
export function selectedDuplicateReviewPath(
  ids: SelectedDuplicatePairIds,
): string {
  const normalized = ids.map((id) => id.trim().toLowerCase());
  if (
    !UUID_RE.test(normalized[0] ?? "") ||
    !UUID_RE.test(normalized[1] ?? "") ||
    normalized[0] === normalized[1]
  ) {
    throw new SubscriberDedupeContractError();
  }
  const params = new URLSearchParams({
    selected: `${normalized[0]},${normalized[1]}`,
  });
  return `/app/subscribers/duplicates?${params.toString()}`;
}

export function parseSelectedDuplicatePairIds(
  value: string | null | undefined,
): SelectedDuplicatePairIds | null {
  if (typeof value !== "string" || value.length !== 73) return null;
  const parts = value.split(",");
  if (
    parts.length !== 2 ||
    !UUID_RE.test(parts[0] ?? "") ||
    !UUID_RE.test(parts[1] ?? "") ||
    parts[0] === parts[1]
  ) {
    return null;
  }
  return [parts[0]!, parts[1]!];
}

export function duplicatePairMatchesSelection(
  pair: Pick<DuplicatePair, "primary_id" | "duplicate_id">,
  selected: SelectedDuplicatePairIds,
): boolean {
  return (
    (pair.primary_id === selected[0] && pair.duplicate_id === selected[1]) ||
    (pair.primary_id === selected[1] && pair.duplicate_id === selected[0])
  );
}

// --- scan lifecycle ---

/** Materialize a fresh complete scan (201). 409 duplicate_scan_in_progress if one is running. */
export function startDuplicateScan(
  options: {
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {},
): Promise<DuplicateScan> {
  return api
    .post<unknown>("/api/v1/subscribers/duplicate-scans", undefined, {
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    })
    .then(parseDuplicateScan);
}

export function getDuplicateScan(
  scanId: string,
  signal?: AbortSignal,
): Promise<DuplicateScan> {
  assertUuid(scanId);
  return api
    .get<unknown>(
      `/api/v1/subscribers/duplicate-scans/${encodeURIComponent(scanId)}`,
      { signal },
    )
    .then(parseDuplicateScan);
}

export function listScanPairs(
  scanId: string,
  opts: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<DuplicateScanPage> {
  assertUuid(scanId);
  return api
    .get<unknown>(
      `/api/v1/subscribers/duplicate-scans/${encodeURIComponent(scanId)}/pairs`,
      {
        query: { cursor: opts.cursor || undefined, limit: opts.limit },
        signal: opts.signal,
      },
    )
    .then((value) => parseDuplicateScanPage(value, scanId));
}

/** One-shot: creates a complete scan and returns its first page of pairs. */
export function listDuplicates(
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<DuplicateScanPage> {
  return api
    .get<unknown>("/api/v1/subscribers/duplicates", {
      query: { limit: opts.limit },
      signal: opts.signal,
    })
    .then((value) => parseDuplicateScanPage(value));
}

// --- reviewed merge (preview then fingerprint-locked apply) ---

function applyBody(
  t: MergeTarget,
  extra: { dry_run: boolean; expected_plan_fingerprint?: string },
) {
  return {
    primary_id: t.primaryId,
    duplicate_id: t.duplicateId,
    scan_id: t.scanId,
    expected_primary_updated_at: t.primaryUpdatedAt,
    expected_duplicate_updated_at: t.duplicateUpdatedAt,
    ...extra,
  };
}

/** Preview the exact merge plan without writing (dry_run). */
export function previewMerge(
  t: MergeTarget,
  options: { signal?: AbortSignal } = {},
): Promise<MergeApplyResponse> {
  assertMergeTarget(t);
  return api
    .post<unknown>("/api/v1/merge/apply", applyBody(t, { dry_run: true }), {
      // dry_run computes a plan but does not mutate. Never queue/replay it as
      // an offline write or mint a misleading mutation identity.
      idempotencyKey: null,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    })
    .then((value) => parseMergeResponse(value, t, true));
}

/**
 * Commit the previously previewed plan. planFingerprint MUST come from the
 * preview response so the committed plan is exactly what was reviewed — a
 * mismatch (the row changed after preview) is rejected server-side.
 */
export function applyMerge(
  t: MergeTarget,
  planFingerprint: string,
  options: { idempotencyKey: string; signal?: AbortSignal },
): Promise<MergeApplyResponse> {
  assertMergeTarget(t);
  if (!FINGERPRINT_RE.test(planFingerprint) || !options.idempotencyKey) {
    throw new SubscriberDedupeContractError();
  }
  return api
    .post<unknown>(
      "/api/v1/merge/apply",
      applyBody(t, {
        dry_run: false,
        expected_plan_fingerprint: planFingerprint,
      }),
      {
        idempotencyKey: options.idempotencyKey,
        maxAttempts: 1,
        requireOnline: true,
        signal: options.signal,
      },
    )
    .then((value) => {
      const parsed = parseMergeResponse(value, t, false);
      if (parsed.plan_fingerprint !== planFingerprint) {
        throw new SubscriberDedupeContractError();
      }
      return parsed;
    });
}

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) throw new SubscriberDedupeContractError();
}

function assertMergeTarget(target: MergeTarget): void {
  if (
    !UUID_RE.test(target.scanId) ||
    !UUID_RE.test(target.primaryId) ||
    !UUID_RE.test(target.duplicateId) ||
    target.primaryId === target.duplicateId ||
    !dedupeTimestamp(target.primaryUpdatedAt) ||
    !dedupeTimestamp(target.duplicateUpdatedAt)
  ) {
    throw new SubscriberDedupeContractError();
  }
}

function parseDuplicateScan(value: unknown): DuplicateScan {
  if (
    !dedupeRecord(value) ||
    !dedupeUuid(value.scan_id) ||
    !["running", "complete", "failed"].includes(String(value.status)) ||
    !dedupeCount(value.subscriber_count) ||
    !dedupeCount(value.candidate_count) ||
    !dedupeTimestamp(value.created_at) ||
    !(
      value.completed_at === undefined || dedupeTimestamp(value.completed_at)
    ) ||
    !dedupeTimestamp(value.expires_at) ||
    typeof value.complete !== "boolean" ||
    (value.complete && value.status !== "complete")
  ) {
    throw new SubscriberDedupeContractError();
  }
  return value as unknown as DuplicateScan;
}

function parseDuplicatePair(value: unknown): DuplicatePair {
  if (
    !dedupeRecord(value) ||
    !dedupeUuid(value.primary_id) ||
    !dedupeUuid(value.duplicate_id) ||
    value.primary_id === value.duplicate_id ||
    typeof value.primary_email !== "string" ||
    value.primary_email.length > 320 ||
    typeof value.duplicate_email !== "string" ||
    value.duplicate_email.length > 320 ||
    !dedupeTimestamp(value.primary_updated_at) ||
    !dedupeTimestamp(value.duplicate_updated_at) ||
    typeof value.kind !== "string" ||
    value.kind.length > 96 ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 20 ||
    typeof value.stale !== "boolean"
  ) {
    throw new SubscriberDedupeContractError();
  }
  for (const evidence of value.evidence) {
    if (
      !dedupeRecord(evidence) ||
      typeof evidence.kind !== "string" ||
      evidence.kind.length > 96 ||
      typeof evidence.reason !== "string" ||
      evidence.reason.length > 512 ||
      typeof evidence.confidence !== "number" ||
      !Number.isFinite(evidence.confidence) ||
      evidence.confidence < 0 ||
      evidence.confidence > 1
    ) {
      throw new SubscriberDedupeContractError();
    }
  }
  return value as unknown as DuplicatePair;
}

function parseDuplicateScanPage(
  value: unknown,
  expectedScanId?: string,
): DuplicateScanPage {
  if (
    !dedupeRecord(value) ||
    !Array.isArray(value.pairs) ||
    value.pairs.length > 200 ||
    !dedupeCount(value.count) ||
    typeof value.complete !== "boolean" ||
    !(
      value.next_cursor === undefined ||
      (typeof value.next_cursor === "string" &&
        /^[0-9]{1,19}$/u.test(value.next_cursor))
    )
  ) {
    throw new SubscriberDedupeContractError();
  }
  const scan = parseDuplicateScan(value.scan);
  if (
    (expectedScanId && scan.scan_id !== expectedScanId) ||
    scan.complete !== value.complete ||
    Number(value.count) !== value.pairs.length ||
    (value.next_cursor !== undefined && value.pairs.length === 0)
  ) {
    throw new SubscriberDedupeContractError();
  }
  const pairs = value.pairs.map(parseDuplicatePair);
  const keys = pairs.map((pair) => `${pair.primary_id}:${pair.duplicate_id}`);
  if (new Set(keys).size !== keys.length) {
    throw new SubscriberDedupeContractError();
  }
  return {
    scan,
    pairs,
    count: Number(value.count),
    ...(typeof value.next_cursor === "string"
      ? { next_cursor: value.next_cursor }
      : {}),
    complete: value.complete,
  };
}

function parseMergeResponse(
  value: unknown,
  target: MergeTarget,
  expectedDryRun: boolean,
): MergeApplyResponse {
  if (
    !dedupeRecord(value) ||
    value.primary_id !== target.primaryId ||
    value.duplicate_id !== target.duplicateId ||
    value.dry_run !== expectedDryRun ||
    !dedupeRecord(value.plan) ||
    !dedupeCount(value.events_moved) ||
    !dedupeCount(value.suppressions_moved) ||
    typeof value.loser_soft_deleted !== "boolean" ||
    !dedupeTimestamp(value.primary_updated_at) ||
    !dedupeTimestamp(value.duplicate_updated_at) ||
    typeof value.plan_fingerprint !== "string" ||
    !FINGERPRINT_RE.test(value.plan_fingerprint)
  ) {
    throw new SubscriberDedupeContractError();
  }
  const plan = value.plan;
  if (
    !Array.isArray(plan.tags) ||
    plan.tags.length > 10_000 ||
    !plan.tags.every((tag) => typeof tag === "string" && tag.length <= 128) ||
    !dedupeRecord(plan.custom_fields) ||
    typeof plan.status !== "string" ||
    plan.status.length > 64 ||
    !(
      plan.consent_timestamp === undefined ||
      dedupeTimestamp(plan.consent_timestamp)
    ) ||
    !Array.isArray(plan.gdpr_permissions) ||
    !Array.isArray(plan.conflicts) ||
    plan.conflicts.length > 10_000 ||
    !Array.isArray(plan.preserved_on_duplicate) ||
    !plan.preserved_on_duplicate.every(
      (item) => typeof item === "string" && item.length <= 512,
    ) ||
    (!expectedDryRun && value.loser_soft_deleted !== true)
  ) {
    throw new SubscriberDedupeContractError();
  }
  for (const conflict of plan.conflicts) {
    if (
      !dedupeRecord(conflict) ||
      typeof conflict.field !== "string" ||
      conflict.field.length > 256 ||
      !["primary_wins", "most_restrictive_wins"].includes(
        String(conflict.resolution),
      )
    ) {
      throw new SubscriberDedupeContractError();
    }
  }
  return value as unknown as MergeApplyResponse;
}
