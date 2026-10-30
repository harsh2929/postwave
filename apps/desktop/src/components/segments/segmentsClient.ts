/**
 * segmentsClient — thin fetch wrapper for the /api/v1/segments/* surface.
 *
 * Lives next to the segments UI rather than in lib/api-client.ts because
 * the segments surface has no `api.segments.*` namespace today and we
 * don't want to mutate the shared client just to satisfy a single page.
 *
 * Uses the canonical apiRequest helper so it inherits the same native
 * headers, bearer/session resolution, offline policy, retry behavior, and
 * diagnostics as every other desktop API call.
 */

import {
  apiRequest,
  queueableApiRequest,
  type ApiResult,
  type QueueableApiResult,
} from "../../lib/api-client";

/* ----- SUB-040: saved-segment organizer surface --------------------
 *
 * Pinning / sharing / ordering / folders live on the SEPARATE
 * `saved_segments` + `segment_folders` tables, whose typed client lives
 * in lib/api-client.ts (the same surface the SavedSegmentDropdown picker
 * reads). They are re-exported here so the segments UI has one import for
 * its whole client surface; SavedSegmentsManager consumes them.
 */
export {
  type SavedSegment,
  type SavedSegmentInput,
  type SavedSegmentPatch,
  type SavedSegmentScope,
  type SegmentFolder,
  listSavedSegments,
  patchSavedSegment,
  listSegmentFolders,
  createSegmentFolder,
  patchSegmentFolder,
  deleteSegmentFolder,
} from "../../lib/api-client";

export interface Segment {
  id: string;
  tenantId?: string;
  name: string;
  description?: string;
  queryAst?: unknown;
  lastCount?: number | null;
  lastEvaluatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /* Optional UI-only marker so we can render a Static vs Dynamic chip.
   * Backend doesn't model this yet; we fall back to "dynamic" since
   * every saved segment today is a dynamic AST. */
  kind?: "dynamic" | "static" | "ai";
}

export interface CompileFromTextResult {
  query_ast?: unknown;
  queryAst?: unknown;
  rationale?: string;
  suggested_name?: string;
  suggestedName?: string;
}

export interface PreviewCountResult {
  count: number;
  computed_in_ms: number;
  capped: boolean;
}

export interface RecomputeResult {
  scheduled_at: string;
  count: number;
}

/** A segment evaluation record (segments.Snapshot). `count` is the evaluated
 *  member count and `sample_size` is the bounded number of emails cached for
 *  browsing. This is not a complete immutable membership list when the two
 *  values differ and must not be presented as an exact replay audience. */
export interface SegmentSnapshot {
  id: string;
  tenant_id: string;
  segment_id: string;
  query_ast?: unknown;
  count: number;
  sample_size: number;
  evaluator_version: string;
  evaluated_at: string;
  created_at: string;
}

/** One sampled member row (segments.SnapshotMember). */
export interface SnapshotMember {
  email: string;
  subscriber_id: string;
}

/** GET …/members response. `sample_is_complete` is false when the snapshot
 *  sampled fewer rows than its true `total` — drive an honest "first N of
 *  M" note off it, never imply the sample is the whole set. */
export interface SnapshotMembersPage {
  items: SnapshotMember[];
  page: number;
  per_page: number;
  total: number;
  sample_size: number;
  sample_is_complete: boolean;
}

/** One thing a segment can filter on (segments.PredicateDefinition).
 *  `compiler_status` ∈ supported|planned — "planned" predicates are in the
 *  catalog but NOT yet evaluable by the compiler; the UI must badge them so
 *  operators don't rely on a field that won't filter. */
export interface PredicateDefinition {
  key: string;
  label: string;
  category: string;
  value_type: string;
  comparators: string[];
  options?: string[];
  source: string;
  source_ref?: string;
  activation: string[];
  compiler_status: string;
  help?: string;
}

/** An event metric available for segmentation (segments.MetricDefinition). */
export interface RegistryMetricDefinition {
  key: string;
  label: string;
  source: string;
  event_name?: string;
  aggregation: string;
  value_type: string;
  property_path?: string;
  total?: number;
  last_seen_at?: string | null;
}

/** A custom object type linkable in segments (segments.CustomObjectTypeDefinition). */
export interface RegistryCustomObject {
  id: string;
  key: string;
  label: string;
  primary_key: string;
  schema?: Record<string, unknown>;
  status: string;
  updated_at: string;
}

/** GET /api/v1/segments/predicate-registry (segments.PredicateRegistryResponse). */
export interface PredicateRegistry {
  registry_version: string;
  boolean_ops: string[];
  predicates: PredicateDefinition[];
  metrics: RegistryMetricDefinition[];
  custom_objects: RegistryCustomObject[];
  warnings?: string[];
}

/** One AI-suggested segment (segments.AISuggestion) — SUB-065 cohort
 *  discovery. `predicate_json` is a canonical SegmentNode AST that
 *  compiles via the same path as a hand-built segment, so "Use as
 *  segment" can seed the NL builder directly with it. `category` drives
 *  the badge (lifecycle | engagement | predictive | consent). */
export interface AISuggestion {
  key: string;
  name: string;
  description: string;
  predicate_json: unknown;
  estimated_size: number;
  rationale: string;
  category: string;
}

/** GET /api/v1/segments/ai-suggestions (segments.AISuggestionsResponse).
 *  `notice` is a disclosure banner the gallery shows above the cards;
 *  `generated` identifies the engine ("heuristic-v1" today). */
export interface AISuggestionsResponse {
  items: AISuggestion[];
  generated: string;
  notice: string;
}

/**
 * SUB-034 — one entry in the one-click predictive segment-template
 * gallery (segments.SegmentTemplate). `predicate_json` is a
 * ready-to-materialize SegmentNode AST built from the predictive.* /
 * rfm.* predicate fields; `applyTemplate` POSTs it to /segments to stand
 * the audience up as a real saved segment.
 */
export interface SegmentTemplate {
  key: string;
  label: string;
  description: string;
  /** Non-binding lucide-style icon name hint for the card. */
  icon_hint: string;
  /** Gallery grouping (predictive). */
  category: string;
  /** Pre-fills the create-segment name field. */
  suggested_name: string;
  /** The ready-to-materialize SegmentNode AST. */
  predicate_json: unknown;
}

/** GET /api/v1/segments/templates (segments.SegmentTemplatesResponse). */
export interface SegmentTemplatesResponse {
  items: SegmentTemplate[];
}

async function call<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  return apiRequest<T>(path, init, { timeoutMs: 30_000 });
}

async function queueableCall<T>(
  path: string,
  init: RequestInit = {},
): Promise<QueueableApiResult<T>> {
  return queueableApiRequest<T>(path, init, { timeoutMs: 30_000 });
}

export const segmentsClient = {
  list(): Promise<ApiResult<Segment[]>> {
    return call<Segment[]>("/api/v1/segments");
  },
  get(id: string): Promise<ApiResult<Segment>> {
    return call<Segment>(`/api/v1/segments/${encodeURIComponent(id)}`);
  },
  create(input: {
    name: string;
    description?: string;
    queryAst: unknown;
    /** SUB-034 — mark the new segment as materialized from a template. */
    isTemplate?: boolean;
  }): Promise<QueueableApiResult<Segment>> {
    return queueableCall<Segment>("/api/v1/segments", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  delete(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return call<{ ok: boolean }>(`/api/v1/segments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  compileFromText(text: string): Promise<ApiResult<CompileFromTextResult>> {
    return call<CompileFromTextResult>("/api/v1/segments/compile-from-text", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  },
  previewCount(input: {
    queryAst?: unknown;
    text?: string;
  }): Promise<ApiResult<PreviewCountResult>> {
    return call<PreviewCountResult>("/api/v1/segments/preview-count", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  recompute(id: string): Promise<ApiResult<RecomputeResult>> {
    return call<RecomputeResult>(
      `/api/v1/segments/${encodeURIComponent(id)}/recompute`,
      { method: "POST" },
    );
  },
  /** POST /api/v1/segments/{id}/snapshot — record the current predicate,
   *  evaluated count, and bounded browsing sample (201). Write scope. */
  createSnapshot(id: string): Promise<ApiResult<SegmentSnapshot>> {
    return call<SegmentSnapshot>(
      `/api/v1/segments/${encodeURIComponent(id)}/snapshot`,
      { method: "POST" },
    );
  },
  /** GET /api/v1/segments/{id}/snapshots → `{items}` newest-first. */
  listSnapshots(id: string): Promise<ApiResult<{ items: SegmentSnapshot[] }>> {
    return call<{ items: SegmentSnapshot[] }>(
      `/api/v1/segments/${encodeURIComponent(id)}/snapshots`,
    );
  },
  /** GET /api/v1/segments/predicate-registry — the catalog of fields,
   *  metrics, and custom objects a segment can filter on (read scope). */
  registry(): Promise<ApiResult<PredicateRegistry>> {
    return call<PredicateRegistry>("/api/v1/segments/predicate-registry");
  },
  /** GET /api/v1/segments/ai-suggestions — SUB-065 cohort-discovery.
   *  Returns 5-8 heuristic-ranked segment suggestions (read scope). */
  aiSuggestions(): Promise<ApiResult<AISuggestionsResponse>> {
    return call<AISuggestionsResponse>("/api/v1/segments/ai-suggestions");
  },
  /** SUB-034 — GET /api/v1/segments/templates → the static one-click
   *  predictive starter-template catalog (read scope). 404 (route not
   *  deployed yet) degrades to an empty list so the gallery hides
   *  cleanly rather than erroring. */
  async listTemplates(): Promise<ApiResult<SegmentTemplatesResponse>> {
    const res = await call<SegmentTemplatesResponse>(
      "/api/v1/segments/templates",
    );
    if (res.error && res.error.kind === "http" && res.error.status === 404) {
      return { data: { items: [] } };
    }
    return res;
  },
  /** SUB-034 — materialize a template as a new saved segment. POSTs the
   *  template's predicate_json to /segments with isTemplate=true so the
   *  result reuses the full segment lifecycle (preview, recompute,
   *  snapshots). The caller supplies the operator-chosen name. */
  applyTemplate(
    template: SegmentTemplate,
    name: string,
  ): Promise<QueueableApiResult<Segment>> {
    return queueableCall<Segment>("/api/v1/segments", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: template.description,
        queryAst: template.predicate_json,
        isTemplate: true,
      }),
    });
  },
  /** GET /api/v1/segments/snapshots/{snapshotId}/members?page=&per_page=. */
  listSnapshotMembers(
    snapshotId: string,
    opts: { page?: number; perPage?: number } = {},
  ): Promise<ApiResult<SnapshotMembersPage>> {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return call<SnapshotMembersPage>(
      `/api/v1/segments/snapshots/${encodeURIComponent(snapshotId)}/members${qs ? `?${qs}` : ""}`,
    );
  },
};
