/**
 * lib/approvalChain.ts — "am I the blocker, or is someone ahead of me?"
 *
 * Import-free (node-testable). Read off apps/api/internal/approvals/chain.go,
 * which is mounted at apps/api/main.go and is ABSENT from
 * apps/api/internal/apidocs/openapi.json — so the wire facts below come from
 * the Go source and nowhere else.
 *
 *   GET /api/v1/approvals/chain?resource_type=…  (read:campaigns)
 *       → { resource_type, steps: [{ position, role }] }
 *   GET /api/v1/approvals/{id}/chain             (read:campaigns)
 *       → { approval_id, stages: [{ position, role, status,
 *           decided_by_user_id? }], state, current_position }
 *
 * FOUR FACTS, THREE OF WHICH A PLAUSIBLE IMPLEMENTATION GETS WRONG:
 *
 *  1. `stages` IS EMPTY UNTIL SOMEBODY DECIDES. `decideStage` (chain.go:270)
 *     lazily INSERTs the per-approval progress rows on the FIRST decision.
 *     Until then `loadProgress` returns `[]` and `evaluateChain` reports
 *     state=pending, current_position=0. So an untouched three-stage chain and
 *     a resource with NO chain at all look identical on the progress endpoint.
 *     Distinguishing them needs the CONFIG endpoint too, which is why this
 *     module merges two responses instead of rendering one.
 *  2. current_position 0 IS NOT STAGE 0. `evaluateChain` (chain.go:55)
 *     initialises `current := 0` and only overwrites it from a real stage
 *     position, which are 1-based. Zero therefore means "nothing recorded",
 *     and rendering it as a stage number would put the reader on a stage that
 *     does not exist.
 *  3. THE CHAIN CONFIG CAN BE REPLACED UNDER A RUNNING APPROVAL. `setChain`
 *     DELETEs every step for the resource type and re-INSERTs
 *     (chain.go:129-145) while `approval_chain_progress` rows survive. So the
 *     recorded stages can be longer than, shorter than, or differently-rolled
 *     from the current config. The merge below keeps the RECORDED stage
 *     wherever one exists — that is what actually happened — appends any
 *     newly-configured stages as pending, and reports the disagreement rather
 *     than silently picking one source.
 *  4. THE DECIDE ROUTE DOES NOT CHECK THE STAGE'S ROLE. `decideStage` gates on
 *     `write:campaigns` and then decides whatever stage is pending; it never
 *     compares the caller's role to `stages[n].role`. So this module must
 *     never render "only Legal can approve this" — it says who the chain is
 *     WAITING ON, which is what the data supports.
 */

export type ApprovalChainStageStatus = "pending" | "approved" | "rejected";

/** One configured step. Mirrors approvals.ChainStep (Go). */
export interface ApprovalChainStep {
  position: number;
  role: string;
}

/** One recorded stage. Mirrors approvals.StageProgress (Go). */
export interface ApprovalChainStageProgress {
  position: number;
  role: string;
  status: string;
  decided_by_user_id?: string | null;
}

export interface ApprovalChainProgressResponse {
  stages: ApprovalChainStageProgress[];
  state: string;
  current_position: number;
}

export interface ApprovalChainStage {
  position: number;
  role: string;
  status: ApprovalChainStageStatus;
  /** True when this is the stage the chain is currently waiting on. */
  current: boolean;
  /** True when the stage exists only in the config, with nothing recorded. */
  unrecorded: boolean;
}

export interface ApprovalChainView {
  /** False when no chain is configured — the screen renders nothing. */
  configured: boolean;
  stages: ApprovalChainStage[];
  /** 1-based, or null when the chain is settled or nothing is configured. */
  currentPosition: number | null;
  state: "pending" | "approved" | "rejected";
  /** Set when the recorded stages disagree with the current configuration. */
  reconfigured: boolean;
}

function normalizeStatus(raw: unknown): ApprovalChainStageStatus {
  const value = String(raw ?? "").toLowerCase();
  if (value === "approved" || value === "rejected") return value;
  return "pending";
}

export function normalizeChainSteps(res: unknown): ApprovalChainStep[] {
  const raw = (res as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw)) return [];
  const out: ApprovalChainStep[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const step = entry as Partial<ApprovalChainStep>;
    if (typeof step.position !== "number" || step.position <= 0) continue;
    out.push({ position: step.position, role: String(step.role ?? "").trim() });
  }
  return out.sort((a, b) => a.position - b.position);
}

export function normalizeChainProgress(
  res: unknown,
): ApprovalChainProgressResponse {
  const body = (res ?? {}) as Partial<ApprovalChainProgressResponse>;
  const raw = Array.isArray(body.stages) ? body.stages : [];
  const stages: ApprovalChainStageProgress[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const stage = entry as Partial<ApprovalChainStageProgress>;
    if (typeof stage.position !== "number" || stage.position <= 0) continue;
    stages.push({
      position: stage.position,
      role: String(stage.role ?? "").trim(),
      status: String(stage.status ?? "pending"),
      ...(stage.decided_by_user_id
        ? { decided_by_user_id: stage.decided_by_user_id }
        : {}),
    });
  }
  stages.sort((a, b) => a.position - b.position);
  const state = String(body.state ?? "pending");
  return {
    stages,
    state: state === "approved" || state === "rejected" ? state : "pending",
    current_position:
      typeof body.current_position === "number" ? body.current_position : 0,
  };
}

/**
 * Merge the configured chain with what has actually been recorded.
 *
 * The recorded stage always wins where one exists — it is the history, and
 * the config is only the plan. `currentPosition` is recomputed here rather
 * than trusting `current_position`, because that field is 0 for an untouched
 * chain (fact 2) and the reader needs stage 1, not stage 0.
 */
export function buildApprovalChainView(
  rawSteps: readonly ApprovalChainStep[] | null | undefined,
  progress: ApprovalChainProgressResponse | null,
): ApprovalChainView {
  // Both inputs are coerced rather than trusted. This app PERSISTS the query
  // cache to disk (lib/secureQueryPersister), so an entry written by an older
  // build — whose fetcher returned a different shape — can be rehydrated
  // straight into this function after an app update. `.map` on that value
  // throws inside render, which an error boundary turns into a blank approval
  // screen with no way back; an empty chain plus a refetch is recoverable.
  const steps: readonly ApprovalChainStep[] = Array.isArray(rawSteps)
    ? rawSteps
    : [];
  const recorded = Array.isArray(progress?.stages) ? progress.stages : [];
  if (steps.length === 0 && recorded.length === 0) {
    return {
      configured: false,
      stages: [],
      currentPosition: null,
      state: "pending",
      reconfigured: false,
    };
  }

  const byPosition = new Map<number, ApprovalChainStageProgress>();
  for (const stage of recorded) byPosition.set(stage.position, stage);

  const positions = new Set<number>([
    ...steps.map((s) => s.position),
    ...recorded.map((s) => s.position),
  ]);

  const stages: ApprovalChainStage[] = [...positions]
    .sort((a, b) => a - b)
    .map((position) => {
      const done = byPosition.get(position);
      const planned = steps.find((s) => s.position === position);
      return {
        position,
        role: done?.role || planned?.role || "",
        status: done ? normalizeStatus(done.status) : "pending",
        current: false,
        unrecorded: !done,
      };
    });

  const rejected = stages.find((s) => s.status === "rejected");
  const firstOpen = stages.find((s) => s.status === "pending");
  const state: ApprovalChainView["state"] = rejected
    ? "rejected"
    : firstOpen
      ? "pending"
      : "approved";
  const currentPosition =
    state === "pending" && firstOpen ? firstOpen.position : null;
  for (const stage of stages) {
    stage.current = currentPosition !== null && stage.position === currentPosition;
  }

  // The config was replaced mid-flight when a recorded stage names a role the
  // current config no longer has at that position, or when the two lists are
  // different lengths.
  const reconfigured =
    recorded.length > 0 &&
    (steps.length !== recorded.length ||
      recorded.some((stage) => {
        const planned = steps.find((s) => s.position === stage.position);
        return !planned || planned.role !== stage.role;
      }));

  return { configured: true, stages, currentPosition, state, reconfigured };
}

function titleCase(role: string): string {
  const trimmed = role.trim();
  if (!trimmed) return "an unnamed role";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * The one-line answer to "am I the blocker?".
 *
 * `viewerRole` is the reader's own workspace role. It is compared
 * case-insensitively and used ONLY to add "that's you" — never to claim
 * somebody else cannot decide, because the server does not enforce the stage
 * role (fact 4).
 */
export function approvalChainHeadline(
  view: ApprovalChainView,
  viewerRole: string | null | undefined,
): string | null {
  if (!view.configured) return null;
  const total = view.stages.length;
  if (view.state === "rejected") {
    const at = view.stages.find((s) => s.status === "rejected");
    return at
      ? `Rejected at stage ${at.position} of ${total} (${titleCase(at.role)}).`
      : `Rejected in the approval chain.`;
  }
  if (view.state === "approved") {
    return `All ${total} chain stage${total === 1 ? "" : "s"} approved.`;
  }
  const current = view.stages.find((s) => s.current);
  if (!current) return `Waiting in a ${total}-stage approval chain.`;
  const mine =
    Boolean(viewerRole) &&
    current.role.trim().toLowerCase() === String(viewerRole).trim().toLowerCase();
  const ahead = current.position - 1;
  const aheadText =
    ahead > 0
      ? ` ${ahead} stage${ahead === 1 ? "" : "s"} ahead already approved.`
      : "";
  return mine
    ? `Stage ${current.position} of ${total} — waiting on ${titleCase(current.role)}, which is your role.${aheadText}`
    : `Stage ${current.position} of ${total} — waiting on ${titleCase(current.role)}.${aheadText}`;
}

/** The per-stage spoken label. State is never colour-alone. */
export function approvalChainStageLabel(stage: ApprovalChainStage): string {
  const role = titleCase(stage.role);
  switch (stage.status) {
    case "approved":
      return `Stage ${stage.position}, ${role}: approved`;
    case "rejected":
      return `Stage ${stage.position}, ${role}: rejected`;
    default:
      return stage.current
        ? `Stage ${stage.position}, ${role}: waiting now`
        : `Stage ${stage.position}, ${role}: not started`;
  }
}

/**
 * The disclosure shown when the chain configuration changed under a running
 * approval. Without it the ladder silently shows a stage list that never
 * existed as a whole.
 */
export const APPROVAL_CHAIN_RECONFIGURED_NOTE =
  "The chain was changed after this request started. Stages already decided are shown as they were recorded.";
