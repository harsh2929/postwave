import type { ApiErr, ApiResult } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";

export interface SubscriberIntelligenceRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type SubscriberIntelligenceRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: SubscriberIntelligenceRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- #17 Lifecycle rollup (lifecycle) ------------------------ */
// Per-subscriber GET/PUT lifecycle already lives on the main `api`
// object; this group adds the tenant-wide rollup + stage catalog.

export interface LifecycleDistributionRow {
  stage: string;
  count: number;
}

export function createLifecycleRollupApi(
  request: SubscriberIntelligenceRequester,
) {
  const lifecycleRollupApi = {
    /** GET /api/v1/lifecycle/distribution → `{items}` per-stage histogram. */
    distribution(): Promise<ApiResult<{ items: LifecycleDistributionRow[] }>> {
      return request<{ items: LifecycleDistributionRow[] }>(
        "/api/v1/lifecycle/distribution",
      );
    },
    /** GET /api/v1/lifecycle/stages → `{stages}` static catalog. */
    stages(): Promise<ApiResult<{ stages: string[] }>> {
      return request<{ stages: string[] }>("/api/v1/lifecycle/stages");
    },
  };

  return lifecycleRollupApi;
}

/* ---------- #18 Lead scoring (scoring) ------------------------------ */

export interface ScoringRule {
  id: string;
  event_type: string;
  weight: number;
  note?: string;
}

export interface ScoringEventCatalogItem {
  event_type: string;
  label: string;
  category: "engagement" | "delivery" | "consent" | "profile";
}

export interface ScoringRulesResponse {
  rules: ScoringRule[];
  defaults: ScoringRule[];
  event_catalog: ScoringEventCatalogItem[];
  /** Semantic SHA-256 version required by the next whole-set replacement. */
  version: string;
  window_days: number;
}

export function createLeadScoringApi(request: SubscriberIntelligenceRequester) {
  const leadScoringApi = {
    /** GET /api/v1/scoring/rules (admin) → versioned rules + catalog. */
    rules(): Promise<ApiResult<ScoringRulesResponse>> {
      return request<ScoringRulesResponse>("/api/v1/scoring/rules");
    },
    /** PUT /api/v1/scoring/rules (admin) — version-bound whole-set replace. */
    putRules(
      rules: ScoringRule[],
      expectedVersion: string,
    ): Promise<ApiResult<{ saved: number; version: string }>> {
      return request<{ saved: number; version: string }>(
        "/api/v1/scoring/rules",
        {
          method: "PUT",
          body: JSON.stringify({ rules, expected_version: expectedVersion }),
        },
      );
    },
  };

  return leadScoringApi;
}

/* ---------- #19 Contact rating (contact_rating) --------------------- */
// NB: distinct from PATCH /subscribers/{id}/rating (manual set, pkg
// contact_ratings) — this surface is the heuristic recompute + the
// per-subscriber introspection view.

export interface SubscriberRatingView {
  subscriber_id: string;
  /** 1..5; absent when no manual rating nor engagement signal. */
  stars?: number | null;
  engagement_score?: number | null;
  engagement_score_at?: string | null;
  /** "manual" | "heuristic" */
  source: string;
}

export interface ContactRatingRecomputeResult {
  updated: number;
  scanned: number;
  started_at: string;
  finished_at: string;
  window_days: number;
}

export function createContactRatingsApi(
  request: SubscriberIntelligenceRequester,
) {
  const contactRatingsApi = {
    /** GET /api/v1/contact-ratings/{subscriber_id}. */
    async get(
      subscriberId: string | number,
    ): Promise<ApiResult<SubscriberRatingView>> {
      const response = await request<SubscriberRatingView>(
        `/api/v1/contact-ratings/${encodeURIComponent(String(subscriberId))}`,
      );
      if (
        !response.error &&
        !responseIdentityMatches(subscriberId, response.data.subscriber_id)
      ) {
        return responseIdentityMismatch("subscriber");
      }
      return response;
    },
    /** POST /api/v1/contact-ratings/recompute?window= (write_subscribers). */
    recompute(
      windowDays?: number,
    ): Promise<ApiResult<ContactRatingRecomputeResult>> {
      const qs = windowDays != null ? `?window=${windowDays}` : "";
      return request<ContactRatingRecomputeResult>(
        `/api/v1/contact-ratings/recompute${qs}`,
        { method: "POST", body: JSON.stringify({}) },
        { timeoutMs: 30_000, maxAttempts: 1 },
      );
    },
  };

  return contactRatingsApi;
}

/* ---------- #20 EQ score (eqscore) ----------------------------------- */

export interface EQScoreInput {
  subject: string;
  html: string;
  text?: string;
  from: string;
  /** Sender auth and reputation are resolved from tenant-scoped server state. */
  /** Optional persistence breadcrumbs for the per-draft history. */
  campaign_id?: string;
  draft_label?: string;
}

export interface EQScoreReason {
  code: string;
  message: string;
  /** info | warning | fail */
  severity: string;
  /** content | auth | reputation */
  bucket: string;
}

export interface EQSubScore {
  score: number;
  weight: number;
  reasons: EQScoreReason[];
}

export interface EQScoreResult {
  score: number;
  /** A+/A/B/C/D/F */
  grade: string;
  content: EQSubScore;
  auth: EQSubScore;
  reputation: EQSubScore;
  reasons: EQScoreReason[];
  /** e.g. ["reputation"] when the tenant has no history yet. */
  skippedSubScores: string[];
}

export function createEqScoreApi(request: SubscriberIntelligenceRequester) {
  const eqScoreApi = {
    /** POST /api/v1/deliverability/eq-score — synchronous heuristic grade. */
    score(input: EQScoreInput): Promise<ApiResult<EQScoreResult>> {
      return request<EQScoreResult>("/api/v1/deliverability/eq-score", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
  };

  return eqScoreApi;
}

/* ---------- #21 Subscriber notes (subscriber_notes) ------------------ */

/**
 * SUB-097 — one extracted @-mention on a note. The backend parses
 * `@[Display](user:UUID)` tokens out of `markdown_body` and denormalises
 * the de-duplicated set here so "notes that mention me" can query by
 * containment without re-parsing markdown. `user_id` is lower-cased.
 */
export interface SubscriberNoteMention {
  user_id: string;
  display: string;
}

/**
 * SUB-097 — one file attached to a note. The bytes live in the
 * tenant-scoped object store under `file_key`; `download_url` is a
 * freshly-presigned, short-lived GET URL populated lazily by the List
 * endpoint (absent on writes). `size_bytes` may be 0 for empty/unknown.
 */
export interface SubscriberNoteAttachment {
  id: string;
  note_id: string;
  file_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by_user_id?: string;
  uploaded_by_email?: string;
  uploaded_at: string;
  /** Presigned GET URL — present on List, absent on register. */
  download_url?: string;
}

export interface SubscriberNote {
  id: string;
  subscriber_id: string;
  subscriber_email: string;
  /** Plain-text projection (mention tokens collapsed to @Name). */
  body: string;
  /**
   * SUB-097 — the rich markdown source the composer round-trips, with
   * inline `@[Display](user:UUID)` mention tokens. Falls back to `body`
   * server-side when a note predates the markdown column.
   */
  markdown_body: string;
  /** SUB-097 — extracted, de-duplicated @-mentions (may be empty). */
  mentions: SubscriberNoteMention[];
  /** SUB-097 — attached files, each with a presigned download_url. */
  attachments: SubscriberNoteAttachment[];
  author_user_id?: string;
  author_email?: string;
  pinned: boolean;
  created_at: string;
}

interface SubscriberNoteWriteResponse {
  id?: string;
  note_id?: string;
  subscriber_id?: string;
  pinned?: boolean;
  markdown_body?: string;
}

function validateNoteWriteIdentity(
  response: SubscriberNoteWriteResponse,
  subscriberId: string | number,
  noteId?: string,
): ApiErr | null {
  if (
    response.subscriber_id !== undefined &&
    !responseIdentityMatches(subscriberId, response.subscriber_id)
  ) {
    return responseIdentityMismatch("subscriber");
  }
  if (
    noteId !== undefined &&
    response.note_id !== undefined &&
    !responseIdentityMatches(noteId, response.note_id)
  ) {
    return responseIdentityMismatch("note");
  }
  return null;
}

export function createSubscriberNotesApi(
  request: SubscriberIntelligenceRequester,
) {
  const subscriberNotesApi = {
    /** GET /api/v1/subscribers/{id}/notes (admin) → `{notes, count}`. */
    async list(
      subscriberId: string | number,
    ): Promise<ApiResult<{ notes: SubscriberNote[]; count: number }>> {
      const response = await request<{
        notes: SubscriberNote[];
        count: number;
      }>(
        `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/notes`,
      );
      if (response.error) return response;
      const { notes, count } = response.data;
      if (
        !Array.isArray(notes) ||
        !Number.isSafeInteger(count) ||
        count !== notes.length
      ) {
        return responseContractFailure(
          "The notes service returned an incomplete response. The previous verified notes were kept; retry the request.",
        );
      }
      const noteIds = new Set<string>();
      for (const note of notes) {
        if (
          typeof note?.id !== "string" ||
          note.id.trim() === "" ||
          noteIds.has(note.id)
        ) {
          return responseContractFailure(
            "The notes service returned an invalid note identity. The previous verified notes were kept; retry the request.",
          );
        }
        noteIds.add(note.id);
        if (!responseIdentityMatches(subscriberId, note.subscriber_id)) {
          return responseIdentityMismatch("subscriber");
        }
        if (!Array.isArray(note.attachments)) {
          return responseContractFailure(
            "The notes service returned incomplete attachment metadata. The previous verified notes were kept; retry the request.",
          );
        }
        const attachmentIds = new Set<string>();
        for (const attachment of note.attachments) {
          if (
            !attachment ||
            typeof attachment.id !== "string" ||
            attachment.id.trim() === "" ||
            attachmentIds.has(attachment.id)
          ) {
            return responseContractFailure(
              "The notes service returned an invalid attachment identity. The previous verified notes were kept; retry the request.",
            );
          }
          attachmentIds.add(attachment.id);
          if (
            typeof attachment.note_id !== "string" ||
            !responseIdentityMatches(note.id, attachment.note_id)
          ) {
            return responseIdentityMismatch("attachment");
          }
        }
      }
      return response;
    },
    /**
     * POST /api/v1/subscribers/{id}/notes (admin) — 201 {id}. Supply
     * `markdown_body` (preferred — may embed `@[Name](user:id)` tokens) or
     * the legacy plain `body`; at least one must be non-empty.
     */
    async create(
      subscriberId: string | number,
      input: { body?: string; markdown_body?: string; pinned?: boolean },
    ): Promise<ApiResult<{ id: string }>> {
      const response = await request<{ id: string; subscriber_id?: string }>(
        `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/notes`,
        { method: "POST", body: JSON.stringify(input) },
      );
      if (response.error) return response;
      if (typeof response.data.id !== "string" || !response.data.id.trim()) {
        return responseContractFailure(
          "The notes service did not return the created note identity. Retry the request.",
        );
      }
      const identityError = validateNoteWriteIdentity(
        response.data,
        subscriberId,
      );
      return identityError ?? response;
    },
    /**
     * PATCH /api/v1/subscribers/{id}/notes/{note} (admin) — pin/unpin
     * and/or edit the markdown body. At least one of `pinned` /
     * `markdown_body` must be present; editing the body re-syncs the plain
     * projection + extracted mentions server-side.
     */
    async update(
      subscriberId: string | number,
      noteId: string,
      input: { pinned?: boolean; markdown_body?: string },
    ): Promise<ApiResult<SubscriberNoteWriteResponse>> {
      const response = await request<SubscriberNoteWriteResponse>(
        `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/notes/${encodeURIComponent(noteId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      if (response.error) return response;
      if (
        response.data.id !== undefined &&
        !responseIdentityMatches(noteId, response.data.id)
      ) {
        return responseIdentityMismatch("note");
      }
      const identityError = validateNoteWriteIdentity(
        response.data,
        subscriberId,
        noteId,
      );
      return identityError ?? response;
    },
    /** DELETE /api/v1/subscribers/{id}/notes/{note} (admin). */
    remove(
      subscriberId: string | number,
      noteId: string,
    ): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/notes/${encodeURIComponent(noteId)}`,
        { method: "DELETE" },
      );
    },
    /**
     * POST /api/v1/subscribers/{id}/notes/{note}/attachments (admin) —
     * retained for compatibility but intentionally returns 503 with
     * `note_attachment_upload_unavailable` until a verified upload-session
     * and quarantine service exists. The desktop UI must not call it.
     */
    async addAttachment(
      subscriberId: string | number,
      noteId: string,
      input: {
        file_key: string;
        filename: string;
        content_type?: string;
        size_bytes?: number;
      },
    ): Promise<ApiResult<{ id: string; file_key: string }>> {
      const response = await request<{
        id: string;
        file_key: string;
        subscriber_id?: string;
        note_id?: string;
      }>(
        `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/notes/${encodeURIComponent(noteId)}/attachments`,
        { method: "POST", body: JSON.stringify(input) },
      );
      if (response.error) return response;
      const identityError = validateNoteWriteIdentity(
        response.data,
        subscriberId,
        noteId,
      );
      if (identityError) return identityError;
      if (
        typeof response.data.id !== "string" ||
        response.data.id.trim() === "" ||
        response.data.file_key !== input.file_key
      ) {
        return responseIdentityMismatch("attachment");
      }
      return response;
    },
    /**
     * DELETE /api/v1/subscribers/{id}/notes/{note}/attachments/{file_key}
     * (admin) — SUB-097. Removes the metadata row and best-effort deletes
     * the underlying object. `file_key` may contain slashes; it is encoded
     * per-segment so the object-store path survives routing.
     */
    removeAttachment(
      subscriberId: string | number,
      noteId: string,
      fileKey: string,
    ): Promise<ApiResult<void>> {
      const encodedKey = fileKey
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      return request<void>(
        `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/notes/${encodeURIComponent(noteId)}/attachments/${encodedKey}`,
        { method: "DELETE" },
      );
    },
  };

  return subscriberNotesApi;
}

/* ---------- SUB-006 Richer custom-attribute types ------------------- */
// The tenant custom-fields registry — the per-workspace schema layer that
// names + types the keys a tenant stores in subscribers.custom_fields.
// Mirrors apps/api/internal/customfields/customfields.go.

/** The value-type a custom field enforces. enum is a single-select over a
 * fixed option set; array is a homogeneous list; object is a nested map;
 * email/url/phone/region are format-validated scalar strings. */
export type CustomFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "array"
  | "object"
  | "email"
  | "url"
  | "phone"
  | "region";

/** Type-specific metadata attached to a custom field (SUB-006). Stored as
 * the jsonb `config` column on tenant_custom_fields; nil for plain scalar
 * fields unless the tenant attaches flags. */
export interface CustomFieldConfig {
  /** Allowed values for an enum field. */
  options?: string[];
  /** Element type for an array field (a scalar CustomFieldType). */
  item_type?: string;
  /** property name → scalar type for an object field. */
  schema?: Record<string, string>;
  /** Optional regex applied to scalar string-shaped values. */
  pattern?: string;
  /** Marks the field as containing PII (drives masking + export policy). */
  pii_flag?: boolean;
  /** Requests at-rest encryption for the field's values. */
  encryption_flag?: boolean;
  /** SUB-057 — schema-level data-classification label the policy engine
   * reads to apply masking / retention / export / consent-filtering rules
   * downstream. "none" (or absent) = unclassified. */
  data_classification?: DataClassification;
}

/** SUB-057 — the closed data-classification taxonomy. Mirrors the backend
 * customfields CHECK constraint (pii / phi / pci / sensitive / business /
 * none). The empty string / absent value is treated as unclassified. */
export type DataClassification =
  | "pii"
  | "phi"
  | "pci"
  | "sensitive"
  | "business"
  | "none";

/** A persisted tenant custom-field registry row. */
export interface CustomField {
  id: string;
  tenant_id?: string;
  key: string;
  label: string;
  type: CustomFieldType;
  /** Type-specific metadata (SUB-006). Absent for plain scalar fields. */
  config?: CustomFieldConfig | null;
  /** Optional regex/format constraint applied at write time. */
  validation_rule?: string;
  /** Part of the indexed/searchable set (SUB-015). */
  searchable?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Body of POST /api/v1/custom-fields. `key` + `type` are immutable once
 * created (they map into JSONB property names + drive value validation), so
 * they are only accepted at create time. `config`, `validation_rule`, and
 * `searchable` are optional metadata; `searchable` opts the field into the
 * indexed set (SUB-015) and the create is rejected with `limit_exceeded`
 * (422) if the tenant is at its searchable cap. */
export interface CustomFieldCreateInput {
  key: string;
  label: string;
  type: CustomFieldType;
  config?: CustomFieldConfig | null;
  validation_rule?: string;
  searchable?: boolean;
}

/** Body of PATCH /api/v1/custom-fields/{id}. Only label, config, and
 * validation_rule are mutable — key + type are immutable once created. */
export interface CustomFieldUpdateInput {
  label?: string;
  config?: CustomFieldConfig | null;
  validation_rule?: string;
}

export function createCustomFieldsApi(
  request: SubscriberIntelligenceRequester,
) {
  const customFieldsApi = {
    /** GET /api/v1/custom-fields — the tenant's custom-field registry, oldest
     * first. The handler returns a bare array, not a paged envelope. */
    list(): Promise<ApiResult<CustomField[]>> {
      return request<CustomField[]>(`/api/v1/custom-fields`);
    },
    /** POST /api/v1/custom-fields — define a new custom field. Returns the
     * created row (201). The server rejects a duplicate key with 409
     * (`key_conflict`) and a workspace cap breach with 422
     * (`limit_exceeded`). */
    create(input: CustomFieldCreateInput): Promise<ApiResult<CustomField>> {
      return request<CustomField>(`/api/v1/custom-fields`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** PATCH /api/v1/custom-fields/{id} — patch the mutable metadata
     * (label / config / validation_rule). Returns the refreshed row. */
    patch(
      id: string,
      input: CustomFieldUpdateInput,
    ): Promise<ApiResult<CustomField>> {
      return request<CustomField>(
        `/api/v1/custom-fields/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/v1/custom-fields/{id} — remove a custom-field definition.
     * The handler answers 200 `{ ok: true }`; a missing id is 404
     * (`not_found`). */
    delete(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/custom-fields/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
  };

  return customFieldsApi;
}

/* ---------- #26 Predictive / RFM (predictive) ------------------------ */

export interface PredictiveCatalogModel {
  key: string;
  label: string;
  runtime_status: string;
  version: string;
}

export interface PredictiveCatalogResponse {
  schema_version: string;
  models: PredictiveCatalogModel[];
  rfm_segments: unknown[];
}

export interface PredictivePrediction {
  email: string;
  subscriber_id?: string;
  historic_clv_cents: number;
  predicted_clv_cents: number;
  total_clv_cents: number;
  churn_risk: number;
  predicted_order_count: number;
  average_days_between_orders?: number | null;
  expected_next_order_at?: string | null;
  predicted_gender: string;
  confidence: number;
  data_sufficiency: string;
  explanation?: Record<string, unknown>;
  calculated_at?: string;
}

export interface RFMScoreRow {
  email: string;
  subscriber_id?: string;
  recency_days?: number | null;
  frequency: number;
  monetary_cents: number;
  recency_score: number;
  frequency_score: number;
  monetary_score: number;
  rfm_score: string;
  segment_key: string;
  calculated_at?: string;
}

export interface PredictiveProfileAnalytics {
  prediction: PredictivePrediction;
  rfm: RFMScoreRow;
}

/**
 * Producer-shaped response from GET /api/v1/predictive/profiles.
 *
 * The list endpoint returns a prediction/RFM pair per profile. Keeping the
 * envelope explicit prevents consumers from accidentally treating the nested
 * objects as a flat prediction (which previously rendered plausible-looking
 * zeroes for every real response).
 */
export interface PredictiveProfilesResponse {
  items: PredictiveProfileAnalytics[];
}

export interface PredictiveModelRun {
  id: string;
  tenant_id: string;
  model_key: string;
  model_version: string;
  status: string;
  input_window_days: number;
  scored_profiles: number;
  insufficient_profiles: number;
  metrics?: Record<string, unknown>;
  error?: string;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

export interface PredictiveRecomputeResult {
  run: PredictiveModelRun;
  predictions: number;
  rfm_scores: number;
}

/* ---------- SUB-127 CLV dashboard (predictive) ---------------------- */

/** total_clv_cents percentile cut points across the scored snapshot.
 *  Mirrors predictive.CLVPercentiles JSON tags. */
export interface CLVPercentiles {
  p10_cents: number;
  p25_cents: number;
  p50_cents: number;
  p75_cents: number;
  p90_cents: number;
  p99_cents: number;
}

/** One coarse value-band count. Mirrors predictive.CLVTier. */
export interface CLVTier {
  key: string;
  label: string;
  profiles: number;
  avg_total_clv_cents: number;
  avg_churn_risk: number;
}

/** Compact example profile for the preview carousels.
 *  Mirrors predictive.CLVProfilePreview. */
export interface CLVProfilePreview {
  email: string;
  subscriber_id?: string;
  total_clv_cents: number;
  churn_risk: number;
  segment_key?: string;
}

/** Aggregated predicted-CLV distribution for the CLV dashboard (SUB-127).
 *  Mirrors predictive.CLVDistribution JSON tags. */
export interface CLVDistribution {
  profile_count: number;
  scored_profiles: number;
  total_clv_cents: number;
  predicted_clv_cents: number;
  avg_total_clv_cents: number;
  percentiles: CLVPercentiles;
  tiers: CLVTier[];
  top_profiles: CLVProfilePreview[];
  at_risk_profiles: CLVProfilePreview[];
  last_calculated_at?: string | null;
}

export function createPredictiveApi(request: SubscriberIntelligenceRequester) {
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const validProfile = (
    value: unknown,
  ): value is PredictiveProfileAnalytics => {
    if (!value || typeof value !== "object") return false;
    const pair = value as Partial<PredictiveProfileAnalytics>;
    const prediction = pair.prediction;
    const rfm = pair.rfm;
    if (!prediction || !rfm) return false;
    if (
      typeof prediction.email !== "string" ||
      prediction.email.trim() === "" ||
      typeof rfm.email !== "string" ||
      rfm.email.trim() === "" ||
      !responseIdentityMatches(prediction.email, rfm.email)
    ) {
      return false;
    }
    if (
      prediction.subscriber_id !== undefined &&
      rfm.subscriber_id !== undefined &&
      !responseIdentityMatches(prediction.subscriber_id, rfm.subscriber_id)
    ) {
      return false;
    }
    return (
      finite(prediction.historic_clv_cents) &&
      finite(prediction.predicted_clv_cents) &&
      finite(prediction.total_clv_cents) &&
      finite(prediction.churn_risk) &&
      prediction.churn_risk >= 0 &&
      prediction.churn_risk <= 1 &&
      finite(prediction.predicted_order_count) &&
      prediction.predicted_order_count >= 0 &&
      finite(prediction.confidence) &&
      prediction.confidence >= 0 &&
      prediction.confidence <= 1 &&
      typeof prediction.predicted_gender === "string" &&
      typeof prediction.data_sufficiency === "string" &&
      finite(rfm.frequency) &&
      rfm.frequency >= 0 &&
      finite(rfm.monetary_cents) &&
      finite(rfm.recency_score) &&
      Number.isInteger(rfm.recency_score) &&
      rfm.recency_score >= 1 &&
      rfm.recency_score <= 5 &&
      finite(rfm.frequency_score) &&
      Number.isInteger(rfm.frequency_score) &&
      rfm.frequency_score >= 1 &&
      rfm.frequency_score <= 5 &&
      finite(rfm.monetary_score) &&
      Number.isInteger(rfm.monetary_score) &&
      rfm.monetary_score >= 1 &&
      rfm.monetary_score <= 5 &&
      typeof rfm.rfm_score === "string" &&
      rfm.rfm_score.length > 0 &&
      typeof rfm.segment_key === "string" &&
      rfm.segment_key.length > 0
    );
  };

  const predictiveApi = {
    /** GET /api/v1/predictive/catalog — model + RFM-segment catalog. */
    catalog(): Promise<ApiResult<PredictiveCatalogResponse>> {
      return request<PredictiveCatalogResponse>("/api/v1/predictive/catalog");
    },
    /** GET /api/v1/predictive/profiles?segment=&limit= → `{items}`. */
    async profiles(
      opts: { segment?: string; limit?: number } = {},
    ): Promise<ApiResult<PredictiveProfilesResponse>> {
      const params = new URLSearchParams();
      if (opts.segment) params.set("segment", opts.segment);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const response = await request<PredictiveProfilesResponse>(
        `/api/v1/predictive/profiles${qs ? `?${qs}` : ""}`,
      );
      if (response.error) return response;
      if (
        !response.data ||
        !Array.isArray(response.data.items) ||
        !response.data.items.every(validProfile)
      ) {
        return responseContractFailure(
          "The predictive-profile list returned an invalid prediction/RFM envelope. No unverified profile values were shown; retry the request.",
        );
      }
      return response;
    },
    /** GET /api/v1/predictive/profiles/{email} — prediction + RFM pair. */
    async profile(
      email: string,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<PredictiveProfileAnalytics>> {
      const response = await request<PredictiveProfileAnalytics>(
        `/api/v1/predictive/profiles/${encodeURIComponent(email)}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
      if (response.error) return response;
      const { prediction, rfm } = response.data;
      if (!prediction || !rfm) {
        return responseContractFailure(
          "The predictive-profile service returned an incomplete response. The previous verified profile was kept; retry the request.",
        );
      }
      if (
        !responseIdentityMatches(email, prediction.email) ||
        !responseIdentityMatches(email, rfm.email) ||
        (prediction.subscriber_id !== undefined &&
          rfm.subscriber_id !== undefined &&
          !responseIdentityMatches(prediction.subscriber_id, rfm.subscriber_id))
      ) {
        return responseIdentityMismatch("subscriber");
      }
      return response;
    },
    /** GET /api/v1/predictive/rfm/segments → `{items}`. */
    rfmSegments(): Promise<ApiResult<{ items: RFMScoreRow[] }>> {
      return request<{ items: RFMScoreRow[] }>(
        "/api/v1/predictive/rfm/segments",
      );
    },
    /** GET /api/v1/clv-dashboard?preview_limit= — aggregated CLV distribution
     *  (SUB-127). preview_limit caps the top / at-risk preview carousels. */
    clvDashboard(
      opts: { previewLimit?: number } = {},
    ): Promise<ApiResult<CLVDistribution>> {
      const params = new URLSearchParams();
      if (opts.previewLimit != null) {
        params.set("preview_limit", String(opts.previewLimit));
      }
      const qs = params.toString();
      return request<CLVDistribution>(
        `/api/v1/clv-dashboard${qs ? `?${qs}` : ""}`,
      );
    },
    /** POST /api/v1/predictive/recompute (admin) — synchronous model run. */
    recompute(): Promise<ApiResult<PredictiveRecomputeResult>> {
      return request<PredictiveRecomputeResult>(
        "/api/v1/predictive/recompute",
        { method: "POST", body: JSON.stringify({}) },
        { timeoutMs: 60_000, maxAttempts: 1 },
      );
    },
  };

  return predictiveApi;
}

/* ---------- #28 Zero-copy triggers (zerocopy_triggers) --------------- */

export interface ZeroCopyTrigger {
  id?: string;
  tenant_id?: string;
  connection_id?: string;
  journey_id?: string;
  name: string;
  description?: string;
  status: string;
  provider: string;
  query: string;
  cursor_column: string;
  profile_key_column: string;
  last_seen_cursor?: string;
  polling_interval_seconds: number;
  max_rows_per_tick: number;
  last_polled_at?: string | null;
  last_success_at?: string | null;
  last_error?: string;
  consecutive_failures: number;
  rows_fired_total: number;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  runtime?: ZeroCopyRuntimeDescriptor;
}

export interface ZeroCopyTriggerInput {
  connection_id?: string;
  journey_id?: string;
  name: string;
  description?: string;
  status?: string;
  provider: string;
  query: string;
  cursor_column: string;
  profile_key_column: string;
  polling_interval_seconds?: number;
  max_rows_per_tick?: number;
  config?: Record<string, unknown>;
}

export interface ZeroCopyValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface ZeroCopyFire {
  id: number;
  trigger_id: string;
  status: string;
  fired_at: string;
  has_cursor: boolean;
  has_profile_key: boolean;
  has_subscriber: boolean;
  has_payload: boolean;
  has_flow_run: boolean;
  error_category?: "execution_error";
}

export interface ZeroCopyRuntimeDescriptor {
  capability: string;
  runtime_status: string;
  execution_enabled: boolean;
  code: string;
  message: string;
  prerequisites?: string[];
}

export interface ZeroCopyAlertConfig {
  trigger_id: string;
  runtime: ZeroCopyRuntimeDescriptor;
  consecutive_failures_threshold: number;
  lag_seconds_threshold: number;
  fires_per_tick_threshold: number;
  webhook_configured: boolean;
  cooldown_seconds: number;
  last_alert_fired_at?: string | null;
  last_alert_kind?: "failures" | "lag" | "fires_burst";
  has_last_alert_message: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ZeroCopyAlertConfigInput {
  consecutive_failures_threshold: number;
  lag_seconds_threshold: number;
  fires_per_tick_threshold: number;
  notify_webhook_url?: string;
  cooldown_seconds: number;
}

export interface ZeroCopyDLQEntry {
  id: number;
  trigger_id: string;
  reason: "unresolved_subscriber" | "enqueue_failed" | "driver_partial_row";
  retry_count: number;
  last_retried_at?: string | null;
  status: "pending" | "resolved" | "abandoned";
  created_at: string;
  updated_at: string;
  has_cursor: boolean;
  has_profile_key: boolean;
  has_payload: boolean;
  last_error_category?: "execution_error";
}

export function createZeroCopyTriggersApi(
  request: SubscriberIntelligenceRequester,
) {
  const zeroCopyTriggersApi = {
    /** GET /api/v1/zero-copy-triggers?status= → `{items}`. */
    list(
      opts: { status?: string; cursor?: string; limit?: number } = {},
    ): Promise<
      ApiResult<{
        items: ZeroCopyTrigger[];
        nextCursor?: string;
        totalEstimate?: number;
      }>
    > {
      const query = new URLSearchParams();
      if (opts.status) query.set("status", opts.status);
      if (opts.cursor) query.set("cursor", opts.cursor);
      if (opts.limit !== undefined) query.set("limit", String(opts.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request<{
        items: ZeroCopyTrigger[];
        nextCursor?: string;
        totalEstimate?: number;
      }>(`/api/v1/zero-copy-triggers${suffix}`);
    },
    /** POST /api/v1/zero-copy-triggers (admin) — 201, or 400 with the
     *  ZeroCopyValidationResult in the error envelope. */
    create(input: ZeroCopyTriggerInput): Promise<ApiResult<ZeroCopyTrigger>> {
      return request<ZeroCopyTrigger>("/api/v1/zero-copy-triggers", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/zero-copy-triggers/{id}. */
    get(id: string): Promise<ApiResult<ZeroCopyTrigger>> {
      return request<ZeroCopyTrigger>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}`,
      );
    },
    /** PUT /api/v1/zero-copy-triggers/{id} (admin) — full replace. */
    update(
      id: string,
      input: ZeroCopyTriggerInput,
    ): Promise<ApiResult<ZeroCopyTrigger>> {
      return request<ZeroCopyTrigger>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}`,
        { method: "PUT", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/v1/zero-copy-triggers/{id} (admin) — 204. */
    remove(id: string): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    /** POST /api/v1/zero-copy-triggers/{id}/poll (admin) — one synchronous
     *  tick; returns the fires created → `{fires, count}`. */
    pollNow(
      id: string,
    ): Promise<ApiResult<{ fires: ZeroCopyFire[]; count: number }>> {
      return request<{ fires: ZeroCopyFire[]; count: number }>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}/poll`,
        { method: "POST", body: JSON.stringify({}) },
        { timeoutMs: 30_000, maxAttempts: 1, requireOnline: true },
      );
    },
    /** GET /api/v1/zero-copy-triggers/{id}/fires → `{items}` (last 100). */
    fires(id: string): Promise<ApiResult<{ items: ZeroCopyFire[] }>> {
      return request<{ items: ZeroCopyFire[] }>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}/fires`,
      );
    },
    /** POST /api/v1/zero-copy-triggers/validate (admin) — dry validation. */
    validate(
      input: ZeroCopyTriggerInput,
    ): Promise<ApiResult<ZeroCopyValidationResult>> {
      return request<ZeroCopyValidationResult>(
        "/api/v1/zero-copy-triggers/validate",
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/v1/zero-copy-triggers/{id}/alerts — defaults when unset. */
    getAlerts(id: string): Promise<ApiResult<ZeroCopyAlertConfig>> {
      return request<ZeroCopyAlertConfig>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}/alerts`,
      );
    },
    /** PUT /api/v1/zero-copy-triggers/{id}/alerts (admin). */
    putAlerts(
      id: string,
      input: ZeroCopyAlertConfigInput,
    ): Promise<ApiResult<ZeroCopyAlertConfig>> {
      return request<ZeroCopyAlertConfig>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}/alerts`,
        { method: "PUT", body: JSON.stringify(input) },
      );
    },
    /** GET /api/v1/zero-copy-triggers/{id}/dlq → `{items}`. */
    listDLQ(id: string): Promise<ApiResult<{ items: ZeroCopyDLQEntry[] }>> {
      return request<{ items: ZeroCopyDLQEntry[] }>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}/dlq`,
      );
    },
    /** POST /api/v1/zero-copy-triggers/{id}/dlq/{entry}/retry (admin) — 202. */
    retryDLQ(
      id: string,
      entryId: number,
    ): Promise<ApiResult<{ id: number; status: string; note?: string }>> {
      return request<{ id: number; status: string; note?: string }>(
        `/api/v1/zero-copy-triggers/${encodeURIComponent(id)}/dlq/${encodeURIComponent(String(entryId))}/retry`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  };

  return zeroCopyTriggersApi;
}

/* ---------- #29 Trigger delay preferences (trigger_delay) ------------ */

export interface TriggerDelayPreference {
  tenant_id?: string;
  subscriber_id: string;
  event_name: string;
  optimal_delay_seconds: number;
  sample_count: number;
  confidence: number;
  reason?: string;
  computed_at: string;
  updated_at: string;
}

export function createTriggerDelayApi(
  request: SubscriberIntelligenceRequester,
) {
  const triggerDelayApi = {
    /** GET /api/v1/trigger-delay/preferences?subscriber_id=&event_name= —
     *  404 when no preference is stored for the pair. */
    getPreference(params: {
      subscriberId: string;
      eventName: string;
    }): Promise<ApiResult<TriggerDelayPreference>> {
      const qs = new URLSearchParams({
        subscriber_id: params.subscriberId.trim().toLowerCase(),
        event_name: params.eventName.trim().toLowerCase(),
      });
      return request<TriggerDelayPreference>(
        `/api/v1/trigger-delay/preferences?${qs.toString()}`,
      );
    },
    /** PUT /api/v1/trigger-delay/preferences (admin) — upsert. */
    putPreference(input: {
      subscriber_id: string;
      event_name: string;
      /** 0..2592000 (30 days), server-validated. */
      optimal_delay_seconds: number;
      reason?: string;
    }): Promise<ApiResult<TriggerDelayPreference>> {
      const body = {
        subscriber_id: input.subscriber_id.trim().toLowerCase(),
        event_name: input.event_name.trim().toLowerCase(),
        optimal_delay_seconds: input.optimal_delay_seconds,
        ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
      };
      return request<TriggerDelayPreference>(
        "/api/v1/trigger-delay/preferences",
        {
          method: "PUT",
          body: JSON.stringify(body),
        },
      );
    },
  };

  return triggerDelayApi;
}

export function createSubscriberIntelligenceApis(
  request: SubscriberIntelligenceRequester,
) {
  return {
    lifecycleRollupApi: createLifecycleRollupApi(request),
    leadScoringApi: createLeadScoringApi(request),
    contactRatingsApi: createContactRatingsApi(request),
    eqScoreApi: createEqScoreApi(request),
    subscriberNotesApi: createSubscriberNotesApi(request),
    customFieldsApi: createCustomFieldsApi(request),
    predictiveApi: createPredictiveApi(request),
    zeroCopyTriggersApi: createZeroCopyTriggersApi(request),
    triggerDelayApi: createTriggerDelayApi(request),
  };
}
