/**
 * lib/restartSafetyScan.ts — what a restart would interrupt, before it does.
 *
 * Desktop asks every registered draft and background operation whether a
 * relaunch is safe (DesktopUpdateService restartDecision over
 * lifecycle-coordinator guards) and shows the answers in the confirm dialog.
 * Mobile's confirm carried one number — unsent queued changes — and no facts
 * about anything else the phone tracks. This module reads the three
 * registries mobile already keeps and turns them into the same concern list:
 *
 *   - lib/dirtyGuard: editors holding unsaved edits (Workspace, API
 *     connection, an outbound-webhook form). A reload discards the keystrokes.
 *   - the offline queue: a write that is SYNCING is on the wire right now and
 *     its outcome would be lost with the JS context; a QUEUED one is only
 *     durable if the persister has already written it (hooks/useAppUpdate-
 *     Prompt's header), so it is a warning, not a certainty either way.
 *   - lib/transferCenter: a share sheet still open for one of this phone's
 *     exports.
 *
 * Blocking means "finish it first" — the sheet offers no restart. Warning
 * means "you may lose this" — the sheet names it and asks. Both mirror
 * desktop's levels so the two dialogs make the same promises.
 *
 * The 4-hour "remind me later" lives here too, as module state read by the
 * prompt hook, so the deferral is one fact rather than one per surface.
 *
 * Pure: no react-native.
 */
import type { OfflineMutationStatus } from "./offlineMutationQueue";

export type RestartConcernLevel = "blocking" | "warning";

export interface RestartConcern {
  guardId: string;
  level: RestartConcernLevel;
  label: string;
  detail: string;
}

export interface RestartSafetyScan {
  concerns: RestartConcern[];
  blocking: RestartConcern[];
  warnings: RestartConcern[];
  /** True when nothing registered reported a risk. */
  safe: boolean;
}

export interface RestartSafetyInput {
  /** lib/dirtyGuard unsavedLabels(). */
  unsavedLabels: readonly string[];
  /** The current identity's queue rows. */
  queue: readonly { status: OfflineMutationStatus }[];
  /** lib/transferCenter activeLocalTransferCount(). */
  activeTransfers: number;
}

export const RESTART_REMINDER_MS = 4 * 60 * 60 * 1000;

export function scanRestartSafety(input: RestartSafetyInput): RestartSafetyScan {
  const concerns: RestartConcern[] = [];
  const syncing = input.queue.filter((item) => item.status === "syncing").length;
  const queued = input.queue.filter((item) => item.status === "queued").length;

  if (syncing > 0) {
    concerns.push({
      guardId: "offline-queue-syncing",
      level: "blocking",
      label: `${syncing} change${syncing === 1 ? "" : "s"} syncing right now`,
      detail:
        "A restart tears down the request mid-flight and this phone would never learn whether it landed.",
    });
  }
  if (input.activeTransfers > 0) {
    concerns.push({
      guardId: "share-in-progress",
      level: "blocking",
      label: `${input.activeTransfers} share${input.activeTransfers === 1 ? "" : "s"} still open`,
      detail: "Finish or dismiss the share sheet before restarting.",
    });
  }
  const named = input.unsavedLabels.filter((label) => label.trim().length > 0);
  if (named.length > 0) {
    concerns.push({
      guardId: "unsaved-edits",
      level: "warning",
      label: `Unsaved edits in ${joinNames(named)}`,
      detail: "Restarting discards what has been typed but not saved.",
    });
  }
  if (queued > 0) {
    concerns.push({
      guardId: "offline-queue-queued",
      level: "warning",
      label: `${queued} queued change${queued === 1 ? "" : "s"} not yet on the server`,
      detail:
        "Only changes the phone has already written to its encrypted queue resume after a restart; the rest are dropped.",
    });
  }

  const blocking = concerns.filter((concern) => concern.level === "blocking");
  const warnings = concerns.filter((concern) => concern.level === "warning");
  return { concerns, blocking, warnings, safe: concerns.length === 0 };
}

export interface RestartPromptCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: true;
}

/**
 * The confirm sheet for a restart with warnings, or null when there is
 * nothing to confirm (a safe scan restarts on the one tap; a blocked scan
 * never reaches a confirm — see blockedRestartMessage).
 */
export function restartPromptCopy(scan: RestartSafetyScan): RestartPromptCopy | null {
  if (scan.blocking.length > 0 || scan.warnings.length === 0) return null;
  return {
    title: "Restart with work in progress?",
    message: scan.warnings
      .map((concern) => `${concern.label} — ${concern.detail}`)
      .join("\n"),
    consequence:
      "Moosewave reopens on the installed version. Whatever is listed above may be lost.",
    confirmLabel: "Restart anyway",
    cancelLabel: "Remind me in 4 hours",
    destructive: true,
  };
}

/** What to say instead of restarting, when something blocks it. */
export function blockedRestartMessage(scan: RestartSafetyScan): string {
  const first = scan.blocking[0];
  if (!first) return "Restart is blocked right now.";
  return `${first.label}. ${first.detail} The update stays ready in Diagnostics.`;
}

/** One line per concern for the diagnostics card, blocking first. */
export function restartSafetyLines(scan: RestartSafetyScan): string[] {
  return [...scan.blocking, ...scan.warnings].map(
    (concern) =>
      `${concern.level === "blocking" ? "Blocking" : "Review"} · ${concern.label}`,
  );
}

let reminderAt: number | null = null;

/** Snooze the restart prompt; returns when it comes back. */
export function deferRestartReminder(now = Date.now()): number {
  reminderAt = now + RESTART_REMINDER_MS;
  return reminderAt;
}

export function restartReminderAt(): number | null {
  return reminderAt;
}

/** True once a deferral has elapsed — the prompt may show again. */
export function restartReminderDue(now = Date.now()): boolean {
  return reminderAt !== null && now >= reminderAt;
}

export function clearRestartReminder(): void {
  reminderAt = null;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
