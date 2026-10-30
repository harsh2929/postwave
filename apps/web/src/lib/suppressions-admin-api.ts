// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for workspace email-suppression management. Backend:
// apps/api/internal/suppressions (StoreHandlers List/Add/Remove on
// /api/v1/deliverability/suppressions; CSV import on
// /api/v1/suppressions/import). Add/remove are ScopeAdmin on the API; the
// web UI gates the controls behind owner/admin from whoami.

import { ApiError, api, fetchTextAuthed } from "@/lib/api";

// GOV-031: per-channel + per-scope suppression dimension.
export type SuppressionChannel = "email" | "sms" | "push" | "any";
export type SuppressionScope = "marketing" | "transactional" | "all";

export interface SuppressionEntry {
  id: string;
  email: string;
  reason?: string;
  source?: string;
  channel?: SuppressionChannel;
  scope?: SuppressionScope;
  created_at: string;
  expires_at?: string | null;
  /** Durable provider classification captured at ingest (SUB-048). */
  bounce_category?: string;
  match_kind?: string;
  source_event_id?: string;
  campaign_id?: string;
}

/**
 * Row + recent audit trail served by GET /api/v1/suppressions/{id}/timeline.
 * The audit slice is the same shape the paged audit route returns, keyed by
 * email so it survives removal of the row.
 */
export interface SuppressionTimeline {
  suppression: SuppressionEntry;
  audit: SuppressionAuditEvent[];
}

export interface SuppressionAuditEvent {
  id?: string;
  action: string;
  reason?: string;
  email?: string;
  actor?: string;
  actor_type?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SuppressionTrendPoint {
  date: string;
  count: number;
  by_reason?: Record<string, number>;
}

export interface SuppressionList {
  items: SuppressionEntry[];
  total: number;
  page: number;
  size: number;
}

export interface AddSuppressionInput {
  email: string;
  reason?: string;
  source?: string;
  channel?: SuppressionChannel;
  scope?: SuppressionScope;
  expires_at?: string | null;
}

export type SuppressionReason =
  | "list_manual"
  | "manual_unsubscribe"
  | "hard_bounce"
  | "spam_complaint"
  | "global_unsubscribe"
  | "soft_bounce_threshold"
  | "dsar_deletion"
  | "role_address"
  | "invalid_email"
  | "blocklist_auto"
  | "soft_bounce"
  | "complaint"
  | "list_unsub_header"
  | "spamtrap"
  | "role_account"
  | "dns_failure"
  | "invalid_address";

/**
 * Canonical reasons this operator reclassification path may write. DSAR
 * deletion is intentionally absent: only the erasure workflow may create or
 * rescind that compliance evidence.
 */
export const SUPPRESSION_RECLASSIFICATION_REASONS = [
  "manual_unsubscribe",
  "list_manual",
  "hard_bounce",
  "spam_complaint",
  "global_unsubscribe",
  "soft_bounce_threshold",
  "role_address",
  "invalid_email",
  "blocklist_auto",
  "soft_bounce",
  "complaint",
  "list_unsub_header",
  "spamtrap",
  "role_account",
  "dns_failure",
  "invalid_address",
] as const satisfies readonly SuppressionReason[];
const SUPPRESSION_RECLASSIFICATION_REASON_SET: ReadonlySet<SuppressionReason> =
  new Set(SUPPRESSION_RECLASSIFICATION_REASONS);

/** Every provider currently backed by a real server-side pull client. */
export const SUPPRESSION_MIRROR_PROVIDERS = [
  "ses",
  "mailgun",
  "postmark",
  "mailchimp",
  "sendgrid",
] as const;

export type SuppressionMirrorProvider =
  (typeof SUPPRESSION_MIRROR_PROVIDERS)[number];

export const MAX_SELECTED_SUPPRESSION_REASON_CHANGES = 500;
const MAX_MIRROR_ROWS = 5_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_RE = UUID_RE;

export interface SuppressionWriteOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface SelectedSuppressionTarget {
  id: string;
  email: string;
  reason?: string;
}

export interface SuppressionReasonMutationResult {
  requested: number;
  updated: number;
  failed: number;
  missing: number;
  /** Bounded server evidence. UI callers should prefer aggregate counts. */
  errors: string[];
}

export interface SuppressionMirrorResult {
  provider: SuppressionMirrorProvider;
  fetched: number;
  imported: number;
  skipped: number;
  errors: number;
  window_from?: string;
  window_to?: string;
  not_configured: boolean;
  not_configured_reason?: string;
}

export class SuppressionAdminContractError extends Error {
  readonly code = "suppression_admin_contract_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SuppressionAdminContractError";
  }
}

export interface ImportResult {
  inserted: number;
  existing: number;
  skipped: number;
  errors: number;
  bad_rows?: string[];
  bytes_read: number;
}

/**
 * Minimum length before a prefix search round-trips to the server. Shorter
 * prefixes would scan-storm the citext index and match half the table; the
 * caller filters the loaded page client-side instead (desktop parity).
 */
export const SUPPRESSION_SERVER_SEARCH_MIN_PREFIX = 3;

export type SuppressionSearchMode = "none" | "client" | "prefix" | "exact";

export interface ClassifiedSuppressionSearch {
  mode: SuppressionSearchMode;
  /** Trimmed, lower-cased value to send (or filter with). */
  value: string;
}

/**
 * Decides how a raw search-box value reaches
 * GET /api/v1/deliverability/suppressions, mirroring the desktop client:
 *   - "exact"  — a full address → `email=` (case-insensitive citext match)
 *   - "prefix" — ≥3 chars → `q=` (case-insensitive email prefix)
 *   - "client" — 1–2 chars: too short for the server; filter the loaded page
 *   - "none"   — empty
 */
export function classifySuppressionSearch(
  raw: string,
): ClassifiedSuppressionSearch {
  const value = raw.trim().toLowerCase();
  if (!value) return { mode: "none", value: "" };
  if (EMAIL_RE.test(value)) return { mode: "exact", value };
  if (value.length >= SUPPRESSION_SERVER_SEARCH_MIN_PREFIX) {
    return { mode: "prefix", value };
  }
  return { mode: "client", value };
}

/** The `email`/`q` half of a list request for a raw search value. */
export function suppressionSearchQuery(
  raw: string,
): Pick<ListSuppressionsOptions, "email" | "q"> {
  const classified = classifySuppressionSearch(raw);
  if (classified.mode === "exact") return { email: classified.value };
  if (classified.mode === "prefix") return { q: classified.value };
  return {};
}

export interface ListSuppressionsOptions {
  /** Case-insensitive email prefix filter. */
  q?: string;
  /** Exact (case-insensitive) address match; wins over `q` when both set. */
  email?: string;
  page?: number;
  size?: number;
}

export function listSuppressions(
  opts?: ListSuppressionsOptions,
): Promise<SuppressionList> {
  const params = new URLSearchParams();
  if (opts?.email && opts.email.trim()) {
    params.set("email", opts.email.trim().toLowerCase());
  } else if (opts?.q && opts.q.trim()) {
    params.set("q", opts.q.trim());
  }
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.size) params.set("size", String(opts.size));
  const qs = params.toString();
  return api
    .get<
      Partial<SuppressionList>
    >(`/api/v1/deliverability/suppressions${qs ? `?${qs}` : ""}`)
    .then((r) => ({
      items: r.items ?? [],
      total: r.total ?? 0,
      page: r.page ?? 0,
      size: r.size ?? 0,
    }));
}

export function addSuppression(
  input: AddSuppressionInput,
): Promise<SuppressionEntry> {
  return api.post<SuppressionEntry>(
    "/api/v1/deliverability/suppressions",
    normalizeAddInput(input),
  );
}

export function removeSuppression(email: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(
    `/api/v1/deliverability/suppressions/${encodeURIComponent(email.trim().toLowerCase())}`,
  );
}

export interface BulkImportResult {
  /** Newly-written rows. */
  imported: number;
  /** Rows that already existed (ON CONFLICT DO NOTHING). */
  skipped: number;
  /** Rows the server could not write. */
  errors: number;
}

/**
 * Bulk-imports a list of addresses in ONE request via
 * POST /api/v1/suppressions/bulk-import (accepts up to 50,000 rows) instead of
 * N per-row POSTs (GOV-002). The endpoint is idempotent (skips existing rows)
 * and returns aggregate counts. Server-side per-address failures aren't
 * itemized by the endpoint — the caller lists the client-rejected invalid
 * addresses (which it already knows from parseEmailList) so the operator sees
 * exactly what to fix (GOV-010).
 */
export function bulkImportSuppressions(
  emails: string[],
  reason?: SuppressionReason,
): Promise<BulkImportResult> {
  return api
    .post<
      Partial<Omit<BulkImportResult, "errors">> & { errors?: string[] | number }
    >("/api/v1/suppressions/bulk-import", {
      emails,
      ...(reason ? { reason } : {}),
    })
    .then((r) => ({
      imported: r.imported ?? 0,
      skipped: r.skipped ?? 0,
      errors: Array.isArray(r.errors) ? r.errors.length : (r.errors ?? 0),
    }));
}

export interface BulkDeleteResult {
  deleted_count: number;
  errors: string[];
  /** Rows the reversibility gate refused (e.g. hard bounce / complaint). */
  blocked: string[];
}

/**
 * Removes many suppressions in one request via
 * POST /api/v1/suppressions/bulk-delete, addressing rows by email (GOV-029).
 * Rows whose reason is not reversible are reported under `blocked`, matching
 * the single-row DELETE's per-reason gate.
 */
export function bulkDeleteSuppressions(
  emails: string[],
): Promise<BulkDeleteResult> {
  const normalized = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  return api
    .post<Partial<BulkDeleteResult>>("/api/v1/suppressions/bulk-delete", {
      emails: normalized,
    })
    .then((r) => ({
      deleted_count: r.deleted_count ?? 0,
      errors: r.errors ?? [],
      blocked: r.blocked ?? [],
    }));
}

/**
 * Freezes and validates an explicit canonical-row selection before a sensitive
 * reclassification. IDs are the mutation selector; emails are retained only
 * as local review evidence and are never placed in a URL or persisted.
 */
export function selectedSuppressionTargets(
  entries: readonly Pick<SuppressionEntry, "id" | "email" | "reason">[],
): SelectedSuppressionTarget[] {
  if (
    entries.length === 0 ||
    entries.length > MAX_SELECTED_SUPPRESSION_REASON_CHANGES
  ) {
    throw new SuppressionAdminContractError(
      `Select between 1 and ${MAX_SELECTED_SUPPRESSION_REASON_CHANGES} canonical suppression rows.`,
    );
  }
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  return entries.map((entry, index) => {
    if (typeof entry.id !== "string" || typeof entry.email !== "string") {
      throw new SuppressionAdminContractError(
        `Selected suppression row ${index + 1} has a malformed identity.`,
      );
    }
    const id = entry.id.trim().toLowerCase();
    const email = entry.email.trim().toLowerCase();
    if (!UUID_RE.test(id)) {
      throw new SuppressionAdminContractError(
        `Selected suppression row ${index + 1} has an invalid canonical ID.`,
      );
    }
    if (email.length > 320 || !EMAIL_RE.test(email)) {
      throw new SuppressionAdminContractError(
        `Selected suppression row ${index + 1} has an invalid email identity.`,
      );
    }
    if (seenIds.has(id) || seenEmails.has(email)) {
      throw new SuppressionAdminContractError(
        "The selected suppression scope contains a duplicate identity.",
      );
    }
    seenIds.add(id);
    seenEmails.add(email);
    if (entry.reason !== undefined && typeof entry.reason !== "string") {
      throw new SuppressionAdminContractError(
        `Selected suppression row ${index + 1} has an invalid reason.`,
      );
    }
    const reason = entry.reason?.trim();
    if (reason && reason.length > 64) {
      throw new SuppressionAdminContractError(
        `Selected suppression row ${index + 1} has an invalid reason.`,
      );
    }
    if (reason === "dsar_deletion") {
      throw new SuppressionAdminContractError(
        "DSAR deletion suppressions are permanent and cannot be reclassified here.",
      );
    }
    return { id, email, ...(reason ? { reason } : {}) };
  });
}

/**
 * Reclassifies only the supplied canonical row IDs. The server resolves every
 * ID under the authenticated tenant and writes each prior/new reason pair to
 * the suppression audit trail. The current backend exposes no row ETag, so the
 * caller must present the frozen review scope immediately before submitting.
 */
export async function changeSelectedSuppressionReason(
  entries: readonly Pick<SuppressionEntry, "id" | "email" | "reason">[],
  reason: SuppressionReason,
  options: SuppressionWriteOptions,
): Promise<SuppressionReasonMutationResult> {
  const targets = selectedSuppressionTargets(entries);
  if (!SUPPRESSION_RECLASSIFICATION_REASON_SET.has(reason)) {
    throw new SuppressionAdminContractError(
      "Choose a canonical suppression reason.",
    );
  }
  assertSuppressionWriteOptions(options);
  const raw = await api.post<unknown>(
    "/api/v1/suppressions/bulk-action",
    {
      ids: targets.map((target) => target.id),
      action: "change_reason",
      reason,
    },
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: options.idempotencyKey,
      timeoutMs: 65_000,
    },
  );
  return parseSuppressionReasonMutation(raw, targets.length);
}

/**
 * Pulls the provider's bounded seven-day suppression window. A provider with
 * no configured credential is an expected setup state and is returned on the
 * data channel; malformed 503 bodies and genuine provider failures still
 * throw.
 */
export async function mirrorSuppressionsFromProvider(
  provider: SuppressionMirrorProvider,
  options: SuppressionWriteOptions,
): Promise<SuppressionMirrorResult> {
  if (!SUPPRESSION_MIRROR_PROVIDERS.includes(provider)) {
    throw new SuppressionAdminContractError(
      "Choose a supported suppression provider.",
    );
  }
  assertSuppressionWriteOptions(options);
  try {
    const raw = await api.post<unknown>(
      `/api/v1/suppressions/mirror/${encodeURIComponent(provider)}`,
      {},
      {
        signal: options.signal,
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: options.idempotencyKey,
        timeoutMs: 65_000,
      },
    );
    return parseSuppressionMirrorResult(raw, provider, false);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 503 &&
      hasNotConfiguredFlag(error.body)
    ) {
      const notConfigured = parseSuppressionMirrorResult(
        error.body,
        provider,
        true,
      );
      if (notConfigured.not_configured) return notConfigured;
    }
    throw error;
  }
}

/**
 * Sets or clears the expiry on a suppression row (GOV-030) via
 * PATCH /api/v1/suppressions/{id}. Pass `null` to make the hold permanent.
 * Send the field explicitly (the endpoint rejects an omitted expires_at) so
 * intent is unambiguous.
 */
export function patchSuppressionExpiry(
  id: string,
  expiresAt: string | null,
): Promise<SuppressionEntry> {
  return api.patch<SuppressionEntry>(
    `/api/v1/suppressions/${encodeURIComponent(id)}`,
    { expires_at: expiresAt },
  );
}

/**
 * Reads an address's suppression audit trail (GOV-032) via
 * GET /api/v1/suppressions/{id}/audit. `{id}` accepts a row uuid or the email
 * directly; audit rows are keyed by email so the trail survives removal.
 */
export function listSuppressionAudit(
  idOrEmail: string,
): Promise<SuppressionAuditEvent[]> {
  return api
    .get<{
      items?: SuppressionAuditEvent[];
    }>(`/api/v1/suppressions/${encodeURIComponent(idOrEmail)}/audit`)
    .then((response) => normalizeSuppressionAudit(response));
}

export function normalizeSuppressionAudit(response: {
  items?: unknown;
}): SuppressionAuditEvent[] {
  if (!Array.isArray(response.items)) {
    throw new Error("Suppression history response was malformed.");
  }
  return response.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Suppression history row ${index + 1} was malformed.`);
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.action !== "string" ||
      row.action.trim() === "" ||
      typeof row.created_at !== "string" ||
      row.created_at.trim() === ""
    ) {
      throw new Error(`Suppression history row ${index + 1} was malformed.`);
    }
    const optionalString = (key: string): string | undefined => {
      const value = row[key];
      return typeof value === "string" && value.trim() ? value : undefined;
    };
    const id = optionalString("id");
    const reason = optionalString("reason");
    const email = optionalString("email");
    const actor = optionalString("actor");
    const actorType = optionalString("actor_type");
    const source = optionalString("source");
    return {
      action: row.action,
      created_at: row.created_at,
      ...(id ? { id } : {}),
      ...(reason ? { reason } : {}),
      ...(email ? { email } : {}),
      ...(actor ? { actor } : {}),
      ...(actorType ? { actor_type: actorType } : {}),
      ...(source ? { source } : {}),
      ...(row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? { metadata: row.metadata as Record<string, unknown> }
        : {}),
    };
  });
}

/**
 * Daily suppression-growth points over the trailing `days` window (GOV-053)
 * via GET /api/v1/suppressions/trend. Oldest first, zero-filled by the server.
 */
export function getSuppressionTrend(
  days = 30,
): Promise<SuppressionTrendPoint[]> {
  return api
    .get<{
      points?: SuppressionTrendPoint[];
    }>(`/api/v1/suppressions/trend?days=${encodeURIComponent(String(days))}`)
    .then((r) => r.points ?? []);
}

/**
 * Upload ceiling for POST /api/v1/suppressions/import. Matches
 * apps/api/internal/suppressions/import_export.go MaxImportBytes (25 MiB);
 * the server answers 413 above it, so the client refuses first.
 */
export const MAX_SUPPRESSION_IMPORT_BYTES = 25 * 1024 * 1024;

/**
 * Client-side gate for a CSV pick. Returns the sentence to show, or null when
 * the file may be uploaded.
 */
export function suppressionImportFileError(
  file: Pick<File, "name" | "size" | "type">,
): string | null {
  if (file.size === 0) return "Choose a non-empty CSV file.";
  if (file.size > MAX_SUPPRESSION_IMPORT_BYTES) {
    return `File is ${formatSuppressionImportBytes(file.size)} — the limit is 25 MiB. Split the CSV and import in batches.`;
  }
  if (
    !/\.csv$/iu.test(file.name) &&
    !/^text\/csv|application\/vnd\.ms-excel/iu.test(file.type)
  ) {
    return "Choose a .csv file.";
  }
  return null;
}

export function formatSuppressionImportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Multipart CSV import via POST /api/v1/suppressions/import. The Go handler
 * spools a `file` part (email column, optional reason column, header
 * auto-detected) and reads an optional `default_reason` field applied to rows
 * without their own reason. Sent as raw FormData so the browser sets the
 * multipart boundary; never retried (a re-sent upload is a second import).
 */
export function importSuppressionsCsv(
  file: File,
  defaultReason?: SuppressionReason,
): Promise<ImportResult> {
  const fileError = suppressionImportFileError(file);
  if (fileError) return Promise.reject(new Error(fileError));
  const form = new FormData();
  form.append("file", file, file.name);
  if (defaultReason) form.append("default_reason", defaultReason);
  return api
    .postRaw<unknown>("/api/v1/suppressions/import", form, {
      timeoutMs: 5 * 60 * 1000,
      maxAttempts: 1,
      requireOnline: true,
    })
    .then(normalizeImportResult);
}

export function normalizeImportResult(raw: unknown): ImportResult {
  const row = suppressionRecord(raw, "Suppression import response");
  const count = (key: string): number =>
    Number.isInteger(row[key]) && (row[key] as number) >= 0
      ? (row[key] as number)
      : 0;
  const badRows = Array.isArray(row.bad_rows)
    ? row.bad_rows.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];
  return {
    inserted: count("inserted"),
    existing: count("existing"),
    skipped: count("skipped"),
    errors: count("errors"),
    ...(badRows.length > 0 ? { bad_rows: badRows } : {}),
    bytes_read: count("bytes_read"),
  };
}

/**
 * Row detail + recent audit trail via GET /api/v1/suppressions/{id}/timeline
 * (`{id}` is the canonical row uuid). The server returns the row under
 * `suppression` and up to 50 newest-first audit entries under `audit`; an
 * audit-store miss yields an empty array, never a 500.
 */
export function getSuppressionTimeline(
  id: string,
): Promise<SuppressionTimeline> {
  return api
    .get<unknown>(`/api/v1/suppressions/${encodeURIComponent(id)}/timeline`)
    .then(normalizeSuppressionTimeline);
}

export function normalizeSuppressionTimeline(
  raw: unknown,
): SuppressionTimeline {
  const row = suppressionRecord(raw, "Suppression timeline response");
  const suppression = suppressionRecord(
    row.suppression,
    "Suppression timeline row",
  );
  const requiredString = (key: string): string => {
    const value = suppression[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new SuppressionAdminContractError(
        "Suppression timeline row was malformed.",
      );
    }
    return value;
  };
  const optionalString = (key: string): string | undefined => {
    const value = suppression[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const entry: SuppressionEntry = {
    id: requiredString("id"),
    email: requiredString("email"),
    created_at: requiredString("created_at"),
  };
  const reason = optionalString("reason");
  const source = optionalString("source");
  const channel = optionalString("channel");
  const scope = optionalString("scope");
  const expiresAt = optionalString("expires_at");
  const bounceCategory = optionalString("bounce_category");
  const matchKind = optionalString("match_kind");
  const sourceEventId = optionalString("source_event_id");
  const campaignId = optionalString("campaign_id");
  if (reason) entry.reason = reason;
  if (source) entry.source = source;
  if (channel) entry.channel = channel as SuppressionChannel;
  if (scope) entry.scope = scope as SuppressionScope;
  entry.expires_at = expiresAt ?? null;
  if (bounceCategory) entry.bounce_category = bounceCategory;
  if (matchKind) entry.match_kind = matchKind;
  if (sourceEventId) entry.source_event_id = sourceEventId;
  if (campaignId) entry.campaign_id = campaignId;

  // Timeline audit rows carry `source_table` where the paged audit route
  // exposes `source`; fold it in so one normaliser covers both.
  const auditItems = Array.isArray(row.audit) ? row.audit : [];
  const items = auditItems.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (
      record.source === undefined &&
      typeof record.source_table === "string"
    ) {
      return { ...record, source: record.source_table };
    }
    return record;
  });
  return { suppression: entry, audit: normalizeSuppressionAudit({ items }) };
}

/** Client-side KPI counts for the suppression stat strip (desktop parity). */
export interface SuppressionStatCounts {
  /** Rows counted (the loaded sample, not the server total). */
  loaded: number;
  hardBounce: number;
  softBounce: number;
  spamTrap: number;
  complaint: number;
  unsubscribe: number;
  manual: number;
  other: number;
  /** Rows whose created_at falls within the trailing seven days of `now`. */
  added7d: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Buckets loaded rows by canonical reason. `spamtrap` is the canonical value;
 * `spam_trap` is the X1 enum alias, so both count as a trap rather than
 * silently binning into "other".
 */
export function suppressionStatCounts(
  rows: readonly Pick<SuppressionEntry, "reason" | "created_at">[],
  now: number = Date.now(),
): SuppressionStatCounts {
  const counts: SuppressionStatCounts = {
    loaded: rows.length,
    hardBounce: 0,
    softBounce: 0,
    spamTrap: 0,
    complaint: 0,
    unsubscribe: 0,
    manual: 0,
    other: 0,
    added7d: 0,
  };
  const cutoff = now - SEVEN_DAYS_MS;
  for (const row of rows) {
    const reason = (row.reason ?? "").trim().toLowerCase();
    switch (reason) {
      case "hard_bounce":
        counts.hardBounce += 1;
        break;
      case "soft_bounce":
      case "soft_bounce_threshold":
        counts.softBounce += 1;
        break;
      case "spamtrap":
      case "spam_trap":
        counts.spamTrap += 1;
        break;
      case "complaint":
      case "spam_complaint":
        counts.complaint += 1;
        break;
      case "unsubscribe":
      case "manual_unsubscribe":
      case "global_unsubscribe":
      case "list_unsub_header":
        counts.unsubscribe += 1;
        break;
      case "manual":
      case "list_manual":
      case "imported":
        counts.manual += 1;
        break;
      default:
        counts.other += 1;
    }
    const addedAt = Date.parse(row.created_at);
    if (!Number.isNaN(addedAt) && addedAt >= cutoff && addedAt <= now) {
      counts.added7d += 1;
    }
  }
  return counts;
}

/** Server-streamed CSV filename base for a suppression export. */
export function suppressionExportFilename(reason?: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const scope = reason && reason.trim() ? `-${reason.trim()}` : "";
  return `postwave-suppressions${scope}-${stamp}.csv`;
}

/**
 * Fetches the suppression list as CSV (GOV-028) via the authed streaming
 * export endpoint, honoring an optional reason filter. Returns the CSV text so
 * the caller can trigger a browser download with a stable filename. Uses
 * fetchTextAuthed so the tenant header/cookies attach (a bare anchor can't).
 */
export function exportSuppressionsCsv(reason?: string): Promise<string> {
  const params = new URLSearchParams();
  if (reason && reason.trim()) params.set("reason", reason.trim());
  const qs = params.toString();
  return fetchTextAuthed(`/api/v1/suppressions/export${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Trims + lower-cases the email and drops empty optional fields. Throws for
 * an empty email (the API would 400). */
export function normalizeAddInput(
  input: AddSuppressionInput,
): AddSuppressionInput {
  const email = (input.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("Email is required.");
  const out: AddSuppressionInput = { email };
  if (input.reason && input.reason.trim()) out.reason = input.reason.trim();
  if (input.source && input.source.trim()) out.source = input.source.trim();
  // GOV-031: only send non-default channel/scope so the API keeps its
  // email/marketing defaults for plain adds.
  if (input.channel && input.channel !== "email") out.channel = input.channel;
  if (input.scope && input.scope !== "marketing") out.scope = input.scope;
  if (input.expires_at) out.expires_at = input.expires_at;
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertSuppressionWriteOptions(options: SuppressionWriteOptions): void {
  if (!IDEMPOTENCY_KEY_RE.test(options.idempotencyKey)) {
    throw new SuppressionAdminContractError(
      "A valid stable idempotency key is required.",
    );
  }
}

function suppressionRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SuppressionAdminContractError(`${name} was malformed.`);
  }
  return value as Record<string, unknown>;
}

function hasNotConfiguredFlag(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).not_configured === true,
  );
}

function boundedCount(value: unknown, name: string, max: number): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  ) {
    throw new SuppressionAdminContractError(`${name} was malformed.`);
  }
  return value as number;
}

function boundedEvidenceStrings(
  value: unknown,
  name: string,
  maxItems: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new SuppressionAdminContractError(`${name} was malformed.`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new SuppressionAdminContractError(`${name} was malformed.`);
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > 512) {
      throw new SuppressionAdminContractError(`${name} was malformed.`);
    }
    return normalized;
  });
}

function parseSuppressionReasonMutation(
  value: unknown,
  requested: number,
): SuppressionReasonMutationResult {
  const row = suppressionRecord(value, "Suppression reason response");
  const updated = boundedCount(row.updated_count, "Updated count", requested);
  const errors = boundedEvidenceStrings(
    row.errors,
    "Suppression errors",
    requested,
  );
  if (updated + errors.length > requested) {
    throw new SuppressionAdminContractError(
      "Suppression reason response did not reconcile with the reviewed scope.",
    );
  }
  return {
    requested,
    updated,
    failed: errors.length,
    missing: requested - updated - errors.length,
    errors,
  };
}

function boundedRFC3339(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !value.includes("T") ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new SuppressionAdminContractError(`${name} was malformed.`);
  }
  return value;
}

function parseSuppressionMirrorResult(
  value: unknown,
  expectedProvider: SuppressionMirrorProvider,
  allowNotConfigured: boolean,
): SuppressionMirrorResult {
  const row = suppressionRecord(value, "Suppression mirror response");
  if (row.provider !== expectedProvider) {
    throw new SuppressionAdminContractError(
      "Suppression mirror response did not match the reviewed provider.",
    );
  }
  const fetched = boundedCount(row.fetched, "Fetched count", MAX_MIRROR_ROWS);
  const imported = boundedCount(
    row.imported,
    "Imported count",
    MAX_MIRROR_ROWS,
  );
  const skipped = boundedCount(row.skipped, "Skipped count", MAX_MIRROR_ROWS);
  const errors = boundedCount(row.errors, "Error count", MAX_MIRROR_ROWS);
  const notConfigured = row.not_configured === true;

  if (notConfigured) {
    if (!allowNotConfigured || fetched + imported + skipped + errors !== 0) {
      throw new SuppressionAdminContractError(
        "Suppression mirror setup response was malformed.",
      );
    }
    const rawReason = row.not_configured_reason;
    if (
      typeof rawReason !== "string" ||
      rawReason.trim().length === 0 ||
      rawReason.trim().length > 512
    ) {
      throw new SuppressionAdminContractError(
        "Suppression mirror setup response was malformed.",
      );
    }
    return {
      provider: expectedProvider,
      fetched: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      not_configured: true,
      not_configured_reason: rawReason.trim(),
    };
  }

  if (row.not_configured !== undefined && row.not_configured !== false) {
    throw new SuppressionAdminContractError(
      "Suppression mirror response was malformed.",
    );
  }
  if (fetched !== imported + skipped + errors) {
    throw new SuppressionAdminContractError(
      "Suppression mirror counts did not reconcile.",
    );
  }
  const windowFrom = boundedRFC3339(row.window_from, "Mirror window start");
  const windowTo = boundedRFC3339(row.window_to, "Mirror window end");
  if (Date.parse(windowFrom) > Date.parse(windowTo)) {
    throw new SuppressionAdminContractError(
      "Suppression mirror window was malformed.",
    );
  }
  return {
    provider: expectedProvider,
    fetched,
    imported,
    skipped,
    errors,
    window_from: windowFrom,
    window_to: windowTo,
    not_configured: false,
  };
}

/**
 * Parses a paste box of addresses (newline / comma / whitespace separated)
 * into deduped, lower-cased, syntactically-valid emails, plus the rejects so
 * the UI can warn. Order is preserved (first occurrence wins).
 */
export function parseEmailList(raw: string): {
  valid: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const email = token.trim().toLowerCase();
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    if (EMAIL_RE.test(email)) valid.push(email);
    else invalid.push(email);
  }
  return { valid, invalid };
}
