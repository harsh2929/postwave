// SPDX-License-Identifier: AGPL-3.0-only
//
// Autosave + resume for a durable draft checkpoint (ECO-03).
//
// `useUnsavedChangesGuard` opens with "full autosave + version history are
// follow-ups". This is that follow-up, and it is the caller the server side has
// been waiting for: apps/api/internal/editorcheckpoint has been mounted, RLS
// scoped and DB-tested with nothing on any surface writing to it, so the
// guard's confirm dialog was the ONLY thing between an in-progress edit and
// losing it.
//
// The three behaviours here are the ones the program's bar names:
//
//   * close one client mid-edit and the work is on the server (autosave, plus a
//     flush when the editor unmounts or the tab is hidden — the two moments a
//     person actually leaves);
//   * open another and the checkpoint is OFFERED, never silently applied. A
//     draft that appears in the fields without being asked for is
//     indistinguishable from the record itself, and the person cannot tell what
//     they are about to save over;
//   * a stale save shows BOTH versions and refuses to pick a winner.
//
// Autosave is held in three states: while an offer is undecided (writing would
// overwrite the very draft being offered), while a conflict is unresolved
// (every tick would be another 409), and after a permanent refusal (retrying a
// 300 KiB draft every two seconds cannot start working).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type EditorCheckpoint,
  discardCheckpoint,
  isNewerThanRecord,
  loadCheckpoint,
  saveCheckpoint,
} from "@/lib/editor-checkpoint-api";

/**
 * Two seconds after the last change.
 *
 * Short enough that walking away loses at most a sentence, long enough that a
 * person typing a subject line does not mint a checkpoint per keystroke — every
 * PUT is a versioned write of the whole draft, and a 256 KiB body is not free
 * on a phone connection.
 */
export const CHECKPOINT_DEBOUNCE_MS = 2_000;

export interface UseEditorCheckpointOptions<T> {
  /** @postwave/route-map entity key — the same vocabulary as the cursor. */
  entityKey: string;
  entityId: string | undefined;
  /**
   * The draft to checkpoint, or null when there is nothing unsaved. Null is
   * what makes a checkpoint disappear once the record is saved: leaving one
   * behind makes the next open offer a draft that is already the saved state.
   *
   * Callers should keep this referentially stable across unrelated re-renders
   * (a `useMemo` on the draft record); the debounce restarts whenever it
   * changes identity.
   */
  content: T | null;
  /** `updated_at` of the SAVED record — a checkpoint is only offered when newer. */
  recordUpdatedAt: string | undefined;
  /**
   * False on a review-only surface. The checkpoint is still LOADED so the
   * person can be told their draft exists and why it cannot be resumed here;
   * it is never written.
   */
  canEdit: boolean;
  /** Applies a restored draft. Only ever called from an explicit user action. */
  onRestore: (content: T) => void;
}

/**
 * A save the server refused because another device holds newer work.
 *
 * `current` is that newer draft — the whole reason the refusal carries a body.
 * It is null only when the server could not re-read its own row: the conflict
 * is still real and must be shown, but neither resolution is offerable, because
 * both need the other version and we do not have it.
 */
export interface EditorCheckpointConflict<T> {
  current: EditorCheckpoint<T> | null;
}

export interface EditorCheckpointState<T> {
  /** A draft on the server holding work the saved record does not. */
  offer: EditorCheckpoint<T> | null;
  /** Set when a save was refused because another device holds newer work. */
  conflict: EditorCheckpointConflict<T> | null;
  /** A rule this draft breaks; autosave stops until the draft changes. */
  refusal: string | null;
  /** True while a checkpoint write is in flight. */
  saving: boolean;
  /** `updated_at` of the last checkpoint this client wrote. */
  lastSavedAt: string | null;
  /** Apply the offered draft to the editor. */
  resume: () => void;
  /** Keep the saved record and drop the offered draft. */
  dismiss: () => void;
  /** Resolve a conflict by overwriting the other device's draft with this one. */
  keepMine: () => void;
  /** Resolve a conflict by loading the other device's draft into this editor. */
  useTheirs: () => void;
}

export function useEditorCheckpoint<T>({
  entityKey,
  entityId,
  content,
  recordUpdatedAt,
  canEdit,
  onRestore,
}: UseEditorCheckpointOptions<T>): EditorCheckpointState<T> {
  const [offer, setOffer] = useState<EditorCheckpoint<T> | null>(null);
  const [conflict, setConflict] =
    useState<EditorCheckpointConflict<T> | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Refs, not state: the write path runs from a timer, an unmount cleanup and a
  // visibility listener, none of which see a re-rendered closure.
  const liveRef = useRef(true);
  /** Version the server holds, 0 when it holds nothing. */
  const versionRef = useRef(0);
  const contentRef = useRef<T | null>(content);
  contentRef.current = content;
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  /** Serialization of the last draft the server accepted — the no-op guard. */
  const sentRef = useRef<string | null>(null);
  /** Serialization of the draft the server refused, so a NEW draft can retry. */
  const refusedRef = useRef<string | null>(null);
  /** True while a checkpoint for this entity exists on the server. */
  const serverHoldsRef = useRef(false);
  /** True once this editor has held unsaved work in this session. */
  const dirtySeenRef = useRef(false);
  /** Serializes writes so two flush callers cannot race the same version. */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /** Mirrors "an unanswered offer / unresolved conflict / standing refusal". */
  const blockedRef = useRef(false);
  /** Guards the one-shot load, so a later record save cannot re-offer a draft. */
  const loadedRef = useRef(false);

  blockedRef.current = Boolean(offer) || Boolean(conflict) || refusal !== null;
  if (content !== null) dirtySeenRef.current = true;

  // --- open ----------------------------------------------------------------
  // Declared before the load so React runs it first on mount and first on an
  // entity change: everything is reset, THEN the load for the new entity arms.
  useEffect(() => {
    liveRef.current = true;
    versionRef.current = 0;
    sentRef.current = null;
    refusedRef.current = null;
    serverHoldsRef.current = false;
    dirtySeenRef.current = false;
    loadedRef.current = false;
    setOffer(null);
    setConflict(null);
    setRefusal(null);
    setLastSavedAt(null);
    setReady(false);
    return () => {
      liveRef.current = false;
    };
  }, [entityKey, entityId]);

  // Waits for the SAVED record. Without its timestamp there is no way to tell
  // whether a checkpoint holds work the record does not, and offering on a
  // guess is exactly the silent-apply this is built to avoid. Runs ONCE per
  // entity — re-running when the record is saved would re-offer a draft the
  // person has already answered.
  useEffect(() => {
    if (!entityId || !recordUpdatedAt || loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      const result = await loadCheckpoint<T>(entityKey, entityId);
      if (!liveRef.current) return;
      if (result.status === "found") {
        // Track the version either way. A checkpoint we do NOT offer (because
        // the record is newer, so it cannot be unsaved work) is still the row
        // the next autosave writes over — starting from 0 would be refused on
        // the first keystroke and turn a non-event into a conflict dialog.
        versionRef.current = result.checkpoint.version;
        serverHoldsRef.current = true;
        if (isNewerThanRecord(result.checkpoint, recordUpdatedAt)) {
          setOffer(result.checkpoint);
        }
        // A checkpoint OLDER than the record is not deleted here. It is very
        // likely already in the saved record, but "very likely" is not a reason
        // to destroy someone's only copy of an edit; the server's retention
        // sweep reclaims it, and the moment this editor goes dirty-then-clean
        // the discard below removes it for real.
      }
      setReady(true);
    })();
  }, [entityKey, entityId, recordUpdatedAt]);

  // --- write ---------------------------------------------------------------
  const runFlush = useCallback(async (): Promise<void> => {
    const id = entityId;
    const draft = contentRef.current;
    if (!id || draft === null || !canEdit || blockedRef.current) return;
    const serialized = JSON.stringify(draft);
    if (serialized === undefined || serialized === sentRef.current) return;

    if (liveRef.current) setSaving(true);
    try {
      const result = await saveCheckpoint<T>(
        entityKey,
        id,
        draft,
        versionRef.current,
      );
      if (result.status === "saved") {
        versionRef.current = result.checkpoint.version;
        sentRef.current = serialized;
        serverHoldsRef.current = true;
        if (liveRef.current) setLastSavedAt(result.checkpoint.updated_at);
        return;
      }
      if (result.status === "stale") {
        // Do NOT retry at the server's version. That is exactly the silent
        // overwrite the 409 exists to prevent — the other device's newer work
        // would vanish and nobody would ever know it had been there.
        blockedRef.current = true;
        serverHoldsRef.current = true;
        if (result.current) versionRef.current = result.current.version;
        if (liveRef.current) setConflict({ current: result.current });
        return;
      }
      if (result.status === "refused") {
        blockedRef.current = true;
        refusedRef.current = serialized;
        if (liveRef.current) setRefusal(result.message);
        return;
      }
      // `unavailable` — offline, timeout, 5xx. Leave `sentRef` alone so the
      // next tick retries the same draft, and stay quiet: a transient autosave
      // failure is not news the person can act on.
    } finally {
      if (liveRef.current) setSaving(false);
    }
  }, [canEdit, entityKey, entityId]);

  /** Chains onto any write already running, so no two carry the same version. */
  const flush = useCallback((): Promise<void> => {
    const next = queueRef.current.then(() => runFlush());
    queueRef.current = next.catch(() => undefined);
    return next;
  }, [runFlush]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Debounce. Depends on `content` by IDENTITY, so a render that produced a new
  // draft restarts the timer — the same thing as debouncing on change, without
  // serializing the whole draft on every render just to compare it.
  useEffect(() => {
    if (!ready || !canEdit || content === null || blockedRef.current) return;
    const timer = window.setTimeout(() => {
      void flushRef.current();
    }, CHECKPOINT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [content, ready, canEdit, offer, conflict, refusal]);

  // A CHANGED draft after a refusal deserves another attempt — the person may
  // have just deleted the image that broke the size cap. Compared by value, not
  // identity: the refusal itself re-renders the editor, and clearing on
  // identity would wipe the message in the same tick it was shown.
  useEffect(() => {
    if (content === null || refusedRef.current === null) return;
    if (JSON.stringify(content) === refusedRef.current) return;
    refusedRef.current = null;
    setRefusal(null);
  }, [content]);

  // --- clear ---------------------------------------------------------------
  // The record was saved (or the edit reverted): the draft is no longer unsaved
  // work, and a checkpoint left behind would be offered on the next open as if
  // it were.
  useEffect(() => {
    if (!entityId || content !== null) return;
    if (!dirtySeenRef.current || !serverHoldsRef.current) return;
    if (offer) return; // the person has not answered the offer yet.
    dirtySeenRef.current = false;
    serverHoldsRef.current = false;
    versionRef.current = 0;
    sentRef.current = null;
    void (async () => {
      // Sequence behind any in-flight write, or the DELETE lands first and the
      // PUT immediately re-creates the draft it was meant to remove.
      await queueRef.current;
      await discardCheckpoint(entityKey, entityId);
    })();
  }, [content, entityKey, entityId, offer]);

  // --- leaving -------------------------------------------------------------
  // The debounce window is the one place work can still be lost, and it is
  // widest at exactly the moment someone walks away. Unmount covers in-app
  // navigation; `visibilitychange` covers switching tab, minimising, and
  // closing a laptop.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flushRef.current();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      void flushRef.current();
    };
  }, []);

  // --- resolutions ---------------------------------------------------------
  const resume = useCallback(() => {
    if (!offer) return;
    onRestoreRef.current(offer.content);
    // The restored draft IS what the server holds, so record it as already
    // sent: re-uploading a byte-identical copy would only burn a version.
    sentRef.current = JSON.stringify(offer.content) ?? null;
    setOffer(null);
  }, [offer]);

  const dismiss = useCallback(() => {
    if (!offer || !entityId) return;
    setOffer(null);
    // An explicit "keep what is saved" — unambiguous, so the draft goes. This
    // is the one place a checkpoint is deleted on someone's say-so rather than
    // on evidence that it is superseded.
    versionRef.current = 0;
    serverHoldsRef.current = false;
    sentRef.current = null;
    dirtySeenRef.current = false;
    void discardCheckpoint(entityKey, entityId);
  }, [entityKey, entityId, offer]);

  const useTheirs = useCallback(() => {
    const theirs = conflict?.current;
    if (!theirs) return;
    versionRef.current = theirs.version;
    sentRef.current = JSON.stringify(theirs.content) ?? null;
    onRestoreRef.current(theirs.content);
    setConflict(null);
  }, [conflict]);

  const keepMine = useCallback(() => {
    const theirs = conflict?.current;
    if (!theirs) return;
    versionRef.current = theirs.version;
    sentRef.current = null;
    setConflict(null);
    // Write at the version just adopted, so this device's draft replaces the
    // other one — chosen by a person who was shown both, which is the only way
    // that overwrite is acceptable.
    blockedRef.current = false;
    void flushRef.current();
  }, [conflict]);

  return {
    offer,
    conflict,
    refusal,
    saving,
    lastSavedAt,
    resume,
    dismiss,
    keepMine,
    useTheirs,
  };
}
