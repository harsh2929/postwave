/**
 * lib/sequenceParticipants.ts — presentation policy for the participants and
 * stuck-report sections.
 *
 * Import-free (house rule: vitest runs in a node environment) so every state
 * this cluster has to be honest about is directly testable:
 *
 *  - EMPTY IS THE EXPECTED ANSWER. Both surfaces derive from
 *    `sequence_funnel_events`, and no qualified delivery runtime writes it, so
 *    "0 participants" today means "nothing enrols", not "nothing matched your
 *    filter". A generic "No results" empty state would quietly attribute a
 *    platform boundary to the operator's filter choice.
 *  - 503 IS A DEPENDENCY, NOT A FAULT. Both handlers answer 503 + Retry-After
 *    when the durable Postgres read model is absent.
 *  - 400 ON /stuck IS A SETTING, NOT AN ERROR. It means `stuck_after_days` is
 *    unconfigured — the report is switched off for this sequence.
 *  - 403 IS A SCOPE ANSWER. Both routes need read:campaigns AND
 *    read:subscribers; a token with only one gets 403 and retrying cannot help.
 */

export type ParticipantStatusFilter =
  | "all"
  | "active"
  | "completed"
  | "completed_goal"
  | "exited";

export const PARTICIPANT_FILTERS: readonly {
  value: ParticipantStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "completed_goal", label: "Goal met" },
  { value: "exited", label: "Exited" },
];

export const PARTICIPANTS_PAGE_SIZE = 25;

/** Status label + tone for a participant row. */
export function participantStatusPresentation(status: string | undefined): {
  label: string;
  tone: "success" | "info" | "neutral" | "accent";
} {
  switch ((status ?? "").trim().toLowerCase()) {
    case "active":
      return { label: "Active", tone: "accent" };
    case "completed":
      return { label: "Completed", tone: "info" };
    case "completed_goal":
      return { label: "Goal met", tone: "success" };
    case "exited":
      return { label: "Exited", tone: "neutral" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}

export interface SectionState {
  kind: "loading" | "error" | "off" | "empty" | "rows";
  /** Present for error/off/empty. */
  title?: string;
  message?: string;
  /** False when a Retry button could never work. */
  retryable?: boolean;
}

/**
 * What the participants section should render.
 *
 * `runtimeQualified` is false in this build (no enrollment runtime), and that
 * changes the EMPTY sentence only — never the error handling.
 */
export function participantsSectionState(input: {
  loading: boolean;
  status: number;
  message?: string | undefined;
  rowCount: number;
  filter: ParticipantStatusFilter;
  runtimeQualified: boolean;
}): SectionState {
  if (input.loading) return { kind: "loading" };
  if (input.status === 403) {
    return {
      kind: "error",
      title: "Not visible to your role",
      message:
        "Reading participants needs both campaign and subscriber access. Ask an admin.",
      retryable: false,
    };
  }
  if (input.status === 503) {
    return {
      kind: "error",
      title: "Participants are temporarily unavailable",
      message:
        "This report reads a durable database that is not responding. It should return on its own.",
      retryable: true,
    };
  }
  if (input.status === 404 || input.status === 405 || input.status === 501) {
    return {
      kind: "error",
      title: "Participants aren't exposed here",
      message:
        "This deployment doesn't serve the sequence participants endpoint.",
      retryable: false,
    };
  }
  if (input.status !== 0) {
    return {
      kind: "error",
      title: "Couldn't load participants",
      message: input.message || "Pull down to try again.",
      retryable: true,
    };
  }
  if (input.rowCount > 0) return { kind: "rows" };
  if (!input.runtimeQualified) {
    return {
      kind: "empty",
      title: "Nobody is enrolled",
      message:
        "Sequence delivery is not qualified in this build, so no subscriber has entered this journey. This list fills in once enrollment runs.",
    };
  }
  return {
    kind: "empty",
    title: input.filter === "all" ? "Nobody is enrolled" : "No one in this state",
    message:
      input.filter === "all"
        ? "No subscriber has entered this sequence yet."
        : "Try a different status filter.",
  };
}

/** What the stuck-report section should render. */
export function stuckSectionState(input: {
  loading: boolean;
  status: number;
  message?: string | undefined;
  rowCount: number;
  thresholdDays: number;
  runtimeQualified: boolean;
}): SectionState {
  if (input.loading) return { kind: "loading" };
  if (input.status === 400) {
    // The handler's own answer for "stuck_after_days is not configured".
    return {
      kind: "off",
      title: "Stuck detection is off",
      message:
        "This sequence has no idle threshold set. Configure stuck_after_days on desktop to get a report here.",
    };
  }
  if (input.status === 403) {
    return {
      kind: "error",
      title: "Not visible to your role",
      message:
        "The stuck report needs both campaign and subscriber access. Ask an admin.",
      retryable: false,
    };
  }
  if (input.status === 503) {
    return {
      kind: "error",
      title: "Stuck report temporarily unavailable",
      message:
        "This report reads a durable database that is not responding. It should return on its own.",
      retryable: true,
    };
  }
  if (input.status === 404 || input.status === 405 || input.status === 501) {
    return {
      kind: "error",
      title: "Stuck report isn't exposed here",
      message: "This deployment doesn't serve the stuck-participant endpoint.",
      retryable: false,
    };
  }
  if (input.status !== 0) {
    return {
      kind: "error",
      title: "Couldn't load the stuck report",
      message: input.message || "Pull down to try again.",
      retryable: true,
    };
  }
  if (input.rowCount > 0) return { kind: "rows" };
  return {
    kind: "empty",
    title: "Nobody is stuck",
    message: input.runtimeQualified
      ? `No active participant has been idle for ${input.thresholdDays} ${input.thresholdDays === 1 ? "day" : "days"}.`
      : "Nothing enrols in this build, so there is nobody who could be stuck.",
  };
}

/** "Step 3 · idle 12 days" — spoken in full beside the compacted row. */
export function stuckRowSpoken(row: {
  email: string;
  current_step: number;
  idle_days: number;
}): string {
  const days = Math.max(0, Math.trunc(row.idle_days));
  return `${row.email}. On step ${Math.max(1, Math.trunc(row.current_step))}. Idle ${days} ${days === 1 ? "day" : "days"}.`;
}
