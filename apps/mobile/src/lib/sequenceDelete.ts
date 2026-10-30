/**
 * lib/sequenceDelete.ts — the policy behind deleting a sequence from mobile.
 *
 * Deleting a sequence is the one irreversible write this cluster exposes, and
 * three separate things about it are easy to get wrong:
 *
 *  1. IT CANNOT BE QUEUED. `lib/offlineQueueSafety` denies every DELETE by
 *     design, so this is an ONLINE-ONLY action. Offering it while the online
 *     gate is closed would produce a button that silently does nothing.
 *  2. IT CANNOT BE UNDONE. The kit's default for a destructive action is
 *     toast-with-undo, which is right when the mutation is reversible. There
 *     is no un-delete endpoint here, so this is the case that genuinely earns
 *     a pre-confirm — with the sequence's own name typed, so the gesture is a
 *     real check rather than a speed bump.
 *  3. IT NEEDS A VERSION. The Voice handler requires If-Match and answers 412
 *     when the row moved on. That is a DIFFERENT sentence from "not found" and
 *     from "you can't do that", and collapsing the three into one message is
 *     what makes an operator retry something that can never work.
 *
 * Import-free so every branch is unit-testable.
 */

export interface SequenceDeleteConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: true;
  /** Typed-phrase gate; absent when the sequence has no usable name. */
  confirmPhrase?: string;
  consequence: string;
}

/**
 * Build the confirm sheet. The phrase is the sequence's OWN name so typing it
 * proves the operator is looking at the row they think they are; an unnamed
 * draft falls back to no phrase rather than to a meaningless constant like
 * "DELETE", which teaches muscle memory instead of attention.
 */
export function sequenceDeleteConfirm(input: {
  name?: string | null | undefined;
  stepCount?: number | undefined;
}): SequenceDeleteConfirm {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const steps =
    typeof input.stepCount === "number" && Number.isFinite(input.stepCount)
      ? Math.max(0, Math.trunc(input.stepCount))
      : null;
  const stepText =
    steps === null
      ? "This cannot be undone."
      : `${steps} ${steps === 1 ? "step" : "steps"} will be deleted. This cannot be undone.`;
  return {
    title: name ? `Delete “${name}”?` : "Delete this sequence?",
    message:
      "The sequence and its steps are removed from this workspace permanently. There is no undo.",
    confirmLabel: "Delete",
    destructive: true,
    ...(name ? { confirmPhrase: name } : {}),
    consequence: stepText,
  };
}

/**
 * Human sentence for a failed delete, per the handler's actual answers
 * (services/voice/internal/handlers/sequences.go:1198-1230).
 */
export function sequenceDeleteErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 412) {
    return "This sequence changed on another device. Pull to refresh, then delete it again.";
  }
  if (status === 428) {
    return "Reload this sequence before deleting it — its version is missing.";
  }
  if (status === 404) {
    return "This sequence is already gone.";
  }
  if (status === 403) {
    return "Your role can't delete sequences. Ask an admin.";
  }
  if (status === 405 || status === 501) {
    return "This deployment doesn't allow deleting sequences from the API.";
  }
  if (status === 503) {
    return "The sequence service is unavailable right now. Try again shortly.";
  }
  const message = fallback?.trim();
  return message || "Couldn't delete this sequence.";
}

/**
 * Whether to offer the affordance at all.
 *
 * Hiding it is better than disabling it here: a delete that is impossible
 * because the app is offline, because the row's version was never loaded, or
 * because the role is read-only is not a "try again later" state — it is a
 * different screen.
 */
export function canDeleteSequence(input: {
  online: boolean;
  version: number | null | undefined;
  /** Result of `canAccessMinimumRole("editor", role, mode)` — the role
   *  vocabulary has exactly one owner (lib/mobileRouteManifest) and this
   *  module deliberately does not become a second one. */
  canWrite: boolean;
}): boolean {
  if (!input.online || !input.canWrite) return false;
  return Number.isSafeInteger(input.version) && (input.version ?? 0) >= 1;
}
