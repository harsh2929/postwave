import type { ApiErr, ApiResult, QueueableApiResult } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";
import { DEMO_DATA_FALLBACK_ENABLED } from "../config";
import {
  createListSubscriberChannelConsents,
  createSetSubscriberChannelConsent,
} from "./subscriber-channel-consents";

export {
  createListSubscriberChannelConsents,
  createSetSubscriberChannelConsent,
} from "./subscriber-channel-consents";

export type {
  ChannelConsent,
  ChannelConsentChannel,
  ChannelConsentStatus,
  UpdateChannelConsentInput,
} from "./subscriber-channel-consents";

export interface SubscriberProfilesRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export interface SubscriberUpdateRequestOptions extends SubscriberProfilesRequestOptions {
  /** Exact strong revision returned with the subscriber representation. */
  version: string;
}

const EXACT_SUBSCRIBER_VERSION_PATTERN =
  /^"subscriber:([A-Za-z0-9._~-]+):v[0-9]+"$/;
const SUBSCRIBER_DIRECTORY_ROW_LIMIT = 200;
const SUBSCRIBER_ID_MAX_CHARS = 256;
const SUBSCRIBER_EMAIL_MAX_CHARS = 320;
const SUBSCRIBER_CURSOR_MAX_CHARS = 4_096;
const UNSAFE_RESPONSE_TEXT = /[\u0000-\u001f\u007f]/u;

/**
 * True only for the server-owned strong revision syntax used by subscriber
 * compare-and-swap writers. Weak, wildcard, multi-value, and synthesized
 * validators must never authorize a consent decision.
 */
export function isExactSubscriberVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    value === value.trim() &&
    EXACT_SUBSCRIBER_VERSION_PATTERN.test(value)
  );
}

export function isExactSubscriberVersionFor(
  value: unknown,
  subscriberID: string | number,
): value is string {
  if (!isExactSubscriberVersion(value)) return false;
  const versionIdentity = EXACT_SUBSCRIBER_VERSION_PATTERN.exec(value)?.[1];
  return responseIdentityMatches(subscriberID, versionIdentity ?? "");
}

function hasMatchingExactSubscriberVersion(
  bodyVersion: unknown,
  serverVersion: unknown,
  subscriberID?: string | number,
): bodyVersion is string {
  return (
    isExactSubscriberVersion(bodyVersion) &&
    isExactSubscriberVersion(serverVersion) &&
    bodyVersion === serverVersion &&
    (subscriberID === undefined ||
      isExactSubscriberVersionFor(bodyVersion, subscriberID))
  );
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validDirectorySubscriber(row: unknown): row is Subscriber {
  const value = responseRecord(row);
  if (!value) return false;
  const id = value.id;
  const stableID =
    (typeof id === "string" &&
      id.length > 0 &&
      id.length <= SUBSCRIBER_ID_MAX_CHARS &&
      id === id.trim() &&
      !UNSAFE_RESPONSE_TEXT.test(id)) ||
    (typeof id === "number" && Number.isSafeInteger(id) && id >= 0);
  const email = value.email;
  return (
    stableID &&
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= SUBSCRIBER_EMAIL_MAX_CHARS &&
    email === email.trim() &&
    !UNSAFE_RESPONSE_TEXT.test(email) &&
    isExactSubscriberVersionFor(value.version, id)
  );
}

function validSubscriberDirectoryResponse(
  payload: unknown,
  request: { page?: number; cursor?: string },
): payload is SubscribersResponse {
  const value = responseRecord(payload);
  if (!value) return false;
  const rowKeys = ["items", "data", "results"].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (rowKeys.length !== 1) return false;
  const rows = value[rowKeys[0] as keyof typeof value];
  if (!Array.isArray(rows) || rows.length > SUBSCRIBER_DIRECTORY_ROW_LIMIT) {
    return false;
  }
  const total = value.total;
  const page = value.page;
  const perPage = value.per_page;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    typeof perPage !== "number" ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > SUBSCRIBER_DIRECTORY_ROW_LIMIT ||
    rows.length > perPage
  ) {
    return false;
  }
  if (
    request.page !== undefined &&
    Number.isSafeInteger(request.page) &&
    request.page > 0 &&
    page !== request.page
  ) {
    return false;
  }
  if (
    !request.cursor &&
    rows.length > 0 &&
    total < (page - 1) * perPage + rows.length
  ) {
    return false;
  }
  if (request.cursor && total !== 0) return false;
  if (
    value.next_cursor !== undefined &&
    (typeof value.next_cursor !== "string" ||
      value.next_cursor.length === 0 ||
      value.next_cursor.length > SUBSCRIBER_CURSOR_MAX_CHARS ||
      UNSAFE_RESPONSE_TEXT.test(value.next_cursor))
  ) {
    return false;
  }
  const identities = new Set<string>();
  for (const row of rows) {
    if (!validDirectorySubscriber(row)) return false;
    const identity = String(row.id).trim().toLowerCase();
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

export type SubscriberProfilesRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: SubscriberProfilesRequestOptions,
) => Promise<ApiResult<T>>;

export type SubscriberProfilesQueueableRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: SubscriberProfilesRequestOptions,
) => Promise<QueueableApiResult<T>>;

export interface Subscriber {
  id?: string | number;
  /** Strong profile revision. Echo in If-Match on generic profile PATCHes. */
  version?: string;
  /**
   * SUB-017 — stable synthetic profile identifier (migration 0453),
   * distinct from the physical row `id`. It sits at the top of the
   * identifier-precedence hierarchy (profile_id > external_id > email >
   * phone > anonymous) used by identify/merge. Opaque to operators —
   * auto-assigned on insert and `omitempty` on the wire, so it is only
   * present on rows scanned after the column existed. Surfaced read-only
   * in the slideover Profile tab for support/debugging.
   */
  profile_id?: string;
  email: string;
  /**
   * SUB-016 — canonical contact address mirrored from the primary row in
   * the subscriber_emails junction table. Absent on older deployments /
   * rows that predate the column; falls back to `email` for display.
   */
  primary_email?: string;
  external_id?: string;
  status?: string;
  created_at?: string;
  joined_at?: string;
  tags?: string[];
  name?: string;
  /**
   * First/last/full/display name columns (SUB-004). Promoted out of the
   * merge_fields/custom_fields jsonb into first-class subscriber columns so
   * they can be shown in the list table, sorted server-side (first_name /
   * last_name), and driven into picker UIs. Backed by `text NOT NULL DEFAULT
   * ''` on the server, so an empty string means "no name on file".
   */
  first_name?: string;
  last_name?: string;
  full_name?: string;
  display_name?: string;
  /**
   * SUB-009 — soft-delete marker. null/absent = active; a timestamp means
   * the row was archived (reversibly hidden, audit-join keys preserved).
   * Only returned to the list when ?include_archived=true.
   */
  archived_at?: string | null;
  /**
   * SUB-012 — canonical many-to-one link to the first-class `accounts`
   * (B2B company) object. null/absent = unlinked. `account_name` is a
   * convenience denormalisation the list endpoint may hydrate so the
   * optional Account column can render without a second fetch.
   */
  account_id?: string | null;
  account_name?: string | null;
  /**
   * SUB-023 — cross-tenant federation (agency/MSP). When present, this
   * child-workspace row is linked to a *master* subscriber in the agency
   * parent workspace, so the same human across an agency's client
   * workspaces is one master identity. null/absent = not federated.
   * Surfaced as a "Federated in [Parent]" badge on list rows and a
   * dedicated section in the detail slideover Profile tab.
   */
  federated_master_id?: string | null;
  /**
   * SUB-055 — jurisdiction-drift consent re-confirmation.
   * `detected_jurisdiction` is the ISO 3166-1 alpha-2 country inferred from
   * signup_ip; `jurisdiction_changed_at` stamps the most recent drift; and
   * `jurisdiction_reconfirm_required` is true when the drift entered a
   * stricter consent regime (GDPR / CASL / Quebec Law 25) and a fresh
   * consent decision is required. Cleared via
   * PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm. Absent on older
   * deployments / rows that predate the columns.
   */
  detected_jurisdiction?: string | null;
  jurisdiction_changed_at?: string | null;
  jurisdiction_reconfirm_required?: boolean;
  /**
   * SUB-010 — predictive-score versioning denormalisation. The scorer
   * stamps the current churn-score model lineage inline on the subscriber
   * row so the list table can render a Klaviyo-style explainability badge
   * (e.g. "v1 (0.85)") next to the score without a second fetch. The full
   * per-score-type version history + per-feature snapshot lives in the
   * prediction-metadata surface (GET /api/v1/subscribers/{id}/
   * prediction-metadata). Both are `omitempty` on the wire, so an absent
   * value means "no model has scored this subscriber yet".
   */
  prediction_model_version?: string | null;
  prediction_confidence?: number | null;
  /**
   * SUB-132 — subscriber-level send-cadence hint (migration 0180):
   * 'default' | 'weekly' | 'monthly' | 'paused'. Read during initial campaign
   * queue admission and intelligent-retry promotion so an actively paused
   * subscriber is not newly admitted. It does not withdraw a recipient who
   * was already queued before the pause committed. Always present server-side
   * (NOT NULL DEFAULT 'default'), but optional here for rows scanned before the
   * column / on older deployments.
   */
  frequency_preference?: FrequencyPreference;
  /**
   * SUB-132 — temporary-suppression auto-reactivation timestamp (migration
   * 0180). When `frequency_preference='paused'`, a non-null `paused_until`
   * in the future means "skip until then"; a null `paused_until` with
   * 'paused' means "paused indefinitely". null/absent in the common case.
   */
  paused_until?: string | null;
  /**
   * SUB-134 — per-topic opt-in state for this subscriber, hydrated only on
   * the detail GET (absent on list rows to avoid an N+1 topics fetch). Each
   * entry pairs a tenant topic with the subscriber's resolved opt-in state
   * (the topic's `default_opt_in` when no explicit row exists). The full
   * read/write surface is GET/PUT /api/v1/subscribers/{email}/topics and the
   * per-topic subscribe/unsubscribe endpoints.
   */
  preference_topics?: SubscriberTopicView[];
}

/**
 * SUB-132 — the subscriber-level frequency preference vocabulary, matching
 * the migration 0180 CHECK constraint. Keep in lockstep with the
 * `frequency_preference` enum in openapi.yaml.
 */
export type FrequencyPreference = "default" | "weekly" | "monthly" | "paused";

/**
 * SUB-134 — one tenant topic with the subscriber's resolved opt-in state, as
 * surfaced under `Subscriber.preference_topics` on the detail GET. Mirrors
 * `subscribers.SubscriberTopicView` (apps/api/internal/subscribers/types.go)
 * — note the flat shape (distinct from the nested
 * `preferences.SubscriberTopicView` the topics list endpoint returns).
 */
export interface SubscriberTopicView {
  /** The topics row id (used by the subscribe/unsubscribe endpoints). */
  topic_id: string;
  /** Operator-facing stable topic identifier. */
  slug: string;
  /** Human-readable topic name rendered in the preference center. */
  name: string;
  /** Optional topic blurb (empty when none). */
  description?: string;
  /** The topic's default opt-in state for subscribers with no explicit row. */
  default_opt_in: boolean;
  /** The topic's sort order in the preference center. */
  display_order: number;
  /** The subscriber's resolved opt-in state (explicit value, or the default). */
  opted_in: boolean;
}

/**
 * SUB-053 — one per-store DSAR fan-out receipt. Returned inline by
 * POST /api/v1/sar/requests (fanout_enabled=true, key `store_responses`,
 * which carries the live `action_taken`) and read back later via
 * GET /api/v1/sar/requests/{id}/store-responses. The persisted-row shape
 * omits `action_taken` (it isn't a stored column) but adds `id` +
 * `created_at`; both shapes share provider / status / customer / receipt.
 */
export interface DSARStoreResponse {
  id?: string;
  provider: "shopify" | "woocommerce" | "stripe" | "square" | string;
  status:
    | "found"
    | "returned"
    | "deleted"
    | "ack_required"
    | "not_found"
    | "error"
    | string;
  /** Provider-side customer id matched for the subject (empty when not found). */
  customer_id?: string;
  /** Live action the fan-out took. Present on the Create response only. */
  action_taken?:
    | "return_only"
    | "auto_delete"
    | "ack_required"
    | "none"
    | string;
  /** Compliance receipt URL proving the deletion/retention decision. */
  receipt_url?: string;
  /** Raw provider response (or {error}) for the audit trail. */
  response?: Record<string, unknown>;
  created_at?: string;
}

/**
 * The privacy operation submitted to POST /api/v1/sar/requests.
 *
 * This discriminator is deliberately required. Access and erasure have
 * different data, side-effect, and receipt contracts, so callers must never
 * rely on a server-side default.
 */
export type DSAROperation = "access" | "erase";

/** Required POST /api/v1/sar/requests payload. */
export interface DSARRequestInput {
  kind: DSAROperation;
  email: string;
  fanout_enabled: boolean;
  notes?: string;
  region?: string;
}

/** Read-only access-request result and downloadable disclosure metadata. */
export interface DSARAccessRequestResult {
  id: string;
  kind: "access";
  subscriber_email: string;
  status: string;
  event_count: number;
  consent_count: number;
  bundle_bytes: number;
  download_url: string;
  /** Present only when the request was created with fanout_enabled=true. */
  store_responses?: DSARStoreResponse[];
}

/**
 * Counts-only Moosewave erasure receipt.
 *
 * Erasure does not return a disclosure bundle or download URL and currently
 * does not erase connected provider stores.
 */
export interface DSAREraseRequestResult {
  id: string;
  kind: "erase";
  scope: "postwave";
  status: string;
  rows_deleted: number;
  placeholder: string;
  external_stores_affected: 0;
}

/** Operation-specific POST /api/v1/sar/requests response. */
export type DSARRequestResult =
  | DSARAccessRequestResult
  | DSAREraseRequestResult;

/** SUB-055 — PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm body. */
export interface JurisdictionReconfirmInput {
  decision: "accepted" | "declined";
  regime: "gdpr" | "casl" | "law25";
  privacy_policy_version: string;
  captured_text: string;
  /** Send the raw server string; parsing through Date loses PG microseconds. */
  expected_jurisdiction_changed_at: string;
  /** Exact strong version from the same reviewed subscriber detail response. */
  expected_subscriber_version: string;
}

export interface SubscribersResponse {
  // The Moosewave Go API returns rows under `items`. Older / mock backends
  // may use `data` or `results`. Pages read all three with a fallback chain.
  items?: Subscriber[];
  data?: Subscriber[];
  results?: Subscriber[];
  total?: number;
  page?: number;
  per_page?: number;
  /**
   * Keyset cursor for the next page (server-side paging at scale). Present
   * only on the cursor path and only when more rows exist; pass it back as
   * `cursor` to fetch the next page. On the cursor path `total` is 0 —
   * drive "load more" off this, not a count.
   */
  next_cursor?: string;
}

/**
 * SUB-089 — one parsed address in a bulk-paste response. `status` mirrors
 * the CSV-import per-row outcome vocabulary so the modal can reuse a single
 * results renderer.
 */
export interface BulkPasteRow {
  email: string;
  status: "created" | "updated" | "skipped" | "error";
  error?: string;
}

/**
 * SUB-089 — POST /api/v1/subscribers/bulk-paste response. `parsed` is the
 * count of distinct addresses extracted from the raw paste (after de-dupe);
 * the per-status counters sum to `parsed`.
 */
export interface BulkPasteResponse {
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  rows: BulkPasteRow[];
}

/* ---------- detail / patch types ------------------------------------ */

/**
 * SubscriberDetail extends Subscriber with full custom_fields + activity
 * summary. Mirrors `Subscriber` in apps/api/internal/subscribers/types.go.
 */
export interface SubscriberDetail extends Subscriber {
  custom_fields?: Record<string, unknown>;
  merge_fields?: Record<string, unknown>;
  activity_summary?: Record<string, unknown>;
  consent_source?: string;
  consent_timestamp?: string;
  /**
   * SUB-041 — per-purpose consent vector. Each field is the
   * state-of-record timestamp of the last `granted` consent event for
   * that purpose; null/absent = no recorded grant (treat as denied).
   * Read-only: auto-maintained server-side by the consent_events trigger
   * (the ledger is the source of truth), surfaced as timestamp badges in
   * the slideover Profile tab. Absent on deployments predating the column.
   */
  consent_email_marketing_at?: string | null;
  consent_sms_marketing_at?: string | null;
  consent_profiling_at?: string | null;
  consent_targeted_ads_at?: string | null;
  consent_ai_processing_at?: string | null;
  /**
   * Signup source — where the subscriber was captured. One of
   * 'embedded_form' | 'hosted_page' | 'import' | 'api' | 'integration' |
   * 'unknown'. Backed by subscribers.signup_source (migration 0303).
   * Surfaced in the subscriber detail slideover and used as a filter in
   * the segment builder + automation triggers so welcome flows can fork
   * on origin without manual tagging.
   */
  signup_source?: string;
  /**
   * Localization columns (SUB-005). All four are nullable on the server
   * (`omitempty` on the wire), so an absent/null value means "never set".
   * `language` is ISO 639-1 alpha-2, `country` is ISO 3166-1 alpha-2,
   * `locale` is a BCP-47-ish tag, and `region` is free-text. Surfaced as
   * read-only badges in the slideover Profile tab; full edit UI (ISO
   * comboboxes) is deferred to Phase 2.
   */
  locale?: string | null;
  language?: string | null;
  country?: string | null;
  region?: string | null;
  updated_at?: string;
  /**
   * SUB-059 / SUB-060 — first-class predictive projection (historic /
   * predicted / total CLV in cents, churn risk, data-sufficiency band) plus
   * the SUB-060 ranked top-3 explainable churn drivers. Hydrated on the
   * detail GET via a LEFT JOIN on profile_predictions (populated by the
   * predictive worker); absent when the worker hasn't scored this email yet.
   */
  prediction?: SubscriberPrediction | null;
  /**
   * SUB-061 — predicted timestamp of the next order, projected by the
   * commerce replenishment-cadence worker as last_order_at +
   * average_days_between_orders. Hydrated on the detail GET; absent when
   * the profile has no computed cadence yet.
   */
  expected_next_order_at?: string | null;
  /**
   * SUB-062 — compact repeat-purchase cadence (average days between
   * orders + when it was last computed), hydrated inline on the detail
   * GET. Absent when the profile has no computed cadence yet.
   */
  order_cadence_metrics?: OrderCadenceMetrics | null;
  /**
   * SUB-063 — confidence-labelled inferred demographics (gender / age
   * group / interests). Hydrated on the detail GET; absent when no
   * demographic was inferred for this profile.
   */
  demographics?: Demographics | null;
}

/**
 * SUB-060 — one explainable contributor to a churn prediction. `impact` is
 * a coarse band ('high' | 'medium' | 'low'); `value` is the human-readable
 * driver detail (e.g. "62 days since last open").
 */
export interface SubscriberChurnDriver {
  key: string;
  label: string;
  value: string;
  impact: "high" | "medium" | "low" | string;
}

/**
 * SUB-059 — subscriber-level predictive payload surfaced on the detail GET.
 * A read-only projection of the profile_predictions row, narrowed to the
 * fields the slideover's Insights section renders.
 */
export interface SubscriberPrediction {
  /** Realised lifetime value to date, in cents. */
  historic_clv_cents: number;
  /** Modelled forward lifetime value, in cents. */
  predicted_clv_cents: number;
  /** historic + predicted, in cents — the headline CLV. */
  total_clv_cents: number;
  /** Churn probability in [0,1]. */
  churn_risk: number;
  /** Model confidence in [0,1]. */
  confidence: number;
  /** 'insufficient' | 'limited' | 'sufficient'. */
  data_sufficiency: string;
  /** SUB-060 ranked top-3 explainable churn drivers (highest impact first). */
  churn_drivers: SubscriberChurnDriver[];
  /** When the predictive worker last scored this profile. */
  calculated_at: string;
}

/**
 * SUB-010 — one versioned predictive-score metadata snapshot (migration
 * 0900): a single current row per (subscriber, score_type) carrying the
 * model lineage, confidence, and a per-feature explainability snapshot
 * for a cached churn/engagement scalar.
 */
export interface PredictionMetadata {
  id: string;
  subscriber_id: string;
  /** Which cached predictive scalar this metadata explains. */
  score_type: "churn" | "engagement" | string;
  /** Freeform model version (e.g. "heuristic-v1", "churn-xgb-v2"). */
  model_version: string;
  /** Model confidence in [0,1]; null = below the minimum-data threshold. */
  confidence?: number | null;
  /** Per-feature explainability snapshot (top features / weights / raw value). */
  features?: Record<string, unknown>;
  computed_at: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * SUB-010 — GET /api/v1/subscribers/{id}/prediction-metadata response:
 * every per-score-type metadata snapshot for one subscriber. An empty
 * `items` list means no model has scored this subscriber yet.
 */
export interface PredictionMetadataList {
  subscriber_id: string;
  items: PredictionMetadata[];
}

export const SUBSCRIBER_LIFECYCLE_STAGES = [
  "subscriber",
  "lead",
  "mql",
  "sql",
  "opportunity",
  "customer",
  "evangelist",
  "other",
] as const;

export type SubscriberLifecycleStage =
  (typeof SUBSCRIBER_LIFECYCLE_STAGES)[number];

const SUBSCRIBER_LIFECYCLE_STAGE_SET = new Set<string>(
  SUBSCRIBER_LIFECYCLE_STAGES,
);
const RFC3339_LIFECYCLE_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface SubscriberLifecycle {
  subscriber_id: string;
  subscriber_version: string;
  tenant_id: string;
  stage: SubscriberLifecycleStage;
  previous_stage?: SubscriberLifecycleStage;
  score: number;
  transitioned?: boolean;
  transitioned_at?: string;
  updated_at: string;
}

function isLifecycleTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !RFC3339_LIFECYCLE_TIMESTAMP_RE.test(value)
  ) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const offsetHour = value.endsWith("Z") ? 0 : Number(value.slice(-5, -3));
  const offsetMinute = value.endsWith("Z") ? 0 : Number(value.slice(-2));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function hasValidLifecycleTransitionFields(
  lifecycle: SubscriberLifecycle,
): boolean {
  if (
    lifecycle.previous_stage !== undefined &&
    !SUBSCRIBER_LIFECYCLE_STAGE_SET.has(lifecycle.previous_stage)
  ) {
    return false;
  }
  if (
    lifecycle.transitioned !== undefined &&
    typeof lifecycle.transitioned !== "boolean"
  ) {
    return false;
  }
  if (
    lifecycle.transitioned_at !== undefined &&
    !isLifecycleTimestamp(lifecycle.transitioned_at)
  ) {
    return false;
  }
  if (lifecycle.transitioned === true) {
    return (
      lifecycle.previous_stage !== undefined &&
      lifecycle.previous_stage !== lifecycle.stage &&
      lifecycle.transitioned_at !== undefined &&
      Date.parse(lifecycle.transitioned_at) <= Date.parse(lifecycle.updated_at)
    );
  }
  return (
    lifecycle.previous_stage === undefined &&
    lifecycle.transitioned_at === undefined
  );
}

export type SubscriberAliasType =
  | "email"
  | "external_id"
  | "anonymous_id"
  | "phone"
  | "device_token"
  | "push_token"
  | "custom";

export interface SubscriberAlias {
  id: string;
  subscriber_id: string;
  alias_type: SubscriberAliasType;
  alias_value: string;
  confidence: number;
  source: string;
  provenance?: Record<string, unknown>;
  first_seen_at?: string;
  last_seen_at?: string;
  created_at?: string;
  updated_at?: string;
  /** Fresh parent-subscriber revision returned by alias mutations. */
  subscriber_version?: string;
  /** Canonical external_id after this mutation; null means it was cleared. */
  external_id?: string | null;
}

export interface SubscriberAliasList {
  items: SubscriberAlias[];
  subscriber_version?: string;
}

export interface SubscriberAliasDeleteResult {
  deleted: boolean;
  subscriber_id: string;
  subscriber_version: string;
  external_id: string | null;
}

/**
 * SUB-120 — one row of the per-jurisdiction GPP change ledger. Mirrors
 * `subscribers.GppAuditEntry` JSON tags (apps/api/internal/subscribers/gpp.go).
 * `source` is the provenance of the change (cmp_webhook / manual_override /
 * import / api).
 */
export interface GppAuditEntry {
  id: string;
  subscriber_id: string;
  jurisdiction: string;
  section_value: string;
  source: string;
  created_at: string;
}

/**
 * SUB-120 — GET /api/v1/subscribers/{id}/gpp response. `sections` is the
 * current per-jurisdiction IAB Global Privacy Platform map (e.g.
 * {"usnat": "BACnBBBB…"}), stored verbatim — no decoding at this phase.
 * `audit` is the change ledger, newest-first (capped at 100). Mirrors
 * `subscribers.GppResponse`.
 */
export interface GppSectionsResponse {
  subscriber_id: string;
  sections: Record<string, string>;
  audit: GppAuditEntry[];
}

/**
 * SUB-016 — one address attached to a profile. A profile may own up to
 * {@link MAX_EMAILS_PER_PROFILE} addresses, each with independent consent /
 * suppression / engagement state. Exactly one address is the primary
 * (canonical) address, mirrored onto `subscribers.primary_email`.
 * Backed by GET/POST/PATCH/DELETE /api/v1/subscribers/{id}/emails
 * (apps/api/internal/subscribers/multi_email.go).
 */
export interface SubscriberEmail {
  id: string;
  subscriber_id: string;
  email: string;
  is_primary: boolean;
  /** subscribed | unsubscribed | never_subscribed | pending | unknown — per-address consent. */
  consent_status: string;
  suppressed: boolean;
  last_engaged_at?: string;
  created_at: string;
  updated_at: string;
  /** Strong address revision token. Echo in If-Match for PATCH/DELETE. */
  version: string;
}

/** SUB-016 — server caps a profile at this many addresses (MaxEmailsPerProfile). */
export const MAX_EMAILS_PER_PROFILE = 5;

/** Allowed per-address consent states (mirror normalizeConsentStatus).
 * SUB-044 adds never_subscribed as the explicit third state (the address was
 * added but the contact has never opted in), distinct from unknown (no
 * recorded signal either way). */
export type SubscriberEmailConsent =
  | "subscribed"
  | "unsubscribed"
  | "never_subscribed"
  | "pending"
  | "unknown";

export interface SubscriberEmailConsentEvidence {
  source: string;
  channel: string;
  legal_basis: string;
  occurred_at: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policy_version: string;
}

export interface SubscriberEmailAddInput {
  email: string;
  /** Secondary-address creation cannot rotate the canonical identity. */
  is_primary?: false;
  consent_status?: SubscriberEmailConsent;
  source?: string;
  channel?: string;
  legal_basis?: string;
  occurred_at?: string;
  jurisdiction?: string;
  evidence?: string;
  reason?: string;
  policy_version?: string;
}

export type SubscriberEmailUpdateInput =
  | ({
      consent_status: SubscriberEmailConsent;
    } & SubscriberEmailConsentEvidence)
  | {
      suppressed: boolean;
      suppression_reason: string;
      suppression_evidence?: string;
    };

export interface SubscriberComputedTrait {
  id: string;
  subscriber_id: string;
  key: string;
  value: unknown;
  value_type: "string" | "number" | "boolean" | "date" | "datetime" | "json";
  source: "operator" | "api" | "model" | "warehouse" | "system";
  model_version?: string;
  confidence?: number;
  drivers?: Array<Record<string, unknown>>;
  computed_at?: string;
  updated_at?: string;
}

export interface SubscriberEventInput {
  event_name: string;
  event_type?: string;
  metadata?: Record<string, unknown>;
  source_event_id?: string;
  occurred_at?: string;
}

export interface SubscriberEventRecord {
  id: number;
  subscriber_id: string;
  subscriber_email: string;
  event_name?: string;
  event_type: string;
  source: string;
  source_event_id?: string;
  metadata?: Record<string, unknown>;
  at: string;
  deduped?: boolean;
}

/**
 * Pinned vocabulary for SubscriberDetail.signup_source. Mirrors the
 * CHECK-constrained values in migration 0303 — keep in lockstep with
 * apps/api/internal/subscribers/types.go.
 */
export const SIGNUP_SOURCES = [
  "embedded_form",
  "hosted_page",
  "import",
  "api",
  "integration",
  "unknown",
] as const;

export type SignupSource = (typeof SIGNUP_SOURCES)[number];

/** Human-readable label for a signup_source value. */
export function signupSourceLabel(s: string | undefined | null): string {
  switch (s) {
    case "embedded_form":
      return "Embedded form";
    case "hosted_page":
      return "Hosted page";
    case "import":
      return "CSV import";
    case "api":
      return "API";
    case "integration":
      return "Integration";
    default:
      return "Unknown";
  }
}

/**
 * One row in the subscriber activity timeline. The `/activity` endpoint
 * isn't built yet — this is the shape we expect when it lands, derived
 * from `campaign_report_events`.
 */
export interface SubscriberActivity {
  id?: string;
  /** "sent" | "opened" | "clicked" | "bounced" | "unsubscribed" | "complained" */
  type: string;
  campaign_id?: string;
  campaign_name?: string;
  link_url?: string;
  at: string;
}

/**
 * SUB-117 — one normalized group membership for a subscriber. Joins the
 * subscriber_group_memberships junction row to its subscriber_groups
 * definition so the caller gets the human-facing label fields
 * (category / name / type) without a second lookup.
 */
export interface SubscriberGroupMembership {
  group_id: string;
  category: string;
  name: string;
  type: string;
  joined_at: string;
}

/** SUB-117 — body of GET /api/v1/subscribers/{id}/groups. */
export interface SubscriberGroupMembershipsResponse {
  subscriber_id: string;
  groups: SubscriberGroupMembership[];
}

/** PATCH body for /api/v1/subscribers/{id}. */
export interface SubscriberUpdateInput {
  email?: string;
  status?: string;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  merge_fields?: Record<string, unknown>;
  unsubscribe_reason?: string;
  /**
   * A generic status=enabled transition is a new exact-address email grant,
   * not a harmless status toggle. These fields must travel as one reviewed
   * envelope. The runtime client rejects partial grants before transport and
   * always requires an online response for this transition.
   */
  consent_timestamp?: string;
  consent_source?: string;
  consent_channel?: string;
  consent_legal_basis?: string;
  consent_jurisdiction?: string;
  consent_evidence?: string;
  consent_reason?: string;
  consent_policy_version?: string;
  /**
   * First-class name columns (SUB-004). An omitted key leaves the column
   * untouched; an explicit empty string clears it (server normalises to '').
   */
  first_name?: string;
  last_name?: string;
  full_name?: string;
  display_name?: string;
  /**
   * Localization columns (SUB-005). An omitted key is a no-op; an explicit
   * value (including "") updates the column ("" → NULL server-side).
   */
  locale?: string;
  language?: string;
  country?: string;
  region?: string;
  /**
   * SUB-132 — subscriber-level send-cadence hint (migration 0180 column).
   * An omitted key is a no-op; an explicit value must be one of
   * 'default' | 'weekly' | 'monthly' | 'paused' (server-validated).
   */
  frequency_preference?: FrequencyPreference;
  /**
   * SUB-132 — auto-reactivation timestamp. Send an ISO timestamp to set it,
   * or use `clear_paused_until` to drop it (the two intents are distinct
   * since an omitted `paused_until` means "leave unchanged").
   */
  paused_until?: string | null;
  /** SUB-132 — when true, clears `paused_until` (sets it NULL) server-side. */
  clear_paused_until?: boolean;
  /**
   * SUB-135 vacation-mode convenience: when > 0, the number of days from now
   * to auto-reactivation. The server computes `paused_until = now + pause_days`
   * and pins `frequency_preference` to 'paused' when unset. Bounded 1..365
   * (out-of-range 422s); mutually exclusive with `clear_paused_until`.
   */
  pause_days?: number;
}

export interface SubscriberEnableConsentInput extends SubscriberUpdateInput {
  status: "enabled";
  consent_timestamp: string;
  consent_source: "double_optin" | "single_optin";
  consent_channel: string;
  consent_legal_basis: string;
  consent_jurisdiction: string;
  consent_evidence: string;
  consent_reason: string;
  consent_policy_version: string;
}

/* ---------------------------------------------------------------------
 * SUB-012 — first-class B2B Account / Company object.
 * Mirrors apps/api/internal/accounts/types.go.
 * ------------------------------------------------------------------- */

/** One persisted org/company row. Many contacts point at it via
 *  `subscribers.account_id`. */
export interface Account {
  id: string;
  tenant_id?: string;
  name: string;
  industry?: string;
  country?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** Body of POST /api/v1/accounts. */
export interface AccountCreateInput {
  name: string;
  industry?: string;
  country?: string;
  metadata?: Record<string, unknown>;
}

/** Body of PATCH /api/v1/accounts/{id}. Omitted keys are left untouched. */
export interface AccountUpdateInput {
  name?: string;
  industry?: string;
  country?: string;
  metadata?: Record<string, unknown>;
}

/** Response envelope for GET /api/v1/accounts. */
export interface AccountPage {
  items: Account[];
  total: number;
}

/* ---------------------------------------------------------------------
 * SUB-013 — catalog-linked profile attributes.
 * Mirrors apps/api/internal/subscribers/catalog_attributes.go.
 * ------------------------------------------------------------------- */

/** The structured `favorite_category` trait value. */
export interface FavoriteCategoryValue {
  category: string;
  count: number;
  timestamp?: string;
}

/**
 * Read view over the two catalog computed-traits for a subscriber.
 * `favorite_category` is JSON-shaped ({category, count, timestamp}) when
 * present, `last_viewed_sku` is a SKU string. Either field is null when
 * the trait has never been computed.
 */
export interface CatalogAttributes {
  subscriber_id: string;
  favorite_category: FavoriteCategoryValue | null;
  last_viewed_sku: string | null;
  computed_at?: string;
}

/** PATCH body for /api/v1/subscribers/{id}/catalog-attributes. At least
 *  one field must be present. */
export interface CatalogAttributesInput {
  favorite_category?: FavoriteCategoryValue;
  last_viewed_sku?: string;
}

/* ---------------------------------------------------------------------
 * SUB-061 / SUB-062 — replenishment cadence (expected next order +
 * average days between orders). Mirrors
 * apps/api/internal/subscribers/replenishment_cadence.go: three
 * computed-trait signals (average_days_between_orders /
 * expected_next_order_at / last_order_at) the commerce cadence worker
 * maintains from order history. Any field is null when never computed.
 * ------------------------------------------------------------------- */

export interface ReplenishmentCadence {
  subscriber_id: string;
  /** Rolling mean number of days between consecutive orders. */
  average_days_between_orders: number | null;
  /** Predicted timestamp of the next order (last_order_at + average). */
  expected_next_order_at: string | null;
  /** Most recent order timestamp. */
  last_order_at: string | null;
  /** When the cadence signals were last refreshed. */
  computed_at?: string;
}

/**
 * SUB-062 — compact repeat-purchase projection hydrated inline on the
 * subscriber detail GET (mirrors subscribers.OrderCadenceMetrics).
 * Absent when the profile has no computed cadence (no / single order).
 */
export interface OrderCadenceMetrics {
  average_days_between_orders: number;
  last_computed_at: string;
}

/* ---------------------------------------------------------------------
 * SUB-063 — confidence-labelled inferred demographics (gender / age
 * group / interests). Mirrors apps/api/internal/subscribers/
 * demographics.go: each trait carries the model confidence in [0,1].
 * A field is null when the demographic was never inferred.
 * ------------------------------------------------------------------- */

/** One confidence-labelled inferred demographic. */
export interface DemographicTrait {
  value: unknown;
  confidence?: number;
  source?: string;
  computed_at?: string;
}

/** Composite read view over the three inferred-demographic traits. */
export interface Demographics {
  subscriber_id: string;
  gender: DemographicTrait | null;
  age_group: DemographicTrait | null;
  interests: DemographicTrait | null;
}

/* ---------------------------------------------------------------------
 * SUB-014 — workspace-scoped reference collections (lookup tables).
 * Mirrors apps/api/internal/collections/types.go.
 * ------------------------------------------------------------------- */

export type CollectionType = "coupons" | "content" | "schedule";
export type CollectionSourceType = "uploaded" | "api" | "manual";

/** One row in a collection — an arbitrary column→value map. */
export type CollectionRow = Record<string, unknown>;

/** One persisted reference-collection row. */
export interface Collection {
  id: string;
  tenant_id?: string;
  name: string;
  collection_type: CollectionType;
  source_type: CollectionSourceType;
  /** Empty on metadata-list responses; populated by the privileged detail read. */
  data: CollectionRow[];
  /** Exact persisted row count, including metadata responses without row bodies. */
  row_count: number;
  created_at?: string;
  updated_at?: string;
  /** Positive compare-and-swap revision returned by every read. */
  version: number;
}

/** Body of POST /api/v1/collections. */
export interface CollectionCreateInput {
  name: string;
  collection_type?: CollectionType;
  source_type?: CollectionSourceType;
  data?: CollectionRow[];
}

/** Body of PATCH /api/v1/collections/{id}. Omitted keys are left
 *  untouched; a present `data` (even []) replaces the rows. */
export interface CollectionUpdateInput {
  name?: string;
  collection_type?: CollectionType;
  source_type?: CollectionSourceType;
  data?: CollectionRow[];
}

/** Response envelope for GET /api/v1/collections. */
export interface CollectionPage {
  items: Collection[];
  total: number;
  next_cursor?: string;
}

export function createListSubscribers(request: SubscriberProfilesRequester) {
  return async function listSubscribers(
    opts: {
      query?: string;
      status?: string;
      sort?: string;
      order?: "asc" | "desc";
      page?: number;
      perPage?: number;
      /**
       * Keyset cursor for scale paging. Honoured only under the default
       * sort (updated_at desc); pass the previous response's `next_cursor`.
       * When set, the server pages via keyset (O(1) deep pages) and `total`
       * comes back 0 — use `next_cursor` to drive "load more".
       */
      cursor?: string;
      /**
       * SUB-009 — include soft-deleted (archived) rows. Archived rows are
       * hidden by default; the "Show archived" list toggle flips this on.
       */
      includeArchived?: boolean;
    } = {},
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscribersResponse>> {
    const params = new URLSearchParams();
    if (opts.query) params.set("q", opts.query);
    if (opts.status) params.set("status", opts.status);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.order) params.set("order", opts.order);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.includeArchived) params.set("include_archived", "true");
    const qs = params.toString();
    const response = await request<SubscribersResponse>(
      `/api/v1/subscribers${qs ? `?${qs}` : ""}`,
      {},
      reqOpts,
    );
    if (response.error) return response;
    if (!validSubscriberDirectoryResponse(response.data, opts)) {
      return responseContractFailure(
        "The subscriber service returned an invalid directory page. The previous verified data was kept; retry the request.",
      );
    }
    return response;
  };
}

export function createCreateSubscriber(request: SubscriberProfilesRequester) {
  return function createSubscriber(input: {
    email: string;
    tags?: string[];
    name?: string;
    status?: "enabled" | "unconfirmed";
    consent_source?: "double_optin" | "single_optin";
    consent_timestamp?: string;
    consent_channel?: string;
    consent_legal_basis?: string;
    consent_evidence?: string;
    consent_reason?: string;
    consent_policy_version?: string;
    country?: string;
  }): Promise<ApiResult<Subscriber>> {
    return request<Subscriber>("/api/v1/subscribers", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        tags: input.tags ?? [],
        merge_fields: input.name ? { name: input.name } : undefined,
        status: input.status ?? "unconfirmed",
        consent_source: input.consent_source,
        consent_timestamp: input.consent_timestamp,
        consent_channel: input.consent_channel,
        consent_legal_basis: input.consent_legal_basis,
        consent_evidence: input.consent_evidence,
        consent_reason: input.consent_reason,
        consent_policy_version: input.consent_policy_version,
        country: input.country,
      }),
    });
  };
}

/**
 * SUB-089 — bulk-paste a raw address list into the add-subscriber modal.
 * `emails` is a single raw string (newline / comma / semicolon /
 * whitespace separated); the server parses it into distinct addresses,
 * upserts each as unconfirmed/non-sendable, and returns per-address outcomes
 * inline. Capped at 100 distinct addresses per call (422 `too_many_emails`
 * over the cap); shared tags may be applied to every parsed address. Import
 * provenance is never treated as consent proof on this convenience path.
 */
export function createBulkPasteSubscribers(
  request: SubscriberProfilesRequester,
) {
  return function bulkPasteSubscribers(input: {
    emails: string;
    status?: "unconfirmed";
    tags?: string[];
  }): Promise<ApiResult<BulkPasteResponse>> {
    return request<BulkPasteResponse>("/api/v1/subscribers/bulk-paste", {
      method: "POST",
      body: JSON.stringify({
        emails: input.emails,
        status: input.status,
        tags: input.tags,
      }),
    });
  };
}

/* ---------- subscriber detail ------------------------------------- */

/** GET /api/v1/subscribers/{id} */
export function createGetSubscriber(request: SubscriberProfilesRequester) {
  return async function getSubscriber(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberDetail>> {
    const response = await request<SubscriberDetail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}`,
      undefined,
      opts,
    );
    if (!response.error) {
      const detail = response.data as Partial<SubscriberDetail>;
      const returnedID = detail.id;
      if (
        returnedID === undefined ||
        !validDirectorySubscriber(detail) ||
        !hasMatchingExactSubscriberVersion(
          detail.version,
          response.serverVersion,
          returnedID,
        )
      ) {
        return responseContractFailure(
          "The subscriber service returned a profile without one stable identity and matching exact revision. The previous verified data was kept; retry the request.",
        );
      }
      const expected = String(id).trim();
      const matchesStableID = responseIdentityMatches(expected, returnedID);
      const matchesEmailLookup =
        expected.includes("@") &&
        [detail.email, detail.primary_email].some(
          (email) =>
            typeof email === "string" &&
            responseIdentityMatches(expected, email),
        );
      if (!matchesStableID && !matchesEmailLookup) {
        return responseIdentityMismatch("subscriber");
      }
    }
    return response;
  };
}

/**
 * GET /api/v1/subscribers/{id}/activity
 *
 * Wired in the Moosewave Go API at apps/api/internal/subscribers/
 * activity.go. Callers should still tolerate transient errors (the
 * slideover does) but the endpoint itself is live.
 */
export function createGetSubscriberActivity(
  request: SubscriberProfilesRequester,
) {
  return function getSubscriberActivity(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberActivity[]>> {
    return request<SubscriberActivity[]>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/activity`,
      undefined,
      opts,
    );
  };
}

/**
 * SUB-010 — GET /api/v1/subscribers/{id}/prediction-metadata. Returns
 * every per-score-type predictive metadata snapshot for one subscriber
 * (the version-history surface, migration 0900): model_version,
 * confidence, and a per-feature explainability snapshot behind each
 * cached churn/engagement scalar. An empty items list means no model has
 * scored this subscriber yet. Callers should tolerate a 404 (route not
 * deployed) by hiding the section.
 */
export function createGetSubscriberPredictionMetadata(
  request: SubscriberProfilesRequester,
) {
  return function getSubscriberPredictionMetadata(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<PredictionMetadataList>> {
    return request<PredictionMetadataList>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/prediction-metadata`,
      undefined,
      opts,
    );
  };
}

/**
 * GET /api/v1/subscribers/{id}/groups (SUB-117)
 *
 * Normalized group memberships for one subscriber, resolved by Moosewave
 * id or email. Each membership joins the subscriber_group_memberships
 * junction row to its subscriber_groups definition (category / name /
 * type) so the slide-over can render labels without a second call. This
 * is the operator-facing (auth) counterpart to the public storefront
 * personalization read used by site/app integrations.
 */
export function createGetSubscriberGroupMemberships(
  request: SubscriberProfilesRequester,
) {
  return function getSubscriberGroupMemberships(
    id: string | number,
  ): Promise<ApiResult<SubscriberGroupMembershipsResponse>> {
    return request<SubscriberGroupMembershipsResponse>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/groups`,
    );
  };
}

const SUBSCRIBER_CONSENT_CHANNELS = new Set([
  "web",
  "mobile",
  "desktop",
  "email",
  "import",
  "api",
]);
const SUBSCRIBER_CONSENT_LEGAL_BASES = new Set([
  "consent",
  "contract",
  "legitimate_interest",
  "legal_obligation",
]);
const SUBSCRIBER_ENABLE_EVIDENCE_KEYS = [
  "consent_timestamp",
  "consent_source",
  "consent_channel",
  "consent_legal_basis",
  "consent_jurisdiction",
  "consent_evidence",
  "consent_reason",
  "consent_policy_version",
] as const satisfies readonly (keyof SubscriberUpdateInput)[];
const SUBSCRIBER_CONSENT_SINGLE_LINE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const SUBSCRIBER_CONSENT_MULTILINE_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;

function subscriberUpdateInputFailure(message: string): ApiErr {
  return {
    error: {
      kind: "http",
      status: 400,
      code: "invalid_subscriber_status_consent_input",
      message,
    },
    retryability: "not-retryable",
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Mirrors the server's generic PATCH consent firewall. It also normalizes the
 * reviewed envelope before serialization so whitespace/casing cannot make the
 * operator's confirmation differ from the immutable proof that is stored.
 */
export function normalizeSubscriberUpdateInput(
  patch: SubscriberUpdateInput,
  now = Date.now(),
): { patch: SubscriberUpdateInput; grant: boolean } | { error: ApiErr } {
  const status = trimmedString(patch.status).toLowerCase();
  const grant = status === "enabled";
  const hasEvidenceClaim = SUBSCRIBER_ENABLE_EVIDENCE_KEYS.some(
    (key) => patch[key] !== undefined,
  );
  if (!grant && hasEvidenceClaim) {
    return {
      error: subscriberUpdateInputFailure(
        "Consent evidence can only be submitted with an explicit enabled transition.",
      ),
    };
  }
  if (!grant) return { patch, grant: false };

  const source = trimmedString(patch.consent_source).toLowerCase();
  const channel = trimmedString(patch.consent_channel).toLowerCase();
  const legalBasis = trimmedString(patch.consent_legal_basis).toLowerCase();
  const jurisdiction = trimmedString(patch.consent_jurisdiction).toUpperCase();
  const evidence = trimmedString(patch.consent_evidence);
  const reason = trimmedString(patch.consent_reason);
  const policyVersion = trimmedString(patch.consent_policy_version);
  const capturedAt = trimmedString(patch.consent_timestamp);
  const timestamp = Date.parse(capturedAt);
  if (source !== "double_optin" && source !== "single_optin") {
    return {
      error: subscriberUpdateInputFailure(
        "Enabling a subscriber requires a reviewed single- or double-opt-in source.",
      ),
    };
  }
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000) {
    return {
      error: subscriberUpdateInputFailure(
        "Enter a valid consent capture time that is not in the future.",
      ),
    };
  }
  if (!SUBSCRIBER_CONSENT_CHANNELS.has(channel)) {
    return {
      error: subscriberUpdateInputFailure(
        "Select the channel where the consent decision was captured.",
      ),
    };
  }
  if (!SUBSCRIBER_CONSENT_LEGAL_BASES.has(legalBasis)) {
    return {
      error: subscriberUpdateInputFailure(
        "Select the legal basis reviewed for this consent decision.",
      ),
    };
  }
  if (
    !jurisdiction ||
    utf8Bytes(jurisdiction) > 32 ||
    SUBSCRIBER_CONSENT_SINGLE_LINE_CONTROL.test(jurisdiction)
  ) {
    return {
      error: subscriberUpdateInputFailure(
        "Enter a consent jurisdiction of no more than 32 UTF-8 bytes.",
      ),
    };
  }
  if (
    !evidence ||
    utf8Bytes(evidence) > 2_048 ||
    SUBSCRIBER_CONSENT_MULTILINE_CONTROL.test(evidence)
  ) {
    return {
      error: subscriberUpdateInputFailure(
        "Enter a durable evidence reference of no more than 2,048 UTF-8 bytes.",
      ),
    };
  }
  if (
    !reason ||
    utf8Bytes(reason) > 500 ||
    SUBSCRIBER_CONSENT_MULTILINE_CONTROL.test(reason)
  ) {
    return {
      error: subscriberUpdateInputFailure(
        "Enter an operator review reason of no more than 500 UTF-8 bytes.",
      ),
    };
  }
  if (
    !policyVersion ||
    utf8Bytes(policyVersion) > 100 ||
    SUBSCRIBER_CONSENT_SINGLE_LINE_CONTROL.test(policyVersion)
  ) {
    return {
      error: subscriberUpdateInputFailure(
        "Enter the policy version in force, using no more than 100 UTF-8 bytes.",
      ),
    };
  }
  return {
    grant: true,
    patch: {
      ...patch,
      status: "enabled",
      consent_source: source,
      consent_timestamp: new Date(timestamp).toISOString(),
      consent_channel: channel,
      consent_legal_basis: legalBasis,
      consent_jurisdiction: jurisdiction,
      consent_evidence: evidence,
      consent_reason: reason,
      consent_policy_version: policyVersion,
    },
  };
}

function enabledSubscriberResponseIsVerified(
  value: unknown,
  expectedID: string | number,
  expectedSource: string,
  expectedTimestamp: string,
): value is SubscriberDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Partial<SubscriberDetail>;
  const expectedTimestampMs = Date.parse(expectedTimestamp);
  const consentTimestampMs = Date.parse(detail.consent_timestamp ?? "");
  const purposeTimestampMs = Date.parse(
    detail.consent_email_marketing_at ?? "",
  );
  return (
    detail.id !== undefined &&
    responseIdentityMatches(expectedID, detail.id) &&
    typeof detail.email === "string" &&
    detail.email.trim().length > 0 &&
    trimmedString(detail.status).toLowerCase() === "enabled" &&
    trimmedString(detail.consent_source).toLowerCase() === expectedSource &&
    Number.isFinite(expectedTimestampMs) &&
    consentTimestampMs === expectedTimestampMs &&
    purposeTimestampMs === expectedTimestampMs
  );
}

/** PATCH /api/v1/subscribers/{id} */
export function createUpdateSubscriber(
  request: SubscriberProfilesQueueableRequester,
) {
  return async function updateSubscriber(
    id: string | number,
    patch: SubscriberUpdateInput,
    opts: SubscriberUpdateRequestOptions,
  ): Promise<QueueableApiResult<SubscriberDetail>> {
    const normalized = normalizeSubscriberUpdateInput(patch);
    if ("error" in normalized) return normalized.error;
    const version = opts?.version;
    if (!isExactSubscriberVersion(version)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before editing so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
        preservedDraft: normalized.patch,
      };
    }
    const { version: _version, ...transportOptions } = opts;
    const requestOptions = normalized.grant
      ? { ...transportOptions, maxAttempts: 1, requireOnline: true }
      : transportOptions;
    const response = await request<SubscriberDetail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}`,
      {
        method: "PATCH",
        headers: { "If-Match": version },
        body: JSON.stringify(normalized.patch),
      },
      requestOptions,
    );
    if (response.queued || response.error) return response;
    const responseID = response.data.id;
    if (
      responseID === undefined ||
      !responseIdentityMatches(id, responseID) ||
      !validDirectorySubscriber(response.data) ||
      !hasMatchingExactSubscriberVersion(
        response.data.version,
        response.serverVersion,
        responseID,
      )
    ) {
      return responseContractFailure(
        "The server did not return one matching subscriber revision in the body and ETag header. The previous verified data was kept; refresh before trying again.",
      );
    }
    if (!normalized.grant) return response;
    if (
      !enabledSubscriberResponseIsVerified(
        response.data,
        id,
        String(normalized.patch.consent_source),
        String(normalized.patch.consent_timestamp),
      )
    ) {
      return responseContractFailure(
        "The server did not return a verified enabled subscriber and email-consent projection. No success was accepted locally; refresh before trying again.",
      );
    }
    return response;
  };
}

/** DELETE /api/v1/subscribers/{id} */
export function createDeleteSubscriber(request: SubscriberProfilesRequester) {
  return function deleteSubscriber(
    id: string | number,
    version: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return Promise.resolve({
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before deleting so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      });
    }
    return request<{ ok: boolean }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}`,
      { method: "DELETE", headers: { "If-Match": exactVersion } },
    );
  };
}

/**
 * PATCH /api/v1/subscribers/{id}/archive — SUB-009 soft-delete.
 * Sets archived_at=now() (reversible) instead of hard-erasing the row,
 * preserving audit-join keys. Returns the resulting subscriber row.
 */
export function createArchiveSubscriber(request: SubscriberProfilesRequester) {
  return async function archiveSubscriber(
    id: string | number,
    version: string,
  ): Promise<ApiResult<SubscriberDetail>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before archiving so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberDetail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/archive`,
      { method: "PATCH", headers: { "If-Match": exactVersion } },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    const responseID = response.data.id;
    if (
      responseID === undefined ||
      !responseIdentityMatches(id, responseID) ||
      !validDirectorySubscriber(response.data) ||
      !response.data.archived_at ||
      !hasMatchingExactSubscriberVersion(
        response.data.version,
        response.serverVersion,
        responseID,
      )
    ) {
      return responseContractFailure(
        "The server did not return the archived subscriber with one matching fresh revision. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

/** PATCH /api/v1/subscribers/{id}/unarchive — restores an archived row. */
export function createUnarchiveSubscriber(
  request: SubscriberProfilesRequester,
) {
  return async function unarchiveSubscriber(
    id: string | number,
    version: string,
  ): Promise<ApiResult<SubscriberDetail>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before restoring so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberDetail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/unarchive`,
      { method: "PATCH", headers: { "If-Match": exactVersion } },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    const responseID = response.data.id;
    if (
      responseID === undefined ||
      !responseIdentityMatches(id, responseID) ||
      !validDirectorySubscriber(response.data) ||
      response.data.archived_at != null ||
      !hasMatchingExactSubscriberVersion(
        response.data.version,
        response.serverVersion,
        responseID,
      )
    ) {
      return responseContractFailure(
        "The server did not return the restored subscriber with one matching fresh revision. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

export function createGetSubscriberLifecycle(
  request: SubscriberProfilesRequester,
) {
  return async function getSubscriberLifecycle(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberLifecycle>> {
    const response = await request<SubscriberLifecycle>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/lifecycle`,
      undefined,
      opts,
    );
    if (response.error) return response;
    if (
      !responseIdentityMatches(id, response.data.subscriber_id) ||
      !trimmedString(response.data.tenant_id) ||
      !SUBSCRIBER_LIFECYCLE_STAGE_SET.has(response.data.stage) ||
      !Number.isInteger(response.data.score) ||
      response.data.score < 1 ||
      response.data.score > 5 ||
      !isLifecycleTimestamp(response.data.updated_at) ||
      !hasValidLifecycleTransitionFields(response.data) ||
      !hasMatchingExactSubscriberVersion(
        response.data.subscriber_version,
        response.serverVersion,
        response.data.subscriber_id,
      )
    ) {
      return responseContractFailure(
        "The server returned lifecycle data that could not be tied to this subscriber and one exact revision. The unverified data was not shown; refresh to retry.",
      );
    }
    return response;
  };
}

export function createPutSubscriberLifecycle(
  request: SubscriberProfilesRequester,
) {
  return async function putSubscriberLifecycle(
    id: string | number,
    input: {
      stage: SubscriberLifecycleStage;
      score?: number;
      source?: string;
      reason?: string;
    },
    version: string,
  ): Promise<ApiResult<SubscriberLifecycle>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before changing its lifecycle stage so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberLifecycle>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/lifecycle`,
      {
        method: "PUT",
        headers: { "If-Match": exactVersion },
        body: JSON.stringify(input),
      },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    if (
      !responseIdentityMatches(id, response.data.subscriber_id) ||
      !trimmedString(response.data.tenant_id) ||
      response.data.stage !== input.stage ||
      (input.score !== undefined && response.data.score !== input.score) ||
      !Number.isInteger(response.data.score) ||
      response.data.score < 1 ||
      response.data.score > 5 ||
      !isLifecycleTimestamp(response.data.updated_at) ||
      !hasValidLifecycleTransitionFields(response.data) ||
      !hasMatchingExactSubscriberVersion(
        response.data.subscriber_version,
        response.serverVersion,
        response.data.subscriber_id,
      )
    ) {
      return responseContractFailure(
        "The server did not return the requested lifecycle state with one matching fresh subscriber revision. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

export function createListSubscriberAliases(
  request: SubscriberProfilesRequester,
) {
  return function listSubscriberAliases(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberAliasList>> {
    return request<SubscriberAliasList>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/aliases`,
      undefined,
      opts,
    );
  };
}

export function createUpsertSubscriberAlias(
  request: SubscriberProfilesRequester,
) {
  return async function upsertSubscriberAlias(
    id: string | number,
    input: {
      alias_type: SubscriberAliasType;
      alias_value: string;
      confidence?: number;
      source?: string;
      provenance?: Record<string, unknown>;
    },
    version: string,
  ): Promise<ApiResult<SubscriberAlias>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before adding an identity alias so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberAlias>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/aliases`,
      {
        method: "POST",
        headers: { "If-Match": exactVersion },
        body: JSON.stringify(input),
      },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    if (
      !trimmedString(response.data.id) ||
      !responseIdentityMatches(id, response.data.subscriber_id) ||
      response.data.alias_type !== input.alias_type ||
      !hasMatchingExactSubscriberVersion(
        response.data.subscriber_version,
        response.serverVersion,
        response.data.subscriber_id,
      )
    ) {
      return responseContractFailure(
        "The server did not return the saved alias with one matching fresh subscriber revision. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

export function createDeleteSubscriberAlias(
  request: SubscriberProfilesRequester,
) {
  return async function deleteSubscriberAlias(
    id: string | number,
    aliasId: string,
    version: string,
  ): Promise<ApiResult<SubscriberAliasDeleteResult>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before deleting an identity alias so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberAliasDeleteResult>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/aliases/${encodeURIComponent(aliasId)}`,
      { method: "DELETE", headers: { "If-Match": exactVersion } },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    if (
      response.data.deleted !== true ||
      !responseIdentityMatches(id, response.data.subscriber_id) ||
      !hasMatchingExactSubscriberVersion(
        response.data.subscriber_version,
        response.serverVersion,
        response.data.subscriber_id,
      )
    ) {
      return responseContractFailure(
        "The server did not confirm the alias deletion with one matching fresh subscriber revision. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

/**
 * SUB-134 — opt a subscriber into a preference-center topic. Keyed by
 * email (the preferences package's per-topic write surface).
 * POST /api/v1/subscribers/{email}/topics/{topicId}/subscribe.
 */
export function createSubscribeToTopic(request: SubscriberProfilesRequester) {
  return function subscribeToTopic(
    email: string,
    topicId: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/subscribers/${encodeURIComponent(email)}/topics/${encodeURIComponent(topicId)}/subscribe`,
      { method: "POST" },
    );
  };
}

/**
 * SUB-134 — opt a subscriber out of a preference-center topic.
 * POST /api/v1/subscribers/{email}/topics/{topicId}/unsubscribe.
 */
export function createUnsubscribeFromTopic(
  request: SubscriberProfilesRequester,
) {
  return function unsubscribeFromTopic(
    email: string,
    topicId: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/subscribers/${encodeURIComponent(email)}/topics/${encodeURIComponent(topicId)}/unsubscribe`,
      { method: "POST" },
    );
  };
}

/**
 * SUB-120 — read the current per-jurisdiction GPP sections + change
 * ledger for a profile. Read-only at MVP (writes are admin/CMP-webhook
 * only). GET /api/v1/subscribers/{id}/gpp. A 404 (routes not deployed)
 * lets the caller hide the GPP panel.
 */
export function createGetSubscriberGpp(request: SubscriberProfilesRequester) {
  return function getSubscriberGpp(
    id: string | number,
  ): Promise<ApiResult<GppSectionsResponse>> {
    return request<GppSectionsResponse>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/gpp`,
    );
  };
}

/**
 * SUB-016 — list every email address attached to a profile, primary
 * first. GET /api/v1/subscribers/{id}/emails.
 */
export function createListSubscriberEmails(
  request: SubscriberProfilesRequester,
) {
  return function listSubscriberEmails(
    id: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ items: SubscriberEmail[] }>> {
    return request<{ items: SubscriberEmail[] }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/emails`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/** SUB-016 — attach a new address. POST /api/v1/subscribers/{id}/emails. */
export function createAddSubscriberEmail(request: SubscriberProfilesRequester) {
  return function addSubscriberEmail(
    id: string | number,
    input: SubscriberEmailAddInput,
    subscriberVersion: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscriberEmail>> {
    if (!isExactSubscriberVersion(subscriberVersion)) {
      return Promise.resolve(
        responseContractFailure(
          "Reload this subscriber before attaching another address so the latest exact profile revision can be verified.",
        ),
      );
    }
    return request<SubscriberEmail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/emails`,
      {
        method: "POST",
        headers: { "If-Match": subscriberVersion },
        body: JSON.stringify(input),
      },
      { ...opts, maxAttempts: 1, requireOnline: true },
    );
  };
}

/**
 * SUB-016 — apply one reviewed consent or suppression decision to an address.
 * Canonical identity changes use the subscriber editor, never this endpoint.
 */
export function createUpdateSubscriberEmail(
  request: SubscriberProfilesRequester,
) {
  return function updateSubscriberEmail(
    id: string | number,
    emailId: string,
    input: SubscriberEmailUpdateInput,
    version: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscriberEmail>> {
    return request<SubscriberEmail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/emails/${encodeURIComponent(emailId)}`,
      {
        method: "PATCH",
        headers: { "If-Match": version },
        body: JSON.stringify(input),
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/**
 * SUB-016 — remove an address. DELETE /api/v1/subscribers/{id}/emails/{email_id}.
 * The canonical address cannot be removed here; rotate it in the subscriber
 * editor first. Every delete requires the current address revision.
 */
export function createDeleteSubscriberEmail(
  request: SubscriberProfilesRequester,
) {
  return function deleteSubscriberEmail(
    id: string | number,
    emailId: string,
    version: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ deleted: boolean }>> {
    return request<{ deleted: boolean }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/emails/${encodeURIComponent(emailId)}`,
      { method: "DELETE", headers: { "If-Match": version } },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

export function createListSubscriberTraits(
  request: SubscriberProfilesRequester,
) {
  return function listSubscriberTraits(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<{ items: SubscriberComputedTrait[] }>> {
    return request<{ items: SubscriberComputedTrait[] }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/traits`,
      undefined,
      opts,
    );
  };
}

export function createRecordSubscriberEvent(
  request: SubscriberProfilesRequester,
) {
  return function recordSubscriberEvent(
    id: string | number,
    input: SubscriberEventInput,
  ): Promise<ApiResult<SubscriberEventRecord>> {
    return request<SubscriberEventRecord>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/events`,
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/* ---------- SUB-012 accounts (B2B company object) ----------------- */

/** GET /api/v1/accounts */
export function createListAccounts(request: SubscriberProfilesRequester) {
  return function listAccounts(
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<AccountPage>> {
    return request<AccountPage>(
      "/api/v1/accounts",
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/** GET /api/v1/accounts/{id} */
export function createGetAccount(request: SubscriberProfilesRequester) {
  return function getAccount(id: string): Promise<ApiResult<Account>> {
    return request<Account>(`/api/v1/accounts/${encodeURIComponent(id)}`);
  };
}

/** POST /api/v1/accounts */
export function createCreateAccount(request: SubscriberProfilesRequester) {
  return function createAccount(
    input: AccountCreateInput,
  ): Promise<ApiResult<Account>> {
    return request<Account>("/api/v1/accounts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** PATCH /api/v1/accounts/{id} */
export function createUpdateAccount(request: SubscriberProfilesRequester) {
  return function updateAccount(
    id: string,
    patch: AccountUpdateInput,
  ): Promise<ApiResult<Account>> {
    return request<Account>(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  };
}

/** DELETE /api/v1/accounts/{id} */
export function createDeleteAccount(request: SubscriberProfilesRequester) {
  return function deleteAccount(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/accounts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/**
 * PATCH /api/v1/subscribers/{id}/account — SUB-012 set/clear the
 * canonical many-to-one account link. Pass `accountId: null` to unlink.
 */
export function createSetSubscriberAccount(
  request: SubscriberProfilesRequester,
) {
  return async function setSubscriberAccount(
    id: string | number,
    accountId: string | null,
    version: string,
  ): Promise<ApiResult<SubscriberDetail>> {
    const exactVersion = version;
    if (!isExactSubscriberVersion(exactVersion)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before changing its account so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberDetail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/account`,
      {
        method: "PATCH",
        headers: { "If-Match": exactVersion },
        body: JSON.stringify({ account_id: accountId }),
      },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    if (
      response.data.id === undefined ||
      !responseIdentityMatches(id, response.data.id) ||
      !validDirectorySubscriber(response.data) ||
      !hasMatchingExactSubscriberVersion(
        response.data.version,
        response.serverVersion,
        response.data.id,
      ) ||
      (response.data.account_id ?? null) !== accountId
    ) {
      return responseContractFailure(
        "The server did not return the requested account link with one matching fresh subscriber revision. The previous verified data was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

/* ---------- SUB-013 catalog-linked profile attributes ------------- */

/** GET /api/v1/subscribers/{id}/catalog-attributes */
export function createGetSubscriberCatalogAttributes(
  request: SubscriberProfilesRequester,
) {
  return function getSubscriberCatalogAttributes(
    id: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CatalogAttributes>> {
    return request<CatalogAttributes>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/catalog-attributes`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/** PATCH /api/v1/subscribers/{id}/catalog-attributes */
export function createSetSubscriberCatalogAttributes(
  request: SubscriberProfilesRequester,
) {
  return function setSubscriberCatalogAttributes(
    id: string | number,
    input: CatalogAttributesInput,
  ): Promise<ApiResult<CatalogAttributes>> {
    return request<CatalogAttributes>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/catalog-attributes`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  };
}

/* ---------- SUB-061 / SUB-062 replenishment cadence -------------- */

/** GET /api/v1/subscribers/{id}/replenishment-cadence */
export function createGetSubscriberReplenishmentCadence(
  request: SubscriberProfilesRequester,
) {
  return function getSubscriberReplenishmentCadence(
    id: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<ReplenishmentCadence>> {
    return request<ReplenishmentCadence>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/replenishment-cadence`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/* ---------- SUB-063 inferred demographics ------------------------ */

/** GET /api/v1/subscribers/{id}/demographics */
export function createGetSubscriberDemographics(
  request: SubscriberProfilesRequester,
) {
  return function getSubscriberDemographics(
    id: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<Demographics>> {
    return request<Demographics>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/demographics`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/* ---------- SUB-014 reference collections (lookup tables) --------- */

/** GET /api/v1/collections */
export function createListCollections(request: SubscriberProfilesRequester) {
  return function listCollections(
    opts: {
      /** Compatibility marker; collection lists are always metadata-only. */
      includeData?: false;
      limit?: number;
      cursor?: string;
      query?: string;
      collectionType?: CollectionType;
      /** Demo builds echo the active workspace into fallback metadata rows. */
      workspaceId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApiResult<CollectionPage>> {
    const params = new URLSearchParams();
    if (opts.includeData === false) params.set("include_data", "false");
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.query !== undefined) params.set("q", opts.query);
    if (opts.collectionType !== undefined) {
      params.set("collection_type", opts.collectionType);
    }
    if (DEMO_DATA_FALLBACK_ENABLED && opts.workspaceId) {
      params.set("workspace_id", opts.workspaceId);
    }
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    return request<CollectionPage>(
      `/api/v1/collections${suffix}`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/** GET /api/v1/collections/{id} */
export function createGetCollection(request: SubscriberProfilesRequester) {
  return function getCollection(
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<Collection>> {
    return request<Collection>(
      `/api/v1/collections/${encodeURIComponent(id)}`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  };
}

/** POST /api/v1/collections */
export function createCreateCollection(request: SubscriberProfilesRequester) {
  return function createCollection(
    input: CollectionCreateInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<Collection>> {
    return request<Collection>(
      "/api/v1/collections",
      {
        method: "POST",
        body: JSON.stringify({ ...input, expected_version: 0 }),
      },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        requireOnline: true,
        maxAttempts: 1,
      },
    );
  };
}

/** PATCH /api/v1/collections/{id} */
export function createUpdateCollection(request: SubscriberProfilesRequester) {
  return function updateCollection(
    id: string,
    patch: CollectionUpdateInput,
    expectedVersion: number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<Collection>> {
    return request<Collection>(
      `/api/v1/collections/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ ...patch, expected_version: expectedVersion }),
      },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        requireOnline: true,
        maxAttempts: 1,
      },
    );
  };
}

/** DELETE /api/v1/collections/{id} */
export function createDeleteCollection(request: SubscriberProfilesRequester) {
  return function deleteCollection(
    id: string,
    expectedVersion: number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ ok: boolean; id: string; version: number }>> {
    return request<{ ok: boolean; id: string; version: number }>(
      `/api/v1/collections/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expected_version: expectedVersion }),
      },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        requireOnline: true,
        maxAttempts: 1,
      },
    );
  };
}

export function createSubscriberDirectoryMethods(
  request: SubscriberProfilesRequester,
) {
  return {
    listSubscribers: createListSubscribers(request),
    createSubscriber: createCreateSubscriber(request),
    bulkPasteSubscribers: createBulkPasteSubscribers(request),
  };
}

function subscriberIdentityFromPath(path: string): string | null {
  const match = /^\/api\/v1\/subscribers\/([^/?]+)/.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function payloadHasMismatchedSubscriber(
  payload: unknown,
  expected: string,
  seen = new WeakSet<object>(),
): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (seen.has(payload)) return false;
  seen.add(payload);
  if (Array.isArray(payload)) {
    return payload.some((item) =>
      payloadHasMismatchedSubscriber(item, expected, seen),
    );
  }
  const record = payload as Record<string, unknown>;
  const actual = record.subscriber_id;
  if (typeof actual === "string" || typeof actual === "number") {
    const directMatch = responseIdentityMatches(expected, actual);
    const emailMatch =
      expected.includes("@") &&
      [record.subscriber_email, record.email, record.primary_email].some(
        (candidate) =>
          (typeof candidate === "string" || typeof candidate === "number") &&
          responseIdentityMatches(expected, candidate),
      );
    if (!directMatch && !emailMatch) return true;
  }
  return Object.values(record).some((value) =>
    payloadHasMismatchedSubscriber(value, expected, seen),
  );
}

function directSubscriberPayloadMismatch(
  path: string,
  payload: unknown,
  expected: string,
): boolean {
  const pathname = path.split("?", 1)[0] ?? path;
  const suffix = pathname
    .replace(/^\/api\/v1\/subscribers\/[^/]+/, "")
    .replace(/\/$/, "");
  if (!["", "/archive", "/unarchive", "/account"].includes(suffix)) {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const detail = payload as Partial<SubscriberDetail>;
  if (detail.id === undefined) return false;
  return !(
    responseIdentityMatches(expected, detail.id) ||
    (expected.includes("@") &&
      [detail.email, detail.primary_email].some(
        (email) =>
          typeof email === "string" && responseIdentityMatches(expected, email),
      ))
  );
}

function subscriberResponseMismatch(path: string, payload: unknown): boolean {
  const expected = subscriberIdentityFromPath(path);
  if (!expected) return false;
  return (
    directSubscriberPayloadMismatch(path, payload, expected) ||
    payloadHasMismatchedSubscriber(payload, expected)
  );
}

function subscriberIdentityAwareRequest(
  request: SubscriberProfilesRequester,
): SubscriberProfilesRequester {
  return async <T>(
    path: string,
    init?: RequestInit,
    opts?: SubscriberProfilesRequestOptions,
  ) => {
    const response = await request<T>(path, init, opts);
    if (response.error || !subscriberResponseMismatch(path, response.data)) {
      return response;
    }
    return responseIdentityMismatch("subscriber");
  };
}

function subscriberIdentityAwareQueueableRequest(
  request: SubscriberProfilesQueueableRequester,
): SubscriberProfilesQueueableRequester {
  return async <T>(
    path: string,
    init?: RequestInit,
    opts?: SubscriberProfilesRequestOptions,
  ) => {
    const response = await request<T>(path, init, opts);
    if (
      response.queued ||
      response.error ||
      !subscriberResponseMismatch(path, response.data)
    ) {
      return response;
    }
    return responseIdentityMismatch("subscriber");
  };
}

export function createSubscriberProfileMethods(
  request: SubscriberProfilesRequester,
  queueableRequest: SubscriberProfilesQueueableRequester = request,
) {
  const identityAwareRequest = subscriberIdentityAwareRequest(request);
  const identityAwareQueueableRequest =
    subscriberIdentityAwareQueueableRequest(queueableRequest);
  return {
    getSubscriber: createGetSubscriber(identityAwareRequest),
    getSubscriberActivity: createGetSubscriberActivity(identityAwareRequest),
    getSubscriberPredictionMetadata:
      createGetSubscriberPredictionMetadata(identityAwareRequest),
    getSubscriberGroupMemberships:
      createGetSubscriberGroupMemberships(identityAwareRequest),
    updateSubscriber: createUpdateSubscriber(identityAwareQueueableRequest),
    deleteSubscriber: createDeleteSubscriber(identityAwareRequest),
    archiveSubscriber: createArchiveSubscriber(identityAwareRequest),
    unarchiveSubscriber: createUnarchiveSubscriber(identityAwareRequest),
    getSubscriberLifecycle: createGetSubscriberLifecycle(identityAwareRequest),
    putSubscriberLifecycle: createPutSubscriberLifecycle(identityAwareRequest),
    listSubscriberAliases: createListSubscriberAliases(identityAwareRequest),
    upsertSubscriberAlias: createUpsertSubscriberAlias(identityAwareRequest),
    deleteSubscriberAlias: createDeleteSubscriberAlias(identityAwareRequest),
    listSubscriberChannelConsents:
      createListSubscriberChannelConsents(identityAwareRequest),
    setSubscriberChannelConsent:
      createSetSubscriberChannelConsent(identityAwareRequest),
    subscribeToTopic: createSubscribeToTopic(identityAwareRequest),
    unsubscribeFromTopic: createUnsubscribeFromTopic(identityAwareRequest),
    getSubscriberGpp: createGetSubscriberGpp(identityAwareRequest),
    listSubscriberEmails: createListSubscriberEmails(identityAwareRequest),
    addSubscriberEmail: createAddSubscriberEmail(identityAwareRequest),
    updateSubscriberEmail: createUpdateSubscriberEmail(identityAwareRequest),
    deleteSubscriberEmail: createDeleteSubscriberEmail(identityAwareRequest),
    listSubscriberTraits: createListSubscriberTraits(identityAwareRequest),
    recordSubscriberEvent: createRecordSubscriberEvent(identityAwareRequest),
    listAccounts: createListAccounts(request),
    getAccount: createGetAccount(request),
    createAccount: createCreateAccount(request),
    updateAccount: createUpdateAccount(request),
    deleteAccount: createDeleteAccount(request),
    setSubscriberAccount: createSetSubscriberAccount(identityAwareRequest),
    getSubscriberCatalogAttributes:
      createGetSubscriberCatalogAttributes(identityAwareRequest),
    setSubscriberCatalogAttributes:
      createSetSubscriberCatalogAttributes(identityAwareRequest),
    getSubscriberReplenishmentCadence:
      createGetSubscriberReplenishmentCadence(identityAwareRequest),
    getSubscriberDemographics:
      createGetSubscriberDemographics(identityAwareRequest),
    listCollections: createListCollections(request),
    getCollection: createGetCollection(request),
    createCollection: createCreateCollection(request),
    updateCollection: createUpdateCollection(request),
    deleteCollection: createDeleteCollection(request),
  };
}

export function createSubscriberProfilesApis(
  request: SubscriberProfilesRequester,
  queueableRequest: SubscriberProfilesQueueableRequester = request,
) {
  return {
    subscriberDirectoryMethods: createSubscriberDirectoryMethods(request),
    subscriberProfileMethods: createSubscriberProfileMethods(
      request,
      queueableRequest,
    ),
  };
}
