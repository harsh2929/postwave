import type { ApiErr, ApiResult } from "./result";

export interface AuditOperationsRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type AuditOperationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: AuditOperationsRequestOptions,
) => Promise<ApiResult<T>>;

export interface AuditDownloadController {
  signal: AbortSignal;
  dispose: () => void;
}

export interface AuditOperationsDependencies {
  request: AuditOperationsRequester;
  getApiUrl: () => string;
  buildStreamUrl: (path: string) => Promise<string>;
  createDownloadController: (
    callerSignal?: AbortSignal | null,
  ) => AuditDownloadController;
  getApiKey: () => string | null;
  normalizeApiKey: (key: string | null | undefined) => string | null;
  nativeAwareFetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  apiUrl: (path: string) => string;
  errorFromResponse: (response: Response) => Promise<ApiErr["error"]>;
  transportError: (error: unknown) => ApiErr["error"];
  llmRequestOptions: AuditOperationsRequestOptions;
}

/* ---------- audit --------------------------------------------------- */

export interface AuditRow {
  id: number | string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  actorType: string;
  actorLabel?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown> | null;
  at: string;
  /** pii-redaction (Compliance, P0): dotted JSONPaths that were
   *  redacted from `metadata` on write. Drives the "contains
   *  redacted fields" badge on AuditRowItem + the slideover. */
  redactedFields?: string[];
  /** pii-redaction: true when an encrypted side-blob exists for this
   *  row. Frontend gates the "Reveal PII" button on this AND on the
   *  caller holding the audit:read_pii scope. */
  hasEncryptedMetadata?: boolean;
  /** retention-trail-archive (Compliance, P1): true when an operator
   *  has placed a legal hold on this row — the retention trimmer
   *  skips it until the hold is cleared. Drives a "On hold" badge
   *  on AuditRowItem and the "Release hold" affordance in the
   *  slideover. */
  legalHold?: boolean;
  /** retention-trail-archive: per-row retention window override.
   *  When set, this row uses its own window rather than the tenant
   *  default. Bounded 1..3650 server-side. */
  retentionOverrideDays?: number | null;
  /** aivs-bundles (Compliance, P2): groups related agent events into
   *  a logical session for AIVS bundle export. When present AND
   *  actorType==='agent', the slideover surfaces the
   *  "Download AIVS bundle" button. */
  sessionId?: string;
}

/** pii-redaction: POST /api/v1/audit/{id}/unmask response. Returns
 *  the fully-restored metadata with the previously-redacted fields
 *  decrypted in place. Only callable with audit:read_pii scope; the
 *  call itself emits an audit.pii_unmask event so PII access is
 *  itself auditable. */
export interface AuditUnmaskResponse {
  id: number;
  metadata: Record<string, unknown>;
  unmaskedFields: string[];
  unmaskedAt: string;
}

/** pii-redaction: GET /api/v1/audit/redaction-policies response. */
export interface AuditRedactionPolicy {
  defaultRedactedFields: string[];
  jsonpathRules: Array<{ path: string; action: "mask" | "encrypt" | "hash" }>;
  updatedAt: string;
}

export interface AuditListResponse {
  rows: AuditRow[];
  nextCursor?: string;
}

/** Public callers use renderer-friendly camelCase; every audit read maps this
 * shape to the backend's canonical snake_case query contract. */
export interface AuditQueryFilters {
  actorType?: string;
  actorLabel?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
}

export interface AuditCountResponse {
  totalEstimate: number;
  confidence: "exact" | "approximate";
}

/** Refined Audit PR 1: generic (label, count) pair used by stats. */
export interface AuditCount {
  label: string;
  count: number;
}

/** Refined Audit PR 1: one day in the events-per-day sparkline. */
export interface AuditDailyBucket {
  date: string;
  count: number;
}

/** Refined Audit PR 2: operator-defined named filter set. The
 *  `filters` blob is intentionally opaque (Record<string, unknown>)
 *  so adding a new filter to the page never needs a backend change. */
export interface AuditSavedView {
  id: string;
  name: string;
  description?: string;
  filters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/** Refined Audit PR 1: response shape for `getAuditStats`. */
export interface AuditStatsResponse {
  window?: string;
  totalEvents: number;
  byActorType: AuditCount[];
  topActions: AuditCount[];
  daily: AuditDailyBucket[];
}

/** ueba-baselines (AI/Anomaly, P1): per-audit anomaly score returned
 *  by GET /api/v1/audit/{id}/anomaly-score. Drives the "Why high risk?"
 *  modal and the API-fetched RiskAssessment that replaces the
 *  client-side AuditRiskScore.ts rules. */
export interface AnomalyDetectorReason {
  type: string;
  reason: string;
  confidence: number;
  mitre?: string[];
}

export interface AnomalyBaselineSnapshot {
  actorLabel: string;
  actorType: string;
  day: string;
  typicalHours: Record<string, number>;
  typicalIps: string[];
  typicalActions: Record<string, number>;
  meanActionsPerDay: number;
}

export interface AnomalyScoreResponse {
  available: boolean;
  auditId: number;
  score: number;
  bucket: "low" | "med" | "high";
  reasons: AnomalyDetectorReason[];
  mitreTechniques: string[];
  baseline?: AnomalyBaselineSnapshot;
  createdAt: string;
}

/** ueba-baselines: response shape for GET /api/v1/audit/anomalies/recent. */
export interface RecentAnomalyRow {
  auditId: number;
  score: number;
  bucket: "low" | "med" | "high";
  action: string;
  actorLabel: string;
  actorType: string;
  dominantType: string;
  reasons: AnomalyDetectorReason[];
  mitreTechniques: string[];
  createdAt: string;
}

export interface RecentAnomaliesResponse {
  items: RecentAnomalyRow[];
  count: number;
}

/** ai-investigation-agent (audit-2026 AI/Anomaly, P1): one numbered
 *  hypothesis returned by the agent. Every Finding cites at least
 *  one audit_log row id (server validates on insert + read). */
export interface AuditInvestigationFinding {
  num: number;
  hypothesis: string;
  mitre_techniques: string[];
  confidence: number;
  evidence_audit_ids: number[];
  detector_reasons?: string[];
}

/** One remediation candidate. requires_human_approval is always true.
 *  Approval records a review decision; Moosewave does not execute the
 *  proposed identity, key, token, MFA, or IP change. */
export interface AuditInvestigationProposedAction {
  id: string;
  action:
    | "disable_user"
    | "rotate_key"
    | "force_reauth"
    | "revoke_token"
    | "require_mfa"
    | "quarantine_ip";
  target_id: string;
  rationale: string;
  severity: "low" | "medium" | "high" | string;
  requires_human_approval: boolean;
  evidence_audit_ids: number[];
  linked_finding_nums?: number[];
}

/** Persisted form of an investigation, returned by GET /investigations/{id}. */
export interface AuditInvestigation {
  id: string;
  tenant_id: string;
  seed_audit_id: number;
  findings: AuditInvestigationFinding[];
  evidence_audit_ids: number[];
  proposed_actions: AuditInvestigationProposedAction[];
  mitre_techniques: string[];
  confidence: number;
  status: "draft" | "approved" | "rejected" | "executed";
  approved_at?: string;
  approved_by?: string;
  rejection_reason?: string;
  completed_at?: string;
  executed_at?: string;
  executed_by?: string;
  created_at: string;
  updated_at: string;
}

/** POST /api/v1/audit/{id}/investigate response. */
export interface AuditInvestigationTriggerResponse {
  id: string;
  seed_audit_id: number;
  findings_count: number;
  actions_count: number;
  confidence: number;
  mitre: string[];
  status: string;
}

/** POST /api/v1/audit/investigations/{id}/approve response. */
export interface AuditInvestigationApprovalResponse {
  id: string;
  status: "approved";
  execution_state: "not_executed";
  message: string;
  approval_notes?: string;
}

/** natural-language-query: structured filter shape Claude is allowed
 *  to emit. Mirrors apps/api/internal/audit/nlq.go StructuredFilters
 *  and the audit_log List handler param surface. */
export interface AuditNLQStructuredFilters {
  actor_type?: string;
  actor_label?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  since?: string;
  limit?: number;
}

/** natural-language-query: LLM trace exposed to the operator in the
 *  "Why this answer?" expander. Surfaces the prompt → response loop
 *  so a hallucinated translation is visible at audit time. */
export interface AuditNLQTrace {
  reasoning: string;
  model: string;
  raw_llm_response: string;
  prompt_tokens: number;
  response_tokens: number;
  summary_tokens: number;
  cache_hit: boolean;
  retention_days: number;
  generated_at: string;
}

/** natural-language-query: per-tenant daily token cap state. */
export interface AuditNLQCostStatus {
  daily_usage_tokens: number;
  daily_cap_tokens: number;
  remaining_tokens: number;
  reset_at: string;
  nlq_available?: boolean;
}

/** natural-language-query: POST /api/v1/audit/nlq response. */
export interface AuditNLQResponse {
  query_preview: string;
  structured_filters: AuditNLQStructuredFilters;
  invalid_fields?: string[];
  results: AuditRow[];
  total_count: number;
  summary: string;
  trace: AuditNLQTrace;
  cost_status: AuditNLQCostStatus;
}

/** natural-language-query: POST /api/v1/audit/nlq request body. */
export interface AuditNLQRequest {
  query: string;
}

/** rbac-meta-audit: the union of audit:* scope strings recognised by
 *  the backend. Mirrors apps/api/internal/apikeys/apikeys.go
 *  AllAuditScopes + the CHECK constraint in migration 0262. */
export type AuditScope =
  | "audit:read"
  | "audit:read_pii"
  | "audit:read_all_tenants"
  | "audit:configure_sinks"
  | "audit:configure_retention"
  | "audit:execute_actions";

/** rbac-meta-audit: GET /api/v1/audit/my-scopes response. */
export interface MyAuditScopesResponse {
  scopes: string[];
  auditScopes: string[];
  isAdmin: boolean;
}

/** rbac-meta-audit: one tenant role + its assigned audit scopes. */
export interface AuditRoleWithScopes {
  id: string;
  name: string;
  description: string;
  assignedScopes: string[];
  createdAt: string;
  updatedAt: string;
}

/** rbac-meta-audit: GET /api/v1/roles response. */
export interface ListRolesResponse {
  roles: AuditRoleWithScopes[];
  availableScopes: string[];
}

/* ---------- audit Merkle proofs (CryptoAnchor) ---------------------- */

/** GET /api/v1/audit/{id}/session-replay
 *  session-replay-deeplink (audit-2026 UX, P1). Returns the replay URL
 *  + ±2min time window for the audit row, or {available:false} when no
 *  replay provider is configured / the row has no session_id. */
export interface SessionReplayResponse {
  available: boolean;
  reason?: string;
  replay_url?: string;
  provider?: string;
  session_id?: string;
  scoped_start_at?: string;
  scoped_end_at?: string;
  client_event_seq?: number;
  event_at?: string;
}

/** GET /api/v1/audit/{id}/inclusion-proof
 *  Returns the leaf hash + ordered audit-path (intermediate row_hashes)
 *  + the signed root checkpoint that covers the row. A verifier walks
 *  the path forward, re-hashing each row, and confirms the final hash
 *  matches `rootHash`. See docs/audit/verify-proofs.md for the math. */
export interface InclusionProofResponse {
  leaf_id: number;
  leaf_hash: string;
  audit_path: string[];
  tree_size: number;
  root_hash: string;
  root_signature?: string;
  root_kid?: string;
  anchored_at: string;
}

/** retention-trail-archive (Compliance, P1): one row in the
 *  audit_retention_purge_events view. Emitted by the trim worker
 *  at the end of every batch that actually deleted rows. */
export interface AuditPurgeEvent {
  id: number;
  tenant_id: string;
  action: string;
  deleted_id_range: string;
  deleted_count: number;
  retention_days: number;
  before_root_hash: string;
  at: string;
}

/** retention-trail-archive (Compliance, P1): list envelope for
 *  GET /api/v1/audit/retention-activity. */
export interface RetentionActivityResponse {
  events: AuditPurgeEvent[];
  count: number;
  total_purged_last_30d: number;
}

/** GET /api/v1/audit/consistency-proof?from=N&to=M
 *  Returns the row-hash list a holder of the old root needs to extend
 *  it to the new root. */
export interface ConsistencyProofResponse {
  old_size: number;
  new_size: number;
  old_root_hash: string;
  new_root_hash: string;
  consistency_hashes: string[];
}

/** GET /api/v1/audit/checkpoint/latest
 *  Most recent signed root for the tenant — the bootstrap value an
 *  external verifier pins as a trust anchor. */
export interface CheckpointResponse {
  checkpoint_id: number;
  tree_size: number;
  upto_audit_id: number;
  root_hash: string;
  root_signature?: string;
  root_kid?: string;
  anchored_at: string;
}

/** One signed export-manifest row returned by GET /audit/export/manifests. */
export interface AuditExportManifest {
  export_id: string;
  filters_canonical: Record<string, unknown>;
  from_audit_id: number;
  to_audit_id: number;
  row_count: number;
  tree_size_at_export: number;
  root_hash_hex: string;
  signature_hex?: string;
  signature_kid?: string;
  exported_by?: string;
  created_at: string;
}

/* ---------- audit ------------------------------------------------ */

const AUDIT_TEXT_CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const AUDIT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const AUDIT_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const MAX_AUDIT_LIST_ROWS = 500;
const MAX_AUDIT_SAVED_VIEWS = 250;
const MAX_AUDIT_QUERY_INPUT_CHARS = 256;
// The server applies action filters with ILIKE. This value therefore must not
// contain `%` or `_`, because either character would turn a fail-closed query
// into a wildcard read. It is intentionally outside Moosewave's dotted action
// namespace and long enough that a stored action cannot match accidentally.
export const INVALID_AUDIT_QUERY_SENTINEL =
  "postwave-invalid-query-7f16d6a8c0044ee5a1d80dfdc3d33b87";
const AUDIT_SCOPE_VALUE_RE = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const CANONICAL_AUDIT_ACTOR_TYPES = new Set([
  "human",
  "agent",
  "system",
  "platform_operator",
]);
const CANONICAL_AUDIT_SCOPES = new Set<AuditScope>([
  "audit:read",
  "audit:read_pii",
  "audit:read_all_tenants",
  "audit:configure_sinks",
  "audit:configure_retention",
  "audit:execute_actions",
]);
const AUDIT_ROW_KEYS = new Set([
  "id",
  "action",
  "resourceType",
  "resourceId",
  "actorType",
  "actorLabel",
  "userId",
  "ip",
  "userAgent",
  "metadata",
  "at",
  "redactedFields",
  "hasEncryptedMetadata",
  "legalHold",
  "retentionOverrideDays",
  "sessionId",
]);

export interface AuditQueryInput extends AuditQueryFilters {
  cursor?: string;
  limit?: number;
  includeManifest?: boolean;
}

function boundedAuditText(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    !AUDIT_TEXT_CONTROL_RE.test(value)
  );
}

function decodeAuditScopeList(
  value: unknown,
  maxItems: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !AUDIT_SCOPE_VALUE_RE.test(candidate) ||
      seen.has(candidate)
    ) {
      return null;
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

/** Runtime trust boundary for the authorization payload. In particular,
 * arbitrary truthy values such as `"false"`, `1`, or `{}` can never become
 * an admin wildcard in the renderer. */
export function decodeMyAuditScopesPayload(
  value: unknown,
): MyAuditScopesResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).length !== 3 ||
    !Object.hasOwn(response, "scopes") ||
    !Object.hasOwn(response, "auditScopes") ||
    !Object.hasOwn(response, "isAdmin") ||
    typeof response.isAdmin !== "boolean"
  ) {
    return null;
  }
  const scopes = decodeAuditScopeList(response.scopes, 512);
  const auditScopes = decodeAuditScopeList(
    response.auditScopes,
    CANONICAL_AUDIT_SCOPES.size,
  );
  if (!scopes || !auditScopes) return null;
  const auditSet = new Set(auditScopes);
  if (
    auditScopes.some(
      (scope) => !CANONICAL_AUDIT_SCOPES.has(scope as AuditScope),
    ) ||
    scopes.some(
      (scope) => scope.startsWith("audit:") && !auditSet.has(scope),
    ) ||
    auditScopes.some((scope) => !scopes.includes(scope))
  ) {
    return null;
  }
  return { scopes, auditScopes, isAdmin: response.isAdmin };
}

function boundedTrimmedAuditText(
  value: unknown,
  maxLength: number,
): value is string {
  return boundedAuditText(value, maxLength) && value === value.trim();
}

function validAuditDateParts(
  year: number,
  month: number,
  day: number,
): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isAuditIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = AUDIT_INSTANT_RE.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match;
  if (
    !validAuditDateParts(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isAuditCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = AUDIT_DATE_RE.exec(value);
  return Boolean(
    match &&
    validAuditDateParts(Number(match[1]), Number(match[2]), Number(match[3])),
  );
}

function isBoundedAuditJson(
  value: unknown,
  maxNodes = 1_024,
  maxTextLength = 64 * 1_024,
): boolean {
  const seen = new Set<object>();
  let nodes = 0;
  let textLength = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxNodes || depth > 8) return false;
    if (candidate === null || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate === "string") {
      textLength += candidate.length;
      return candidate.length <= 16_384 && textLength <= maxTextLength;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return (
        candidate.length <= 256 &&
        candidate.every((item) => visit(item, depth + 1))
      );
    }
    const entries = Object.entries(candidate as Record<string, unknown>);
    return (
      entries.length <= 128 &&
      entries.every(
        ([key, item]) =>
          key.length <= 256 &&
          !AUDIT_TEXT_CONTROL_RE.test(key) &&
          visit(item, depth + 1),
      )
    );
  };
  return visit(value, 0);
}

function optionalAuditText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined | null {
  if (!(key in record)) return undefined;
  return boundedAuditText(record[key], maxLength) ? record[key] : null;
}

function auditRowID(value: unknown): number | string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return boundedAuditText(value, 128) ? value : null;
}

/** Strict, bounded decoder shared by list reads and live SSE frames. */
export function decodeAuditRow(value: unknown): AuditRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isBoundedAuditJson(value)) return null;
  const row = value as Record<string, unknown>;
  const id = auditRowID(row.id);
  if (
    id === null ||
    !boundedAuditText(row.action, 512) ||
    !boundedAuditText(row.actorType, 64) ||
    !isAuditIsoInstant(row.at)
  ) {
    return null;
  }
  if (Object.keys(row).some((key) => !AUDIT_ROW_KEYS.has(key))) return null;
  const optionalTextFields = [
    ["resourceType", 128],
    ["resourceId", 512],
    ["actorLabel", 512],
    ["userId", 128],
    ["ip", 128],
    ["userAgent", 2_048],
    ["sessionId", 256],
  ] as const;
  const decodedText: Record<string, string | undefined> = {};
  for (const [key, maxLength] of optionalTextFields) {
    const decoded = optionalAuditText(row, key, maxLength);
    if (decoded === null) return null;
    if (decoded !== undefined) decodedText[key] = decoded;
  }
  if (
    "metadata" in row &&
    row.metadata !== null &&
    (!row.metadata ||
      typeof row.metadata !== "object" ||
      Array.isArray(row.metadata))
  ) {
    return null;
  }
  if (
    ("hasEncryptedMetadata" in row &&
      typeof row.hasEncryptedMetadata !== "boolean") ||
    ("legalHold" in row && typeof row.legalHold !== "boolean")
  ) {
    return null;
  }
  if (
    "retentionOverrideDays" in row &&
    row.retentionOverrideDays !== null &&
    (!Number.isInteger(row.retentionOverrideDays) ||
      Number(row.retentionOverrideDays) < 1 ||
      Number(row.retentionOverrideDays) > 3_650)
  ) {
    return null;
  }
  let redactedFields: string[] | undefined;
  if ("redactedFields" in row) {
    if (!Array.isArray(row.redactedFields) || row.redactedFields.length > 64)
      return null;
    if (!row.redactedFields.every((item) => boundedAuditText(item, 256)))
      return null;
    if (new Set(row.redactedFields).size !== row.redactedFields.length)
      return null;
    redactedFields = [...row.redactedFields];
  }
  return {
    id,
    action: row.action,
    actorType: row.actorType,
    at: row.at,
    ...decodedText,
    ...(row.metadata === undefined
      ? {}
      : { metadata: row.metadata as Record<string, unknown> | null }),
    ...(redactedFields ? { redactedFields } : {}),
    ...(row.hasEncryptedMetadata === undefined
      ? {}
      : { hasEncryptedMetadata: row.hasEncryptedMetadata as boolean }),
    ...(row.legalHold === undefined
      ? {}
      : { legalHold: row.legalHold as boolean }),
    ...(row.retentionOverrideDays === undefined
      ? {}
      : { retentionOverrideDays: row.retentionOverrideDays as number | null }),
  };
}

function decodeAuditRows(value: unknown): AuditRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_AUDIT_LIST_ROWS) return null;
  const rows: AuditRow[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const row = decodeAuditRow(candidate);
    if (!row) return null;
    const key = String(row.id);
    if (ids.has(key)) return null;
    ids.add(key);
    rows.push(row);
  }
  return rows;
}

export function decodeAuditListPayload(
  value: unknown,
  currentCursor?: string,
): AuditListResponse | null {
  if (Array.isArray(value)) {
    const rows = decodeAuditRows(value);
    return rows ? { rows } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).some(
      (key) =>
        !["rows", "items", "data", "nextCursor", "next_cursor"].includes(key),
    )
  ) {
    return null;
  }
  const rowAliases = ["rows", "items", "data"].filter((key) => key in envelope);
  if (rowAliases.length !== 1) return null;
  const rows = decodeAuditRows(envelope[rowAliases[0]!]);
  if (!rows) return null;
  const cursorAliases = ["nextCursor", "next_cursor"].filter(
    (key) => key in envelope,
  );
  if (cursorAliases.length > 1) return null;
  const rawCursor =
    cursorAliases.length === 1 ? envelope[cursorAliases[0]!] : undefined;
  if (rawCursor !== undefined && !boundedAuditText(rawCursor, 512)) return null;
  if (rawCursor !== undefined && rawCursor === currentCursor) return null;
  return {
    rows,
    ...(rawCursor === undefined ? {} : { nextCursor: rawCursor }),
  };
}

function decodeAuditCounts(
  value: unknown,
  maxItems: number,
): AuditCount[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: AuditCount[] = [];
  const labels = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return null;
    const item = candidate as Record<string, unknown>;
    if (
      !boundedAuditText(item.label, 512) ||
      !Number.isSafeInteger(item.count) ||
      Number(item.count) < 0 ||
      labels.has(item.label)
    ) {
      return null;
    }
    labels.add(item.label);
    result.push({ label: item.label, count: item.count as number });
  }
  return result;
}

function decodeAuditDaily(value: unknown): AuditDailyBucket[] | null {
  if (!Array.isArray(value) || value.length > 3_660) return null;
  const result: AuditDailyBucket[] = [];
  let previous = "";
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return null;
    const item = candidate as Record<string, unknown>;
    if (
      !isAuditCalendarDate(item.date) ||
      item.date <= previous ||
      !Number.isSafeInteger(item.count) ||
      Number(item.count) < 0
    ) {
      return null;
    }
    previous = item.date;
    result.push({ date: item.date, count: item.count as number });
  }
  return result;
}

function safeAuditSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function decodeAuditStatsPayload(
  value: unknown,
): AuditStatsResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stats = value as Record<string, unknown>;
  if (!isBoundedAuditJson(stats, 20_000, 512 * 1_024)) return null;
  if (
    Object.keys(stats).some(
      (key) =>
        ![
          "window",
          "totalEvents",
          "byActorType",
          "topActions",
          "daily",
        ].includes(key),
    )
  ) {
    return null;
  }
  if (!Number.isSafeInteger(stats.totalEvents) || Number(stats.totalEvents) < 0)
    return null;
  const byActorType = decodeAuditCounts(stats.byActorType, 32);
  const topActions = decodeAuditCounts(stats.topActions, 20);
  const daily = decodeAuditDaily(stats.daily);
  if (!byActorType || !topActions || !daily) return null;
  const actorTotal = safeAuditSum(byActorType.map((item) => item.count));
  const actionTotal = safeAuditSum(topActions.map((item) => item.count));
  const dailyTotal = safeAuditSum(daily.map((item) => item.count));
  if (
    actorTotal !== stats.totalEvents ||
    dailyTotal !== stats.totalEvents ||
    actionTotal === null ||
    actionTotal > Number(stats.totalEvents)
  ) {
    return null;
  }
  if ("window" in stats && !boundedAuditText(stats.window, 128)) return null;
  return {
    totalEvents: stats.totalEvents as number,
    byActorType,
    topActions,
    daily,
    ...(stats.window === undefined ? {} : { window: stats.window as string }),
  };
}

export function decodeAuditCountPayload(
  value: unknown,
): AuditCountResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = value as Record<string, unknown>;
  if (
    Object.keys(count).length !== 2 ||
    !("totalEstimate" in count) ||
    !("confidence" in count) ||
    !Number.isSafeInteger(count.totalEstimate) ||
    Number(count.totalEstimate) < 0 ||
    (count.confidence !== "exact" && count.confidence !== "approximate")
  ) {
    return null;
  }
  return {
    totalEstimate: count.totalEstimate as number,
    confidence: count.confidence,
  };
}

const AUDIT_SAVED_FILTER_KEYS = new Set([
  "actorType",
  "actorLabel",
  "actionQuery",
  "resourceType",
  "resourceId",
  "days",
  "category",
  // Web supports exact calendar bounds in addition to desktop's relative-day
  // selector. Desktop deliberately leaves these fields unapplied for now, but
  // accepting and preserving them prevents one web-created shared view from
  // making the tenant's entire saved-view list fail strict decoding here.
  "since",
  "until",
]);

/** Decodes the renderer-owned saved-view schema; opaque or future blobs stay
 * unavailable until the renderer explicitly understands their semantics. */
export function decodeAuditSavedViewFilters(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const filters = value as Record<string, unknown>;
  if (
    Object.keys(filters).length > AUDIT_SAVED_FILTER_KEYS.size ||
    Object.keys(filters).some((key) => !AUDIT_SAVED_FILTER_KEYS.has(key))
  ) {
    return null;
  }
  if (
    "actorType" in filters &&
    (typeof filters.actorType !== "string" ||
      ![
        "any",
        "human",
        "user",
        "agent",
        "system",
        "platform_operator",
      ].includes(filters.actorType))
  ) {
    return null;
  }
  for (const [key, maxLength] of [
    ["actorLabel", 256],
    ["actionQuery", 256],
    ["resourceType", 128],
    ["resourceId", 512],
  ] as const) {
    if (key in filters && !boundedAuditText(filters[key], maxLength, true))
      return null;
  }
  if (
    "days" in filters &&
    (typeof filters.days !== "number" || ![0, 7, 30, 90].includes(filters.days))
  )
    return null;
  if (
    "category" in filters &&
    (typeof filters.category !== "string" ||
      ![
        "all",
        "destructive",
        "auth",
        "export",
        "one_click",
        "meta_audit",
      ].includes(filters.category))
  ) {
    return null;
  }
  for (const key of ["since", "until"] as const) {
    if (key in filters && !isAuditIsoInstant(filters[key])) return null;
  }
  if (
    typeof filters.since === "string" &&
    typeof filters.until === "string" &&
    Date.parse(filters.since) > Date.parse(filters.until)
  ) {
    return null;
  }
  // Saved queries created by renderer v1 used `user`; the server has always
  // stored and filtered human actors as `human`. Canonicalise that legacy
  // value at the trust boundary instead of replaying a known-empty query.
  return {
    ...filters,
    ...(filters.actorType === "user" ? { actorType: "human" } : {}),
  };
}

export function decodeAuditSsePayload(value: unknown): AuditRow | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 * 1_024
  ) {
    return null;
  }
  try {
    return decodeAuditRow(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function decodeAuditSavedView(value: unknown): AuditSavedView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isBoundedAuditJson(value)) return null;
  const view = value as Record<string, unknown>;
  if (
    Object.keys(view).some(
      (key) =>
        ![
          "id",
          "name",
          "description",
          "filters",
          "createdAt",
          "updatedAt",
          "createdBy",
        ].includes(key),
    )
  ) {
    return null;
  }
  const filters = decodeAuditSavedViewFilters(view.filters);
  if (
    !boundedAuditText(view.id, 128) ||
    !boundedAuditText(view.name, 256) ||
    !filters ||
    !isAuditIsoInstant(view.createdAt) ||
    !isAuditIsoInstant(view.updatedAt)
  ) {
    return null;
  }
  const description = optionalAuditText(view, "description", 2_048);
  const createdBy = optionalAuditText(view, "createdBy", 128);
  if (description === null || createdBy === null) return null;
  return {
    id: view.id,
    name: view.name,
    filters,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(description === undefined ? {} : { description }),
    ...(createdBy === undefined ? {} : { createdBy }),
  };
}

export function decodeAuditSavedViewsPayload(
  value: unknown,
): { views: AuditSavedView[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some((key) => key !== "views")) return null;
  const rawViews = envelope.views;
  if (!Array.isArray(rawViews) || rawViews.length > MAX_AUDIT_SAVED_VIEWS)
    return null;
  const views: AuditSavedView[] = [];
  const ids = new Set<string>();
  for (const candidate of rawViews) {
    const view = decodeAuditSavedView(candidate);
    if (!view || ids.has(view.id)) return null;
    ids.add(view.id);
    views.push(view);
  }
  return { views };
}

export function serializeAuditQuery(input: AuditQueryInput = {}): string {
  const params = new URLSearchParams();
  const allowedKeys = new Set([
    "actorType",
    "actorLabel",
    "action",
    "resourceType",
    "resourceId",
    "since",
    "cursor",
    "limit",
    "includeManifest",
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    return `action=${INVALID_AUDIT_QUERY_SENTINEL}`;
  }
  if (
    input.actorType !== undefined &&
    input.actorType !== "" &&
    !CANONICAL_AUDIT_ACTOR_TYPES.has(input.actorType)
  ) {
    return `action=${INVALID_AUDIT_QUERY_SENTINEL}`;
  }
  const strings = [
    ["actor_type", input.actorType, 64],
    ["actor_label", input.actorLabel, MAX_AUDIT_QUERY_INPUT_CHARS],
    ["action", input.action, MAX_AUDIT_QUERY_INPUT_CHARS],
    ["resource_type", input.resourceType, 128],
    ["resource_id", input.resourceId, MAX_AUDIT_QUERY_INPUT_CHARS],
    ["since", input.since, 40],
    ["cursor", input.cursor, 512],
  ] as const;
  for (const [key, value, maxLength] of strings) {
    if (value === undefined || value === "") continue;
    if (
      !boundedAuditText(value, maxLength) ||
      (key === "since" && !isAuditIsoInstant(value))
    ) {
      // A malformed filter must never be omitted: omission broadens the read.
      // Pin an impossible action instead, producing an empty evidence set.
      return `action=${INVALID_AUDIT_QUERY_SENTINEL}`;
    }
    params.set(key, value);
  }
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) ||
      Number(input.limit) < 1 ||
      Number(input.limit) > 100_000)
  ) {
    return `action=${INVALID_AUDIT_QUERY_SENTINEL}`;
  }
  if (input.limit !== undefined) {
    params.set("limit", String(input.limit));
  }
  if (input.includeManifest === true) params.set("include_manifest", "true");
  return params.toString();
}

function invalidAuditPayload(label: string): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "invalid_audit_payload",
      message: `The ${label} response was invalid.`,
    },
    retryability: "manual",
  };
}

function decodedAuditResult<T>(
  result: ApiResult<unknown>,
  decoder: (value: unknown) => T | null,
  label: string,
): ApiResult<T> {
  if (result.error) return result;
  const data = decoder(result.data);
  return data
    ? ({ ...result, data } as ApiResult<T>)
    : invalidAuditPayload(label);
}

/**
 * GET /api/v1/audit — chronological audit log with cursor pagination.
 *
 * The Go server today reads `actor_type`, `actor_label`, `limit`,
 * `cursor`. We additionally pass `action` and `since` when supplied
 * because the spec lists them; the server ignores unknown query params
 * so this is forward-compatible.
 */
export function createListAudit({ request }: AuditOperationsDependencies) {
  return async function listAudit(
    opts: AuditQueryFilters & { cursor?: string; limit?: number } = {},
    requestOptions?: { signal?: AbortSignal },
  ): Promise<ApiResult<AuditListResponse>> {
    const qs = serializeAuditQuery(opts);
    const response = await request<unknown>(
      `/api/v1/audit${qs ? `?${qs}` : ""}`,
      undefined,
      requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
    );
    return decodedAuditResult(
      response,
      (value) => decodeAuditListPayload(value, opts.cursor),
      "audit-log list",
    );
  };
}

/**
 * Refined Audit PR 1: GET /api/v1/audit/stats — aggregated counts
 * (actor mix + top actions + daily series) for the insights row
 * at the top of the audit page. Shares the filter set with
 * `listAudit` so the cards always reflect the current view.
 */
export function createGetAuditStats({ request }: AuditOperationsDependencies) {
  return async function getAuditStats(
    opts: AuditQueryFilters = {},
    requestOptions?: { signal?: AbortSignal },
  ): Promise<ApiResult<AuditStatsResponse>> {
    const qs = serializeAuditQuery(opts);
    const response = await request<unknown>(
      `/api/v1/audit/stats${qs ? `?${qs}` : ""}`,
      undefined,
      requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
    );
    return decodedAuditResult(
      response,
      decodeAuditStatsPayload,
      "audit statistics",
    );
  };
}

/**
 * ueba-baselines (AI/Anomaly, P1): fetches the anomaly score +
 * detector reasons + baseline snapshot for a single audit_log row.
 * Returns {available:false} (not 404) when no UEBA score exists,
 * so the consumer can render an inline "no anomaly detected" state.
 */
export function createGetAuditAnomalyScore({
  request,
}: AuditOperationsDependencies) {
  return function getAuditAnomalyScore(
    auditId: number,
  ): Promise<ApiResult<AnomalyScoreResponse>> {
    return request<AnomalyScoreResponse>(
      `/api/v1/audit/${auditId}/anomaly-score`,
    );
  };
}

/**
 * ueba-baselines: top-N highest-scoring anomalies in the last 24h.
 * Powers the UEBA insights tile in AuditInsightsRow.
 */
export function createGetAuditRecentAnomalies({
  request,
}: AuditOperationsDependencies) {
  return function getAuditRecentAnomalies(
    limit = 5,
  ): Promise<ApiResult<RecentAnomaliesResponse>> {
    const q = limit && limit > 0 ? `?limit=${limit}` : "";
    return request<RecentAnomaliesResponse>(
      `/api/v1/audit/anomalies/recent${q}`,
    );
  };
}

/**
 * Refined Audit PR 1: builds the CSV-export URL with the active
 * filter set encoded. We return a URL string (not a fetch) so the
 * caller can open it in a new tab and let the browser handle the
 * Content-Disposition file download. The server endpoint streams
 * up to 100k rows — auditor's bulk-review entry point.
 */
export function createAuditExportUrl({
  getApiUrl,
}: AuditOperationsDependencies) {
  return function auditExportUrl(
    opts: AuditQueryFilters & { limit?: number } = {},
  ): string {
    const qs = serializeAuditQuery(opts);
    return `${getApiUrl()}/api/v1/audit/export${qs ? `?${qs}` : ""}`;
  };
}

/**
 * Auth-token-safe variant of auditExportUrl. The bare auditExportUrl
 * returns a host-relative URL with no auth; opening it in a new tab
 * in Electron/cookieless contexts 401s. This async variant runs the
 * URL through buildStreamUrl which attaches a short-lived
 * `stream_token` query param the export handler accepts in lieu of
 * the session cookie. Use this for `window.open()` / anchor-click
 * downloads.
 */
export function createAuditExportUrlAuthed({
  buildStreamUrl,
}: AuditOperationsDependencies) {
  return async function auditExportUrlAuthed(
    opts: AuditQueryFilters & {
      limit?: number;
      /**
       * signed-export-replay: when true, the server records a signed
       * export manifest row (audit_export_manifests). The manifest
       * sidecar JSON is fetched separately via auditExportManifestsList().
       */
      includeManifest?: boolean;
    } = {},
  ): Promise<string> {
    const qs = serializeAuditQuery(opts);
    return buildStreamUrl(`/api/v1/audit/export${qs ? `?${qs}` : ""}`);
  };
}

/**
 * GET /api/v1/audit/export/manifests — signed-export-replay history.
 * Returns the most recent N signed export manifests for the tenant.
 * Used by the Audit page's "Export history" panel.
 */
export function createAuditExportManifestsList({
  request,
}: AuditOperationsDependencies) {
  return function auditExportManifestsList(
    limit?: number,
  ): Promise<ApiResult<{ manifests: AuditExportManifest[] }>> {
    const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return request<{ manifests: AuditExportManifest[] }>(
      `/api/v1/audit/export/manifests${qs}`,
    );
  };
}

/* ====================================================================
 * natural-language-query — POST a plain-English question, get back
 * the structured filter Claude translated it to (CloudTrail-Lake
 * pattern: always show the operator the query that ran), the
 * matching audit rows, and an LLM summary.
 * ================================================================== */

/** POST /api/v1/audit/nlq — translate + execute + summarise.
 *  Discriminated-union error path: server returns 503 nlq_unavailable
 *  when ANTHROPIC_API_KEY is unset, 429 cost_cap_exceeded when the
 *  tenant's daily token budget is exhausted. */
export function createApiAuditNLQ({
  request,
  llmRequestOptions: LLM_REQUEST_OPTS,
}: AuditOperationsDependencies) {
  return function apiAuditNLQ(
    query: string,
  ): Promise<ApiResult<AuditNLQResponse>> {
    return request<AuditNLQResponse>(
      `/api/v1/audit/nlq`,
      {
        method: "POST",
        body: JSON.stringify({ query } satisfies AuditNLQRequest),
      },
      LLM_REQUEST_OPTS,
    );
  };
}

/** GET /api/v1/audit/nlq/cost-status — daily token usage + cap so
 *  the bar can grey out before a 429. */
export function createApiAuditNLQCostStatus({
  request,
}: AuditOperationsDependencies) {
  return function apiAuditNLQCostStatus(): Promise<
    ApiResult<AuditNLQCostStatus>
  > {
    return request<AuditNLQCostStatus>(`/api/v1/audit/nlq/cost-status`);
  };
}

/* ====================================================================
 * rbac-meta-audit — RBAC scopes + role management. Powers the
 * permission gates on Audit.tsx, AuditSinks.tsx, Sidebar.tsx, and
 * the Settings > Team > Roles matrix.
 * ================================================================== */

/**
 * GET /api/v1/audit/my-scopes — the calling actor's effective audit
 * scopes. The frontend reads this on Audit-page mount to gate UI
 * features (mask PII when audit:read_pii missing, disable retention
 * editor when audit:configure_retention missing, hide nav lock).
 */
export function createGetMyAuditScopes({
  request,
}: AuditOperationsDependencies) {
  return async function getMyAuditScopes(): Promise<
    ApiResult<MyAuditScopesResponse>
  > {
    const response = await request<unknown>(`/api/v1/audit/my-scopes`);
    return decodedAuditResult(
      response,
      decodeMyAuditScopesPayload,
      "audit permission",
    );
  };
}

/** GET /api/v1/roles — list tenant roles with their assigned scopes. */
export function createListRoles({ request }: AuditOperationsDependencies) {
  return function listRoles(): Promise<ApiResult<ListRolesResponse>> {
    return request<ListRolesResponse>(`/api/v1/roles`);
  };
}

/** PUT /api/v1/roles/{id}/scopes — replace the role's assigned scopes.
 *  Any valid apikeys scope may be granted (the roles matrix surfaces the
 *  full grantable set via ListRolesResponse.availableScopes, which the
 *  backend now returns beyond audit:* — see G-48); unknown scope strings
 *  are rejected server-side, so this takes the broad string[] rather than
 *  the audit-only AuditScope union. */
export function createUpdateRoleScopes({
  request,
}: AuditOperationsDependencies) {
  return function updateRoleScopes(
    id: string,
    scopes: string[],
  ): Promise<ApiResult<{ ok: boolean; id: string; assignedScopes: string[] }>> {
    return request<{ ok: boolean; id: string; assignedScopes: string[] }>(
      `/api/v1/roles/${encodeURIComponent(id)}/scopes`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes }),
      },
    );
  };
}

/* ====================================================================
 * Refined Audit PRs 2-4 — SSE live tail, saved views CRUD, tenant
 * retention editor.
 * ================================================================== */

/** Refined Audit PR 2: returns an EventSource URL the page opens
 *  for SSE live tail.
 *
 *  NOTE: prefer `auditStreamUrlAuthed(filters)` for any real call site
 *  — this bare variant has no stream_token and no filter params, so
 *  the SSE connection 401s in cookieless contexts and pushes events
 *  outside the operator's active filter into the live feed.
 *  Kept for backwards-compatibility with any existing callers.
 */
export function createAuditStreamUrl({
  getApiUrl,
}: AuditOperationsDependencies) {
  return function auditStreamUrl(): string {
    return `${getApiUrl()}/api/v1/audit/stream`;
  };
}

/**
 * Auth-token-safe variant of auditStreamUrl. Attaches stream_token
 * via buildStreamUrl so the EventSource opens in Electron and other
 * cookieless contexts, and forwards filter params so the live feed
 * matches the rest-list filter set.
 */
export function createAuditStreamUrlAuthed({
  buildStreamUrl,
}: AuditOperationsDependencies) {
  return async function auditStreamUrlAuthed(
    opts: AuditQueryFilters = {},
  ): Promise<string> {
    const qs = serializeAuditQuery(opts);
    return buildStreamUrl(`/api/v1/audit/stream${qs ? `?${qs}` : ""}`);
  };
}

/**
 * Auth-token-safe SSE URL for a single investigation's live status
 * stream (GET /api/v1/audit/investigations/{id}/stream). Same
 * buildStreamUrl pattern as auditStreamUrlAuthed — a bare relative
 * URL resolves against tauri://localhost and carries no auth, so
 * the EventSource never connects in the packaged app.
 */
export function createAuditInvestigationStreamUrlAuthed({
  buildStreamUrl,
}: AuditOperationsDependencies) {
  return function auditInvestigationStreamUrlAuthed(
    id: string,
  ): Promise<string> {
    return buildStreamUrl(
      `/api/v1/audit/investigations/${encodeURIComponent(id)}/stream`,
    );
  };
}

/** Refined Audit PR 2: list saved views (operator-defined filter
 *  sets). Sorted newest-updated-first. */
export function createListAuditSavedViews({
  request,
}: AuditOperationsDependencies) {
  return async function listAuditSavedViews(): Promise<
    ApiResult<{ views: AuditSavedView[] }>
  > {
    const response = await request<unknown>(`/api/v1/audit/saved-views`);
    return decodedAuditResult(
      response,
      decodeAuditSavedViewsPayload,
      "saved audit views",
    );
  };
}

export function createCreateAuditSavedView({
  request,
}: AuditOperationsDependencies) {
  return async function createAuditSavedView(input: {
    name: string;
    description?: string;
    filters: Record<string, unknown>;
  }): Promise<ApiResult<AuditSavedView>> {
    if (
      !boundedAuditText(input.name, 256) ||
      (input.description !== undefined &&
        !boundedAuditText(input.description, 2_048, true))
    ) {
      return invalidAuditPayload("saved audit view input");
    }
    const filters = decodeAuditSavedViewFilters(input.filters);
    if (!filters) return invalidAuditPayload("saved audit view filters");
    const response = await request<unknown>(`/api/v1/audit/saved-views`, {
      method: "POST",
      body: JSON.stringify({ ...input, filters }),
    });
    return decodedAuditResult(
      response,
      decodeAuditSavedView,
      "saved audit view",
    );
  };
}

export function createUpdateAuditSavedView({
  request,
}: AuditOperationsDependencies) {
  return async function updateAuditSavedView(
    id: string,
    input: {
      name?: string;
      description?: string;
      filters?: Record<string, unknown>;
    },
  ): Promise<ApiResult<{ ok: boolean; id: string }>> {
    if (
      !boundedAuditText(id, 128) ||
      (input.name !== undefined && !boundedAuditText(input.name, 256)) ||
      (input.description !== undefined &&
        !boundedAuditText(input.description, 2_048, true))
    ) {
      return invalidAuditPayload("saved audit view input");
    }
    const filters =
      input.filters === undefined
        ? undefined
        : decodeAuditSavedViewFilters(input.filters);
    if (filters === null)
      return invalidAuditPayload("saved audit view filters");
    return request(`/api/v1/audit/saved-views/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...input, ...(filters ? { filters } : {}) }),
    });
  };
}

export function createDeleteAuditSavedView({
  request,
}: AuditOperationsDependencies) {
  return function deleteAuditSavedView(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request(`/api/v1/audit/saved-views/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  };
}

/** Refined Audit PR 2: tenant retention window. null means
 *  "use deployment default" (90 days in the current build). */
export function createGetAuditRetention({
  request,
}: AuditOperationsDependencies) {
  return function getAuditRetention(): Promise<
    ApiResult<{ retentionDays: number | null; defaultDays: number }>
  > {
    return request(`/api/v1/audit/retention`);
  };
}

export function createSetAuditRetention({
  request,
}: AuditOperationsDependencies) {
  return function setAuditRetention(
    retentionDays: number | null,
  ): Promise<ApiResult<{ ok: boolean; retentionDays?: number }>> {
    return request(`/api/v1/audit/retention`, {
      method: "PUT",
      body: JSON.stringify({ retentionDays }),
    });
  };
}

/* ---------- retention-trail-archive (Compliance, P1) -------------- *
 * Per-batch audit.retention.purge events emitted by the trim worker
 * are exposed through /audit/retention-activity so the Compliance
 * "Retention activity" tab can render the timeline. Per-row
 * retention overrides + legal hold flips happen through PATCH
 * /audit/{id}/retention-override and are themselves meta-audited
 * server-side (audit.retention.override_set).                      */
export function createListRetentionActivity({
  request,
}: AuditOperationsDependencies) {
  return function listRetentionActivity(opts?: {
    limit?: number;
  }): Promise<ApiResult<RetentionActivityResponse>> {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return request<RetentionActivityResponse>(
      `/api/v1/audit/retention-activity${tail}`,
    );
  };
}

export function createSetEventRetentionOverride({
  request,
}: AuditOperationsDependencies) {
  return function setEventRetentionOverride(
    id: number | string,
    patch: { retention_override_days?: number | null; legal_hold?: boolean },
  ): Promise<
    ApiResult<{
      id: number;
      retention_override_days: number | null;
      legal_hold: boolean | null;
    }>
  > {
    return request(
      `/api/v1/audit/${encodeURIComponent(String(id))}/retention-override`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
  };
}

/* ---------- embeddable-customer-portal (audit-2026 API P1) -------- */

/** POST /api/v1/audit/portal/sessions — mint a portal-session JWT
 *  for the embeddable customer-facing audit portal. Returns the
 *  full portal_url for the admin to copy + share. */
export function createCreateAuditPortalSession({
  request,
}: AuditOperationsDependencies) {
  return function createAuditPortalSession(opts?: {
    sub_tenant_id?: string;
    ttl_seconds?: number;
  }): Promise<
    ApiResult<{
      session_id: string;
      portal_url: string;
      expires_at: string;
      token: string;
    }>
  > {
    return request(`/api/v1/audit/portal/sessions`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    });
  };
}

/** GET /api/v1/audit/portal/sessions — list recent portal sessions
 *  (no raw JWTs returned; only metadata). */
export function createListAuditPortalSessions({
  request,
}: AuditOperationsDependencies) {
  return function listAuditPortalSessions(): Promise<
    ApiResult<{
      sessions: Array<{
        id: string;
        scope: string;
        subTenantId?: string;
        expiresAt: string;
        createdAt: string;
        accessedAt?: string;
        revokedAt?: string;
      }>;
    }>
  > {
    return request(`/api/v1/audit/portal/sessions`);
  };
}

/** DELETE /api/v1/audit/portal/sessions/{id} — revoke a session. */
export function createRevokeAuditPortalSession({
  request,
}: AuditOperationsDependencies) {
  return function revokeAuditPortalSession(
    id: string,
  ): Promise<ApiResult<{ ok: boolean; id: string }>> {
    return request(`/api/v1/audit/portal/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  };
}

/* ---------- audit Merkle proofs (CryptoAnchor) ------------------- */

/** GET /api/v1/audit/{id}/inclusion-proof — proof that audit row id
 *  is committed under the smallest signed Merkle root covering it.
 *  Returns HTTP 425 (mapped to a structured error) when the
 *  background Merkle worker hasn't yet rooted the row. */
export function createGetInclusionProof({
  request,
}: AuditOperationsDependencies) {
  return function getInclusionProof(
    id: number | string,
  ): Promise<ApiResult<InclusionProofResponse>> {
    return request<InclusionProofResponse>(
      `/api/v1/audit/${encodeURIComponent(String(id))}/inclusion-proof`,
    );
  };
}

/** GET /api/v1/audit/{id}/session-replay — session-replay deep-link
 *  lookup. Returns {available:true} + a player URL when the row
 *  carries a session_id and a replay provider is configured, or
 *  {available:false} otherwise. UI surfaces a "Watch session replay"
 *  button only on available=true. */
export function createAuditSessionReplay({
  request,
}: AuditOperationsDependencies) {
  return function auditSessionReplay(
    id: number | string,
  ): Promise<ApiResult<SessionReplayResponse>> {
    return request<SessionReplayResponse>(
      `/api/v1/audit/${encodeURIComponent(String(id))}/session-replay`,
    );
  };
}

/** ai-investigation-agent (audit-2026 AI/Anomaly, P1):
 *  POST /api/v1/audit/{id}/investigate — kicks off the autonomous
 *  investigator. Returns the new investigation id (or the existing
 *  one when the seed already has an investigation). */
export function createInvestigateAuditEvent({
  request,
  llmRequestOptions: LLM_REQUEST_OPTS,
}: AuditOperationsDependencies) {
  return function investigateAuditEvent(
    auditId: number | string,
    contextWindowMinutes?: number,
  ): Promise<ApiResult<AuditInvestigationTriggerResponse>> {
    const qs =
      contextWindowMinutes && contextWindowMinutes > 0
        ? `?context_window_minutes=${contextWindowMinutes}`
        : "";
    return request<AuditInvestigationTriggerResponse>(
      `/api/v1/audit/${encodeURIComponent(String(auditId))}/investigate${qs}`,
      { method: "POST" },
      LLM_REQUEST_OPTS,
    );
  };
}

/** GET /api/v1/audit/investigations — paginated list of investigations. */
export function createListAuditInvestigations({
  request,
}: AuditOperationsDependencies) {
  return function listAuditInvestigations(
    filters: { status?: string; limit?: number } = {},
  ): Promise<ApiResult<{ investigations: AuditInvestigation[] }>> {
    const qs = new URLSearchParams();
    if (filters.status) qs.set("status", filters.status);
    if (filters.limit) qs.set("limit", String(filters.limit));
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ investigations: AuditInvestigation[] }>(
      `/api/v1/audit/investigations${tail}`,
    );
  };
}

/** GET /api/v1/audit/investigations/{id} — full investigation detail. */
export function createGetAuditInvestigation({
  request,
}: AuditOperationsDependencies) {
  return function getAuditInvestigation(
    id: string,
  ): Promise<ApiResult<AuditInvestigation>> {
    return request<AuditInvestigation>(
      `/api/v1/audit/investigations/${encodeURIComponent(id)}`,
    );
  };
}

/** POST /api/v1/audit/investigations/{id}/approve — approve the complete
 *  remediation plan for manual or external execution. */
export function createApproveAuditInvestigation({
  request,
}: AuditOperationsDependencies) {
  return function approveAuditInvestigation(
    id: string,
    body: { notes?: string } = {},
  ): Promise<ApiResult<AuditInvestigationApprovalResponse>> {
    return request<AuditInvestigationApprovalResponse>(
      `/api/v1/audit/investigations/${encodeURIComponent(id)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: body.notes ?? "",
        }),
      },
    );
  };
}

/** POST /api/v1/audit/investigations/{id}/reject — reject the proposed
 *  remediation plan. Reason is required. */
export function createRejectAuditInvestigation({
  request,
}: AuditOperationsDependencies) {
  return function rejectAuditInvestigation(
    id: string,
    reason: string,
  ): Promise<ApiResult<{ id: string; status: string }>> {
    return request<{ id: string; status: string }>(
      `/api/v1/audit/investigations/${encodeURIComponent(id)}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      },
    );
  };
}

/** aivs-bundles (Compliance, P2): GET /api/v1/audit/ai-session/{sid}/aivs-bundle.
 *  Downloads an AIVS proof bundle (.tar.gz) for an AI agent session:
 *  manifest.json + events.jsonl + chain.json + verify.py. Returns the
 *  raw blob + a server-suggested filename pulled from
 *  Content-Disposition. Caller triggers the actual save (anchor click
 *  via createObjectURL) so the UI can also show a "preparing…" state. */
export function createDownloadAIVSBundle({
  createDownloadController,
  getApiKey,
  normalizeApiKey,
  nativeAwareFetch,
  apiUrl,
  errorFromResponse,
  transportError,
}: AuditOperationsDependencies) {
  return async function downloadAIVSBundle(
    sessionID: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<{ blob: Blob; filename: string }>> {
    const dl = createDownloadController(opts?.signal);
    try {
      const headers: Record<string, string> = {
        Accept: "application/gzip",
      };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await nativeAwareFetch(
        apiUrl(
          `/api/v1/audit/ai-session/${encodeURIComponent(sessionID)}/aivs-bundle`,
        ),
        {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        },
      );
      if (!res.ok) {
        return { error: await errorFromResponse(res) };
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename =
        m?.[1] ??
        `postwave-aivs-${sessionID}-${new Date()
          .toISOString()
          .slice(0, 10)}.tar.gz`;
      const blob = await res.blob();
      return { data: { blob, filename } };
    } catch (err) {
      return { error: transportError(err) };
    } finally {
      dl.dispose();
    }
  };
}

/** pii-redaction (Compliance, P0): POST /api/v1/audit/{id}/unmask —
 *  decrypt the row's encrypted metadata side-blob and return the
 *  fully-restored metadata. Requires audit:read_pii scope; the
 *  unmask itself is recorded in audit_pii_unmask_history AND emits
 *  an audit.pii_unmask audit_log row. `reason` lets the operator
 *  attach a free-form justification surfaced to compliance reviewers. */
export function createAuditUnmaskPII({ request }: AuditOperationsDependencies) {
  return function auditUnmaskPII(
    id: number | string,
    reason?: string,
  ): Promise<ApiResult<AuditUnmaskResponse>> {
    return request<AuditUnmaskResponse>(
      `/api/v1/audit/${encodeURIComponent(String(id))}/unmask`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason ?? "" }),
      },
    );
  };
}

/** pii-redaction: GET /api/v1/audit/redaction-policies — return the
 *  tenant's effective redaction policy (default-deny list +
 *  JSONPath rules). Used by Settings > Compliance to show the
 *  current rule set. */
export function createGetAuditRedactionPolicy({
  request,
}: AuditOperationsDependencies) {
  return function getAuditRedactionPolicy(): Promise<
    ApiResult<AuditRedactionPolicy>
  > {
    return request<AuditRedactionPolicy>(`/api/v1/audit/redaction-policies`);
  };
}

/** pii-redaction: PUT /api/v1/audit/redaction-policies — replace the
 *  tenant's redaction policy. The Go side enforces the default-deny
 *  floor regardless of the supplied list. */
export function createPutAuditRedactionPolicy({
  request,
}: AuditOperationsDependencies) {
  return function putAuditRedactionPolicy(
    policy: AuditRedactionPolicy,
  ): Promise<ApiResult<AuditRedactionPolicy>> {
    return request<AuditRedactionPolicy>(`/api/v1/audit/redaction-policies`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    });
  };
}

/** GET /api/v1/audit/consistency-proof?from=N&to=M — proof that the
 *  new root extends the old root (no row was modified or removed). */
export function createGetConsistencyProof({
  request,
}: AuditOperationsDependencies) {
  return function getConsistencyProof(
    fromSize: number,
    toSize: number,
  ): Promise<ApiResult<ConsistencyProofResponse>> {
    const qs = new URLSearchParams({
      from: String(fromSize),
      to: String(toSize),
    }).toString();
    return request<ConsistencyProofResponse>(
      `/api/v1/audit/consistency-proof?${qs}`,
    );
  };
}

/** GET /api/v1/audit/checkpoint/latest — most recent signed root. */
export function createGetLatestAuditCheckpoint({
  request,
}: AuditOperationsDependencies) {
  return function getLatestAuditCheckpoint(): Promise<
    ApiResult<CheckpointResponse>
  > {
    return request<CheckpointResponse>(`/api/v1/audit/checkpoint/latest`);
  };
}

/* ---------- ECO-22: the chain one request wrote ------------------- */

/** One row of a correlation chain.
 *
 *  Deliberately narrower than `AuditRow`: the chain endpoint
 *  (apps/api/internal/handlers/audit_chain.go) omits the feed's per-row
 *  affordances — legal hold, retention override, AIVS bundles — because it
 *  does not support them, and returning them here would imply actions this
 *  read cannot perform.
 *
 *  Optionality mirrors the Go `omitempty` tags exactly: `id`, `action`,
 *  `resourceType` and `at` are always present; everything else can be ABSENT
 *  from the JSON rather than null. `metadata` is `omitempty` on a map, so an
 *  empty payload arrives as a missing key, not `{}`. */
export interface AuditChainRow {
  id: number;
  action: string;
  resourceType: string;
  resourceId?: string;
  actorType?: string;
  actorLabel?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

export interface AuditChainResponse {
  requestId: string;
  /** ASCENDING by id — the server orders a chain as a narrative (what
   *  happened, then what happened next), unlike the reverse-chronological
   *  feed. Render in the order received; re-sorting descending makes a causal
   *  chain read backwards. */
  rows: AuditChainRow[];
  /** The server hit its 500-row cap. Stated by the server rather than
   *  inferred from `rows.length`, so a reader is never left guessing whether
   *  the chain ended or was cut off. */
  truncated: boolean;
}

const AUDIT_CHAIN_ROW_KEYS = new Set([
  "id",
  "action",
  "resourceType",
  "resourceId",
  "actorType",
  "actorLabel",
  "userId",
  "ip",
  "userAgent",
  "metadata",
  "at",
]);

function decodeAuditChainRow(value: unknown): AuditChainRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isBoundedAuditJson(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !AUDIT_CHAIN_ROW_KEYS.has(key)))
    return null;
  if (
    !Number.isSafeInteger(row.id) ||
    Number(row.id) < 1 ||
    !boundedAuditText(row.action, 512) ||
    !boundedAuditText(row.resourceType, 128) ||
    !isAuditIsoInstant(row.at)
  ) {
    return null;
  }
  const result: AuditChainRow = {
    id: row.id as number,
    action: row.action,
    resourceType: row.resourceType,
    at: row.at,
  };
  for (const [key, maxLength] of [
    ["resourceId", 512],
    ["actorType", 64],
    ["actorLabel", 512],
    ["userId", 128],
    ["ip", 128],
    ["userAgent", 2_048],
  ] as const) {
    const decoded = optionalAuditText(row, key, maxLength);
    if (decoded === null) return null;
    if (decoded !== undefined) result[key] = decoded;
  }
  if ("metadata" in row) {
    if (
      !row.metadata ||
      typeof row.metadata !== "object" ||
      Array.isArray(row.metadata)
    ) {
      return null;
    }
    result.metadata = row.metadata as Record<string, unknown>;
  }
  return result;
}

export function decodeAuditChainPayload(
  value: unknown,
): AuditChainResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chain = value as Record<string, unknown>;
  if (
    Object.keys(chain).some(
      (key) => !["requestId", "rows", "truncated"].includes(key),
    ) ||
    !boundedTrimmedAuditText(chain.requestId, 256) ||
    chain.requestId === "-" ||
    typeof chain.truncated !== "boolean" ||
    !Array.isArray(chain.rows) ||
    chain.rows.length > 500
  ) {
    return null;
  }
  const rows: AuditChainRow[] = [];
  let previousID = 0;
  for (const value of chain.rows) {
    const row = decodeAuditChainRow(value);
    if (!row || row.id <= previousID) return null;
    previousID = row.id;
    rows.push(row);
  }
  if (chain.truncated && rows.length !== 500) return null;
  return {
    requestId: chain.requestId,
    rows,
    truncated: chain.truncated,
  };
}

/** The request id that ties this row to the others written by the same
 *  request, or null when the row carries none.
 *
 *  Rows written outside a request — workers, queue consumers — have no
 *  correlation id at all, so the affordance must be conditional: offering
 *  "view the chain" on such a row would open an empty view every time.
 *
 *  The `"-"` sentinel is refused by the endpoint (it would otherwise match
 *  every row that lacks the field), so a row carrying it has no chain that
 *  can be opened either. */
export function auditCorrelationId(row: {
  metadata?: Record<string, unknown> | null;
}): string | null {
  const context = row.metadata?.["context"];
  if (typeof context !== "object" || context === null) return null;
  const id = (context as Record<string, unknown>)["correlation_id"];
  if (!boundedAuditText(id, 256)) return null;
  const trimmed = id.trim();
  if (!trimmed || trimmed === "-") return null;
  return trimmed;
}

/** GET /api/v1/audit/chain/{requestId} — every audit row one request wrote,
 *  in causal order.
 *
 *  The id is percent-encoded because real correlation ids CONTAIN A SLASH:
 *  chi's generator builds `hostname/b64prefix-000001`
 *  (apps/api/internal/middleware/request_id.go), so an unencoded id splits
 *  into an extra path segment and misses the route. The server decodes it
 *  back with url.PathUnescape. Getting this wrong does not error — it returns
 *  an empty chain, which reads as "this request touched nothing": a confident
 *  wrong answer to the one question the endpoint exists for. The exact
 *  encoding is pinned against real chi routing by
 *  apps/api/internal/handlers/testdata/audit_chain_client_paths.json.
 *
 *  A request id that audited nothing is answered 200 with `rows: []`. That is
 *  an answer, not a failure, and callers must not render it as an error. */
export function createGetAuditChain({ request }: AuditOperationsDependencies) {
  return async function getAuditChain(
    requestId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<AuditChainResponse>> {
    if (!boundedTrimmedAuditText(requestId, 256) || requestId === "-") {
      return invalidAuditPayload("audit request-chain identifier");
    }
    const response = await request<unknown>(
      `/api/v1/audit/chain/${encodeURIComponent(requestId)}`,
      undefined,
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    const decoded = decodedAuditResult(
      response,
      decodeAuditChainPayload,
      "audit request chain",
    );
    if (!decoded.error && decoded.data.requestId !== requestId) {
      return invalidAuditPayload("audit request chain");
    }
    return decoded;
  };
}

export function createAuditOperationsMethods(
  dependencies: AuditOperationsDependencies,
) {
  return {
    listAudit: createListAudit(dependencies),
    getAuditStats: createGetAuditStats(dependencies),
    getAuditAnomalyScore: createGetAuditAnomalyScore(dependencies),
    getAuditRecentAnomalies: createGetAuditRecentAnomalies(dependencies),
    auditExportUrl: createAuditExportUrl(dependencies),
    auditExportUrlAuthed: createAuditExportUrlAuthed(dependencies),
    auditExportManifestsList: createAuditExportManifestsList(dependencies),
    apiAuditNLQ: createApiAuditNLQ(dependencies),
    apiAuditNLQCostStatus: createApiAuditNLQCostStatus(dependencies),
    getMyAuditScopes: createGetMyAuditScopes(dependencies),
    listRoles: createListRoles(dependencies),
    updateRoleScopes: createUpdateRoleScopes(dependencies),
    auditStreamUrl: createAuditStreamUrl(dependencies),
    auditStreamUrlAuthed: createAuditStreamUrlAuthed(dependencies),
    auditInvestigationStreamUrlAuthed:
      createAuditInvestigationStreamUrlAuthed(dependencies),
    listAuditSavedViews: createListAuditSavedViews(dependencies),
    createAuditSavedView: createCreateAuditSavedView(dependencies),
    updateAuditSavedView: createUpdateAuditSavedView(dependencies),
    deleteAuditSavedView: createDeleteAuditSavedView(dependencies),
    getAuditRetention: createGetAuditRetention(dependencies),
    setAuditRetention: createSetAuditRetention(dependencies),
    listRetentionActivity: createListRetentionActivity(dependencies),
    setEventRetentionOverride: createSetEventRetentionOverride(dependencies),
    createAuditPortalSession: createCreateAuditPortalSession(dependencies),
    listAuditPortalSessions: createListAuditPortalSessions(dependencies),
    revokeAuditPortalSession: createRevokeAuditPortalSession(dependencies),
    getInclusionProof: createGetInclusionProof(dependencies),
    auditSessionReplay: createAuditSessionReplay(dependencies),
    investigateAuditEvent: createInvestigateAuditEvent(dependencies),
    listAuditInvestigations: createListAuditInvestigations(dependencies),
    getAuditInvestigation: createGetAuditInvestigation(dependencies),
    approveAuditInvestigation: createApproveAuditInvestigation(dependencies),
    rejectAuditInvestigation: createRejectAuditInvestigation(dependencies),
    downloadAIVSBundle: createDownloadAIVSBundle(dependencies),
    auditUnmaskPII: createAuditUnmaskPII(dependencies),
    getAuditRedactionPolicy: createGetAuditRedactionPolicy(dependencies),
    putAuditRedactionPolicy: createPutAuditRedactionPolicy(dependencies),
    getConsistencyProof: createGetConsistencyProof(dependencies),
    getLatestAuditCheckpoint: createGetLatestAuditCheckpoint(dependencies),
    getAuditChain: createGetAuditChain(dependencies),
  };
}
