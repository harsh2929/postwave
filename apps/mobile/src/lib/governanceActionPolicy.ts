/**
 * lib/governanceActionPolicy.ts — when a governance write is offerable, and
 * what to say when it fails.
 *
 * Pure on purpose (no react-native, no query layer, no SDK), so the rules
 * that decide whether to render a destructive button can be tested rather
 * than eyeballed. The screens import these; nothing here imports a screen.
 *
 * The failure mapping matters more than it looks. Every one of these actions
 * has at least two distinct 4xx outcomes that mean completely different
 * things to the operator — "someone already replayed this" versus "your
 * token lost the scope" versus "that job already finished". Collapsing them
 * into "Request failed" is how an operator retries something that can never
 * succeed, or gives up on something that would have worked.
 */

export interface GovernanceActionErrorInput {
  status?: number;
  code?: string;
  message?: string;
}

/** Read `{status, code, message}` off an unknown thrown value. */
export function governanceErrorInput(
  err: unknown,
): GovernanceActionErrorInput {
  if (!err || typeof err !== "object") {
    return typeof err === "string" && err ? { message: err } : {};
  }
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  const out: GovernanceActionErrorInput = {};
  if (typeof e.status === "number") out.status = e.status;
  if (typeof e.code === "string" && e.code.trim()) out.code = e.code;
  if (typeof e.message === "string" && e.message) out.message = e.message;
  return out;
}

export type GovernanceAction =
  | "revoke_scim_token"
  | "reset_circuit"
  | "test_sink"
  | "replay_dlq"
  | "cancel_migration";

const NOUN: Record<GovernanceAction, string> = {
  revoke_scim_token: "revoke that token",
  reset_circuit: "reset that circuit",
  test_sink: "test that sink",
  replay_dlq: "replay that batch",
  cancel_migration: "cancel that job",
};

/**
 * The sentence the toast shows. Never returns an empty string: a silent
 * failure is the one outcome an operator cannot act on.
 */
export function governanceActionErrorMessage(
  action: GovernanceAction,
  err: unknown,
): string {
  const { status, code, message } = governanceErrorInput(err);
  if (status === 0 || status === undefined) {
    return `Couldn't reach Moosewave, so nothing was changed. Check your connection and try again.`;
  }
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 403) {
    return `You don't have permission to ${NOUN[action]}.`;
  }
  if (status === 404) {
    return action === "cancel_migration"
      ? "That job no longer exists — it may have already finished."
      : "That record no longer exists. Pull to refresh.";
  }
  if (status === 409) {
    switch (action) {
      case "replay_dlq":
        return "That batch was already replayed.";
      case "cancel_migration":
        return "That job is no longer running, so there was nothing to cancel.";
      case "revoke_scim_token":
        return "That token was already revoked.";
      default:
        return "That already changed — pull to refresh.";
    }
  }
  if (status === 429) {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (status >= 500) {
    return `Moosewave couldn't ${NOUN[action]} right now. Try again shortly.`;
  }
  // A server-supplied message beats a generic one when we have nothing
  // better; the code is appended so support can grep for it.
  if (message) return code ? `${message} (${code})` : message;
  return `Couldn't ${NOUN[action]}.`;
}

export interface ScimTokenLike {
  revoked_at?: string | null;
  last_used_at?: string | null;
  created_at?: string;
  prefix?: string;
}

/** A live token can be revoked; an already-revoked one must not offer it. */
export function canRevokeScimToken(token: ScimTokenLike): boolean {
  return !token.revoked_at;
}

/**
 * Dormancy: the signal that decides whether a token is a live integration
 * or forgotten credential surface. A never-used token older than a day is
 * the single most likely thing on a SCIM screen to be safe to revoke.
 */
export function scimTokenDormancy(
  token: ScimTokenLike,
  now: number,
): { label: string; tone: "neutral" | "warning" | "danger" } | null {
  if (token.revoked_at) return null;
  const lastUsed = token.last_used_at ? Date.parse(token.last_used_at) : NaN;
  if (!Number.isFinite(lastUsed)) {
    const created = token.created_at ? Date.parse(token.created_at) : NaN;
    if (Number.isFinite(created) && now - created > 24 * 60 * 60 * 1000) {
      return { label: "Never used", tone: "warning" };
    }
    return { label: "Not used yet", tone: "neutral" };
  }
  const days = Math.floor((now - lastUsed) / (24 * 60 * 60 * 1000));
  if (days >= 90) return { label: `Idle ${days}d`, tone: "danger" };
  if (days >= 30) return { label: `Idle ${days}d`, tone: "warning" };
  return null;
}

export interface DlqEntryLike {
  replayed_at?: string | null;
}

/** Only an un-replayed batch can be replayed. */
export function canReplayDlqEntry(entry: DlqEntryLike): boolean {
  return !entry.replayed_at;
}

/**
 * The statuses where a cancel is meaningful. Deliberately excludes
 * `rolling_back` (already unwinding) and every terminal status — offering
 * cancel there can only produce a 409.
 */
const CANCELLABLE = new Set([
  "pending",
  "authenticating",
  "discovering",
  "dry_run",
  "awaiting_confirmation",
  "importing",
]);

export function canCancelMigration(status: string | undefined): boolean {
  return CANCELLABLE.has((status ?? "").toLowerCase());
}
