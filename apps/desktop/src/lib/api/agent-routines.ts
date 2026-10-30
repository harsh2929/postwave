import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type AgentRoutinesRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- R5 Agent routines (agent_routines) ----------------------- */

export type AgentRoutineKind = "draft_campaign" | "draft_sequence";
export type AgentRoutineSchedule = "manual" | "daily" | "weekly" | "monthly";

/** agent_routines.Routine. */
export interface AgentRoutine {
  id: string;
  name: string;
  prompt: string;
  kind: AgentRoutineKind;
  schedule: AgentRoutineSchedule;
  schedule_detail?: Record<string, unknown>;
  /**
   * Deprecated inert value returned only for cleanup of pre-hardening rows.
   * Routines never resolve or target this list.
   */
  target_list_id?: string | null;
  target_segment_id?: string | null;
  require_approval: boolean;
  enabled: boolean;
  /** True while one durable manual/scheduled run owns this routine. */
  has_active_run: boolean;
  last_run_at?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

/** 422 invalid_routine on validation failure; 409 name_taken on dupes. */
export interface AgentRoutineCreateInput {
  name: string;
  prompt: string;
  kind: AgentRoutineKind;
  schedule?: AgentRoutineSchedule;
  schedule_detail?: Record<string, unknown>;
  target_segment_id?: string | null;
  require_approval?: boolean;
  enabled?: boolean;
}

/** PATCH body — `kind` is immutable after create (no field). */
export interface AgentRoutinePatch {
  name?: string;
  prompt?: string;
  schedule?: AgentRoutineSchedule;
  schedule_detail?: Record<string, unknown>;
  /** Empty string explicitly clears an inert legacy value; non-empty is rejected. */
  target_list_id?: "" | null;
  target_segment_id?: string | null;
  require_approval?: boolean;
  enabled?: boolean;
}

/** agent_routines.Run — one execution (manual or scheduled). */
/** One email of a drafted-sequence trust snapshot. */
export interface AgentRoutineDraftStep {
  position?: number;
  delay_hours?: number;
  subject?: string;
  body?: string;
}

/**
 * draft_preview snapshot — exactly what the agent drafted at run time,
 * captured so a reviewer sees the agent's output even if the underlying
 * draft is later edited. `kind` discriminates campaign vs sequence.
 */
export interface AgentRoutineDraftPreview {
  kind?: "campaign" | "sequence" | string;
  name?: string;
  subject?: string;
  preview_text?: string;
  body?: string;
  steps?: AgentRoutineDraftStep[];
}

export interface AgentRoutineRun {
  id: string;
  routine_id: string;
  /** "running" | "succeeded" | "failed" (render, don't switch). */
  status: string;
  output_kind?: string;
  output_ref?: string;
  approval_id?: string;
  error?: string;
  /**
   * Trust record — the honest "why" behind an autonomous draft. All
   * optional: a run that predates the feature, or failed before drafting,
   * carries none (never fabricated).
   *
   * - prompt_used:  the brief the agent sent the model
   * - context_used: the resolved audience context
   * - reasoning:    the MODEL's own rationale (empty ⇒ none given)
   * - draft_preview: a snapshot of what it produced
   */
  prompt_used?: string;
  context_used?: string;
  reasoning?: string;
  draft_preview?: AgentRoutineDraftPreview;
  started_at: string;
  finished_at?: string | null;
}

export function createAgentRoutinesApi(request: AgentRoutinesRequester) {
  return {
    /** GET /api/v1/agent-routines → `{items}`. */
    list(): Promise<ApiResult<{ items: AgentRoutine[] }>> {
      return request<{ items: AgentRoutine[] }>("/api/v1/agent-routines");
    },
    /** POST /api/v1/agent-routines — 201; 422 invalid_routine / 409 name_taken. */
    create(input: AgentRoutineCreateInput): Promise<ApiResult<AgentRoutine>> {
      return request<AgentRoutine>("/api/v1/agent-routines", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/agent-routines/{id}. */
    get(id: string): Promise<ApiResult<AgentRoutine>> {
      return request<AgentRoutine>(
        `/api/v1/agent-routines/${encodeURIComponent(id)}`,
      );
    },
    /** PATCH /api/v1/agent-routines/{id} — same error codes as create. */
    update(
      id: string,
      patch: AgentRoutinePatch,
    ): Promise<ApiResult<AgentRoutine>> {
      return request<AgentRoutine>(
        `/api/v1/agent-routines/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
    },
    /** DELETE /api/v1/agent-routines/{id}. */
    remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/agent-routines/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    /** POST /api/v1/agent-routines/{id}/run — 202 `{run_id,status:"running"}`;
     *  execution continues server-side, poll {@link listRuns}. The run
     *  itself invokes an LLM, so this is fire-once (no auto-retry) and
     *  never queued offline. */
    run(id: string): Promise<ApiResult<{ run_id: string; status: string }>> {
      return request<{ run_id: string; status: string }>(
        `/api/v1/agent-routines/${encodeURIComponent(id)}/run`,
        { method: "POST", body: "{}" },
        { maxAttempts: 1, requireOnline: true },
      );
    },
    /** GET /api/v1/agent-routines/{id}/runs → `{items}` newest-first. */
    listRuns(id: string): Promise<ApiResult<{ items: AgentRoutineRun[] }>> {
      return request<{ items: AgentRoutineRun[] }>(
        `/api/v1/agent-routines/${encodeURIComponent(id)}/runs`,
      );
    },
    /**
     * GET /api/v1/agent-routines/runs/by-approval/{approvalId} → the agent
     * run that produced a given approval, so the Approvals surface can show
     * the reasoning + draft snapshot beside the decision. 404 (error) when
     * the approval wasn't agent-produced — callers treat that as "no trust
     * record" and render their normal view.
     */
    runByApproval(approvalId: string): Promise<ApiResult<AgentRoutineRun>> {
      return request<AgentRoutineRun>(
        `/api/v1/agent-routines/runs/by-approval/${encodeURIComponent(approvalId)}`,
      );
    },
  };
}
