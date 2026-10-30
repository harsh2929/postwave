/**
 * lib/feedbackPolicy.ts — the decision rules behind the feedback primitives.
 *
 * `Toast` and `ConfirmSheet` are presentation; these are the policies they
 * enforce. They live here, in a module with no `react-native` import, for two
 * reasons:
 *
 *  - the repo's vitest suite runs in a plain node environment, so anything
 *    reachable from a `react-native` import cannot be unit-tested without
 *    wholesale mocking — and these particular rules carry real user
 *    consequence (an undo window that is too short, a confirmation gate that
 *    is accidentally loosened), so they deserve direct tests;
 *  - it mirrors the existing split in this codebase, where `src/lib/*.ts`
 *    holds logic and `src/components/*.tsx` holds views.
 */

export interface FeedbackAction {
  label: string;
  onPress: () => void;
}

export interface FeedbackToastOptions {
  message: string;
  action?: FeedbackAction | undefined;
  durationMs?: number | undefined;
}

/** Plain confirmations read fast. */
export const TOAST_DEFAULT_MS = 3200;
/**
 * With an action the user must read it, decide, and reach the button. 6s is
 * the low end of the accessible range for a reversible action — shorter and
 * the undo is decorative.
 */
export const TOAST_ACTION_MS = 6000;

/** How long a toast stays up. */
export function toastDurationMs(options: FeedbackToastOptions): number {
  if (typeof options.durationMs === "number") return options.durationMs;
  return options.action ? TOAST_ACTION_MS : TOAST_DEFAULT_MS;
}

/**
 * What assistive tech announces. A toast carrying an undo MUST say so — an
 * action a screen-reader user cannot discover is worse than no action at all,
 * because the destructive write has already happened.
 */
export function toastAnnouncement(options: FeedbackToastOptions): string {
  return options.action
    ? `${options.message}. ${options.action.label} available.`
    : options.message;
}

/**
 * How many toasts may wait behind the visible one.
 *
 * The host used to show exactly one and REPLACE it on the next call, so a
 * bulk action that produced two confirmations discarded one of them — and if
 * the discarded one carried an undo, the destructive write had already
 * happened and its only recovery vanished silently. Three is enough to absorb
 * a burst without stacking a queue the user has to sit through.
 */
export const TOAST_QUEUE_LIMIT = 3;

/** The part of a toast this module reasons about. */
export interface QueuedFeedback {
  message: string;
  kind?: string | undefined;
  action?: FeedbackAction | undefined;
}

/**
 * Whether `next` says nothing `existing` is not already saying.
 *
 * Ten rows failing the same way should cost ONE toast, not ten sequential
 * ones. An entry carrying an action is never redundant: two undos are two
 * different reversals even when their copy is identical.
 */
export function isRedundantFeedback(
  existing: QueuedFeedback,
  next: QueuedFeedback,
): boolean {
  return (
    existing.message === next.message && !existing.action && !next.action
  );
}

/**
 * Append to the pending queue.
 *
 * Two rules, both about not wasting the user's attention:
 *
 *  - A REPEAT COLLAPSES (see `isRedundantFeedback`).
 *  - AN UNDO IS THE LAST THING DROPPED. At the limit the oldest entry WITHOUT
 *    an action is evicted first, because a plain confirmation is repeatable
 *    information while an undo is the only path back from a committed write.
 */
export function enqueueFeedback<T extends QueuedFeedback>(
  pending: readonly T[],
  next: T,
  limit: number = TOAST_QUEUE_LIMIT,
): T[] {
  if (pending.some((entry) => isRedundantFeedback(entry, next))) {
    return [...pending];
  }

  const queue = [...pending, next];
  while (queue.length > Math.max(1, limit)) {
    const evictable = queue.findIndex((entry) => !entry.action);
    queue.splice(evictable >= 0 ? evictable : 0, 1);
  }
  return queue;
}

/**
 * Whether an arriving toast should take over the screen from the visible one
 * instead of queueing behind it.
 *
 * Only an error interrupts, and only a non-error. Something went wrong is
 * time-critical in a way that "Saved." is not; the displaced toast is pushed
 * back to the FRONT of the queue rather than dropped, so nothing is lost.
 */
export function feedbackInterrupts(
  currentKind: string | undefined,
  nextKind: string | undefined,
): boolean {
  return nextKind === "error" && currentKind !== "error";
}

/**
 * Whether a typed-phrase confirmation gate is satisfied.
 *
 * This single predicate is what stands between a user and an irreversible
 * write. It is deliberately an EXACT comparison: a case-insensitive or
 * substring match would let a half-typed name through, which defeats the only
 * purpose of asking someone to type it.
 *
 * Surrounding whitespace is trimmed because a phrase copied out of the UI
 * often carries a trailing space; nothing else is normalised.
 */
export function confirmPhraseSatisfied(
  required: string | undefined,
  typed: string,
): boolean {
  if (!required) return true;
  return typed.trim() === required.trim();
}
