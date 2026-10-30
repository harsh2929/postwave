/**
 * lib/privacyIncidentPolicy.ts — the clock, ordering, and mobile write hold.
 *
 * THE CLOCK IS AN OPERATIONAL TARGET. The server stamps
 * `gdpr_72h_deadline = detected_at + 72h` for every incident without deciding
 * awareness, role, risk, or jurisdiction. It must never be presented as proof
 * of a statutory deadline.
 *
 *   - A MISSING DEADLINE IS NOT A MET ONE. An incident whose row carries no
 *     `gdpr_72h_deadline` gets `state: "unknown"` and an em-dash. Treating an
 *     absent timestamp as 0 would render every such incident as maximally
 *     overdue; treating it as "fine" would be worse.
 *   - A LEGACY CLOSED RECORD'S TARGET IS INACTIVE. New closure is release-held,
 *     but an existing closed record must not continue an active countdown.
 *
 * THE ADJACENCY MIRRORS THE SERVER, and is deliberately a local constant.
 * `validIncidentTransitions` (incidents.go:53-58) is four rows that change
 * when the law does; fetching it would put a network round trip in front of
 * the status options a reader may encounter. Non-closure moves are LIVE on
 * this surface: the transition sheet captures the bounded, operator-supplied
 * audit reason and re-reads the record before asserting `expected_from`
 * (lib/privacyIncidentWrite owns that policy).
 *
 * CLOSURE IS RELEASE-HELD. The option remains visible but disabled so the
 * operator sees that the server cannot yet enforce jurisdiction decisions and
 * authenticated delivery evidence atomically.
 *
 * DELIBERATELY IMPORT-FREE apart from sibling pure modules, so it runs under
 * the node vitest environment.
 */
import { EMDASH } from "@/lib/format";
import {
  epochOf,
  type IncidentState,
  type PrivacyIncident,
} from "@/lib/privacyIncidents";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How close to the legacy operational target counts as "due soon".
 *
 * Twelve hours, not one: a breach notification packet needs counsel review and
 * a regulator portal submission, so an alert that fires an hour out is an
 * alert that fires after the work needed to act on it was already impossible.
 */
export const INCIDENT_DUE_SOON_MS = 12 * HOUR_MS;

/** Mirrors the desktop StatStrip's "open over 24h" worry cell. */
export const INCIDENT_STALE_OPEN_MS = DAY_MS;

export type IncidentClockState =
  | "unknown"
  | "stopped"
  | "running"
  | "due-soon"
  | "overdue";

export type IncidentTone =
  | "neutral"
  | "info"
  | "warning"
  | "danger"
  | "success";

export interface IncidentClock {
  state: IncidentClockState;
  tone: IncidentTone;
  /** Compact badge text — "9h left", "6h over", or an em-dash. */
  label: string;
  /** The full sentence assistive tech announces. */
  spoken: string;
  /** Signed ms to the deadline; null when there is no deadline to count to. */
  msRemaining: number | null;
}

/**
 * A gap in words: "3d 4h", "9h 12m", "45m", "under a minute".
 *
 * Two units maximum. "2 days, 4 hours, 17 minutes and 3 seconds" is a
 * stopwatch reading; what a woken operator needs is the magnitude.
 */
export function humanGap(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return "under a minute";
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24)
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

export function incidentClock(
  incident: PrivacyIncident,
  now: number,
): IncidentClock {
  if (incident.status === "closed") {
    return {
      state: "stopped",
      tone: "success",
      label: "Closed",
      spoken: "Closed legacy record. Its operational target is inactive.",
      msRemaining: null,
    };
  }
  if (!incident.deadlineAt) {
    return {
      state: "unknown",
      tone: "neutral",
      label: EMDASH,
      spoken:
        "No operational response target is recorded, so no countdown can be shown.",
      msRemaining: null,
    };
  }
  const remaining = epochOf(incident.deadlineAt) - now;
  if (remaining <= 0) {
    const over = humanGap(remaining);
    return {
      state: "overdue",
      tone: "danger",
      label: `${over} over`,
      spoken: `Past the legacy 72-hour operational target by ${over}. This is not a legal deadline determination.`,
      msRemaining: remaining,
    };
  }
  const left = humanGap(remaining);
  if (remaining <= INCIDENT_DUE_SOON_MS) {
    return {
      state: "due-soon",
      tone: "warning",
      label: `${left} left`,
      spoken: `${left} left before the legacy 72-hour operational target.`,
      msRemaining: remaining,
    };
  }
  return {
    state: "running",
    tone: "neutral",
    label: `${left} left`,
    spoken: `${left} left before the legacy 72-hour operational target.`,
    msRemaining: remaining,
  };
}

export interface IncidentCounts {
  total: number;
  /** Anything not `closed`, including a state this build does not know. */
  open: number;
  overdue: number;
  dueSoon: number;
  /** Open and detected more than 24 hours ago. */
  staleOpen: number;
}

export function incidentCounts(
  rows: readonly PrivacyIncident[],
  now: number,
): IncidentCounts {
  const counts: IncidentCounts = {
    total: rows.length,
    open: 0,
    overdue: 0,
    dueSoon: 0,
    staleOpen: 0,
  };
  for (const row of rows) {
    if (row.status === "closed") continue;
    counts.open += 1;
    const clock = incidentClock(row, now);
    if (clock.state === "overdue") counts.overdue += 1;
    if (clock.state === "due-soon") counts.dueSoon += 1;
    if (
      row.detectedAt &&
      now - epochOf(row.detectedAt) > INCIDENT_STALE_OPEN_MS
    ) {
      counts.staleOpen += 1;
    }
  }
  return counts;
}

/**
 * Sort by what needs a human, not by when it was filed.
 *
 * Bands: overdue, then due soon, then everything else still open, then closed.
 * Inside a band the nearest deadline leads; an incident with NO deadline sorts
 * to the back of its band rather than the front, because an unknown clock is
 * not an urgent one and putting it first would bury the incidents whose
 * countdown is real.
 */
export function orderIncidents(
  rows: readonly PrivacyIncident[],
  now: number,
): PrivacyIncident[] {
  const band = (row: PrivacyIncident): number => {
    if (row.status === "closed") return 3;
    const state = incidentClock(row, now).state;
    if (state === "overdue") return 0;
    if (state === "due-soon") return 1;
    return 2;
  };
  return [...rows].sort((a, b) => {
    const bandDelta = band(a) - band(b);
    if (bandDelta !== 0) return bandDelta;
    const aDeadline = a.deadlineAt
      ? epochOf(a.deadlineAt)
      : Number.MAX_SAFE_INTEGER;
    const bDeadline = b.deadlineAt
      ? epochOf(b.deadlineAt)
      : Number.MAX_SAFE_INTEGER;
    if (aDeadline !== bDeadline) return aDeadline - bDeadline;
    return epochOf(b.detectedAt) - epochOf(a.detectedAt);
  });
}

/** Mirrors `validIncidentTransitions` (incidents.go:53-58). */
export const INCIDENT_TRANSITIONS: Readonly<
  Record<IncidentState, readonly IncidentState[]>
> = {
  open: ["contained", "notifications_pending", "closed"],
  contained: ["notifications_pending", "closed"],
  notifications_pending: ["contained", "closed"],
  closed: [],
};

export const INCIDENT_STATE_LABEL: Readonly<Record<IncidentState, string>> = {
  open: "Open",
  contained: "Contained",
  notifications_pending: "Notifying",
  closed: "Closed",
};

const TRANSITION_VERB: Readonly<Record<IncidentState, string>> = {
  open: "Reopen",
  contained: "Mark contained",
  notifications_pending: "Move to notifying",
  closed: "Close incident",
};

export interface IncidentTransitionOption {
  to: IncidentState;
  label: string;
  allowed: boolean;
  /** Why the option is disabled. null when it is available. */
  blockedReason: string | null;
  /** Closing is irreversible — the confirm sheet paints it as destructive. */
  destructive: boolean;
}

export const INCIDENT_CLOSURE_RELEASE_HOLD =
  "Incident closure is release-held until jurisdiction-specific decisions and authenticated delivery evidence can be enforced atomically. No closure is available from this client.";

export const INCIDENT_TRANSITION_OFFLINE_NOTICE =
  "State changes need a live connection. A move is recorded with your reason at the moment you confirm it — it is never queued to replay later, because a replayed audit entry out of context would be invented evidence.";

/**
 * The states this incident may move to, with the close guard applied.
 *
 * A state this build does not recognise yields NO options: offering a
 * transition out of a state whose adjacency we cannot know is guessing with an
 * audited workflow.
 */
export function incidentTransitionOptions(
  incident: PrivacyIncident,
): IncidentTransitionOption[] {
  if (!incident.status) return [];
  return INCIDENT_TRANSITIONS[incident.status].map((to) => {
    const blocked = to === "closed";
    return {
      to,
      label: TRANSITION_VERB[to],
      allowed: !blocked,
      blockedReason: blocked ? INCIDENT_CLOSURE_RELEASE_HOLD : null,
      destructive: to === "closed",
    };
  });
}

export interface IncidentAccess {
  allowed: boolean;
  /** False while the session role is still unknown — render no verdict. */
  known: boolean;
  notice: string | null;
}

export interface IncidentAccessInput {
  /** `canAccessMinimumRole("admin", role, mode)`. */
  isAdmin: boolean;
  role: string | null;
  mode: "api_key" | "session" | null;
  online: boolean;
}

/**
 * Whether this session may READ the incident register.
 *
 * EVERY route in the group is admin-only, and not because of anything visible
 * in `incidents.go`: `MountIncidentRoutes` registers them bare
 * (incidents.go:1027-1039) and the caller wraps the whole group with
 * `apikeys.RequireScope(apikeys.ScopeAdmin)`
 * (server/tenant_governance.go:112-116). `ScopeAdmin` is absent from
 * `readOnlyScopes` (apikeys/middleware.go:332-337), so on the session path it
 * becomes `isAdminOrOwner` — owner or admin only.
 */
export function incidentReadAccess(input: IncidentAccessInput): IncidentAccess {
  if (!input.role && input.mode !== "api_key") {
    return { allowed: false, known: false, notice: null };
  }
  if (input.isAdmin) return { allowed: true, known: true, notice: null };
  return {
    allowed: false,
    known: true,
    notice:
      input.mode === "api_key"
        ? "The breach-incident register needs an API key with the admin scope. Every route in this group — including the list — is behind it, so there is no read-only view to fall back to."
        : "The breach-incident register needs an owner or admin role on this workspace. Every route in this group — including the list — is behind that check, so there is no read-only view to fall back to.",
  };
}

/**
 * Whether this surface may advance incident state right now.
 *
 * An online owner/admin may: the transition sheet captures the operator's
 * bounded reason and re-reads the record before asserting `expected_from`, so
 * both endpoint requirements are met honestly. Offline the verb is withheld
 * WITH its reason — the write is never queued (see the notice), so offering
 * the button would promise a replay this client refuses to make. Closure is
 * still excluded per-option by `incidentTransitionOptions`.
 */
export function incidentTransitionAccess(
  input: IncidentAccessInput,
): IncidentAccess {
  const read = incidentReadAccess(input);
  if (!read.allowed) return read;
  if (!input.online) {
    return {
      allowed: false,
      known: true,
      notice: INCIDENT_TRANSITION_OFFLINE_NOTICE,
    };
  }
  return { allowed: true, known: true, notice: null };
}

/**
 * Turn a failed transition into a sentence.
 *
 * The four conflict codes the server can answer with are distinct facts and
 * collapsing them into "Request failed" loses every one of them.
 */
export function incidentTransitionError(error: unknown): string {
  const err = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const code = typeof err.code === "string" ? err.code : "";
  const status = typeof err.status === "number" ? err.status : 0;
  if (code === "incident_closure_release_hold") {
    return INCIDENT_CLOSURE_RELEASE_HOLD;
  }
  if (code === "stale_incident_state" || code === "transition_conflict") {
    return "Somebody else already moved this incident. Pull to refresh to see where it is now.";
  }
  if (code === "no_op") {
    return "This incident is already in the requested state. Refresh before choosing another move.";
  }
  if (code === "invalid_transition") {
    return "That state move is unavailable from the incident's current state. Refresh before choosing another move.";
  }
  if (status === 404) {
    return "That incident no longer exists in this workspace.";
  }
  if (status === 403) {
    return "Your role can no longer change incident state. Every incident route needs owner or admin.";
  }
  const message = typeof err.message === "string" ? err.message.trim() : "";
  return message || "The state change did not go through.";
}

export type IncidentRegisterDataState =
  | "hidden"
  | "current"
  | "refreshing"
  | "stale";

/**
 * Whether cached register rows may be painted, and which warning they need.
 *
 * A closed online/auth gate or a 403 always wins: protected incident rows and
 * their moving countdowns must disappear immediately. While online, a prior
 * successful non-empty page may remain visible during a background refresh or
 * a non-authorization failure, but only under an explicit freshness label.
 */
export function incidentRegisterDataState(input: {
  canReadNow: boolean;
  forbidden: boolean;
  hasRows: boolean;
  fetching: boolean;
  failed: boolean;
}): IncidentRegisterDataState {
  if (!input.canReadNow || input.forbidden) return "hidden";
  if (!input.hasRows) return "current";
  if (input.failed) return "stale";
  if (input.fetching) return "refreshing";
  return "current";
}

/** The screen-level headline: the shortest true summary of the register. */
export function incidentHeadline(counts: IncidentCounts): string | null {
  if (counts.overdue > 0) {
    return counts.overdue === 1
      ? "1 incident is past its legacy 72-hour operational target."
      : `${counts.overdue} incidents are past their legacy 72-hour operational target.`;
  }
  if (counts.dueSoon > 0) {
    return counts.dueSoon === 1
      ? "1 incident is inside the last 12 hours of its legacy operational target."
      : `${counts.dueSoon} incidents are inside the last 12 hours of their legacy operational target.`;
  }
  if (counts.staleOpen > 0) {
    return counts.staleOpen === 1
      ? "1 incident has been open for more than 24 hours."
      : `${counts.staleOpen} incidents have been open for more than 24 hours.`;
  }
  return null;
}
