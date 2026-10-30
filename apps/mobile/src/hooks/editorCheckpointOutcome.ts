/**
 * hooks/editorCheckpointOutcome.ts — what the server's answers MEAN, with no
 * React in the room.
 *
 * Split out of hooks/useEditorCheckpoint.ts exactly as api/eventBusStream.ts
 * was split out of api/eventBus.ts, and for the same reason. The half of a
 * durable checkpoint (ECO-03) worth testing without a simulator is the
 * DECISION — which answer adopts a version, which draft is worth OFFERING,
 * which refusal is a conflict and which is silent, and when the draft the
 * server holds may be deleted at all. None of that involves a ref, a state
 * setter, a timer or AppState, and all of those live next door in the hook.
 *
 * So: PURE here, LIFECYCLE there. Nothing in this file reads or writes
 * anything, on the wire or in React. Each function takes what the client
 * returned and reports the moves the caller should make; the hook still makes
 * them, in the order it always did. That is what lets these rules be tested in
 * the node vitest environment, where `react-native` cannot be imported.
 *
 * api/editorCheckpoint.ts is a third thing again — the WIRE: paths, status
 * codes, which failure is permanent and which is worth another tick.
 */
import {
  isNewerThanRecord,
  type CheckpointLoad,
  type CheckpointSave,
  type EditorCheckpoint,
} from "@/api/editorCheckpoint";

/**
 * The version and content the server is now known to hold.
 *
 * Reported by outcomes that are NOT a successful save as well, because the
 * version is tracked either way. A checkpoint this client does not offer — or
 * one it was refused against — is still the row its next write lands on, and a
 * client that started from 0 there would be refused on the first keystroke and
 * turn a non-event into a conflict dialog.
 */
export interface CheckpointHeld<T> {
  version: number;
  content: T;
}

/** What the one-shot load on open means for a screen that has offered nothing. */
export interface CheckpointOpening<T> {
  /** Null when the server holds no draft for this entity. */
  held: CheckpointHeld<T> | null;
  /**
   * Serialization of the held content, for the caller's "already sent" guard.
   *
   * What the server holds counts as already sent. Web can skip this because
   * its content is null until the editor goes dirty; on this surface a subset
   * screen merges over `held`, so an untouched editor would otherwise re-PUT a
   * byte-identical body and burn a version on every open.
   */
  sent: string | null;
  /**
   * The draft to OFFER, or null when there is nothing to offer.
   *
   * A checkpoint OLDER than the record is reported as held-but-not-offered,
   * never as something to delete. It is very likely already in the saved
   * record, but "very likely" is not a reason to destroy someone's only copy
   * of an edit; the server's retention sweep reclaims it, and the moment the
   * editor goes dirty-then-clean the caller's discard removes it for real.
   */
  offer: EditorCheckpoint<T> | null;
}

/**
 * What a save ATTEMPT means.
 *
 *   * `accepted` — the server holds this draft. Covers a plain 200 and the
 *     409 that is our own write arriving twice (see `canonicalJSON` below).
 *   * `conflict` — another device holds newer work. `current` is that work,
 *     null only when the server could not re-read its own row: the conflict is
 *     still real and must be shown, but neither resolution is offerable.
 *   * `refused` — the draft broke a rule. Retrying the SAME draft is noise.
 *   * `unsupported` — no signed-in person can own this draft (401/403 —
 *     signed out, or a shared API key on a per-person route). Permanent for
 *     the session and deliberately silent: the API is behaving correctly.
 *   * `unavailable` — offline, timeout, 5xx. Say nothing and let the next tick
 *     retry the same draft.
 */
export type CheckpointSaveOutcome<T> =
  | { kind: "accepted"; held: CheckpointHeld<T>; savedAt: string }
  | {
      kind: "conflict";
      held: CheckpointHeld<T> | null;
      current: EditorCheckpoint<T> | null;
    }
  | { kind: "refused"; message: string }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

/**
 * True when the outcome means a checkpoint row for this entity now exists on
 * the server. A refusal is the only answer that leaves the row untouched.
 */
export function outcomeMeansServerHolds<T>(
  outcome: CheckpointSaveOutcome<T>,
): boolean {
  return outcome.kind === "accepted" || outcome.kind === "conflict";
}

/**
 * The version and content to adopt, or null when the answer said nothing about
 * what the server holds. A conflict the server could not read a row for is the
 * one refusal-shaped answer that still reports null.
 */
export function heldFromOutcome<T>(
  outcome: CheckpointSaveOutcome<T>,
): CheckpointHeld<T> | null {
  if (outcome.kind === "accepted") return outcome.held;
  if (outcome.kind === "conflict") return outcome.held;
  return null;
}

export function classifyLoadOutcome<T>(
  result: CheckpointLoad<T>,
  recordUpdatedAt: string | undefined,
): CheckpointOpening<T> {
  if (result.status !== "found") return { held: null, sent: null, offer: null };
  const draft = result.checkpoint;
  return {
    held: { version: draft.version, content: draft.content },
    sent: JSON.stringify(draft.content) ?? null,
    offer: isNewerThanRecord(draft, recordUpdatedAt) ? draft : null,
  };
}

/**
 * `sent` is the body that was PUT, so the "our own write arriving twice" case
 * below can be recognised by comparing it with what came back.
 */
export function classifySaveOutcome<T>(
  result: CheckpointSave<T>,
  sent: T,
): CheckpointSaveOutcome<T> {
  if (result.status === "saved") {
    const saved = result.checkpoint;
    return {
      kind: "accepted",
      held: { version: saved.version, content: saved.content },
      savedAt: saved.updated_at,
    };
  }
  if (result.status === "stale") {
    const theirs = result.current;
    if (!theirs) return { kind: "conflict", held: null, current: null };
    const held = { version: theirs.version, content: theirs.content };
    // OUR OWN WRITE, ARRIVING TWICE. The SDK retries a PUT after a network
    // error or timeout, and a phone on a train produces exactly that: the
    // first attempt commits, its response never comes back, the retry carries
    // the now-stale version and is refused with the content we just sent.
    // Calling that "another device saved newer work" would put a conflict
    // dialog in front of a person whose only other device is in a drawer.
    // Byte-identical content means nothing is at stake either way — adopt the
    // version and carry on.
    if (canonicalJSON(theirs.content) === canonicalJSON(sent)) {
      return { kind: "accepted", held, savedAt: theirs.updated_at };
    }
    // Do NOT report "retry at the server's version". That is exactly the
    // silent overwrite the 409 exists to prevent — the other device's newer
    // work would vanish and nobody would ever know it had been there.
    return { kind: "conflict", held, current: theirs };
  }
  if (result.status === "refused") {
    return { kind: "refused", message: result.message };
  }
  if (result.status === "unsupported") return { kind: "unsupported" };
  return { kind: "unavailable" };
}

/**
 * Whether the checkpoint the server holds may be DELETED from this surface.
 *
 * No guard means yes, which is right for an editor that renders the whole
 * draft. A SUBSET surface answers no for a checkpoint holding fields it cannot
 * represent, and that veto is load-bearing in two places:
 *
 *   * the auto-delete when the editor goes clean — "the person closed my
 *     four-field sheet" is not evidence that the body draft behind it was
 *     abandoned;
 *   * a DISMISS, where web's reasoning does not survive the trip to a phone.
 *     On web the editor renders the whole draft, so "keep what is saved" is a
 *     choice made with the draft in front of you. A phone shows a banner — "you
 *     have an unsaved draft from another device" and a relative time; the body
 *     is never rendered. Deleting on that say-so destroys three paragraphs the
 *     person was never shown, and it is the ONLY path by which this surface can
 *     lose the laptop's work. A dismiss that cannot see everything it would
 *     delete dismisses the OFFER and leaves the draft alone: "don't ask me
 *     again right now" is not "throw away what my laptop is holding".
 */
export function mayDiscardHeld<T>(
  canDiscardHeld: ((held: T | null) => boolean) | undefined,
  held: T | null,
): boolean {
  return canDiscardHeld ? canDiscardHeld(held) : true;
}

// A key-order-independent serialization, for comparing something we sent with
// the same thing read back out of PostgreSQL.
//
// jsonb is not a text format: it stores an object's keys sorted by length then
// bytes and returns them that way, so a round-tripped payload is equal in value
// and different in bytes. Verified against the live database:
//
//   '{"subject":"a","preview_text":"b","from_name":"c","reply_to":"d"}'::jsonb::text
//   -> {"subject": "a", "reply_to": "d", "from_name": "c", "preview_text": "b"}
//
// A raw JSON.stringify comparison therefore fails on the FIRST write for any
// entity, which is the commonest instance of the exact case the stale branch
// above exists to absorb — so the person on the train gets the conflict dialog
// anyway, naming a second device that does not exist.
//
// Only for that cross-boundary comparison. Client-to-client dedupe (the
// caller's `sentRef` / `refusedRef`) compares two values one process produced,
// where key order is already stable and a plain JSON.stringify is both correct
// and cheaper.
export function canonicalJSON(value: unknown): string | undefined {
  return JSON.stringify(withSortedKeys(value));
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Array order is meaningful — sort the keys inside each element, never the
    // elements themselves.
    return value.map(withSortedKeys);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = withSortedKeys(source[key]);
    }
    return sorted;
  }
  return value;
}
