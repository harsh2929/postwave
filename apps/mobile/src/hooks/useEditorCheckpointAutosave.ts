/**
 * hooks/useEditorCheckpointAutosave.ts — the WRITE half of a durable draft
 * checkpoint (ECO-03): when the draft is PUT, when the checkpoint is DELETED,
 * and the moment on a phone where work can still be lost.
 *
 * Split out of hooks/useEditorCheckpoint.ts, which keeps the OPEN half (what
 * the server already holds, whether it is worth offering) and the answers a
 * person gives. The cells both halves read and write are the one bundle in
 * hooks/editorCheckpointMachine; the meaning of each of the server's answers
 * is hooks/editorCheckpointOutcome, which has no React in it at all.
 *
 * --- what is different on a phone, and why ---
 *
 * FLUSH ON BACKGROUND, NOT ONLY ON UNMOUNT. Web listens for
 * `visibilitychange`; the phone equivalent is AppState leaving `active`, and
 * it is not a nicety here. A person editing on a phone almost never unmounts
 * the editor — they get a call, swipe up, or lock the screen mid-sentence, and
 * expo-router keeps the screen mounted the whole time. Without this listener
 * the debounce window is the common case rather than the edge case, and the
 * feature mostly does not fire. `inactive` is included with `background`: on
 * iOS that is the state an incoming call and the app switcher enter first, and
 * a process killed from the switcher may never reach `background` at all.
 *
 * NOTHING HERE MAY BE QUEUED FOR OFFLINE REPLAY. A checkpoint write carries
 * the version it was built on; replayed minutes later it would carry a version
 * the server has long since moved past — a guaranteed 409 arriving with no
 * editor open to resolve it. So this hook never goes through `useMutation`
 * (mobile's outbox is TanStack's paused-mutation persistence, opted into with
 * `offlineSafeMutationMeta`), the route is on lib/offlineQueueSafety's
 * online-only list, and the client itself refuses to send while offline.
 */
import { useCallback, useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { editorCheckpoints } from "@/hooks/editorCheckpointClient";
import {
  forgetHeldCheckpoint,
  type Cell,
  type EditorCheckpointConflict,
  type EditorCheckpointRefs,
} from "@/hooks/editorCheckpointMachine";
import {
  classifySaveOutcome,
  heldFromOutcome,
  mayDiscardHeld,
  outcomeMeansServerHolds,
} from "@/hooks/editorCheckpointOutcome";

/**
 * Two seconds after the last change.
 *
 * Short enough that walking away loses at most a sentence, long enough that a
 * person typing a subject line does not mint a checkpoint per keystroke — every
 * PUT is a versioned write of the whole draft, and a 256 KiB body is not free
 * on a cellular connection.
 */
export const CHECKPOINT_DEBOUNCE_MS = 2_000;

export interface EditorCheckpointAutosave {
  /** Force the debounce window closed. Wired to AppState and unmount. */
  flush: () => Promise<void>;
  /**
   * The same flush, in a cell. Everything that fires outside a render — the
   * timer, the unmount cleanup, the AppState listener, and the caller's
   * conflict resolution — goes through this rather than a captured closure.
   */
  flushRef: Cell<() => Promise<void>>;
}

export function useEditorCheckpointAutosave<T>({
  entityKey,
  entityId,
  content,
  canEdit,
  ready,
  offer,
  conflict,
  refusal,
  refs,
  setSaving,
  setLastSavedAt,
  setConflict,
  setRefusal,
}: {
  entityKey: string;
  entityId: string | undefined;
  content: T | null;
  canEdit: boolean;
  /** True once the one-shot load has answered. Nothing is written before it. */
  ready: boolean;
  /**
   * The three answers a person can still owe this client. Only their presence
   * matters here — they are dependencies of the debounce, so that answering
   * one re-arms it.
   */
  offer: object | null;
  conflict: object | null;
  refusal: string | null;
  refs: EditorCheckpointRefs<T>;
  setSaving: (saving: boolean) => void;
  setLastSavedAt: (at: string | null) => void;
  setConflict: (conflict: EditorCheckpointConflict<T>) => void;
  setRefusal: (message: string | null) => void;
}): EditorCheckpointAutosave {
  const merge = useCallback(
    (draft: T): T => {
      const fn = refs.mergeRef.current;
      return fn ? fn(refs.heldRef.current, draft) : draft;
    },
    [refs],
  );

  // --- write ---------------------------------------------------------------
  const runFlush = useCallback(async (): Promise<void> => {
    const id = entityId;
    const draft = refs.contentRef.current;
    if (!id || draft === null || !canEdit || refs.blockedRef.current) return;
    const body = merge(draft);
    const serialized = JSON.stringify(body);
    if (serialized === undefined || serialized === refs.sentRef.current) return;

    if (refs.liveRef.current) setSaving(true);
    try {
      const result = await editorCheckpoints.save<T>(
        entityKey,
        id,
        body,
        refs.versionRef.current,
      );
      // Which answer adopts a version, which is a real conflict, and which of
      // them is our own retried write coming back — editorCheckpointOutcome.
      // The moves stay here, in the order they have always been made.
      const outcome = classifySaveOutcome(result, body);
      const held = heldFromOutcome(outcome);
      if (held) {
        refs.versionRef.current = held.version;
        refs.heldRef.current = held.content;
      }
      if (outcomeMeansServerHolds(outcome)) refs.serverHoldsRef.current = true;

      if (outcome.kind === "accepted") {
        refs.sentRef.current = serialized;
        if (refs.liveRef.current) setLastSavedAt(outcome.savedAt);
        return;
      }
      if (outcome.kind === "conflict") {
        refs.blockedRef.current = true;
        if (refs.liveRef.current) setConflict({ current: outcome.current });
        return;
      }
      if (outcome.kind === "refused") {
        refs.blockedRef.current = true;
        refs.refusedRef.current = serialized;
        if (refs.liveRef.current) setRefusal(outcome.message);
        return;
      }
      if (outcome.kind === "unsupported") {
        refs.unsupportedRef.current = true;
        refs.blockedRef.current = true;
        return;
      }
      // `unavailable` — offline, timeout, 5xx. Leave `sentRef` alone so the
      // next tick retries the same draft, and stay quiet: a transient autosave
      // failure is not news the person can act on.
    } finally {
      if (refs.liveRef.current) setSaving(false);
    }
  }, [
    canEdit,
    entityKey,
    entityId,
    merge,
    refs,
    setConflict,
    setLastSavedAt,
    setRefusal,
    setSaving,
  ]);

  /** Chains onto any write already running, so no two carry the same version. */
  const flush = useCallback((): Promise<void> => {
    const next = refs.queueRef.current.then(() => runFlush());
    refs.queueRef.current = next.catch(() => undefined);
    return next;
  }, [refs, runFlush]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Debounce. Depends on `content` by IDENTITY, so a render that produced a new
  // draft restarts the timer — the same thing as debouncing on change, without
  // serializing the whole draft on every render just to compare it.
  useEffect(() => {
    if (!ready || !canEdit || content === null || refs.blockedRef.current)
      return;
    const timer = setTimeout(() => {
      void flushRef.current();
    }, CHECKPOINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content, ready, canEdit, offer, conflict, refusal, refs]);

  // A CHANGED draft after a refusal deserves another attempt — the person may
  // have just deleted the image that broke the size cap. Compared by value, not
  // identity: the refusal itself re-renders the editor, and clearing on
  // identity would wipe the message in the same tick it was shown.
  useEffect(() => {
    if (content === null || refs.refusedRef.current === null) return;
    if (JSON.stringify(merge(content)) === refs.refusedRef.current) return;
    refs.refusedRef.current = null;
    setRefusal(null);
  }, [content, merge, refs, setRefusal]);

  // --- clear ---------------------------------------------------------------
  // The record was saved (or the edit reverted): the draft is no longer unsaved
  // work, and a checkpoint left behind would be offered on the next open as if
  // it were. `canDiscardHeld` is the veto a subset surface uses — see
  // useEditorCheckpoint's header and lib/campaignCheckpoint.
  useEffect(() => {
    if (!entityId || content !== null) return;
    if (!refs.dirtySeenRef.current || !refs.serverHoldsRef.current) return;
    if (offer) return; // the person has not answered the offer yet.
    if (!mayDiscardHeld(refs.canDiscardRef.current, refs.heldRef.current))
      return;
    forgetHeldCheckpoint(refs);
    // `lastSavedAt` means "a draft this client wrote is on the server". Past
    // this line one is not, so a surface rendering it would go on promising a
    // kept draft after the very DELETE that removed it. Cleared here and not
    // above the veto: when `canDiscardHeld` refuses, the draft really does
    // survive and the promise is still true.
    setLastSavedAt(null);
    void (async () => {
      // Sequence behind any in-flight write, or the DELETE lands first and the
      // PUT immediately re-creates the draft it was meant to remove.
      await refs.queueRef.current;
      await editorCheckpoints.discard(entityKey, entityId);
    })();
  }, [content, entityKey, entityId, offer, refs, setLastSavedAt]);

  // --- leaving -------------------------------------------------------------
  // The debounce window is the one place work can still be lost, and on a
  // phone it is widest at exactly the moment someone is interrupted. Unmount
  // covers in-app navigation; AppState covers the app switcher, an incoming
  // call, the lock button — which is how a phone is actually put down.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === "background" || next === "inactive") {
        void flushRef.current();
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      sub.remove();
      void flushRef.current();
    };
  }, []);

  return { flush, flushRef };
}
