/**
 * lib/workspaceSwitchPolicy.ts — the pure half of the workspace switcher
 * (SHELL#6).
 *
 * Deliberately import-free (no react-native, no expo, no network) so the rules
 * that decide what a switcher may show and what it refuses to do can be tested
 * in the node vitest environment rather than only reasoned about.
 *
 * Three rules live here because each of them, got wrong, is a security or
 * honesty bug rather than a cosmetic one:
 *
 *  1. A WORKSPACE ROW IS ONLY AS TRUSTWORTHY AS ITS PARSE. The list arrives
 *     over the wire as `{workspaces: [...]}`; anything whose `id` is missing,
 *     control-charactered or unreasonably long is DROPPED rather than rendered,
 *     because the id is what a later switch call sends back to the server as
 *     the thing to become.
 *
 *  2. ABSENCE IS NOT ZERO. A failed list load is an error state; it is never
 *     "you belong to no other workspaces". The parser therefore returns null
 *     for a malformed envelope and an array only for a well-formed one — an
 *     empty array means the server really did say "one workspace".
 *
 *  3. THE CURRENT WORKSPACE IS NOT A SWITCH TARGET. The server treats a
 *     redundant switch as a free no-op, but a UI that offers it invites a user
 *     to tap the row they are already in and watch the app tear its cache down
 *     for nothing.
 */

/** One row of GET /api/v1/auth/workspaces. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  current: boolean;
}

/**
 * Field ceilings. A workspace name is operator-controlled free text and this
 * list is rendered in a sheet on a phone; the cap is what stops one absurd
 * value from pushing every other row off screen. Ids are UUIDs — 64 is already
 * generous — and the cap is what stops an oversized value being echoed back
 * into a POST body.
 */
const MAX_ID_CHARS = 64;
const MAX_NAME_CHARS = 120;
const MAX_ROLE_CHARS = 40;
/**
 * One person genuinely can belong to a lot of workspaces (the agency case this
 * finding is about), but a sheet cannot usefully render an unbounded list and
 * an unbounded parse is an unbounded allocation from a response body.
 */
export const MAX_WORKSPACE_ROWS = 200;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Optional display fields are allowed to be absent — a tenant with no name is
 * a real state — but never allowed to be garbage.
 */
function optionalBoundedString(value: unknown, maxChars: number): string {
  return boundedString(value, maxChars) ?? "";
}

function parseWorkspaceRow(raw: unknown): WorkspaceSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = boundedString(row.id, MAX_ID_CHARS);
  if (!id) return null;
  return {
    id,
    name: optionalBoundedString(row.name, MAX_NAME_CHARS),
    slug: optionalBoundedString(row.slug, MAX_NAME_CHARS),
    role: optionalBoundedString(row.role, MAX_ROLE_CHARS),
    current: row.current === true,
  };
}

/**
 * Parse the `{workspaces: [...]}` envelope.
 *
 * Returns null when the envelope itself is not what the contract says — the
 * caller must surface that as an error, NOT as an empty list. Returns an array
 * (possibly empty) when the envelope is well formed; individual rows that fail
 * validation are dropped, and duplicate ids collapse to the first occurrence so
 * a repeated row cannot produce two identical, indistinguishable buttons.
 */
export function parseWorkspaceList(raw: unknown): WorkspaceSummary[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const rows: WorkspaceSummary[] = [];
  for (const entry of list) {
    if (rows.length >= MAX_WORKSPACE_ROWS) break;
    const row = parseWorkspaceRow(entry);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

/** What to print for a workspace. Never the bare id unless nothing else exists. */
export function workspaceDisplayName(workspace: WorkspaceSummary): string {
  return workspace.name || workspace.slug || workspace.id;
}

/**
 * The second line under the name. Slug and role answer different questions
 * ("which of the three Acmes is this" and "what will I be able to do there"),
 * so both are shown when both exist, and neither is invented when absent.
 */
export function workspaceSubtitle(workspace: WorkspaceSummary): string | null {
  const parts: string[] = [];
  if (workspace.slug && workspace.slug !== workspace.name) {
    parts.push(workspace.slug);
  }
  if (workspace.role) parts.push(workspace.role);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Current workspace pinned first, then alphabetical by what the user actually
 * reads. Locale-aware and case-insensitive: an agency list sorted by raw
 * codepoint puts "Zebra" before "acme".
 */
export function sortWorkspaces(
  rows: readonly WorkspaceSummary[],
): WorkspaceSummary[] {
  return [...rows].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return workspaceDisplayName(a).localeCompare(
      workspaceDisplayName(b),
      undefined,
      { sensitivity: "base" },
    );
  });
}

/** The rows a switch may target: everything except where we already are. */
export function switchableWorkspaces(
  rows: readonly WorkspaceSummary[],
): WorkspaceSummary[] {
  return rows.filter((row) => !row.current);
}

/**
 * Whether the switcher is worth offering at all.
 *
 * A single-workspace user is the overwhelming majority and a "Switch
 * workspace" row that opens a sheet containing only the workspace they are
 * already in is a dead end. The control hides itself instead — but only once
 * the list has actually LOADED, because hiding on absence would hide it
 * forever for anyone whose list request failed.
 */
export function shouldOfferSwitcher(
  rows: readonly WorkspaceSummary[] | undefined,
): boolean {
  if (!rows) return false;
  return switchableWorkspaces(rows).length > 0;
}

/**
 * Server error codes from POST /api/v1/auth/workspaces/switch
 * (apps/api/internal/auth/workspace_switch.go), turned into something a person
 * can act on.
 *
 * Each of these is a DIFFERENT thing to do next, which is why they are not
 * collapsed into one apology:
 *   - email_not_verified        → go answer the verification email;
 *   - workspace_access_revoked  → somebody removed you; ask them;
 *   - workspace_not_found       → the list is stale; reload it;
 *   - session_revoke_failed /
 *     session_failed            → the server may have already ended the old
 *                                 session, so the honest instruction is to
 *                                 sign in again rather than "try again".
 */
export function workspaceSwitchErrorMessage(
  code: string | undefined,
  status: number | undefined,
  fallback: string,
): string {
  switch (code) {
    case "email_not_verified":
      return "Verify your email address before switching workspaces.";
    case "workspace_access_revoked":
      return "Your access to that workspace was removed.";
    case "workspace_not_found":
      return "That workspace is no longer available to you.";
    case "session_revoke_failed":
    case "session_failed":
      return "The workspace switch didn't finish. Sign in again to continue.";
    case "no_session":
      return "Your sign-in session expired. Please sign in again.";
    default:
      break;
  }
  if (status === 401) return "Your sign-in session expired. Please sign in again.";
  if (status === 403) return "You can't switch into that workspace.";
  if (status === 404) return "That workspace is no longer available to you.";
  return fallback;
}

/**
 * The confirmation a switch has to earn.
 *
 * Switching is not a navigation: the server revokes the current session and
 * mints a new one, and the device wipes every cached artifact of the outgoing
 * workspace (query cache, offline queue, widget snapshot, saved list views).
 * Anything queued offline is therefore GONE, and a user who thinks they are
 * "peeking at the other account" must be told that before, not after.
 */
export function workspaceSwitchConsequence(pendingMutations: number): string {
  if (pendingMutations > 0) {
    return pendingMutations === 1
      ? "1 change waiting to sync will be discarded."
      : `${pendingMutations} changes waiting to sync will be discarded.`;
  }
  return "Offline data for this workspace is cleared from this device.";
}
