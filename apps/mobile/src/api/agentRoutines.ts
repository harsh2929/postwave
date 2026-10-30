/**
 * api/agentRoutines.ts — transport for standing agent routines.
 *
 * Every route below was read off the chi mount at
 * `apps/api/internal/agent_routines/handlers.go::MountRoutes` (mounted from
 * `apps/api/main.go:3219`), and its role floor off the generated policy
 * manifest at `apps/api/internal/routeauth/manifest.json`:
 *
 *   GET  /api/v1/agent-routines            viewer / read:campaigns  → {items:[Routine]}
 *   GET  /api/v1/agent-routines/{id}/runs  viewer / read:reports    → {items:[Run]}
 *   POST /api/v1/agent-routines/{id}/run   EDITOR / write:campaigns → 202 {run_id,status}
 *
 * THE ROLE SPLIT IS THE POINT. Reading is `viewer`; running is `editor`,
 * because a run spends LLM quota and writes drafts (the MountRoutes comment
 * says exactly that). The screen gates the button on role rather than
 * discovering the boundary through a 403 after a confirm sheet.
 *
 * DELIBERATELY NOT HERE, and each for a reason rather than for time:
 *   - POST /agent-routines (create) and the AUTHORING half of PATCH /{id}: an 8000-rune
 *     standing brief is a keyboard job, and the PATCH body is a nine-field
 *     partial with pointer semantics ("nil = leave unchanged") that a phone
 *     form would have to reproduce exactly to avoid clearing a field nobody
 *     touched. Note the route is PATCH, not PUT — a client written against
 *     the PUT that some docs imply would 405 on every save.
 *
 *     THE ONE EXCEPTION, added deliberately: `setAgentRoutineEnabled` sends a
 *     body of exactly `{"enabled": …}`. The pointer semantics that make the
 *     full form dangerous are what make this safe — `Enabled *bool` with nil
 *     meaning "leave unchanged" guarantees nothing else moves. The screen was
 *     already sorting routines into "scheduled" and "paused" and offering no
 *     way to move one between them.
 *   - DELETE /{id}: destroying a standing instruction has no undo anywhere in
 *     the API, and it is not a thing anyone needs to do from a phone.
 *   - GET /agent-routines/runs/by-approval/{approvalId}: already consumed, in
 *     the other direction, by hooks/useApprovals.useApprovalAgentRun. This
 *     surface needs run → approval, and `Run.approval_id` carries that
 *     directly (repo.go:344), so no second request exists to make.
 *
 * Parsing lives in lib/agentRoutines so it is unit-testable in the node vitest
 * environment; this module is only URLs and envelopes.
 */
import {
  parseRoutineList,
  parseRunList,
  parseRunNowAck,
  type AgentRoutine,
  type AgentRoutineRun,
  type RunNowAck,
} from "@/lib/agentRoutines";

import { checkedApiResult, rawRequest } from "./request";

export const AGENT_ROUTINES_PATH = "/api/v1/agent-routines";

export function agentRoutinePath(id: string): string {
  return `${AGENT_ROUTINES_PATH}/${encodeURIComponent(id)}`;
}

export function agentRoutineRunsPath(id: string): string {
  return `${agentRoutinePath(id)}/runs`;
}

export function agentRoutineRunNowPath(id: string): string {
  return `${agentRoutinePath(id)}/run`;
}

export async function fetchAgentRoutines(): Promise<AgentRoutine[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AGENT_ROUTINES_PATH),
  );
  return parseRoutineList(res.data);
}

/**
 * `handlers.go:ListRuns` checks the routine exists first, so a deleted routine
 * 404s here rather than answering an empty list — an empty list would read as
 * "this routine has never run", which is a different and wrong claim.
 */
export async function fetchAgentRoutineRuns(
  id: string,
): Promise<AgentRoutineRun[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", agentRoutineRunsPath(id)),
  );
  return parseRunList(res.data);
}

/**
 * 202 Accepted. The handler opens the ledger row SYNCHRONOUSLY (so the id in
 * the body is real) and then executes the drafting work in a detached
 * goroutine bounded by `ExecuteTimeout`. The promise resolving therefore means
 * "a run has started", never "a draft exists" — the screen's copy says so.
 */
/**
 * Pause or resume a standing routine. `PATCH /api/v1/agent-routines/{id}`,
 * editor-minimum (`write:campaigns`), one field only.
 *
 * Answers 409 while a run is in flight — see `ErrRoutineActive`, which start,
 * update and delete deliberately share so no caller learns another run's
 * provider state. The caller turns that into a sentence via
 * `routineEnableErrorMessage`.
 */
export async function setAgentRoutineEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "PATCH",
      `/api/v1/agent-routines/${encodeURIComponent(id)}`,
      { enabled },
    ),
  );
}

export async function runAgentRoutineNow(id: string): Promise<RunNowAck | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", agentRoutineRunNowPath(id)),
  );
  return parseRunNowAck(res.data);
}
