/**
 * lib/dirtyGuard.ts — "you have unsaved changes" for the Settings screen.
 *
 * Settings hosts three independent editors (API connection, Workspace, the
 * outbound-webhook create form). Each owns a local Save button and nothing
 * guarded leaving mid-edit, so an accidental tap on the back chevron silently
 * discarded whatever had been typed. On a phone that is a much easier mistake
 * than on a desktop: the back affordance sits under the thumb.
 *
 * Why a MODULE-LEVEL registry rather than context: the editors are three
 * unrelated components several levels below the screen, and the thing that has
 * to ask the question — the header's back handler — is above all of them. A
 * context would work, but every editor would then re-render the screen on each
 * keystroke that flips its dirty bit. This registry is written by an effect and
 * read only at the moment the user tries to leave.
 *
 * Import-free so the copy and the bookkeeping are testable in the node
 * environment.
 */

const dirtySections = new Map<string, string>();

/** Register (or refresh) a section as having unsaved edits. */
export function markDirty(id: string, label: string): void {
  if (!id) return;
  dirtySections.set(id, label || id);
}

export function clearDirty(id: string): void {
  dirtySections.delete(id);
}

/** Labels of every section currently holding unsaved edits, in insertion order. */
export function unsavedLabels(): string[] {
  return [...dirtySections.values()];
}

/**
 * Called after the user confirms a discard, and on sign-out. Without this the
 * flags would survive the navigation and warn again on the next attempt to
 * leave, for edits that are already gone.
 */
export function resetDirtyGuard(): void {
  dirtySections.clear();
}

export interface UnsavedPrompt {
  title: string;
  message: string;
}

/**
 * The confirm copy, or null when there is nothing to warn about.
 *
 * It NAMES the sections. "You have unsaved changes" makes the user hunt for
 * what they were editing; "Workspace and API connection have unsaved changes"
 * tells them whether it matters enough to go back.
 */
export function unsavedPrompt(
  labels: readonly string[],
): UnsavedPrompt | null {
  const named = labels.filter((label) => label.trim().length > 0);
  if (named.length === 0) return null;
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return {
    title: named.length === 1 ? "Discard your changes?" : "Discard your edits?",
    message: `${list} ${named.length === 1 ? "has" : "have"} unsaved changes. Leaving now discards them.`,
  };
}
