// Typed client for the sto_content_optimizer Thompson-sampling bandit
// (apps/api/internal/sto_content_optimizer), mounted at
// /api/v1/campaigns/{id}/optimizer/runs + /api/v1/optimizer/runs/{run_id}/*.
//
// G-54: this is a real multi-armed-bandit content optimizer (Beta-Bernoulli
// Thompson sampling over the cartesian product of subject/header/body/CTA
// variants) with a worker + 5 mounted routes and ZERO client — operators could
// not create, start, inspect, or complete a run from the app. The existing
// "Content optimizer" card drives a DIFFERENT, simpler module
// (/api/v1/campaigns/{id}/content-optimizer); this is the client for the
// rigorous bandit. Shapes verified against sto_content_optimizer.go.
import type { ApiRequester, ApiResult } from "./result";

export type OptimizerObjective = "open_rate" | "click_rate" | "conversion_rate";
export type OptimizerStatus = "draft" | "exploring" | "exploiting" | "completed" | "aborted";

export interface ComponentVariant {
  id: string;
  text?: string;
  mjml?: string;
  label?: string;
  url?: string;
}

export interface ComponentsManifest {
  subject?: ComponentVariant[];
  header?: ComponentVariant[];
  body?: ComponentVariant[];
  cta?: ComponentVariant[];
}

export interface OptimizerRun {
  id: string;
  tenant_id: string;
  campaign_id: string;
  name?: string;
  objective: OptimizerObjective;
  status: OptimizerStatus;
  components: ComponentsManifest;
  traffic_allocation: Record<string, number>;
  model_state?: unknown;
  min_impressions_per_arm: number;
  exploration_floor: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

// OptimizerArm is one materialised cartesian arm with its Beta posterior — the
// number the UI renders as "this combination is winning".
export interface OptimizerArm {
  id: string;
  run_id: string;
  tenant_id: string;
  component_ids: Record<string, string>;
  impressions: number;
  conversions: number;
  posterior_alpha: number;
  posterior_beta: number;
  last_assigned_at?: string;
  created_at: string;
}

export interface CreateOptimizerRunInput {
  name?: string;
  objective?: OptimizerObjective;
  components: ComponentsManifest;
  min_impressions_per_arm?: number;
  exploration_floor?: number;
}

export interface OptimizerRunWithArms {
  run: OptimizerRun;
  arms: OptimizerArm[];
}

interface RunEnvelope {
  run: OptimizerRun;
}
interface RunsEnvelope {
  runs: OptimizerRun[];
}

function post(body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

// createOptimizerRunsApi wires typed methods over the 5 mounted bandit routes.
export function createOptimizerRunsApi(request: ApiRequester) {
  return {
    // POST /api/v1/campaigns/{id}/optimizer/runs — create a run (201).
    createRun(campaignId: string, input: CreateOptimizerRunInput): Promise<ApiResult<OptimizerRun>> {
      return request<RunEnvelope>(
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/optimizer/runs`,
        post(input),
      ).then(unwrapRun);
    },

    // GET /api/v1/campaigns/{id}/optimizer/runs — the campaign's runs.
    listRuns(campaignId: string): Promise<ApiResult<OptimizerRun[]>> {
      return request<RunsEnvelope>(
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/optimizer/runs`,
      ).then((res) => (res.error ? res : { data: res.data.runs ?? [] }));
    },

    // GET /api/v1/optimizer/runs/{run_id} — one run + its arms/posteriors.
    getRun(runId: string): Promise<ApiResult<OptimizerRunWithArms>> {
      return request<OptimizerRunWithArms>(`/api/v1/optimizer/runs/${encodeURIComponent(runId)}`);
    },

    // POST /api/v1/optimizer/runs/{run_id}/start — draft → exploring.
    startRun(runId: string): Promise<ApiResult<OptimizerRun>> {
      return request<RunEnvelope>(
        `/api/v1/optimizer/runs/${encodeURIComponent(runId)}/start`,
        post(),
      ).then(unwrapRun);
    },

    // POST /api/v1/optimizer/runs/{run_id}/complete — freeze allocation.
    completeRun(runId: string): Promise<ApiResult<OptimizerRun>> {
      return request<RunEnvelope>(
        `/api/v1/optimizer/runs/${encodeURIComponent(runId)}/complete`,
        post(),
      ).then(unwrapRun);
    },
  };
}

// unwrapRun flattens the {run} envelope to the run, preserving the ApiErr branch.
function unwrapRun(res: ApiResult<RunEnvelope>): ApiResult<OptimizerRun> {
  if (res.error) return res;
  return { data: res.data.run };
}

export type OptimizerRunsApi = ReturnType<typeof createOptimizerRunsApi>;
