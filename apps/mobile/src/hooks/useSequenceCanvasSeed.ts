/**
 * hooks/useSequenceCanvasSeed.ts — the two effects that decide WHEN the
 * sequence canvas may be (re)populated from a fetched detail, lifted out of
 * `app/(tabs)/sequences/[id].tsx` alongside its sibling
 * `useSequenceCanvasSave`.
 *
 * These belong together and away from layout because both encode the same
 * non-obvious rule, and getting either wrong silently destroys user edits:
 *
 *  - SEED EXACTLY ONCE PER SEQUENCE ID. After first load the canvas is the
 *    source of truth. Re-seeding on every `detail` change would clobber
 *    in-progress edits each time our own save's onSuccess invalidation
 *    triggered a refetch — server-assigned step ids don't match client ids,
 *    so the whole canvas remounts and anything typed during the save/refetch
 *    window is lost.
 *  - RESET WHEN THE ROUTE ID CHANGES. Expo Router reuses the mounted screen
 *    for a sibling route, so without an explicit reset the next sequence
 *    would inherit the previous one's steps, name, open editor and — worst —
 *    its `version`, which is the If-Match token guarding writes. A stale
 *    version is mutation authority over a document the user is no longer
 *    looking at, so it is cleared before anything else.
 *
 * The version is accepted through `acceptFetchedSequenceVersion`, which is
 * scoped to the current offline auth identity. If that throws, the version is
 * left null: the save path fails closed rather than manufacturing authority
 * for an identity that is no longer present. Offline projections deliberately
 * carry no version, so they seed a readable canvas that cannot be saved.
 */
import { useEffect, type MutableRefObject } from "react";

import {
  wireToCanvas,
  type CanvasStep,
} from "@/components/sequence-builder/types";
import {
  acceptFetchedSequenceVersion,
  currentOfflineAuthScope,
} from "@/lib/offlineMutations";
import {
  fetchedSequenceVersion,
  seedableSteps,
  type SeedableSequenceDetail as PolicySeedableDetail,
} from "@/lib/sequenceSeedPolicy";

/**
 * The decoder's own input element type. `wireToCanvas` does not export it, so
 * it is recovered from the signature — that keeps this hook honest if the
 * decoder ever widens or narrows what it accepts.
 */
type WireStep = NonNullable<Parameters<typeof wireToCanvas>[0]>[number];

/** The fetched detail, narrowed to what seeding actually reads. */
export type SeedableSequenceDetail = PolicySeedableDetail<WireStep>;

export interface SequenceCanvasSeedInput {
  /** Route param; may be undefined on a malformed deep link. */
  id: string | undefined;
  /** The fetched detail, or null while loading / on a failure. */
  detail: SeedableSequenceDetail | null | undefined;
  setSteps: (steps: CanvasStep[]) => void;
  setName: (name: string) => void;
  setEditing: (step: CanvasStep | null) => void;
  setEditorOpen: (open: boolean) => void;
  sequenceVersionRef: MutableRefObject<number | null>;
  activeSequenceIdRef: MutableRefObject<string>;
  saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingSaveRef: MutableRefObject<CanvasStep[] | null>;
  /** Guards the once-per-id rule; owned by the screen so it survives renders. */
  seededForRef: MutableRefObject<string | null>;
}

export function useSequenceCanvasSeed({
  id,
  detail,
  setSteps,
  setName,
  setEditing,
  setEditorOpen,
  sequenceVersionRef,
  activeSequenceIdRef,
  saveTimerRef,
  pendingSaveRef,
  seededForRef,
}: SequenceCanvasSeedInput): void {
  // Route change → drop everything belonging to the previous sequence,
  // including any debounced save still holding its steps.
  useEffect(() => {
    const nextId = id ?? "";
    if (activeSequenceIdRef.current === nextId) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
    activeSequenceIdRef.current = nextId;
    seededForRef.current = null;
    sequenceVersionRef.current = null;
    setSteps([]);
    setName("");
    setEditing(null);
    setEditorOpen(false);
  }, [
    id,
    activeSequenceIdRef,
    saveTimerRef,
    pendingSaveRef,
    seededForRef,
    sequenceVersionRef,
    setSteps,
    setName,
    setEditing,
    setEditorOpen,
  ]);

  // First readable detail for THIS id → seed once.
  useEffect(() => {
    const current = id ?? "";
    if (!detail || detail.id !== current) return;
    if (seededForRef.current === current) return;
    seededForRef.current = current;

    setName(detail.name ?? "Untitled sequence");

    const version = fetchedSequenceVersion(detail);
    sequenceVersionRef.current = version;
    if (version !== null) {
      try {
        acceptFetchedSequenceVersion(currentOfflineAuthScope(), current, version);
      } catch {
        // The online-query identity gate owns the visible auth error. Never
        // manufacture mutation authority when the current identity is absent.
        sequenceVersionRef.current = null;
      }
    }

    setSteps(wireToCanvas(seedableSteps(detail)));
  }, [detail, id, seededForRef, sequenceVersionRef, setName, setSteps]);
}
