// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport for the subscribers DIRECTORY verbs that desktop exposes and web
// did not: evidence-gated bulk resubscribe, one-key bulk custom-field and
// merge-field writes, lookalike generation, saved directory views, per-user
// column preferences, inline row edits, the engagement-score browser and the
// directory stats strip.
//
// Every call writes its path as its own literal so the mounted-route guard
// (src/__tests__/client-calls-mounted-routes.test.ts) can resolve it.
//
// PATCH /api/v1/subscribers/{id} treats a non-nil `custom_fields` or
// `merge_fields` map as a FULL REPLACE. Nothing here sends either map: the
// bulk field verbs go to the dedicated one-key endpoints, whose SQL is
// `COALESCE(col,'{}') || {key: value}` (or `- key`), so every other key on
// every selected row survives.

import { api } from "@/lib/api";
import {
  connectRealtimeBus,
  type RealtimeStatus,
} from "@/lib/realtime/event-bus-client";
import {
  isExactSubscriberVersion,
  updateSubscriber,
  type Subscriber,
  type SubscriberStatus,
  type UpdateSubscriberInput,
} from "@/lib/subscribers-api";

export class DirectoryContractError extends Error {
  readonly code = "subscriber_directory_contract_invalid";
  constructor(surface: string) {
    super(
      `Moosewave returned an invalid ${surface} response. Nothing is being shown for it; refresh and try again.`,
    );
    this.name = "DirectoryContractError";
  }
}

export interface DirectoryWriteOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export function directoryIdempotencyKey(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nonEmpty(value: unknown, max = 2_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function timestamp(value: unknown): value is string {
  return nonEmpty(value, 80) && Number.isFinite(Date.parse(value));
}
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function writeOptions(options: DirectoryWriteOptions, prefix: string) {
  return {
    idempotencyKey: options.idempotencyKey ?? directoryIdempotencyKey(prefix),
    maxAttempts: 1,
    requireOnline: true,
    signal: options.signal,
  } as const;
}

/* ------------------------------------------------------------------------ *
 * Consent evidence (the server's ConsentProvenanceInput, flat snake_case)
 * ------------------------------------------------------------------------ */

export const CONSENT_SOURCES = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
  { value: "preference_center", label: "Preference center" },
  { value: "signed_form", label: "Signed form or contract" },
  { value: "direct_request", label: "Direct subscriber request" },
] as const;

export const CONSENT_CHANNELS = [
  { value: "web", label: "Web form" },
  { value: "mobile", label: "Mobile app" },
  { value: "desktop", label: "Admin desktop" },
  { value: "email", label: "Email confirmation" },
  { value: "import", label: "Verified import evidence" },
  { value: "api", label: "Verified API evidence" },
] as const;

export const CONSENT_LEGAL_BASES = [
  { value: "consent", label: "Consent" },
  { value: "contract", label: "Contract" },
  { value: "legitimate_interest", label: "Legitimate interest" },
  { value: "legal_obligation", label: "Legal obligation" },
] as const;

export type ConsentSourceValue = (typeof CONSENT_SOURCES)[number]["value"];
export type ConsentChannelValue = (typeof CONSENT_CHANNELS)[number]["value"];
export type ConsentLegalBasisValue =
  (typeof CONSENT_LEGAL_BASES)[number]["value"];

export interface ConsentEvidenceDraft {
  source: string;
  channel: string;
  legalBasis: string;
  /** `datetime-local` value; converted to RFC3339 on submit. */
  occurredAt: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policyVersion: string;
}

export interface ConsentProvenance {
  source: ConsentSourceValue;
  channel: ConsentChannelValue;
  legal_basis: ConsentLegalBasisValue;
  occurred_at: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policy_version: string;
}

export function emptyConsentEvidenceDraft(): ConsentEvidenceDraft {
  return {
    source: "",
    channel: "web",
    legalBasis: "consent",
    occurredAt: "",
    jurisdiction: "",
    evidence: "",
    reason: "",
    policyVersion: "",
  };
}

/**
 * The first problem with a draft, in the order an operator fills it in, or
 * null when it satisfies the server's `normalizeConsentProvenance` bounds.
 * `requireEvidence` mirrors the server: resubscribe and enable both need a
 * durable evidence reference.
 */
export function consentEvidenceProblem(
  draft: ConsentEvidenceDraft,
  now = Date.now(),
): string | null {
  if (!CONSENT_SOURCES.some((option) => option.value === draft.source))
    return "Select where the evidence came from.";
  if (!CONSENT_CHANNELS.some((option) => option.value === draft.channel))
    return "Select the capture channel.";
  if (!CONSENT_LEGAL_BASES.some((option) => option.value === draft.legalBasis))
    return "Select the legal basis.";
  const occurred = Date.parse(draft.occurredAt);
  if (!draft.occurredAt || !Number.isFinite(occurred))
    return "Enter the date and time the decision was captured.";
  if (occurred > now + 5 * 60_000)
    return "The captured time cannot be in the future.";
  const jurisdiction = draft.jurisdiction.trim();
  if (!jurisdiction) return "Enter the governing jurisdiction.";
  if (jurisdiction.length > 32)
    return "Jurisdiction must be 32 characters or fewer.";
  const evidence = draft.evidence.trim();
  if (!evidence) return "Enter a durable evidence reference.";
  if (evidence.length > 2_048)
    return "Evidence reference must be 2,048 characters or fewer.";
  const reason = draft.reason.trim();
  if (!reason) return "Explain why this change is being recorded.";
  if (reason.length > 500) return "Reason must be 500 characters or fewer.";
  const policy = draft.policyVersion.trim();
  if (!policy) return "Enter the policy version in force.";
  if (policy.length > 100)
    return "Policy version must be 100 characters or fewer.";
  return null;
}

export function consentProvenance(
  draft: ConsentEvidenceDraft,
  now = Date.now(),
): ConsentProvenance {
  const problem = consentEvidenceProblem(draft, now);
  if (problem) throw new Error(problem);
  return {
    source: draft.source as ConsentSourceValue,
    channel: draft.channel as ConsentChannelValue,
    legal_basis: draft.legalBasis as ConsentLegalBasisValue,
    occurred_at: new Date(draft.occurredAt).toISOString(),
    jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    evidence: draft.evidence.trim(),
    reason: draft.reason.trim(),
    policy_version: draft.policyVersion.trim(),
  };
}

/* ------------------------------------------------------------------------ *
 * Bulk verbs
 * ------------------------------------------------------------------------ */

export const BULK_ID_LIMIT = 10_000;

export interface DirectoryBulkResult {
  affected: number;
  skipped: number;
  exclusions: Record<string, number>;
}

function parseBulkResult(value: unknown, surface: string): DirectoryBulkResult {
  const row = rec(value);
  if (!row || !count(row.affected)) throw new DirectoryContractError(surface);
  const skipped = row.skipped === undefined ? 0 : row.skipped;
  if (!count(skipped)) throw new DirectoryContractError(surface);
  const exclusions: Record<string, number> = {};
  if (row.exclusions !== undefined && row.exclusions !== null) {
    const raw = rec(row.exclusions);
    if (!raw) throw new DirectoryContractError(surface);
    for (const [key, n] of Object.entries(raw)) {
      if (!count(n)) throw new DirectoryContractError(surface);
      exclusions[key] = n;
    }
  }
  return { affected: row.affected, skipped, exclusions };
}

function assertBulkIds(ids: readonly string[]): string[] {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) throw new Error("Select at least one subscriber.");
  if (unique.length > BULK_ID_LIMIT)
    throw new Error("Bulk actions are limited to 10,000 subscribers.");
  if (!unique.every(isUuid))
    throw new Error("Reload the directory before running a bulk action.");
  return unique;
}

/** Server-side eligibility reasons for a skipped resubscribe row. */
export const RESUBSCRIBE_EXCLUSION_LABELS: Record<string, string> = {
  missing_or_outside_tenant: "not found in this workspace",
  canonical_address_conflict: "address conflicts with another profile",
  not_blocklisted: "not currently unsubscribed",
  protected_suppression: "held by a protected suppression",
  unattributed_address_hold: "held pending address attribution",
};

/**
 * Local preflight, mirroring desktop's classifyResubscribeEligibility: only
 * rows the engine has unsubscribed are eligible. The server re-checks every
 * row under a serializable transaction; this only keeps obviously ineligible
 * rows out of the request and tells the operator why.
 */
export function classifyResubscribeEligibility(rows: readonly Subscriber[]): {
  eligibleIds: string[];
  alreadySubscribed: number;
  ineligible: number;
  missingId: number;
} {
  const eligibleIds: string[] = [];
  let alreadySubscribed = 0;
  let ineligible = 0;
  let missingId = 0;
  for (const row of rows) {
    if (!row.id) {
      missingId += 1;
      continue;
    }
    if (row.status === "blocklisted") eligibleIds.push(row.id);
    else if (row.status === "enabled") alreadySubscribed += 1;
    else ineligible += 1;
  }
  return { eligibleIds, alreadySubscribed, ineligible, missingId };
}

export async function bulkResubscribeWithEvidence(
  ids: readonly string[],
  evidence: ConsentProvenance,
  options: DirectoryWriteOptions = {},
): Promise<DirectoryBulkResult> {
  const subscriberIds = assertBulkIds(ids);
  return parseBulkResult(
    await api.post<unknown>(
      "/api/v1/subscribers/bulk/resubscribe",
      { subscriber_ids: subscriberIds, ...evidence },
      writeOptions(options, "subscriber-directory:bulk-resubscribe"),
    ),
    "bulk resubscribe",
  );
}

export type BulkFieldValue = string | number | boolean;

/** Sets ONE custom-field key on every selected row; other keys are kept. */
export async function bulkSetCustomFieldValue(
  ids: readonly string[],
  key: string,
  value: BulkFieldValue,
  options: DirectoryWriteOptions = {},
): Promise<DirectoryBulkResult> {
  const subscriberIds = assertBulkIds(ids);
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Choose a custom field.");
  return parseBulkResult(
    await api.post<unknown>(
      "/api/v1/subscribers/bulk/set-custom-field",
      { subscriber_ids: subscriberIds, key: trimmed, value },
      writeOptions(options, "subscriber-directory:bulk-custom-field"),
    ),
    "bulk custom field",
  );
}

export const BULK_MERGE_FIELDS = [
  { key: "FNAME", label: "First name" },
  { key: "LNAME", label: "Last name" },
  { key: "COMPANY", label: "Company" },
  { key: "ADDRESS", label: "Address" },
  { key: "PHONE", label: "Phone" },
  { key: "ZIP", label: "Postal code" },
  { key: "CITY", label: "City" },
  { key: "STATE", label: "State / region" },
  { key: "COUNTRY", label: "Country" },
] as const;
export type BulkMergeFieldKey = (typeof BULK_MERGE_FIELDS)[number]["key"];

/** Sets ONE merge-field key on every selected row; other keys are kept. */
export async function bulkUpdateMergeFieldValue(
  ids: readonly string[],
  key: BulkMergeFieldKey,
  value: string,
  options: DirectoryWriteOptions = {},
): Promise<DirectoryBulkResult> {
  const subscriberIds = assertBulkIds(ids);
  if (!BULK_MERGE_FIELDS.some((field) => field.key === key))
    throw new Error("Choose a merge field.");
  return parseBulkResult(
    await api.post<unknown>(
      "/api/v1/subscribers/bulk/update-merge-field",
      { subscriber_ids: subscriberIds, key, value },
      writeOptions(options, "subscriber-directory:bulk-merge-field"),
    ),
    "bulk merge field",
  );
}

/* ------------------------------------------------------------------------ *
 * Lookalike audiences (/api/v1/subscribers/lookalike — desktop's contract)
 * ------------------------------------------------------------------------ */

export type LookalikeStatus = "pending" | "running" | "ready" | "failed";
const LOOKALIKE_STATUSES = new Set<LookalikeStatus>([
  "pending",
  "running",
  "ready",
  "failed",
]);

export interface LookalikeAudience {
  id: string;
  name: string;
  seedSegmentId: string;
  sizeRequested: number;
  memberCount: number;
  seedCount: number;
  confidenceThreshold: number | null;
  status: LookalikeStatus;
  exportedDestinationId: string | null;
  error: string;
  createdAt: string;
}

export function isTerminalLookalike(status: LookalikeStatus): boolean {
  return status === "ready" || status === "failed";
}

function parseLookalike(value: unknown): LookalikeAudience {
  const row = rec(value);
  const threshold = row?.confidence_threshold;
  const exported = row?.exported_destination_id;
  if (
    !row ||
    !isUuid(row.id) ||
    typeof row.name !== "string" ||
    !isUuid(row.seed_segment_id) ||
    !count(row.size_requested) ||
    !count(row.member_count) ||
    !count(row.seed_count) ||
    row.member_count > row.size_requested ||
    (threshold !== undefined &&
      threshold !== null &&
      (typeof threshold !== "number" || threshold < 0.5 || threshold > 1)) ||
    !LOOKALIKE_STATUSES.has(row.status as LookalikeStatus) ||
    (exported !== undefined && exported !== null && !isUuid(exported)) ||
    (row.error !== undefined && typeof row.error !== "string") ||
    !timestamp(row.created_at)
  ) {
    throw new DirectoryContractError("lookalike audience");
  }
  return {
    id: row.id,
    name: row.name,
    seedSegmentId: row.seed_segment_id,
    sizeRequested: row.size_requested,
    memberCount: row.member_count,
    seedCount: row.seed_count,
    confidenceThreshold: typeof threshold === "number" ? threshold : null,
    status: row.status as LookalikeStatus,
    exportedDestinationId: isUuid(exported) ? exported : null,
    error: typeof row.error === "string" ? row.error : "",
    createdAt: row.created_at,
  };
}

export async function listLookalikeAudiences(
  signal?: AbortSignal,
): Promise<LookalikeAudience[]> {
  const raw = rec(
    await api.get<unknown>("/api/v1/subscribers/lookalike", { signal }),
  );
  if (!raw || !Array.isArray(raw.items))
    throw new DirectoryContractError("lookalike list");
  return raw.items.map(parseLookalike);
}

export interface CreateLookalikeInput {
  name: string;
  seedSegmentId: string;
  size: number;
  /** null = no confidence floor. */
  confidenceThreshold: number | null;
}

export function lookalikeInputProblem(input: CreateLookalikeInput): string | null {
  if (!isUuid(input.seedSegmentId)) return "Choose a seed segment.";
  if (input.name.trim().length > 120)
    return "Name must be 120 characters or fewer.";
  if (!Number.isInteger(input.size) || input.size < 100 || input.size > 10_000)
    return "Audience size must be between 100 and 10,000.";
  if (
    input.confidenceThreshold !== null &&
    (!Number.isFinite(input.confidenceThreshold) ||
      input.confidenceThreshold < 0.5 ||
      input.confidenceThreshold > 1)
  )
    return "Confidence floor must be between 0.5 and 1.";
  return null;
}

/** Generates a modeled audience. The caller must have captured data-use acknowledgement. */
export async function createLookalikeAudience(
  input: CreateLookalikeInput,
  options: DirectoryWriteOptions = {},
): Promise<LookalikeAudience> {
  const problem = lookalikeInputProblem(input);
  if (problem) throw new Error(problem);
  const audience = parseLookalike(
    await api.post<unknown>(
      "/api/v1/subscribers/lookalike",
      {
        name: input.name.trim() || "Lookalike audience",
        seed_segment_id: input.seedSegmentId,
        size: input.size,
        confidence_threshold: input.confidenceThreshold,
        data_use_acknowledged: true,
      },
      { ...writeOptions(options, "subscriber-directory:lookalike"), timeoutMs: 60_000 },
    ),
  );
  if (
    audience.seedSegmentId !== input.seedSegmentId ||
    audience.sizeRequested !== input.size
  )
    throw new DirectoryContractError("lookalike audience");
  return audience;
}

export async function getLookalikeAudience(
  id: string,
  signal?: AbortSignal,
): Promise<LookalikeAudience> {
  if (!isUuid(id)) throw new Error("Invalid lookalike id.");
  const raw = rec(
    await api.get<unknown>(
      `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}`,
      { query: { per_page: 1 }, signal },
    ),
  );
  const audience = parseLookalike(raw?.audience);
  if (audience.id !== id) throw new DirectoryContractError("lookalike audience");
  return audience;
}

export const LOOKALIKE_POLL_INTERVAL_MS = 1_250;
export const LOOKALIKE_POLL_LIMIT = 96;

/** Polls until the audience reaches `ready` or `failed` (desktop's cadence). */
export async function waitForLookalikeTerminal(
  audience: LookalikeAudience,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    limit?: number;
    onProgress?: (audience: LookalikeAudience) => void;
  } = {},
): Promise<LookalikeAudience> {
  let current = audience;
  const limit = options.limit ?? LOOKALIKE_POLL_LIMIT;
  for (let attempt = 0; !isTerminalLookalike(current.status); attempt += 1) {
    if (attempt >= limit)
      throw new Error(
        "The model is still generating. Check the recent audiences list again shortly.",
      );
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs ?? LOOKALIKE_POLL_INTERVAL_MS),
    );
    if (options.signal?.aborted)
      throw new DOMException("Polling cancelled", "AbortError");
    current = await getLookalikeAudience(current.id, options.signal);
    options.onProgress?.(current);
  }
  return current;
}

export async function exportLookalikeAudience(
  id: string,
  destinationId: string,
  options: DirectoryWriteOptions = {},
): Promise<LookalikeAudience> {
  if (!isUuid(id) || !isUuid(destinationId))
    throw new Error("Choose a connected destination.");
  const audience = parseLookalike(
    await api.post<unknown>(
      `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}/export`,
      { destination_id: destinationId },
      writeOptions(options, "subscriber-directory:lookalike-export"),
    ),
  );
  if (audience.id !== id || audience.exportedDestinationId !== destinationId)
    throw new DirectoryContractError("lookalike export");
  return audience;
}

export async function deleteLookalikeAudience(
  id: string,
  options: DirectoryWriteOptions = {},
): Promise<void> {
  if (!isUuid(id)) throw new Error("Invalid lookalike id.");
  await api.delete<void>(
    `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}`,
    writeOptions(options, "subscriber-directory:lookalike-delete"),
  );
}

export interface AudienceDestination {
  id: string;
  provider: string;
  status: string;
}

export async function listAudienceDestinations(
  signal?: AbortSignal,
): Promise<AudienceDestination[]> {
  const raw = rec(
    await api.get<unknown>("/api/v1/audience-destinations", { signal }),
  );
  if (!raw || !Array.isArray(raw.items))
    throw new DirectoryContractError("audience destinations");
  return raw.items.flatMap((value) => {
    const row = rec(value);
    if (!row || !isUuid(row.id) || !nonEmpty(row.provider, 64) || !nonEmpty(row.status, 64))
      throw new DirectoryContractError("audience destinations");
    return row.status === "disconnected"
      ? []
      : [{ id: row.id, provider: row.provider, status: row.status }];
  });
}

/* ------------------------------------------------------------------------ *
 * Directory view state, shared by the toolbar, saved views and the page.
 *
 * `status` and `sort` use the web directory vocabulary (the `?status=` and
 * `?sort=` URL params the subscribers page already parses); saved views are
 * written in desktop's v3 snapshot vocabulary so a view saved on either client
 * applies on the other.
 * ------------------------------------------------------------------------ */

export type DirectoryStatusFilter =
  | "all"
  | "enabled"
  | "suppressed"
  | "disabled"
  | "pending";

export type DirectorySortKey =
  | "updated_at"
  | "created_at"
  | "email"
  | "status"
  | "engagement"
  | "rating"
  | "churn"
  | "first_name"
  | "last_name";

export interface DirectoryView {
  q: string;
  status: DirectoryStatusFilter;
  archived: boolean;
  sort: DirectorySortKey;
  order: "asc" | "desc";
}

export const DEFAULT_DIRECTORY_VIEW: DirectoryView = {
  q: "",
  status: "all",
  archived: false,
  sort: "updated_at",
  order: "desc",
};

const STATUS_TO_ENGINE: Record<DirectoryStatusFilter, SubscriberStatus | ""> = {
  all: "",
  enabled: "enabled",
  suppressed: "blocklisted",
  disabled: "disabled",
  pending: "unconfirmed",
};
const STATUS_TO_SNAPSHOT: Record<DirectoryStatusFilter, string> = {
  all: "all",
  enabled: "subscribed",
  suppressed: "unsubscribed",
  disabled: "disabled",
  pending: "unconfirmed",
};
const SORT_TO_COLUMN: Record<DirectorySortKey, string> = {
  updated_at: "updated_at",
  created_at: "joined",
  email: "email",
  status: "status",
  engagement: "engagement",
  rating: "rating",
  churn: "churn_score",
  first_name: "first_name",
  last_name: "last_name",
};

function invert<K extends string>(map: Record<K, string>): Map<string, K> {
  return new Map(
    (Object.entries(map) as [K, string][]).map(([key, value]) => [value, key]),
  );
}
const SNAPSHOT_TO_STATUS = invert(STATUS_TO_SNAPSHOT);
const ENGINE_TO_STATUS = invert(STATUS_TO_ENGINE);
const COLUMN_TO_SORT = invert(SORT_TO_COLUMN);

/* ------------------------------------------------------------------------ *
 * Column preferences (GET/PUT /api/v1/me/prefs/subscribers_view)
 * ------------------------------------------------------------------------ */

export const DIRECTORY_COLUMNS = [
  { key: "avatar", label: "Avatar" },
  { key: "email", label: "Email", required: true },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "display_name", label: "Display name" },
  { key: "status", label: "Status" },
  { key: "joined", label: "Joined" },
  { key: "engagement", label: "Engagement" },
  { key: "rating", label: "Rating" },
  { key: "churn_score", label: "Churn score" },
  { key: "archived_at", label: "Archived" },
  { key: "tags", label: "Tags" },
] as const;
export type DirectoryColumnKey = (typeof DIRECTORY_COLUMNS)[number]["key"];
export const DEFAULT_DIRECTORY_COLUMNS: DirectoryColumnKey[] = [
  "avatar",
  "email",
  "status",
  "joined",
  "engagement",
  "tags",
];
const COLUMN_KEYS = new Set<string>(DIRECTORY_COLUMNS.map((column) => column.key));

export function isDirectoryColumn(value: unknown): value is DirectoryColumnKey {
  return typeof value === "string" && COLUMN_KEYS.has(value);
}

/** Email is always visible; unknown and duplicate keys are dropped. */
export function normalizeDirectoryColumns(
  columns: readonly unknown[],
): DirectoryColumnKey[] {
  const out: DirectoryColumnKey[] = [];
  for (const column of columns) {
    if (isDirectoryColumn(column) && !out.includes(column)) out.push(column);
  }
  if (!out.includes("email")) out.unshift("email");
  return out;
}

export interface DirectoryViewPrefs {
  /** null = the user has never saved a column set. */
  columns: DirectoryColumnKey[] | null;
  widths: Record<string, number>;
  sort: string;
  order: string;
}

function parsePrefs(value: unknown): DirectoryViewPrefs {
  const row = rec(value);
  if (!row) throw new DirectoryContractError("column preference");
  const widths: Record<string, number> = {};
  const rawWidths = rec(row.widths);
  if (rawWidths) {
    for (const [key, width] of Object.entries(rawWidths)) {
      if (isDirectoryColumn(key) && count(width)) widths[key] = width;
    }
  }
  return {
    columns:
      Array.isArray(row.columns) && row.columns.length > 0
        ? normalizeDirectoryColumns(row.columns)
        : null,
    widths,
    sort: typeof row.sort === "string" ? row.sort : "",
    order: typeof row.order === "string" ? row.order : "",
  };
}

export async function getDirectoryViewPrefs(
  signal?: AbortSignal,
): Promise<DirectoryViewPrefs> {
  return parsePrefs(
    await api.get<unknown>("/api/v1/me/prefs/subscribers_view", { signal }),
  );
}

/**
 * PUT replaces the whole preference object, so the last-read widths/sort/order
 * travel with the new column set rather than being reset by it.
 */
export async function putDirectoryViewPrefs(
  previous: DirectoryViewPrefs,
  columns: readonly DirectoryColumnKey[],
  options: DirectoryWriteOptions = {},
): Promise<DirectoryViewPrefs> {
  const normalized = normalizeDirectoryColumns(columns);
  return parsePrefs(
    await api.put<unknown>(
      "/api/v1/me/prefs/subscribers_view",
      {
        columns: normalized,
        widths: previous.widths,
        sort: previous.sort,
        order: previous.order,
      },
      writeOptions(options, "subscriber-directory:view-prefs"),
    ),
  );
}

/* ------------------------------------------------------------------------ *
 * Saved directory views (/api/v1/segments/saved)
 * ------------------------------------------------------------------------ */

export type SavedViewScope = "personal" | "workspace";

export interface SavedDirectoryView {
  id: string;
  name: string;
  scope: SavedViewScope;
  isPinned: boolean;
  lastCount: number | null;
  /** null when the stored predicate is not a directory view this client can apply. */
  view: DirectoryView | null;
  /** Visible column set the view carries (v3 snapshots only). */
  columns: DirectoryColumnKey[] | null;
}

export interface SavedDirectoryViewList {
  items: SavedDirectoryView[];
  totalItems: number;
  maxItems: number;
}

const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/** Desktop's `savedSegmentSnapshot`: v3 is strict; older shapes are best-effort. */
export function directoryViewFromPredicate(predicate: unknown): {
  view: DirectoryView | null;
  columns: DirectoryColumnKey[] | null;
} {
  const root = rec(predicate);
  const snapshot = rec(root?.snapshot);
  if (snapshot && Number(snapshot.version) >= 3) {
    const sort = rec(snapshot.sort);
    const reset = rec(snapshot.reset);
    const status = SNAPSHOT_TO_STATUS.get(String(snapshot.status));
    const column = COLUMN_TO_SORT.get(String(sort?.column));
    const query = snapshot.applied_query;
    const columns = Array.isArray(snapshot.columns) ? snapshot.columns : [];
    if (
      snapshot.version !== 3 ||
      snapshot.resource_scope !== "subscriber_directory" ||
      snapshot.workspace_scope !== "current" ||
      !status ||
      typeof query !== "string" ||
      query.length > 256 ||
      query.trim() !== query ||
      CONTROL_OR_INVISIBLE.test(query) ||
      typeof snapshot.include_archived !== "boolean" ||
      !column ||
      (sort?.order !== "asc" && sort?.order !== "desc") ||
      columns.length === 0 ||
      !columns.every(isDirectoryColumn) ||
      new Set(columns).size !== columns.length ||
      !columns.includes("email") ||
      reset?.page !== 1 ||
      reset?.selection !== "clear"
    ) {
      return { view: null, columns: null };
    }
    return {
      view: {
        q: query,
        status,
        archived: snapshot.include_archived,
        sort: column,
        order: sort.order,
      },
      columns: columns as DirectoryColumnKey[],
    };
  }
  const legacy =
    snapshot ?? rec(root?.filters) ?? (root && ("status" in root || "q" in root) ? root : null);
  if (!legacy) return { view: null, columns: null };
  const rawStatus = String(legacy.status ?? "");
  const status =
    rawStatus === "" || rawStatus === "all"
      ? "all"
      : (SNAPSHOT_TO_STATUS.get(rawStatus) ?? ENGINE_TO_STATUS.get(rawStatus));
  const q = typeof legacy.q === "string" ? legacy.q.trim().slice(0, 256) : "";
  if (!status) return { view: null, columns: null };
  return {
    view: {
      ...DEFAULT_DIRECTORY_VIEW,
      q,
      status,
      archived: legacy.include_archived === true || legacy.show_archived === true,
    },
    columns: null,
  };
}

/** The predicate a directory view is stored as — desktop's v3 snapshot. */
export function directoryViewPredicate(
  view: DirectoryView,
  columns: readonly DirectoryColumnKey[],
): Record<string, unknown> {
  const q = view.q.trim();
  return {
    filters: { status: STATUS_TO_ENGINE[view.status], q },
    snapshot: {
      version: 3,
      resource_scope: "subscriber_directory",
      workspace_scope: "current",
      applied_query: q,
      status: STATUS_TO_SNAPSHOT[view.status],
      include_archived: view.archived,
      sort: { column: SORT_TO_COLUMN[view.sort], order: view.order },
      columns: normalizeDirectoryColumns(columns),
      reset: { page: 1, selection: "clear" },
    },
  };
}

function parseSavedView(value: unknown, tenantId: string): SavedDirectoryView {
  const row = rec(value);
  const lastCount = row?.last_count;
  if (
    !row ||
    row.tenant_id !== tenantId ||
    !nonEmpty(row.id, 256) ||
    !nonEmpty(row.name, 120) ||
    (row.visibility_scope !== "personal" &&
      row.visibility_scope !== "workspace") ||
    typeof row.is_pinned !== "boolean" ||
    (lastCount !== undefined && lastCount !== null && !count(lastCount))
  ) {
    throw new DirectoryContractError("saved view");
  }
  const { view, columns } = directoryViewFromPredicate(row.predicate_json);
  return {
    id: row.id,
    name: row.name,
    scope: row.visibility_scope,
    isPinned: row.is_pinned,
    lastCount: count(lastCount) ? lastCount : null,
    view,
    columns,
  };
}

export async function listSavedDirectoryViews(
  tenantId: string,
  signal?: AbortSignal,
): Promise<SavedDirectoryViewList> {
  const raw = rec(await api.get<unknown>("/api/v1/segments/saved", { signal }));
  if (
    !raw ||
    !Array.isArray(raw.items) ||
    !count(raw.total_items) ||
    !count(raw.max_items)
  )
    throw new DirectoryContractError("saved view list");
  return {
    items: raw.items.map((item) => parseSavedView(item, tenantId)),
    totalItems: raw.total_items,
    maxItems: raw.max_items,
  };
}

export async function createSavedDirectoryView(
  input: {
    name: string;
    scope: SavedViewScope;
    view: DirectoryView;
    columns: readonly DirectoryColumnKey[];
  },
  tenantId: string,
  options: DirectoryWriteOptions = {},
): Promise<SavedDirectoryView> {
  const name = input.name.trim();
  if (!name) throw new Error("Name the view.");
  if (name.length > 120) throw new Error("Names are limited to 120 characters.");
  if (CONTROL_OR_INVISIBLE.test(name))
    throw new Error("Remove invisible characters from the name.");
  return parseSavedView(
    await api.post<unknown>(
      "/api/v1/segments/saved",
      {
        name,
        visibility_scope: input.scope,
        predicate_json: directoryViewPredicate(input.view, input.columns),
      },
      writeOptions(options, "subscriber-directory:saved-view"),
    ),
    tenantId,
  );
}

/** Marks the view as just used (bumps last_run_at). Failure is non-fatal. */
export async function touchSavedDirectoryView(id: string): Promise<void> {
  await api.patch<unknown>(
    `/api/v1/segments/saved/${encodeURIComponent(id)}`,
    { touch: true },
    { maxAttempts: 1 },
  );
}

export async function deleteSavedDirectoryView(
  id: string,
  options: DirectoryWriteOptions = {},
): Promise<void> {
  await api.delete<unknown>(
    `/api/v1/segments/saved/${encodeURIComponent(id)}`,
    writeOptions(options, "subscriber-directory:saved-view-delete"),
  );
}

/* ------------------------------------------------------------------------ *
 * Inline row edits — PATCH /api/v1/subscribers/{id} under If-Match
 * ------------------------------------------------------------------------ */

export const SUBSCRIBER_TAG_LIMIT = 50;

function requireRevision(subscriber: Subscriber): {
  id: string;
  version: string;
} {
  if (
    !subscriber.id ||
    !isExactSubscriberVersion(subscriber.version, subscriber.id)
  ) {
    throw new Error("Reload this subscriber before changing it.");
  }
  return { id: subscriber.id, version: subscriber.version };
}

/** Email-rename normalisation mirroring the detail edit dialog. */
export function normalizeRenamedEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

/**
 * One PATCH under the row's exact revision. Reuses the shared subscribers
 * transport so the If-Match, ETag capture and revision checks stay in one
 * place (a 412 there drops the cached token, so a retry re-reads).
 */
function patchSubscriber(
  subscriber: Subscriber,
  body: UpdateSubscriberInput,
  prefix: string,
  options: DirectoryWriteOptions,
): Promise<Subscriber> {
  const { id, version } = requireRevision(subscriber);
  return updateSubscriber(id, body, {
    expectedVersion: version,
    idempotencyKey: options.idempotencyKey ?? directoryIdempotencyKey(prefix),
    signal: options.signal,
  });
}

export async function renameSubscriberEmail(
  subscriber: Subscriber,
  nextEmail: string,
  options: DirectoryWriteOptions = {},
): Promise<Subscriber> {
  const email = normalizeRenamedEmail(nextEmail);
  if (!email) throw new Error("Enter a valid email address.");
  const updated = await patchSubscriber(
    subscriber,
    { email },
    "subscriber-directory:rename",
    options,
  );
  if (updated.email.toLowerCase() !== email)
    throw new DirectoryContractError("subscriber rename");
  return updated;
}

/** Tags are a full-array replace on the server; callers pass the whole intended set. */
export async function setSubscriberTags(
  subscriber: Subscriber,
  tags: readonly string[],
  options: DirectoryWriteOptions = {},
): Promise<Subscriber> {
  const next = Array.from(
    new Set(tags.map((tag) => tag.trim()).filter(Boolean)),
  );
  if (next.length > SUBSCRIBER_TAG_LIMIT)
    throw new Error(`A subscriber can carry at most ${SUBSCRIBER_TAG_LIMIT} tags.`);
  if (next.some((tag) => tag.length > 100 || CONTROL_OR_INVISIBLE.test(tag)))
    throw new Error("Tags must be 100 characters or fewer, without invisible characters.");
  return patchSubscriber(
    subscriber,
    { tags: next },
    "subscriber-directory:tags",
    options,
  );
}

/** Non-positive status changes. Enabling goes through `enableSubscriberWithEvidence`. */
export async function setSubscriberInactiveStatus(
  subscriber: Subscriber,
  status: "disabled" | "unconfirmed",
  options: DirectoryWriteOptions = {},
): Promise<Subscriber> {
  const updated = await patchSubscriber(
    subscriber,
    { status },
    "subscriber-directory:status",
    options,
  );
  if (updated.status !== status)
    throw new DirectoryContractError("subscriber status");
  return updated;
}

/** Enable (Subscribed) requires the complete opt-in evidence envelope. */
export type EnableConsentSource = "double_optin" | "single_optin";

export interface EnableEvidenceDraft {
  source: string;
  channel: string;
  legalBasis: string;
  capturedAt: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policyVersion: string;
  scopeAcknowledged: boolean;
  typedEmail: string;
}

export function emptyEnableEvidenceDraft(
  jurisdiction?: string | null,
): EnableEvidenceDraft {
  return {
    source: "",
    channel: "web",
    legalBasis: "consent",
    capturedAt: "",
    jurisdiction: (jurisdiction ?? "").trim().toUpperCase(),
    evidence: "",
    reason: "",
    policyVersion: "",
    scopeAcknowledged: false,
    typedEmail: "",
  };
}

const JURISDICTION_CODE = /^[A-Z][A-Z0-9-]{1,31}$/;

/** Desktop's validateSubscriberStatusConsentDraft, first failure only. */
export function enableEvidenceProblem(
  draft: EnableEvidenceDraft,
  canonicalEmail: string,
  now = Date.now(),
): string | null {
  if (draft.source !== "double_optin" && draft.source !== "single_optin")
    return "Choose the reviewed opt-in record that proves this grant.";
  if (!CONSENT_CHANNELS.some((option) => option.value === draft.channel))
    return "Choose where the subscriber's decision was captured.";
  if (!CONSENT_LEGAL_BASES.some((option) => option.value === draft.legalBasis))
    return "Choose the legal basis confirmed during review.";
  const captured = Date.parse(draft.capturedAt);
  if (!draft.capturedAt || !Number.isFinite(captured))
    return "Enter when this consent was actually captured.";
  if (captured > now + 5 * 60_000)
    return "The captured time cannot be in the future.";
  if (!JURISDICTION_CODE.test(draft.jurisdiction.trim().toUpperCase()))
    return "Use a 2–32 character jurisdiction code such as GB, EU, or US-CA.";
  const evidence = draft.evidence.trim();
  if (!evidence || evidence.length > 2_048)
    return "Enter a durable receipt, record, or approved evidence reference (2,048 characters or fewer).";
  const reason = draft.reason.trim();
  if (!reason || reason.length > 500)
    return "Explain why the reviewed record proves this email grant (500 characters or fewer).";
  const policy = draft.policyVersion.trim();
  if (!policy || policy.length > 100)
    return "Enter the policy version in force at capture time (100 characters or fewer).";
  if (!draft.scopeAcknowledged)
    return "Confirm that the reviewed proof applies to this exact address and email marketing only.";
  if (draft.typedEmail !== canonicalEmail)
    return `Type ${canonicalEmail} exactly to confirm the address.`;
  return null;
}

export async function enableSubscriberWithEvidence(
  subscriber: Subscriber,
  draft: EnableEvidenceDraft,
  options: DirectoryWriteOptions = {},
): Promise<Subscriber> {
  const problem = enableEvidenceProblem(draft, subscriber.email);
  if (problem) throw new Error(problem);
  const consentTimestamp = new Date(draft.capturedAt).toISOString();
  const source = draft.source as EnableConsentSource;
  const updated = await patchSubscriber(
    subscriber,
    {
      status: "enabled",
      consent_source: source,
      consent_timestamp: consentTimestamp,
      consent_channel: draft.channel,
      consent_legal_basis: draft.legalBasis,
      consent_jurisdiction: draft.jurisdiction.trim().toUpperCase(),
      consent_evidence: draft.evidence.trim(),
      consent_reason: draft.reason.trim(),
      consent_policy_version: draft.policyVersion.trim(),
    },
    "subscriber-directory:enable",
    options,
  );
  if (updated.status !== "enabled" || updated.consent_source !== source)
    throw new DirectoryContractError("subscriber enable");
  return updated;
}

/* ------------------------------------------------------------------------ *
 * Add one subscriber (POST /api/v1/subscribers) with a typo check first
 * ------------------------------------------------------------------------ */

const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "hotmal.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "hotmali.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yhaoo.com": "yahoo.com",
  "outlok.com": "outlook.com",
  "outloook.com": "outlook.com",
  "outlook.co": "outlook.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
};
const KNOWN_COM_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "yahoo.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "msn.com",
  "protonmail.com",
]);
const TLD_TYPOS: Record<string, string> = {
  con: "com",
  cmo: "com",
  ocm: "com",
  vom: "com",
  comm: "com",
};

/**
 * A corrected address for an unambiguous domain/TLD typo, or null. The server
 * validator has no suggestion field, so this is client-side assistance only
 * and is never applied without the operator choosing it.
 */
export function suggestEmailFix(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase().replace(/\.$/, "");
  const direct = DOMAIN_TYPOS[domain];
  if (direct) return `${local}@${direct}`;
  const lastDot = domain.lastIndexOf(".");
  if (lastDot > 0) {
    const fixed = TLD_TYPOS[domain.slice(lastDot + 1)];
    if (fixed) {
      const candidate = `${domain.slice(0, lastDot)}.${fixed}`;
      if (KNOWN_COM_DOMAINS.has(candidate)) return `${local}@${candidate}`;
    }
  }
  if (trimmed.endsWith(".") && KNOWN_COM_DOMAINS.has(domain))
    return `${local}@${domain}`;
  return null;
}

export interface AddSubscriberInput {
  email: string;
  tags: readonly string[];
  /** Initial eligibility. `enabled` requires the evidence envelope. */
  status: "unconfirmed" | "enabled";
  evidence: EnableEvidenceDraft | null;
}

export async function createSubscriberWithEvidence(
  input: AddSubscriberInput,
  options: DirectoryWriteOptions = {},
): Promise<Subscriber> {
  const email = normalizeRenamedEmail(input.email);
  if (!email) throw new Error("Enter a valid email address.");
  const tags = Array.from(
    new Set(input.tags.map((tag) => tag.trim()).filter(Boolean)),
  );
  const body: Record<string, unknown> = { email, tags, status: input.status };
  if (input.status === "enabled") {
    const draft = input.evidence;
    if (!draft) throw new Error("Enabling a new subscriber requires consent evidence.");
    const problem = enableEvidenceProblem(draft, email);
    if (problem) throw new Error(problem);
    const country = draft.jurisdiction.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country))
      throw new Error("Use the subscriber's two-letter country code as the jurisdiction.");
    Object.assign(body, {
      consent_source: draft.source,
      consent_timestamp: new Date(draft.capturedAt).toISOString(),
      consent_channel: draft.channel,
      consent_legal_basis: draft.legalBasis,
      consent_evidence: draft.evidence.trim(),
      consent_reason: draft.reason.trim(),
      consent_policy_version: draft.policyVersion.trim(),
      country,
    });
  }
  const created = await api.post<Subscriber>(
    "/api/v1/subscribers",
    body,
    writeOptions(options, "subscriber-directory:create"),
  );
  if (!created || !created.id || created.email.toLowerCase() !== email)
    throw new DirectoryContractError("subscriber create");
  return created;
}

/* ------------------------------------------------------------------------ *
 * Engagement-score browser
 * ------------------------------------------------------------------------ */

export interface ScoredSubscriber {
  id: string;
  email: string;
  score: number;
}

export interface ScoredSubscriberPage {
  items: ScoredSubscriber[];
  page: number;
  perPage: number;
  total: number;
}

export async function listScoredSubscribers(
  params: { min: number | null; max: number | null; page: number; perPage: number },
  signal?: AbortSignal,
): Promise<ScoredSubscriberPage> {
  if (
    (params.min !== null && !Number.isInteger(params.min)) ||
    (params.max !== null && !Number.isInteger(params.max)) ||
    (params.min !== null && params.max !== null && params.min > params.max)
  )
    throw new Error("Enter whole-number score bounds with min ≤ max.");
  const raw = rec(
    await api.get<unknown>("/api/v1/engagement-scores/subscribers", {
      query: {
        min: params.min ?? undefined,
        max: params.max ?? undefined,
        page: params.page,
        per_page: params.perPage,
      },
      signal,
    }),
  );
  if (
    !raw ||
    !Array.isArray(raw.items) ||
    !count(raw.page) ||
    !count(raw.per_page) ||
    !count(raw.total)
  )
    throw new DirectoryContractError("scored subscriber");
  return {
    items: raw.items.map((value) => {
      const row = rec(value);
      if (
        !row ||
        !nonEmpty(row.id, 256) ||
        typeof row.email !== "string" ||
        typeof row.score !== "number" ||
        !Number.isFinite(row.score)
      )
        throw new DirectoryContractError("scored subscriber");
      return { id: row.id, email: row.email, score: row.score };
    }),
    page: raw.page,
    perPage: raw.per_page,
    total: raw.total,
  };
}

/* ------------------------------------------------------------------------ *
 * Insights strip
 * ------------------------------------------------------------------------ */

export interface DirectoryInsights {
  workspaceTotal: number;
  added30d: number | null;
  unsubscribed30d: number | null;
}

export async function getDirectoryInsights(
  signal?: AbortSignal,
): Promise<DirectoryInsights> {
  const [totals, stats] = await Promise.all([
    api.get<unknown>("/api/v1/subscribers", {
      query: { page: 1, per_page: 1 },
      signal,
    }),
    api
      .get<unknown>("/api/v1/dashboard/stats", {
        query: { range: "30d", compare: "false", sparklines: "false" },
        signal,
      })
      .catch(() => null),
  ]);
  const page = rec(totals);
  if (!page || !count(page.total))
    throw new DirectoryContractError("subscriber total");
  const dashboard = rec(stats);
  return {
    workspaceTotal: page.total,
    added30d: count(dashboard?.subscribers_added_30d)
      ? dashboard.subscribers_added_30d
      : null,
    unsubscribed30d: count(dashboard?.subscribers_unsubbed_30d)
      ? dashboard.subscribers_unsubbed_30d
      : null,
  };
}

/** Total matching a directory view (one-row request; the list's own total). */
export async function getDirectoryViewTotal(
  view: DirectoryView,
  signal?: AbortSignal,
): Promise<number> {
  const engine = STATUS_TO_ENGINE[view.status];
  const q = view.q.trim();
  const raw = rec(
    q
      ? await api.get<unknown>("/api/v1/subscribers/search", {
          query: {
            q: engine ? `${q} status:${engine}` : q,
            page: 1,
            per_page: 1,
            include_archived: view.archived ? "true" : undefined,
          },
          signal,
        })
      : await api.get<unknown>("/api/v1/subscribers", {
          query: {
            page: 1,
            per_page: 1,
            status: engine || undefined,
            include_archived: view.archived ? "true" : undefined,
          },
          signal,
        }),
  );
  if (!raw || !count(raw.total))
    throw new DirectoryContractError("subscriber total");
  return raw.total;
}

/* ------------------------------------------------------------------------ *
 * Live directory additions (GET /api/v1/events?topics=subscriber.added)
 * ------------------------------------------------------------------------ */

/** Create, bulk-paste and batch upsert all publish `subscriber.added`. */
export const SUBSCRIBER_ADDED_TOPIC = "subscriber.added";

export function watchSubscriberAdditions(
  onAdded: (subscriberId: string | null) => void,
  onStatus?: (status: RealtimeStatus) => void,
): () => void {
  return connectRealtimeBus(
    (event) => {
      if (event.topic !== SUBSCRIBER_ADDED_TOPIC) return;
      const id = event.payload?.id ?? event.subscriber_id;
      onAdded(typeof id === "string" && id ? id : null);
    },
    onStatus,
    // A replayed `added` after a reconnect would double-count the banner.
    { topics: [SUBSCRIBER_ADDED_TOPIC], recover: false },
  );
}

export type { Subscriber, SubscriberStatus };
export { isExactSubscriberVersion };
