/**
 * hooks/editorCheckpointMachine.ts — the mutable cells a durable draft
 * checkpoint (ECO-03) runs on, and the two ways they are cleared.
 *
 * Refs, not state: the write path runs from a timer, an unmount cleanup and
 * an AppState listener, none of which see a re-rendered closure. They are
 * declared together, in one bundle, because every phase of the lifecycle
 * shares them — the open in hooks/useEditorCheckpoint, the writes and the
 * auto-delete in hooks/useEditorCheckpointAutosave, and the answers a person
 * gives to an offer or a conflict — and because the two places that CLEAR
 * them have to stay in step with the list. Keeping the list and the clears in
 * one file is what makes a cell added on one side and forgotten on the other
 * visible.
 *
 * The bundle's identity is stable for the life of the component — it is held
 * in a ref, not a `useMemo`, which is a performance hint and not a promise.
 * Callers put it in dependency arrays, and a bundle that changed identity
 * would re-run the effect that RESETS the machine.
 */
import { useRef } from "react";

import type { EditorCheckpoint } from "@/api/editorCheckpoint";

/**
 * A plain mutable cell — `useRef`'s shape, named here so this module does not
 * depend on which of React's ref type names is current.
 */
export interface Cell<V> {
  current: V;
}

/**
 * A save the server refused because another device holds newer work.
 *
 * `current` is that newer draft — the whole reason the refusal carries a body.
 * It is null only when the server could not re-read its own row: the conflict
 * is still real and must be shown, but neither resolution is offerable,
 * because both need the other version and we do not have it.
 */
export interface EditorCheckpointConflict<T> {
  current: EditorCheckpoint<T> | null;
}

export interface EditorCheckpointRefs<T> {
  /** False from the moment this editor unmounts or moves to another entity. */
  liveRef: Cell<boolean>;
  /** Version the server holds, 0 when it holds nothing. */
  versionRef: Cell<number>;
  /** The CONTENT the server holds, so a subset surface can merge over it. */
  heldRef: Cell<T | null>;
  /** The draft as of this render, for the write path's timer-driven closures. */
  contentRef: Cell<T | null>;
  /** The current `onRestore`, so a resolution never calls a stale closure. */
  onRestoreRef: Cell<(content: T) => void>;
  /** The current `mergeWithHeld`, read by the write path. */
  mergeRef: Cell<((held: T | null, draft: T) => T) | undefined>;
  /** The current `canDiscardHeld` — the veto on deleting the held draft. */
  canDiscardRef: Cell<((held: T | null) => boolean) | undefined>;
  /** Serialization of the last draft the server accepted — the no-op guard. */
  sentRef: Cell<string | null>;
  /** Serialization of the draft the server refused, so a NEW draft can retry. */
  refusedRef: Cell<string | null>;
  /** True while a checkpoint for this entity exists on the server. */
  serverHoldsRef: Cell<boolean>;
  /** True once this editor has held unsaved work in this session. */
  dirtySeenRef: Cell<boolean>;
  /** Serializes writes so two flush callers cannot race the same version. */
  queueRef: Cell<Promise<void>>;
  /** Mirrors "an unanswered offer / unresolved conflict / standing refusal". */
  blockedRef: Cell<boolean>;
  /**
   * Set when the server says this credential cannot own a draft (401/403 —
   * signed out, or a shared API key on a per-person route). Permanent for this
   * session and deliberately SILENT: it is the API behaving correctly, not a
   * problem with the draft, so it stops the loop without a banner.
   */
  unsupportedRef: Cell<boolean>;
  /** Guards the one-shot load, so a later record save cannot re-offer a draft. */
  loadedRef: Cell<boolean>;
}

/**
 * Declares the cells and refreshes the ones that mirror this render.
 *
 * `offer` / `conflict` / `refusal` are taken as the three answers a person can
 * still owe this client; only their presence matters here, which is why the
 * two drafts are accepted as plain objects rather than by their own types.
 */
export function useEditorCheckpointRefs<T>({
  content,
  onRestore,
  mergeWithHeld,
  canDiscardHeld,
  offer,
  conflict,
  refusal,
}: {
  content: T | null;
  onRestore: (content: T) => void;
  mergeWithHeld: ((held: T | null, draft: T) => T) | undefined;
  canDiscardHeld: ((held: T | null) => boolean) | undefined;
  offer: object | null;
  conflict: object | null;
  refusal: string | null;
}): EditorCheckpointRefs<T> {
  const liveRef = useRef(true);
  const versionRef = useRef(0);
  const heldRef = useRef<T | null>(null);
  const contentRef = useRef<T | null>(content);
  const onRestoreRef = useRef(onRestore);
  const mergeRef = useRef(mergeWithHeld);
  const canDiscardRef = useRef(canDiscardHeld);
  const sentRef = useRef<string | null>(null);
  const refusedRef = useRef<string | null>(null);
  const serverHoldsRef = useRef(false);
  const dirtySeenRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const blockedRef = useRef(false);
  const unsupportedRef = useRef(false);
  const loadedRef = useRef(false);

  const bundle = useRef<EditorCheckpointRefs<T> | null>(null);
  bundle.current ??= {
    liveRef,
    versionRef,
    heldRef,
    contentRef,
    onRestoreRef,
    mergeRef,
    canDiscardRef,
    sentRef,
    refusedRef,
    serverHoldsRef,
    dirtySeenRef,
    queueRef,
    blockedRef,
    unsupportedRef,
    loadedRef,
  };

  contentRef.current = content;
  onRestoreRef.current = onRestore;
  mergeRef.current = mergeWithHeld;
  canDiscardRef.current = canDiscardHeld;
  blockedRef.current =
    Boolean(offer) ||
    Boolean(conflict) ||
    refusal !== null ||
    unsupportedRef.current;
  if (content !== null) dirtySeenRef.current = true;

  return bundle.current;
}

/**
 * Everything a new entity starts from.
 *
 * Called from the effect declared before the load, so React runs it first on
 * mount and first on an entity change: everything is reset, THEN the load for
 * the new entity arms.
 */
export function resetCheckpointRefs<T>(refs: EditorCheckpointRefs<T>): void {
  refs.liveRef.current = true;
  refs.versionRef.current = 0;
  refs.heldRef.current = null;
  refs.sentRef.current = null;
  refs.refusedRef.current = null;
  refs.serverHoldsRef.current = false;
  refs.dirtySeenRef.current = false;
  refs.unsupportedRef.current = false;
  refs.loadedRef.current = false;
}

/**
 * The server no longer holds a draft for this entity: the five cells that
 * together mean "there is a checkpoint out there", cleared as one.
 *
 * Both callers — the auto-delete when the editor goes clean, and a dismiss —
 * reach this only after `mayDiscardHeld` has agreed. When it refuses, the
 * cells stay exactly as they are, because the server still holds the draft.
 */
export function forgetHeldCheckpoint<T>(refs: EditorCheckpointRefs<T>): void {
  refs.versionRef.current = 0;
  refs.heldRef.current = null;
  refs.serverHoldsRef.current = false;
  refs.sentRef.current = null;
  refs.dirtySeenRef.current = false;
}
