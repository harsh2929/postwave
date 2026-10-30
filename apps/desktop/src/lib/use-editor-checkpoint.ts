/**
 * useEditorCheckpoint — autosave + resume for a durable draft checkpoint
 * (ECO-03) on the desktop shell.
 *
 * The bar this exists to meet is explicitly cross-device: "close one client
 * during a supported task, open another, see the exact authoritative
 * checkpoint, and either resume safely or receive a precise explanation of why
 * only review mode is available." Desktop is where "I closed my laptop app" is
 * literal, and until now the campaign editor's only protection was
 * `registerLifecycleGuard` — a dialog that asks before you leave and remembers
 * nothing once you have.
 *
 * Three behaviours, all inherited from the web reference because the server
 * contract is the same one:
 *
 *   * leaving flushes the draft to the server;
 *   * arriving OFFERS the draft, never applies it. A draft that appears in the
 *     fields unasked is indistinguishable from the record, and the person
 *     cannot tell what they are about to save over;
 *   * a stale save shows BOTH versions and refuses to pick a winner.
 *
 * --- what is desktop's own ---
 *
 *  1. LEAVING IS A LIFECYCLE INTENT, not a `visibilitychange`. This shell has a
 *     first-class exit protocol (lib/lifecycle-coordinator): close-window,
 *     quit-app, sign-out, workspace-switch, update-restart, os-shutdown all run
 *     every registered guard's `prepare` before the process or identity
 *     changes. Listening for tab visibility here would miss the quit path
 *     entirely and fire on window blur, which is not leaving.
 *     The guard `inspect`s to null on purpose: the campaign editor already
 *     raises the unsaved-changes concern, and a second blocking voice for the
 *     same edit would make the exit dialog argue with itself.
 *  2. AN OFFER IS ONLY MADE WHEN THE DRAFT DIFFERS FROM THE RECORD, not merely
 *     when it is newer. Desktop's exit path can legitimately run "save the
 *     campaign" and "flush the checkpoint" in the same transition, in either
 *     order, with no render between them — so a checkpoint one tick newer than
 *     the record it duplicates is a normal outcome here. Offering it would be
 *     the "restore a draft that is already the saved state" the server's own
 *     header warns trains people to dismiss the prompt.
 *  3. A CHECKPOINT THIS SURFACE CANNOT OPEN IS SAID SO, not silently applied.
 *     `inspectContent` lets the caller declare a stored draft review-only, and
 *     that is the clause's second branch made real rather than assumed.
 *  4. There is an `unsupported` state. These routes are session-only and
 *     desktop also runs on API-key auth; see lib/editor-checkpoint-api.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type EditorCheckpoint,
  type EditorCheckpointClient,
  editorCheckpoints,
  isNewerThanRecord,
} from "./editor-checkpoint-api";
import { registerLifecycleGuard } from "./lifecycle-coordinator";

/**
 * Two seconds after the last change.
 *
 * Short enough that walking away loses at most a sentence, long enough that a
 * person typing a subject line does not mint a checkpoint per keystroke — every
 * PUT is a versioned write of the whole draft.
 */
export const CHECKPOINT_DEBOUNCE_MS = 2_000;

/** Whether the stored draft is one THIS surface can load into its editor. */
export type CheckpointResumability =
  | { resumable: true }
  | { resumable: false; reason: string };

export interface UseEditorCheckpointOptions<T> {
  /** @postwave/route-map entity key — the same vocabulary as the cursor. */
  entityKey: string;
  entityId: string | undefined;
  /**
   * The draft to checkpoint, or null when there is nothing unsaved. Null is
   * what makes a checkpoint disappear once the record is saved: leaving one
   * behind makes the next open offer a draft that is already the saved state.
   *
   * Keep this referentially stable across unrelated re-renders (a `useMemo`);
   * the debounce restarts whenever its identity changes.
   */
  content: T | null;
  /**
   * The checkpoint the SAVED record would produce, in the same vocabulary as
   * `content`. A stored draft equal to this holds no unsaved work and is not
   * offered — see note 2 in the header.
   */
  recordContent: T | null;
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
   * Optional: declare a stored draft unopenable on this surface. Returning
   * `{resumable:false}` keeps the draft visible and named, and replaces the
   * resume affordance with the reason.
   */
  inspectContent?: (content: T) => CheckpointResumability;
  /** Injection seam for tests; defaults to the live desktop client. */
  client?: EditorCheckpointClient;
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
  /** Set when `current` exists but this surface cannot open it. */
  blockedReason: string | null;
}

export interface EditorCheckpointState<T> {
  /** A draft on the server holding work the saved record does not. */
  offer: EditorCheckpoint<T> | null;
  /** Why the offered draft cannot be resumed here, when it cannot. */
  offerBlockedReason: string | null;
  /** Set when a save was refused because another device holds newer work. */
  conflict: EditorCheckpointConflict<T> | null;
  /** A rule this draft breaks; autosave stops until the draft changes. */
  refusal: string | null;
  /** Set when this sign-in cannot hold checkpoints at all. */
  unsupported: string | null;
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

function serialize(value: unknown): string | null {
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

export function useEditorCheckpoint<T>({
  entityKey,
  entityId,
  content,
  recordContent,
  recordUpdatedAt,
  canEdit,
  onRestore,
  inspectContent,
  client = editorCheckpoints,
}: UseEditorCheckpointOptions<T>): EditorCheckpointState<T> {
  const [offer, setOffer] = useState<EditorCheckpoint<T> | null>(null);
  const [conflict, setConflict] =
    useState<EditorCheckpointConflict<T> | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Refs, not state: the write path runs from a timer, an unmount cleanup and a
  // lifecycle `prepare`, none of which see a re-rendered closure.
  const liveRef = useRef(true);
  /** Version the server holds, 0 when it holds nothing. */
  const versionRef = useRef(0);
  const contentRef = useRef<T | null>(content);
  contentRef.current = content;
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const inspectRef = useRef(inspectContent);
  inspectRef.current = inspectContent;
  const clientRef = useRef(client);
  clientRef.current = client;
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
  /** Mirrors "unanswered offer / unresolved conflict / standing refusal". */
  const blockedRef = useRef(false);
  /** Guards the one-shot load, so a later record save cannot re-offer a draft. */
  const loadedRef = useRef(false);
  /**
   * True once the load has answered and `versionRef` therefore means something.
   *
   * The debounce already waits for this; the LEAVE paths must too, and on
   * desktop that is the common case rather than the edge — closing the
   * slide-over or quitting is how most edits end. Writing before the load
   * answers means writing at version 0 over a row that may already exist: a
   * guaranteed 409, raised as "another device saved newer work" when in fact
   * this device simply had not finished reading its own draft.
   */
  const readyRef = useRef(false);
  readyRef.current = ready;

  blockedRef.current =
    Boolean(offer) || Boolean(conflict) || refusal !== null || unsupported !== null;
  if (content !== null) dirtySeenRef.current = true;

  const recordSerialized = useMemo(
    () => (recordContent === null ? null : serialize(recordContent)),
    [recordContent],
  );
  const recordSerializedRef = useRef(recordSerialized);
  recordSerializedRef.current = recordSerialized;

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
    readyRef.current = false;
    setOffer(null);
    setConflict(null);
    setRefusal(null);
    setUnsupported(null);
    setLastSavedAt(null);
    setReady(false);
    return () => {
      liveRef.current = false;
    };
  }, [entityKey, entityId]);

  // Waits for the SAVED record. Without its timestamp there is no way to tell
  // whether a checkpoint holds work the record does not, and offering on a
  // guess is exactly the silent-apply this is built to avoid. Runs ONCE per
  // entity — re-running after the record is saved would re-offer a draft the
  // person has already answered.
  useEffect(() => {
    if (!entityId || !recordUpdatedAt || loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      const result = await clientRef.current.load<T>(entityKey, entityId);
      if (!liveRef.current) return;
      // Mark the version known BEFORE the state update, not just via the next
      // render: a leave that lands in that gap would otherwise be dropped.
      const arm = (): void => {
        readyRef.current = true;
        setReady(true);
      };
      if (result.status === "unsupported") {
        setUnsupported(result.message);
        arm();
        return;
      }
      if (result.status === "found") {
        // Track the version either way. A checkpoint we do NOT offer (because
        // it duplicates the record) is still the row the next autosave writes
        // over — starting from 0 would be refused on the first keystroke and
        // turn a non-event into a conflict dialog.
        versionRef.current = result.checkpoint.version;
        serverHoldsRef.current = true;
        const duplicatesRecord =
          recordSerializedRef.current !== null &&
          serialize(result.checkpoint.content) === recordSerializedRef.current;
        if (
          !duplicatesRecord &&
          isNewerThanRecord(result.checkpoint, recordUpdatedAt)
        ) {
          setOffer(result.checkpoint);
        }
        // A checkpoint OLDER than the record is not deleted here. It is very
        // likely already in the saved record, but "very likely" is not a reason
        // to destroy someone's only copy of an edit; the server's retention
        // sweep reclaims it, and the moment this editor goes dirty-then-clean
        // the discard below removes it for real.
      }
      arm();
    })();
  }, [entityKey, entityId, recordUpdatedAt]);

  // --- write ---------------------------------------------------------------
  const runFlush = useCallback(async (): Promise<void> => {
    const id = entityId;
    const draft = contentRef.current;
    if (!id || draft === null || !canEdit || blockedRef.current) return;
    if (!readyRef.current) return;
    const serialized = serialize(draft);
    if (serialized === null || serialized === sentRef.current) return;
    // The draft is byte-identical to the saved record: there is nothing
    // unsaved to protect, and writing it would mint a checkpoint the next open
    // offers as if it were newer work.
    if (serialized === recordSerializedRef.current) return;

    if (liveRef.current) setSaving(true);
    try {
      const result = await clientRef.current.save<T>(
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
        const check =
          result.current && inspectRef.current
            ? inspectRef.current(result.current.content)
            : { resumable: true as const };
        if (liveRef.current) {
          setConflict({
            current: result.current,
            blockedReason: check.resumable ? null : check.reason,
          });
        }
        return;
      }
      if (result.status === "unsupported") {
        blockedRef.current = true;
        if (liveRef.current) setUnsupported(result.message);
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
  }, [content, ready, canEdit, offer, conflict, refusal, unsupported]);

  // A CHANGED draft after a refusal deserves another attempt — the person may
  // have just deleted the image that broke the size cap. Compared by value, not
  // identity: the refusal itself re-renders the editor, and clearing on
  // identity would wipe the message in the same tick it was shown.
  useEffect(() => {
    if (content === null || refusedRef.current === null) return;
    if (serialize(content) === refusedRef.current) return;
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
    const activeClient = clientRef.current;
    void (async () => {
      // Sequence behind any in-flight write, or the DELETE lands first and the
      // PUT immediately re-creates the draft it was meant to remove.
      await queueRef.current;
      await activeClient.discard(entityKey, entityId);
    })();
  }, [content, entityKey, entityId, offer]);

  // --- leaving -------------------------------------------------------------
  // The debounce window is the one place work can still be lost, and it is
  // widest at exactly the moment someone walks away. Unmount covers closing the
  // slide-over and in-app navigation; the lifecycle guard covers closing the
  // window, quitting, signing out, switching workspace, an update restart and
  // OS shutdown — every path by which this process or identity ends.
  useEffect(
    () =>
      registerLifecycleGuard({
        id: `editor-checkpoint-${entityKey}-${entityId ?? "none"}`,
        label: "Draft checkpoint",
        // Never raises a concern: the editor that owns the draft already
        // reports it, and two owners describing one edit turns the exit dialog
        // into an argument. This guard exists purely for its `prepare`.
        inspect: () => null,
        prepare: () => flushRef.current(),
      }),
    [entityKey, entityId],
  );

  // Mount-scoped ON PURPOSE. React re-renders with the NEW entity before it
  // runs the OLD effect's cleanup, so a cleanup keyed on `entityId` would call
  // the flush already rebound to the new entity and write this campaign's
  // draft under the next one's id. Only a true unmount is safe to flush from.
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
  );

  // --- resolutions ---------------------------------------------------------
  const offerBlockedReason = useMemo(() => {
    if (!offer) return null;
    const check = inspectContent?.(offer.content);
    return check && !check.resumable ? check.reason : null;
  }, [offer, inspectContent]);

  const resume = useCallback(() => {
    if (!offer || offerBlockedReason) return;
    onRestoreRef.current(offer.content);
    // The restored draft IS what the server holds, so record it as already
    // sent: re-uploading a byte-identical copy would only burn a version.
    sentRef.current = serialize(offer.content);
    setOffer(null);
  }, [offer, offerBlockedReason]);

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
    void clientRef.current.discard(entityKey, entityId);
  }, [entityKey, entityId, offer]);

  const useTheirs = useCallback(() => {
    const theirs = conflict?.current;
    if (!theirs || conflict?.blockedReason) return;
    versionRef.current = theirs.version;
    sentRef.current = serialize(theirs.content);
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
    offerBlockedReason,
    conflict,
    refusal,
    unsupported,
    saving,
    lastSavedAt,
    resume,
    dismiss,
    keepMine,
    useTheirs,
  };
}
