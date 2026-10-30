// SPDX-License-Identifier: AGPL-3.0-only
//
// Multi-step CSV import wizard client. Flow:
//   preview (multipart) -> [PATCH mapping/consent overrides] -> confirm(dry_run)
//   -> confirm(real, 202) -> poll GET /{id} until terminal.
// Backend: apps/api/internal/subscriber_import/subscriber_import.go.

import { api, isApiError } from "./api";

export type ImportFieldKind =
  | "email"
  | "status"
  | "consent_timestamp"
  | "name"
  | "first_name"
  | "last_name"
  | "tags"
  | "custom"
  | "ignore";

export interface ImportColumnMapping {
  index: number;
  name: string;
  kind: ImportFieldKind;
  custom_key?: string;
}

export interface ImportMapping {
  path: string;
  headers: string[];
  columns: ImportColumnMapping[];
  rows: number;
}

export interface ImportPreview {
  id: string;
  status: string;
  mapping: ImportMapping;
  sample_rows: Record<string, string>[];
  rows_total: number;
  rows_new: number;
  rows_existing: number;
  rows_file_dupes: number;
  on_existing: string;
  configuration_revision: number;
  sample_values_truncated?: boolean;
}

export interface RemapOptions {
  merge_fields: { kind: string; label: string }[];
  custom_fields: { key: string; label: string; type: string }[];
}

export interface DryRunRow {
  row_number: number;
  outcome: "create" | "update" | "skip" | "fail";
  error_code?: string;
  error?: string;
}

export interface DryRunResults {
  rows_total: number;
  would_create: number;
  would_update: number;
  would_skip: number;
  would_fail: number;
  file_dupes: number;
  rows: DryRunRow[];
  detail_capped: boolean;
}

export interface ImportState {
  id: string;
  filename?: string;
  status: string;
  rows_total: number;
  rows_imported: number;
  rows_skipped: number;
  rows_failed: number;
  processed_rows: number;
  error_code?: string;
  error?: string;
  configuration_revision: number;
  mapping?: ImportMapping;
  dry_run_results?: DryRunResults;
  cancel_requested?: boolean;
  /** The list imported contacts join, as its canonical uuid; "" for none. */
  target_list_id?: string;
}

/** Step 1 — upload + detect mapping. */
export function previewImport(file: File): Promise<ImportPreview> {
  const form = new FormData();
  form.append("file", file);
  return api.postRaw<ImportPreview>(
    "/api/v1/subscriber-imports/preview",
    form,
    { timeoutMs: 2 * 60 * 1000, maxAttempts: 1, requireOnline: true },
  );
}

export function getRemapOptions(): Promise<RemapOptions> {
  return api.get<RemapOptions>("/api/v1/subscriber-imports/remap-options");
}

/** Step 2 — persist operator column/consent overrides (optimistic revision). */
export function patchImport(
  id: string,
  input: {
    configuration_revision: number;
    mapping?: ImportMapping;
    on_existing?: "skip" | "update" | "error";
    /**
     * Create mapped custom fields the workspace hasn't defined. Only
     * meaningful in auto mode; a strict workspace answers 409
     * custom_fields_mode_strict to `true`.
     */
    auto_create_properties?: boolean;
    /**
     * The list every imported contact joins, as the list's engine id (what the
     * picker holds) or its uuid. `""` clears the choice; omitted leaves it
     * alone. A list that is not this workspace's answers 404
     * target_list_not_found.
     */
    target_list_id?: string;
  },
): Promise<{
  id: string;
  status: string;
  updated: boolean;
  configuration_revision: number;
}> {
  return api.patch(`/api/v1/subscriber-imports/${encodeURIComponent(id)}`, input);
}

/** Step 3a — exhaustive preflight (the confirm route with dry_run:true). */
export function dryRunImport(
  id: string,
): Promise<{ id: string; status: string; dry_run_results: DryRunResults }> {
  return api.post(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}/confirm`,
    { dry_run: true },
    { timeoutMs: 2 * 60 * 1000, maxAttempts: 1 },
  );
}

/** Step 3b — commit the import (202 Accepted; then poll getImport). */
export function confirmImport(
  id: string,
): Promise<{ id: string; status: string }> {
  return api.post(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}/confirm`,
    {},
    { maxAttempts: 1 },
  );
}

export function cancelImport(
  id: string,
): Promise<{ id: string; status: string; cancel_requested: boolean }> {
  return api.post(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}/cancel`,
    {},
    { maxAttempts: 1 },
  );
}

export function getImport(id: string): Promise<ImportState> {
  return api.get<ImportState>(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}`,
  );
}

const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled", "canceled"]);

export function isTerminalImportStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Discard an upload that was never confirmed. The server applies it only while
 * the import is still a preview, so a discard can never stop an import that
 * was confirmed meanwhile, in this tab or another: that answers 409
 * `not_a_preview` and the import carries on.
 */
export function discardImportPreview(
  id: string,
): Promise<{ id: string; status: string; cancel_requested: boolean }> {
  return api.post(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}/cancel`,
    { expected_status: "preview" },
    { maxAttempts: 1 },
  );
}

/** The discard found the upload already importing, finished or discarded. */
export function isNotAPreviewError(error: unknown): boolean {
  return isApiError(error) && error.code === "not_a_preview";
}

/**
 * Discard for cleanup paths (leaving the wizard, starting over), where nobody
 * is waiting on the answer. The server purges an abandoned preview after 24
 * hours anyway, and a refusal means there was nothing left to discard.
 */
export async function discardImportPreviewQuietly(id: string): Promise<void> {
  try {
    await discardImportPreview(id);
  } catch {
    // Nothing left to discard, or the network dropped: the purge covers it.
  }
}

/* -------------------------- Custom field keys ------------------------------ */

const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** The API's property-key rule: a lower-case letter, then letters, digits or underscores; at most 64. */
export function isValidCustomFieldKey(key: string): boolean {
  return CUSTOM_FIELD_KEY_RE.test(key);
}

/**
 * A valid key derived from a CSV header, the same way the preview derives its
 * defaults: "Plan type" → plan_type, "2024 spend" → field_2024_spend.
 */
export function suggestCustomFieldKey(header: string, index: number): string {
  const words = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!words) return `column_${index + 1}`;
  const key = /^[a-z]/.test(words) ? words : `field_${words}`;
  return key.slice(0, 64).replace(/_+$/, "");
}

/** The key a custom column writes, resolved as the API does: custom_key, else the header. */
export function customFieldKeyOf(column: ImportColumnMapping): string {
  const key = (column.custom_key ?? "").trim().toLowerCase();
  return key || column.name.trim().toLowerCase();
}

/** Valid mapped custom-field keys the workspace hasn't defined yet, sorted and unique. */
export function undeclaredCustomFieldKeys(
  columns: ImportColumnMapping[],
  declared: { key: string }[],
): string[] {
  const known = new Set(declared.map((field) => field.key));
  const keys = new Set<string>();
  for (const column of columns) {
    const key = customFieldKeyOf(column);
    if (column.kind === "custom" && isValidCustomFieldKey(key) && !known.has(key)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Why the Map step can't be saved yet, or null. Mirrors the PATCH's rules so
 * the operator fixes a key where they typed it instead of after a round trip.
 */
export function customFieldMappingProblem(columns: ImportColumnMapping[]): string | null {
  const seen = new Map<string, string>();
  for (const column of columns) {
    if (column.kind !== "custom") continue;
    const key = customFieldKeyOf(column);
    const name = column.name || `Column ${column.index + 1}`;
    if (!isValidCustomFieldKey(key)) {
      return `Give “${name}” a custom field key that starts with a lower-case letter and uses only a–z, 0–9 and underscores.`;
    }
    const first = seen.get(key);
    if (first) return `“${first}” and “${name}” both map to the custom field “${key}”. Give each column its own key.`;
    seen.set(key, name);
  }
  return null;
}

/** One row the import could not apply. */
export interface ImportRowError {
  row_number: number;
  error_code: string;
  error: string;
  created_at: string;
}

export interface ImportRowErrors {
  items: ImportRowError[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Which rows failed, and why.
 *
 * The worker has written per-row failures since it was built — its own comment
 * says "so the UI can offer" — and no client read them. A user importing 10,000
 * contacts was told 42 rows failed and had no way to learn which, while the
 * answer sat in the table until the 30-day prune.
 */
export function listImportRowErrors(
  id: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ImportRowErrors> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const query = params.toString();
  return api.get<ImportRowErrors>(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}/errors${query ? `?${query}` : ""}`,
  );
}

/**
 * The same failures as a downloadable file.
 *
 * A list on screen answers "which rows" for a person reading it; a spreadsheet
 * is where they actually fix them. Returns the URL rather than fetching, so the
 * browser performs the download with its own credentials and the file never
 * passes through JS memory.
 */
export function importRowErrorsCsvUrl(id: string): string {
  return `/api/v1/subscriber-imports/${encodeURIComponent(id)}/errors?format=csv`;
}

/* -------------------------------------------------------------------------- *
 * Consent-evidence step (PATCH /api/v1/subscriber-imports/{id})
 *
 * Imported rows land UNCONFIRMED unless the import carries a first-party
 * consent proof. The proof travels on the PATCH (never on /confirm, whose body
 * is only `{dry_run}` and rejects unknown keys): all nine `consent_*` fields
 * together with `consent_scope_acknowledged: true`, or
 * `consent_scope_acknowledged: false` alone to clear it. The bounds below are
 * the server's `validatePatch` rules (subscriber_import.go / options.go).
 * -------------------------------------------------------------------------- */

export const IMPORT_CONSENT_SCOPE = "email_marketing" as const;
export const IMPORT_CONSENT_CONFIRMATION = "EMAIL MARKETING";

export const IMPORT_CONSENT_SOURCES = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
  { value: "signed_form", label: "Signed form or contract" },
  { value: "preference_center", label: "Preference center" },
  { value: "direct_request", label: "Direct subscriber request" },
] as const;
export type ImportConsentSource = (typeof IMPORT_CONSENT_SOURCES)[number]["value"];

export interface ImportConsentDraft {
  mode: "none" | "verified";
  source: "" | ImportConsentSource;
  sourceUrl: string;
  /** `datetime-local` value. */
  capturedAt: string;
  jurisdiction: string;
  reason: string;
  policyVersion: string;
  evidenceReference: string;
  scopeAcknowledged: boolean;
  typedConfirmation: string;
}

export type ImportConsentField = Exclude<keyof ImportConsentDraft, "mode">;
export type ImportConsentErrors = Partial<Record<ImportConsentField, string>>;

export function emptyImportConsentDraft(): ImportConsentDraft {
  return {
    mode: "none",
    source: "",
    sourceUrl: "",
    capturedAt: "",
    jurisdiction: "",
    reason: "",
    policyVersion: "",
    evidenceReference: "",
    scopeAcknowledged: false,
    typedConfirmation: "",
  };
}

const IMPORT_JURISDICTION_RE = /^[A-Z][A-Z0-9-]{1,31}$/;
const IMPORT_EVIDENCE_RE =
  /^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/;
const UNSAFE_SECRET_RE =
  /(?:bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret=|signature=|x-amz-signature|sk-[a-z0-9_-]{8,})/i;
const UNSAFE_QUERY_KEY_RE =
  /(?:^|_)(?:key|token|secret|password|passwd|signature|sig|code|credential)(?:$|_)/i;
const UNSAFE_PII_RE =
  /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}\b|\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\b(?:[0-9][ -]?){12,18}[0-9]\b)/i;

function safeEvidenceUrl(raw: string): boolean {
  if (raw.length < 1 || raw.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !url.host || url.username || url.password)
    return false;
  if ([...url.searchParams.keys()].some((key) => UNSAFE_QUERY_KEY_RE.test(key)))
    return false;
  return !UNSAFE_SECRET_RE.test(raw);
}

export function validateImportConsentDraft(
  draft: ImportConsentDraft,
  now = Date.now(),
): ImportConsentErrors {
  if (draft.mode === "none") return {};
  const errors: ImportConsentErrors = {};
  if (!IMPORT_CONSENT_SOURCES.some((option) => option.value === draft.source))
    errors.source = "Choose the first-party record that proves this grant.";
  if (!safeEvidenceUrl(draft.sourceUrl.trim()))
    errors.sourceUrl =
      "Use an absolute HTTPS evidence URL without credentials or secret-bearing query parameters.";
  const captured = Date.parse(draft.capturedAt);
  if (!draft.capturedAt.trim() || !Number.isFinite(captured))
    errors.capturedAt = "Enter when this consent was actually captured.";
  else if (captured > now)
    errors.capturedAt = "The captured time cannot be in the future.";
  if (!IMPORT_JURISDICTION_RE.test(draft.jurisdiction.trim().toUpperCase()))
    errors.jurisdiction =
      "Use a 2–32 character jurisdiction code such as GB, EU, or US-CA.";
  const reason = draft.reason.trim();
  if (reason.length < 1 || reason.length > 500)
    errors.reason = "Give a 500-character-or-shorter audit reason.";
  else if (UNSAFE_SECRET_RE.test(reason) || UNSAFE_PII_RE.test(reason))
    errors.reason =
      "Do not place personal data or secrets here; cite the typed evidence reference instead.";
  const policy = draft.policyVersion.trim();
  if (policy.length < 1 || policy.length > 100 || UNSAFE_SECRET_RE.test(policy))
    errors.policyVersion =
      "Enter the non-secret policy version that governed this decision.";
  const evidence = draft.evidenceReference.trim();
  if (
    evidence.length > 288 ||
    !IMPORT_EVIDENCE_RE.test(evidence) ||
    UNSAFE_SECRET_RE.test(evidence)
  )
    errors.evidenceReference =
      "Use a safe typed reference such as receipt:CONSENT-123 (not the evidence contents).";
  if (!draft.scopeAcknowledged)
    errors.scopeAcknowledged =
      "Acknowledge that this proof applies only to email marketing.";
  if (draft.typedConfirmation.trim() !== IMPORT_CONSENT_CONFIRMATION)
    errors.typedConfirmation = `Type ${IMPORT_CONSENT_CONFIRMATION} exactly to confirm the scope.`;
  return errors;
}

export type ImportConsentPatch =
  | { consent_scope_acknowledged: false }
  | {
      consent_scope_acknowledged: true;
      consent_source: ImportConsentSource;
      consent_source_url: string;
      consent_captured_at: string;
      consent_legal_basis: "consent";
      consent_jurisdiction: string;
      consent_reason: string;
      consent_policy_version: string;
      consent_evidence_reference: string;
      consent_scope: typeof IMPORT_CONSENT_SCOPE;
    };

/** null while the draft still has a problem. */
export function buildImportConsentPatch(
  draft: ImportConsentDraft,
  now = Date.now(),
): ImportConsentPatch | null {
  if (draft.mode === "none") return { consent_scope_acknowledged: false };
  if (Object.keys(validateImportConsentDraft(draft, now)).length > 0) return null;
  if (draft.source === "") return null;
  return {
    consent_scope_acknowledged: true,
    consent_source: draft.source,
    consent_source_url: draft.sourceUrl.trim(),
    consent_captured_at: new Date(draft.capturedAt).toISOString(),
    consent_legal_basis: "consent",
    consent_jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    consent_reason: draft.reason.trim(),
    consent_policy_version: draft.policyVersion.trim(),
    consent_evidence_reference: draft.evidenceReference.trim(),
    consent_scope: IMPORT_CONSENT_SCOPE,
  };
}

/** Persist (or clear) the import's consent proof under its configuration revision. */
export async function patchImportConsent(
  id: string,
  configurationRevision: number,
  patch: ImportConsentPatch,
): Promise<{ id: string; status: string; configuration_revision: number }> {
  const result = await api.patch<{
    id: string;
    status: string;
    configuration_revision: number;
  }>(
    `/api/v1/subscriber-imports/${encodeURIComponent(id)}`,
    { configuration_revision: configurationRevision, ...patch },
    { maxAttempts: 1, requireOnline: true },
  );
  if (
    !result ||
    result.id !== id ||
    !Number.isSafeInteger(result.configuration_revision) ||
    result.configuration_revision < configurationRevision
  ) {
    throw new Error(
      "The import service returned an invalid revision. Reload the import before continuing.",
    );
  }
  return result;
}

/* ------------------------- Preflight acknowledgement ----------------------- */

export interface ImportAcknowledgements {
  /** "I reviewed this preflight and want it queued." */
  queue: boolean;
  /** Required only when the preflight says rows will fail. */
  failures: boolean;
}

/** The reason commit is still withheld, or null when it may proceed. */
export function importAcknowledgementProblem(
  dryRun: Pick<DryRunResults, "would_fail">,
  acks: ImportAcknowledgements,
): string | null {
  if (!acks.queue) return "Confirm you reviewed the preflight before queueing.";
  if (dryRun.would_fail > 0 && !acks.failures)
    return "Acknowledge that the failing rows will not be imported.";
  return null;
}

/* -------------------------- In-flight import recovery ---------------------- */

export interface ImportSummary {
  id: string;
  filename: string;
  status: string;
  rows_total: number;
  processed_rows: number;
  rows_imported: number;
  rows_failed: number;
  cancel_requested: boolean;
  created_at: string;
}

const IN_FLIGHT_STATUSES = new Set(["queued", "running", "scheduled"]);

export function isInFlightImport(status: string): boolean {
  return IN_FLIGHT_STATUSES.has(status);
}

/** An upload that was previewed but never confirmed. */
export function isDraftImport(status: string): boolean {
  return status === "preview";
}

/** Newest imports first (admin only). */
export async function listSubscriberImports(limit = 20): Promise<ImportSummary[]> {
  const raw = await api.get<{ imports?: unknown }>("/api/v1/subscriber-imports", {
    query: { limit },
  });
  if (!raw || !Array.isArray(raw.imports)) {
    throw new Error("The import service returned an invalid import list.");
  }
  return raw.imports.map((value) => {
    const row = value as Record<string, unknown>;
    const n = (field: string) =>
      Number.isSafeInteger(row[field]) ? (row[field] as number) : 0;
    if (!row || typeof row.id !== "string" || typeof row.status !== "string") {
      throw new Error("The import service returned an invalid import list.");
    }
    return {
      id: row.id,
      filename: typeof row.filename === "string" ? row.filename : "",
      status: row.status,
      rows_total: n("rows_total"),
      processed_rows: n("processed_rows"),
      rows_imported: n("rows_imported"),
      rows_failed: n("rows_failed"),
      cancel_requested: row.cancel_requested === true,
      created_at: typeof row.created_at === "string" ? row.created_at : "",
    };
  });
}
