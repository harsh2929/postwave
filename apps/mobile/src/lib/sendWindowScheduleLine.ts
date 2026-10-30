/**
 * lib/sendWindowScheduleLine.ts — the ONE advisory line under the schedule
 * sheet's date/time picker: "is THIS time inside the workspace send window?"
 *
 * Desktop parity: SendChecklist's send-window row (send-checklist-helpers.ts
 * sendWindowRowDetail / sendWindowRowStatus). The verdict sentences are that
 * file's, verbatim, so the same policy answer reads the same on both devices;
 * the server's `reason` ("local time 08:30 outside 09:00-17:00", "weekday
 * Sunday not in policy bitmap" — send_window.go CheckScheduledAt) is rendered
 * untouched inside the parentheses.
 *
 * What the line must never do is GATE the Save button. The check is advisory:
 * the schedule handler (campaigns/handlers_schedule.go) evaluates the same
 * policy itself and refuses a `block` instant with 422 `outside_send_window`,
 * so a stale or missing verdict here costs the operator nothing but a round
 * trip. The states around the verdict — settling, checking, offline, failed —
 * therefore each say so and each say scheduling still works.
 *
 * Pure: no react-native / expo import, so vitest runs it in node.
 */
import type { SendWindowVerdict } from "@/lib/sendWindowVerdict";

export type SendWindowCheckState =
  | { kind: "idle" }
  | { kind: "offline" }
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "verdict"; verdict: SendWindowVerdict };

export type SendWindowLineTone = "muted" | "ok" | "warning" | "danger";

export interface SendWindowLine {
  text: string;
  tone: SendWindowLineTone;
}

/** Inputs the sheet has on hand; the precedence is decided here, not in JSX. */
export interface SendWindowCheckInputs {
  /** Fixed-time mode with the sheet open — best-time mode has no one instant to check. */
  applicable: boolean;
  online: boolean;
  /** The picker moved and the debounced instant has not caught up yet. */
  settling: boolean;
  fetching: boolean;
  /** Already humanised (campaignErrorMessage); null when the check did not fail. */
  errorMessage: string | null;
  verdict: SendWindowVerdict | null;
}

export const SEND_WINDOW_CHECK_FALLBACK = "Couldn't check the send window.";

/**
 * Precedence: not applicable → nothing; offline beats everything else because
 * a "checking…" that can never resolve is a lie; settling/fetching before a
 * stale verdict so the line never describes the PREVIOUS instant as the
 * current one; a failure before an old success for the same reason.
 */
export function sendWindowCheckState(
  input: SendWindowCheckInputs,
): SendWindowCheckState {
  if (!input.applicable) return { kind: "idle" };
  if (!input.online) return { kind: "offline" };
  if (input.settling || input.fetching) return { kind: "checking" };
  if (input.errorMessage) return { kind: "error", message: input.errorMessage };
  if (input.verdict) return { kind: "verdict", verdict: input.verdict };
  return { kind: "idle" };
}

/** Desktop's sendWindowRowDetail, verbatim. */
export function sendWindowVerdictSentence(verdict: SendWindowVerdict): string {
  if (verdict.insideWindow) {
    return verdict.enforcement === "off" || verdict.enforcement === ""
      ? "No send-window policy is enforced."
      : "Inside the configured send window.";
  }
  const reason = verdict.reason ? ` (${verdict.reason})` : "";
  if (verdict.should === "block") {
    return `Outside the send window — sends are blocked${reason}.`;
  }
  return `Outside the send window — policy warns${reason}.`;
}

/** Desktop's sendWindowRowStatus (fail/warn/pass), as a text tone. */
export function sendWindowVerdictTone(
  verdict: SendWindowVerdict,
): SendWindowLineTone {
  if (verdict.should === "block") return "danger";
  if (verdict.should === "warn") return "warning";
  return verdict.enforcement === "off" || verdict.enforcement === ""
    ? "muted"
    : "ok";
}

export function sendWindowScheduleLine(
  state: SendWindowCheckState,
): SendWindowLine | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return { text: "Checking the send window…", tone: "muted" };
    case "offline":
      return {
        text: "Offline — the send window can't be checked. You can still schedule.",
        tone: "muted",
      };
    case "error":
      return {
        text: `${state.message} You can still schedule.`,
        tone: "muted",
      };
    case "verdict":
      return {
        text: sendWindowVerdictSentence(state.verdict),
        tone: sendWindowVerdictTone(state.verdict),
      };
  }
}

/**
 * When the schedule call itself is refused for the send window, the server's
 * sentence ("that time is outside this workspace's sending window: <reason>",
 * handlers_schedule.go) is the explanation — campaignErrorMessage's generic
 * 422 arm ("The campaign isn't in a state that allows it.") would name the
 * wrong cause. Null for any other code so the caller falls through to the
 * ordinary mapping.
 */
export function sendWindowRefusalMessage(
  code: string | undefined,
  serverMessage: string,
): string | null {
  if (code !== "outside_send_window") return null;
  const trimmed = serverMessage.trim();
  return trimmed || "That time is outside this workspace's sending window.";
}
