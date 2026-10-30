/**
 * hooks/useEditorCheckpoint.ts — autosave + resume for a durable draft
 * checkpoint (ECO-03) on a phone.
 *
 * The rules live in api/editorCheckpoint.ts (the wire) and
 * editorCheckpointOutcome.ts (what each answer means), both free of React and
 * react-native so they can be tested in the node environment. This file is the
 * lifecycle: when a draft is written, when it is offered, and when it is left
 * alone. It is a deliberate port of apps/web/src/lib/use-editor-checkpoint.ts —
 * the three behaviours the program's bar names are the same on every surface:
 *
 *   * leave one client mid-edit and the work is on the server;
 *   * open another and the checkpoint is OFFERED, never silently applied. A
 *     draft that appears in the fields without being asked for is
 *     indistinguishable from the record itself, and the person cannot tell
 *     what they are about to save over;
 *   * a stale save shows BOTH versions and refuses to pick a winner.
 *
 * The lifecycle is split by phase, and the phases run in this order:
 *
 *   * editorCheckpointMachine — the mutable cells every phase shares, and the
 *     two ways they are cleared;
 *   * this file's OPEN — reset on an entity change, then the one-shot load
 *     that decides whether the server holds anything worth offering;
 *   * useEditorCheckpointAutosave — the WRITE: the debounce, the versioned
 *     PUT, the auto-delete, and the flush a phone needs when the app leaves
 *     the foreground (which is where the two behaviours mobile does not share
 *     with web are written down);
 *   * this file's RESOLUTIONS — what happens when the person answers the offer
 *     or the conflict. Every one of them is an explicit user action.
 *
 * --- what is different on a phone, and why ---
 *
 * MERGE BEFORE WRITE, AND DECLINE SOME DELETES. This surface edits four of a
 * campaign's fields; the laptop's editor also holds the body. `mergeWithHeld`
 * and `canDiscardHeld` are how a caller says so — see lib/campaignCheckpoint.
 * Their defaults are exactly web's behaviour, so a surface that holds the
 * whole draft passes neither.
 */
import { useCallback, useEffect, useState } from "react";

import type { EditorCheckpoint } from "@/api/editorCheckpoint";
import { editorCheckpoints } from "@/hooks/editorCheckpointClient";
import {
  forgetHeldCheckpoint,
  resetCheckpointRefs,
  useEditorCheckpointRefs,
  type EditorCheckpointConflict,
} from "@/hooks/editorCheckpointMachine";
import {
  classifyLoadOutcome,
  mayDiscardHeld,
} from "@/hooks/editorCheckpointOutcome";
import { useEditorCheckpointAutosave } from "@/hooks/useEditorCheckpointAutosave";

export { editorCheckpoints };
export { CHECKPOINT_DEBOUNCE_MS } from "@/hooks/useEditorCheckpointAutosave";
export type { EditorCheckpointConflict };

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
   * (a `useMemo` on the draft); the debounce restarts whenever it changes
   * identity.
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
  /**
   * Lay this surface's draft over the content the server already holds.
   *
   * Defaults to "the draft IS the content", which is right for an editor that
   * holds the whole record. A surface that edits a SUBSET must merge, or its
   * first autosave silently deletes every field it cannot see.
   */
  mergeWithHeld?: ((held: T | null, draft: T) => T) | undefined;
  /**
   * Whether the checkpoint the server holds may be DELETED from this surface.
   *
   * Defaults to yes. A subset surface answers no for a checkpoint holding
   * fields it cannot represent: "the person closed my four-field sheet" is not
   * evidence that the body draft behind it was abandoned.
   */
  canDiscardHeld?: ((held: T | null) => boolean) | undefined;
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
  /** Force the debounce window closed. Wired to AppState and unmount. */
  flush: () => Promise<void>;
}

export function useEditorCheckpoint<T>({
  entityKey,
  entityId,
  content,
  recordUpdatedAt,
  canEdit,
  onRestore,
  mergeWithHeld,
  canDiscardHeld,
}: UseEditorCheckpointOptions<T>): EditorCheckpointState<T> {
  const [offer, setOffer] = useState<EditorCheckpoint<T> | null>(null);
  const [conflict, setConflict] = useState<EditorCheckpointConflict<T> | null>(
    null,
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // The cells the whole lifecycle runs on, including the per-render mirrors of
  // the props that timer-driven code has to read — editorCheckpointMachine.
  const refs = useEditorCheckpointRefs<T>({
    content,
    onRestore,
    mergeWithHeld,
    canDiscardHeld,
    offer,
    conflict,
    refusal,
  });

  // --- open ----------------------------------------------------------------
  // Declared before the load so React runs it first on mount and first on an
  // entity change: everything is reset, THEN the load for the new entity arms.
  useEffect(() => {
    resetCheckpointRefs(refs);
    setOffer(null);
    setConflict(null);
    setRefusal(null);
    setLastSavedAt(null);
    setReady(false);
    return () => {
      refs.liveRef.current = false;
    };
  }, [entityKey, entityId, refs]);

  // Waits for the SAVED record. Without its timestamp there is no way to tell
  // whether a checkpoint holds work the record does not, and offering on a
  // guess is exactly the silent-apply this is built to avoid. Runs ONCE per
  // entity — re-running when the record is saved would re-offer a draft the
  // person has already answered.
  useEffect(() => {
    if (!entityId || !recordUpdatedAt || refs.loadedRef.current) return;
    refs.loadedRef.current = true;
    void (async () => {
      const result = await editorCheckpoints.load<T>(entityKey, entityId);
      if (!refs.liveRef.current) return;
      // What "found" means — which version to track, what counts as already
      // sent, and why an older checkpoint is kept but not offered — is
      // editorCheckpointOutcome.classifyLoadOutcome.
      const opening = classifyLoadOutcome<T>(result, recordUpdatedAt);
      if (opening.held) {
        refs.versionRef.current = opening.held.version;
        refs.heldRef.current = opening.held.content;
        refs.serverHoldsRef.current = true;
        refs.sentRef.current = opening.sent;
        if (opening.offer) setOffer(opening.offer);
      }
      setReady(true);
    })();
  }, [entityKey, entityId, recordUpdatedAt, refs]);

  // --- write, clear, leaving -----------------------------------------------
  // Declared here so its effects run after the two above, in the order they
  // always have: debounce, refusal-retry, auto-delete, AppState.
  const { flush, flushRef } = useEditorCheckpointAutosave<T>({
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
  });

  // --- resolutions ---------------------------------------------------------
  const resume = useCallback(() => {
    if (!offer) return;
    refs.onRestoreRef.current(offer.content);
    // The restored draft IS what the server holds, so record it as already
    // sent: re-uploading a byte-identical copy would only burn a version.
    refs.heldRef.current = offer.content;
    refs.sentRef.current = JSON.stringify(offer.content) ?? null;
    setOffer(null);
  }, [offer, refs]);

  const dismiss = useCallback(() => {
    if (!offer || !entityId) return;
    setOffer(null);

    // THE VETO APPLIES HERE TOO — web skips it on a dismiss and a phone cannot,
    // because this surface never renders the body it would be deleting. The
    // reasoning is on editorCheckpointOutcome.mayDiscardHeld. When it refuses,
    // the refs stay exactly as they are, because the server still holds the
    // draft: clearing them here would make this client believe a checkpoint it
    // can still collide with does not exist.
    if (!mayDiscardHeld(refs.canDiscardRef.current, refs.heldRef.current))
      return;

    // Nothing unseen is at stake: the held draft is entirely fields this surface
    // displays, so the person really did choose against what they were shown.
    forgetHeldCheckpoint(refs);
    void editorCheckpoints.discard(entityKey, entityId);
  }, [entityKey, entityId, offer, refs]);

  const useTheirs = useCallback(() => {
    const theirs = conflict?.current;
    if (!theirs) return;
    refs.versionRef.current = theirs.version;
    refs.heldRef.current = theirs.content;
    refs.sentRef.current = JSON.stringify(theirs.content) ?? null;
    refs.onRestoreRef.current(theirs.content);
    setConflict(null);
  }, [conflict, refs]);

  const keepMine = useCallback(() => {
    const theirs = conflict?.current;
    if (!theirs) return;
    refs.versionRef.current = theirs.version;
    refs.heldRef.current = theirs.content;
    refs.sentRef.current = null;
    setConflict(null);
    // Write at the version just adopted, so this device's draft replaces the
    // other one — chosen by a person who was shown both, which is the only way
    // that overwrite is acceptable.
    refs.blockedRef.current = false;
    void flushRef.current();
  }, [conflict, flushRef, refs]);

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
    flush,
  };
}
