/**
 * lib/approvalDelegationDraft.ts — validating a "hand my approvals to Sam" draft.
 *
 * ── WHY THIS EXISTS NOW ────────────────────────────────────────────────────
 * GATE#11. `ApprovalGovernanceSection` shipped read + revoke and said, in its
 * docstring and in the UI: "creating a delegation needs a target USER id and the
 * API exposes no workspace-members listing, so the 'delegate to Sam' picker is not
 * buildable on mobile yet." That was true when written and is now stale —
 * `GET /api/v1/workspace/members` is mounted at
 * apps/api/internal/handlers/workspace_members.go:562 behind ScopeAdmin, which is
 * the same floor `POST /api/v1/approvals/delegations` already requires
 * (approvals/handlers.go:91 → createDelegation → requireAdmin).
 *
 * Handing over approvals before leave is a phone act if anything is: you remember
 * on the way to the airport.
 *
 * ── THE SERVER'S RULES, MIRRORED EXACTLY ───────────────────────────────────
 * Repo.CreateDelegation (delegation.go:106-115) rejects:
 *   - a missing tenant, from or to;
 *   - from == to ("cannot delegate to self"), which a DB constraint also covers;
 *   - an `endsAt` in the past.
 * Each is reproduced here so the Save button is never offered for a body that can
 * only fail — and the self-delegation case matters most, because the obvious
 * picker bug is listing yourself.
 *
 * NOTE THE WIRE CASING. This endpoint is camelCase (`fromUserId`, `toUserId`,
 * `startsAt`), unlike most of this API, which is snake_case. The struct tags at
 * delegation.go:25-34 are the authority; getting it wrong yields a silent
 * "tenant + from + to required" because the fields simply do not bind.
 */

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  status: string;
}

export interface DelegationDraft {
  fromUserId: string;
  toUserId: string;
  /** ISO-8601, or "" for "starts now". */
  endsAt: string;
  reason: string;
}

export type DelegationDraftError =
  | "no_target"
  | "self"
  | "ends_in_past"
  | "no_actor";

/**
 * Members eligible to receive a delegation.
 *
 * Excludes the acting user (the server refuses self-delegation) and anyone not
 * active — handing approvals to a suspended account creates a queue nobody can
 * clear, which is worse than not delegating at all.
 */
export function delegationCandidates(
  members: readonly WorkspaceMember[],
  actingUserId: string,
): WorkspaceMember[] {
  const actor = actingUserId.trim();
  return members.filter(
    (member) =>
      member.id.trim() !== "" &&
      member.id !== actor &&
      member.status.trim().toLowerCase() === "active",
  );
}

/** The first reason this draft cannot be saved, or null when it can. */
export function delegationDraftError(
  draft: DelegationDraft,
  now: Date,
): DelegationDraftError | null {
  if (!draft.fromUserId.trim()) return "no_actor";
  if (!draft.toUserId.trim()) return "no_target";
  if (draft.fromUserId.trim() === draft.toUserId.trim()) return "self";
  if (draft.endsAt.trim() !== "") {
    const ends = new Date(draft.endsAt);
    if (Number.isNaN(ends.getTime()) || ends.getTime() <= now.getTime()) {
      return "ends_in_past";
    }
  }
  return null;
}

export function delegationDraftMessage(error: DelegationDraftError): string {
  switch (error) {
    case "no_actor":
      return "Sign in again — this device doesn't know which user is delegating.";
    case "no_target":
      return "Choose who should hold your approvals.";
    case "self":
      return "You can't delegate approvals to yourself.";
    case "ends_in_past":
      return "The end date has to be in the future.";
  }
}

/**
 * The request body, in the endpoint's own camelCase.
 *
 * `endsAt` is omitted rather than sent empty: the Go field is a *time.Time, and an
 * empty string fails to parse rather than meaning "open-ended".
 */
export function delegationRequestBody(draft: DelegationDraft, startsAt: string) {
  const endsAt = draft.endsAt.trim();
  const reason = draft.reason.trim();
  return {
    fromUserId: draft.fromUserId.trim(),
    toUserId: draft.toUserId.trim(),
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Parse the workspace roster, tolerating either envelope shape. */
export function parseWorkspaceMembers(payload: unknown): WorkspaceMember[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items)
      : [];
  const out: WorkspaceMember[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    const email = typeof row.email === "string" ? row.email.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    out.push({
      id,
      // Fall back to the email so a row is never rendered as a bare uuid — the
      // one thing a person cannot recognise themselves or a colleague by.
      name: name || email || id,
      email,
      status:
        typeof row.status === "string" && row.status.trim() !== ""
          ? row.status.trim()
          : "active",
    });
  }
  return out;
}
