// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the flow-builder backend (apps/api/internal/flowbuilder).
// Mirrors the Go FlowGraph / FlowInput / Flow / GraphValidate* shapes 1:1 —
// keep the json field names in sync with flowbuilder.go.

import { api } from "./api";

export type RuntimeStatus = "supported" | "partial" | "planned";
export type FlowStatus = "draft" | "active" | "paused" | "archived";

export interface FieldSpec {
  key: string;
  type: string; // string | number | textarea | select | datetime | url | segment_condition | boolean
  required?: boolean;
  options?: string[];
}

export interface CatalogItem {
  key: string;
  label: string;
  category: string;
  channel?: string;
  runtime_status: RuntimeStatus;
  fields?: FieldSpec[];
  requires_review?: boolean;
  definition?: Record<string, unknown>;
}

export interface ConditionFieldSpec {
  key: string; // e.g. "custom.predicted_churn_risk"
  label: string;
  type: string; // number | string | datetime
  category: string; // profile | predictive | rfm
}

export interface FlowCatalog {
  schema_version: string;
  triggers: CatalogItem[];
  nodes: CatalogItem[];
  actions: CatalogItem[];
  statuses: string[];
  condition_fields?: ConditionFieldSpec[];
}

// Graph AST. Nodes/triggers are polymorphic — known keys are typed, the rest
// pass through unchanged so the editor never drops backend-authored fields.
export interface FlowNode {
  id: string;
  type: string;
  // Common authored fields (optional; type-specific).
  template_id?: string;
  sms_body?: string;
  duration_seconds?: number;
  wait_until?: string;
  webhook_url?: string;
  webhook_method?: string;
  condition?: Record<string, unknown>;
  goal?: Record<string, unknown>;
  action?: Record<string, unknown>;
  true_next?: string;
  false_next?: string;
  /**
   * Optional canvas coordinates. Presentation ONLY — the engine ignores it.
   * Absent means "auto-layout me"; present means the operator dragged this node
   * and it should stay put. FlowGraph.Nodes is []map[string]any on the Go side,
   * so this round-trips through save/load with no schema change.
   */
  position?: { x: number; y: number };
  [key: string]: unknown;
}

export interface FlowEdge {
  from: string;
  to: string;
}

export interface FlowTrigger {
  type: string;
  [key: string]: unknown;
}

export interface FlowGraph {
  entry_id?: string;
  triggers?: FlowTrigger[];
  nodes: FlowNode[];
  edges?: FlowEdge[];
  goals?: Array<Record<string, unknown>>;
}

/**
 * Whether a subscriber may enter this flow more than once.
 *
 *  once     — default; at most one traversal, ever (welcome / onboarding)
 *  always   — a fresh run on every matching trigger (abandoned cart, back-in-stock)
 *  cooldown — a fresh run only if the last began > cooldown_hours ago (win-back)
 *
 * Before this existed a subscriber could enter any flow exactly ONCE, ever, so
 * abandoned-cart fired at most one email per person per lifetime.
 */
export type ReEnrollment = "once" | "always" | "cooldown";

export interface Flow {
  id: string;
  tenant_id?: string;
  /** Exact strong validator captured with this representation. */
  etag?: string;
  name: string;
  status: FlowStatus;
  version: number;
  re_enrollment?: ReEnrollment;
  re_enrollment_cooldown_hours?: number;
  graph: FlowGraph;
  analytics?: Record<string, unknown>;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
  /**
   * The most recent version (FLOW-008). On an active flow, `latest_version.status`
   * === "draft" means there are unpublished edits — `graph` above reflects that
   * draft. "published" means the stored published configuration is current;
   * neither state is evidence that the release-held runtime executed it.
   */
  latest_version?: FlowVersion;
}

export interface FlowInput {
  name?: string;
  status?: FlowStatus;
  /** Omit to leave the stored policy untouched (the backend COALESCEs it). */
  re_enrollment?: ReEnrollment;
  re_enrollment_cooldown_hours?: number;
  entry_id?: string;
  triggers?: FlowTrigger[];
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  goals?: Array<Record<string, unknown>>;
}

export interface GraphValidateRequest {
  entry_id?: string;
  triggers?: FlowTrigger[];
  nodes: FlowNode[];
  edges?: FlowEdge[];
}

export interface GraphValidateResponse {
  valid: boolean;
  executable: boolean;
  errors?: string[];
  warnings?: string[];
  supported_nodes: number;
  planned_nodes: number;
  unsupported_nodes: number;
}

export interface FlowVersion {
  id: string;
  flow_id: string;
  version: number;
  status: string;
  graph: FlowGraph;
  generated_by: string;
  source_ref?: string;
  published_at?: string | null;
  created_at: string;
}

export interface VersionInput {
  graph?: FlowGraph;
  generated_by?: string;
  source_ref?: string;
}

interface ListEnvelope {
  items: Flow[];
  nextCursor?: string;
}

interface VersionListEnvelope {
  items: FlowVersion[];
  nextCursor?: string;
}

/** One per-subscriber flow run for the run inspector (FLOW-035). */
export interface FlowRunStepAttempt {
  node_id: string;
  action_kind: string;
  applied: number;
  skipped: number;
  failed: number;
  error?: string;
  occurred_at: string;
}

interface FlowRunStepsEnvelope {
  run_id: string;
  attempts?: FlowRunStepAttempt[];
}

export interface FlowRun {
  id: string;
  subscriber_id: string;
  status: string;
  trigger_event_name?: string;
  scheduled_at: string;
  started_at?: string;
  finished_at?: string;
}

interface RunListEnvelope {
  items: FlowRun[];
}

const BASE = "/api/v1/flow-builder";
const flowEtags = new Map<string, string>();

export function isExactStrongFlowETag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= 512 &&
    /^"[^,\u0000-\u001f\u007f-\u009f]+"$/u.test(value)
  );
}

function rememberFlow(flow: Flow): Flow {
  if (isExactStrongFlowETag(flow.etag)) flowEtags.set(flow.id, flow.etag);
  return flow;
}

function captureFlowETag(id: string, response: Response): void {
  // onResponse runs before the shared client throws for a 412. A rejected
  // token is dead and must not poison every retry.
  if (response.status === 412 || response.status === 428) {
    flowEtags.delete(id);
    return;
  }
  const etag = response.headers.get("ETag");
  if (isExactStrongFlowETag(etag)) flowEtags.set(id, etag);
}

function requireFlowETag(id: string): string {
  const etag = flowEtags.get(id);
  if (!isExactStrongFlowETag(etag)) {
    throw new Error(
      "Reload this flow before changing it so Moosewave can verify nobody else edited it.",
    );
  }
  return etag;
}

export const FLOW_ACTIVATION_RELEASE_HOLD =
  "Flow activation is release-held. Draft editing and validation do not enroll subscribers or send messages.";

function flowActivationReleaseHeldError(): Error {
  return new Error(FLOW_ACTIVATION_RELEASE_HOLD);
}

export interface FlowListParams {
  /** Server-side status filter (draft|active|paused|archived). */
  status?: string;
  /** Keyset cursor from a prior page's nextCursor. */
  cursor?: string;
  limit?: number;
}

function flowListPath(params: FlowListParams = {}): string {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString();
  return `${BASE}/flows${suffix ? `?${suffix}` : ""}`;
}

export const flowsApi = {
  catalog: () => api.get<FlowCatalog>(`${BASE}/catalog`),
  list: (params: FlowListParams = {}) =>
    api.get<ListEnvelope>(flowListPath(params)).then((page) => ({
      ...page,
      items: (Array.isArray(page.items) ? page.items : []).map(rememberFlow),
    })),
  /**
   * Page through the whole keyset list (FLOW-021). The list endpoint returns a
   * keyset Envelope (default LIMIT 200) and the UI filters/sorts client-side,
   * so we drain every page up to a hard ceiling rather than silently showing
   * only the first 200. The ceiling bounds a pathological tenant.
   */
  listAll: async (
    params: Omit<FlowListParams, "cursor"> = {},
  ): Promise<Flow[]> => {
    const MAX_PAGES = 25; // 25 × 200 = 5000 flows — far above any real tenant.
    const out: Flow[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.get<ListEnvelope>(
        flowListPath({ ...params, cursor }),
      );
      const items = (Array.isArray(page.items) ? page.items : []).map(
        rememberFlow,
      );
      out.push(...items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  },
  get: (id: string) =>
    api
      .get<Flow>(`${BASE}/flows/${encodeURIComponent(id)}`, {
        onResponse: (response) => captureFlowETag(id, response),
      })
      .then(rememberFlow),
  create: (input: FlowInput) =>
    api
      .post<Flow>(`${BASE}/flows`, input, { requireOnline: true })
      .then(rememberFlow),
  update: async (id: string, input: FlowInput) => {
    const etag = requireFlowETag(id);
    return api
      .patch<Flow>(`${BASE}/flows/${encodeURIComponent(id)}`, input, {
        headers: { "If-Match": etag },
        onResponse: (response) => captureFlowETag(id, response),
      })
      .then(rememberFlow);
  },
  validate: (req: GraphValidateRequest) =>
    api.post<GraphValidateResponse>(`${BASE}/validate`, req),
  // The server deliberately returns its runtime-unavailable descriptor while
  // flowRuntimeQualified=false. Fail before transport as a second containment
  // boundary so a stale client control cannot imply or attempt live delivery.
  activate: async (_id: string): Promise<Flow> => {
    throw flowActivationReleaseHeldError();
  },
  listVersions: (id: string) =>
    api.get<VersionListEnvelope>(
      `${BASE}/flows/${encodeURIComponent(id)}/versions`,
    ),
  /**
   * Per-node attempts for ONE run — the half `listRuns` cannot answer.
   *
   * A run row carries a single status for the whole traversal, so it says a run
   * failed and never which node, or that it succeeded while hiding a node that
   * failed and was retried. The counters come back as three numbers for exactly
   * that reason: a retry is `failed: 1` then `applied: 1`, and collapsing it
   * into one outcome hides the thing somebody opened the inspector to find.
   */
  listRunSteps: (runId: string) =>
    api
      .get<FlowRunStepsEnvelope>(
        `/api/v1/flow-runs/${encodeURIComponent(runId)}/steps`,
      )
      .then((r) => r.attempts ?? []),
  listRuns: (id: string, limit?: number) =>
    api
      .get<RunListEnvelope>(
        `${BASE}/flows/${encodeURIComponent(id)}/runs${limit ? `?limit=${encodeURIComponent(String(limit))}` : ""}`,
      )
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  createVersion: async (id: string, input: VersionInput) => {
    const etag = requireFlowETag(id);
    return api.post<FlowVersion>(
      `${BASE}/flows/${encodeURIComponent(id)}/versions`,
      input,
      {
        headers: { "If-Match": etag },
        onResponse: (response) => captureFlowETag(id, response),
        requireOnline: true,
      },
    );
  },
  promoteVersion: (
    id: string,
    versionId: string,
    activate: boolean,
  ): Promise<Flow> => {
    if (activate) return Promise.reject(flowActivationReleaseHeldError());
    return api.post<Flow>(
      `${BASE}/flows/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/promote`,
      { activate: false },
    );
  },
  /**
   * FLOW-008 — promote a draft into an active row's stored published graph.
   * Omit versionId to publish the latest draft. This is configuration movement,
   * not activation or execution, and returns the updated flow.
   */
  publish: async (id: string, versionId?: string) => {
    const etag = requireFlowETag(id);
    return api
      .post<Flow>(
        `${BASE}/flows/${encodeURIComponent(id)}/publish`,
        versionId ? { version_id: versionId } : {},
        {
          headers: { "If-Match": etag },
          onResponse: (response) => captureFlowETag(id, response),
          requireOnline: true,
        },
      )
      .then(rememberFlow);
  },
};

/**
 * Canonical web URL for a flow (FLOW-040). The shared @postwave/route-map
 * registry does not (yet) carry a "flow" entity, so — rather than emit a broken
 * universal link — we build the same-origin app path directly. `origin`
 * defaults to the current deployment.
 */
export function flowWebUrl(id: string, origin?: string): string {
  const base =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/app/flows/${encodeURIComponent(id)}`;
}

/** Runtime-status presentation: dot colour + human label. */
export function runtimeStatusMeta(status: RuntimeStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "supported":
      return { label: "Supported definition", className: "text-emerald-600" };
    case "partial":
      return { label: "Partial node support", className: "text-amber-600" };
    default:
      return { label: "Design only", className: "text-zinc-400" };
  }
}
