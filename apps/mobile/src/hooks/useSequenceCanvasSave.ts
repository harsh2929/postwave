/**
 * hooks/useSequenceCanvasSave.ts — the sequence-authoring persistence path,
 * lifted out of `app/(tabs)/sequences/[id].tsx`.
 *
 * LIVE since GATE#3 (2026-08-18): `MOBILE_SEQUENCE_AUTHORING_AVAILABLE` is true,
 * so edits made on the canvas reach the server through here. It also still does
 * the job it was kept for while the flag was false — validating and safely
 * replaying mutations queued by OLDER builds.
 *
 * TWO GATES, not one. The flag says whether this build ships authoring;
 * `stepsEditable` says whether the SERVER will accept a PATCH for this
 * particular row (only a `draft` — 409 otherwise). Both are checked before a
 * save is enqueued, and the second one matters most here rather than in the UI:
 * `save.mutate` writes to the offline queue, so a save that should never have
 * been offered survives an app restart and replays hours later.
 *
 * Moving it here does three things: the screen file drops back under its
 * source budget, the render ladder becomes the only thing left in it, and the
 * debounce/flush/version-chaining rules below live in one named place instead
 * of being interleaved with layout.
 *
 * One behaviour HAS changed since the move: `applyAndSave` no longer enqueues
 * a PATCH when the edit resolves to a wire tree the server already holds
 * (AUTOMATION#38 — see lib/sequenceWireDiff for the full argument, including
 * why the server's `ops` delta surface is deliberately not adopted here).
 *
 * Otherwise nothing changed in the move. In particular:
 *   - saves are debounced 600ms and the pending batch is FLUSHED on unmount,
 *     because `save.mutate()` is the only point that enqueues the offline-
 *     persistable mutation, so clearing the timer alone would drop an edit
 *     made inside the window and then abandoned via back-nav;
 *   - an authority error clears the held version so the next attempt fails
 *     closed rather than replaying against a version we no longer own.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/components/Toast";
import {
  canvasToWire,
  stepTypeLabel,
  type CanvasStep,
} from "@/components/sequence-builder/types";
import { haptics } from "@/lib/haptics";
import {
  executeSequenceSave,
  isSequenceSaveAuthorityError,
  newOfflineMutationMetadata,
  OFFLINE_MUTATION_KEYS,
  recordSequenceSaveFailure,
} from "@/lib/offlineMutations";
import { offlineSafeMutationMeta } from "@/lib/queryClient";
import { MOBILE_SEQUENCE_AUTHORING_AVAILABLE } from "@/lib/sequenceCapabilities";
import { sequenceSaveIsWorthSending } from "@/lib/sequenceWireDiff";

export interface SequenceCanvasSaveInput {
  id: string | undefined;
  tenantId: string | null;
  /**
   * The screen's composed authoring gate: the build ships the editor AND this
   * row's stored status is one the server will accept a PATCH for.
   *
   * Mirrored here rather than trusted from the caller's UI gating, because this
   * hook does not only run in response to a tap — the unmount flush and the
   * offline queue both replay through it. A save enqueued against a sequence
   * the server has since refused is a 409 nobody is watching for.
   */
  stepsEditable: boolean;
  steps: CanvasStep[];
  setSteps: (updater: (prev: CanvasStep[]) => CanvasStep[]) => void;
  /** Owned by the screen: the seeding effect and the id-change reset write it. */
  sequenceVersionRef: MutableRefObject<number | null>;
  activeSequenceIdRef: MutableRefObject<string>;
  saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingSaveRef: MutableRefObject<CanvasStep[] | null>;
  onEditRequested: (step: CanvasStep) => void;
  onEditCommitted: () => void;
}

export interface SequenceCanvasSave {
  onDeleteStep: (stepId: string) => void;
  onEditStep: (step: CanvasStep) => void;
  onSaveEdit: (next: CanvasStep) => void;
  onMoveStep: (stepId: string, direction: "up" | "down") => void;
}

export function useSequenceCanvasSave(
  input: SequenceCanvasSaveInput,
): SequenceCanvasSave {
  const {
    id,
    tenantId,
    stepsEditable,
    steps,
    setSteps,
    sequenceVersionRef,
    activeSequenceIdRef,
    saveTimerRef,
    pendingSaveRef,
    onEditRequested,
    onEditCommitted,
  } = input;
  const { toast } = useToast();
  const qc = useQueryClient();

  // Declared before the mutation so onError can offer a Retry that flushes
  // the same pending steps.
  const queueSaveRef = useRef<((next: CanvasStep[]) => void) | null>(null);
  const stepsRef = useRef<CanvasStep[]>(steps);
  stepsRef.current = steps;

  // mutationFn registered centrally (lib/offlineMutations) keyed by
  // sequenceSave; steps are serialized to wire form at mutate() time so a
  // queued-offline save survives an app restart and resumes on reconnect.
  const save = useMutation({
    mutationKey: OFFLINE_MUTATION_KEYS.sequenceSave,
    meta: offlineSafeMutationMeta,
    mutationFn: executeSequenceSave,
    onSuccess: (res, vars) => {
      if (
        activeSequenceIdRef.current !== vars.id ||
        String(res.data.id) !== vars.id ||
        res.data.version !== res.confirmedBaseVersion + 1
      )
        return;
      sequenceVersionRef.current = res.data.version;
      // Prefix match: the detail key also carries the identity and the
      // snapshot/network discriminator (hooks/useSequences).
      void qc.invalidateQueries({ queryKey: ["sequence", tenantId] });
      void qc.invalidateQueries({ queryKey: ["sequences"] });
    },
    onError: (err: unknown, vars) => {
      recordSequenceSaveFailure(vars, err);
      const authority = isSequenceSaveAuthorityError(err);
      if (authority) sequenceVersionRef.current = null;
      // A toast rather than an Alert: a failed save should offer the fix in
      // place, not steal focus and demand a tap to dismiss before the user
      // can even see the canvas they were editing.
      toast({
        kind: "error",
        message: authority
          ? "This draft moved on. Reload the latest version before saving."
          : err instanceof Error
            ? err.message
            : "Couldn't save this sequence.",
        ...(authority
          ? {}
          : {
              action: {
                label: "Retry",
                onPress: () => queueSaveRef.current?.(stepsRef.current),
              },
            }),
      });
    },
  });

  // Debounce saves so a fast edit burst doesn't flood the gateway.
  const queueSave = useCallback(
    (next: CanvasStep[]) => {
      if (!MOBILE_SEQUENCE_AUTHORING_AVAILABLE) return;
      // The server's own rule, mirrored: only a DRAFT is editable
      // (services/voice/internal/handlers/sequences.go:892-895 answers 409
      // otherwise). Refusing to ENQUEUE is what matters — `save.mutate` writes
      // to the offline queue, so a save accepted here against an archived or
      // paused row would survive a restart and replay into a 409 hours later,
      // with the toast that explains it landing on a screen nobody is looking
      // at.
      if (!stepsEditable) return;
      pendingSaveRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        pendingSaveRef.current = null;
        save.mutate({
          ...newOfflineMutationMetadata(),
          id: id ?? "",
          baseVersion: sequenceVersionRef.current ?? 0,
          steps: canvasToWire(next),
        });
      }, 600);
    },
    [save, id, stepsEditable, pendingSaveRef, saveTimerRef, sequenceVersionRef],
  );
  queueSaveRef.current = queueSave;

  // Keep the latest mutate fn + id in refs so the []-deps unmount cleanup can
  // flush without a stale closure (and without re-running — and thus
  // flushing — on every save/id change).
  const saveMutateRef = useRef(save.mutate);
  saveMutateRef.current = save.mutate;
  const idRef = useRef(id);
  idRef.current = id;
  const flushRefs = useRef({
    saveTimerRef,
    pendingSaveRef,
    sequenceVersionRef,
  });
  flushRefs.current = { saveTimerRef, pendingSaveRef, sequenceVersionRef };

  useEffect(
    () => () => {
      const { saveTimerRef: timer, pendingSaveRef: pendingRef, sequenceVersionRef: versionRef } =
        flushRefs.current;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const pending = pendingRef.current;
      if (pending) {
        pendingRef.current = null;
        saveMutateRef.current({
          ...newOfflineMutationMetadata(),
          id: idRef.current ?? "",
          baseVersion: versionRef.current ?? 0,
          steps: canvasToWire(pending),
        });
      }
    },
    [],
  );

  const applyAndSave = useCallback(
    (mutator: (prev: CanvasStep[]) => CanvasStep[]) => {
      setSteps((prev) => {
        const next = mutator(prev).map((s, i) => ({ ...s, position: i }));
        // Only spend a round trip when the SERVER would see a difference.
        // Several canvas actions legitimately resolve to no change — moving
        // the first step "up" returns the list untouched, and dismissing the
        // editor sheet re-commits an unedited step — and the handler answers
        // those 400 "patch does not change the sequence"
        // (services/voice/internal/handlers/sequences.go:986), which arrives
        // here as an error toast offering to Retry a save that is guaranteed
        // to fail again. See lib/sequenceWireDiff for why this, rather than
        // the server's `ops` delta surface, is the sound way to stop wasting
        // the wire from a queued-and-replayed client (AUTOMATION#38).
        if (!sequenceSaveIsWorthSending(canvasToWire(prev), canvasToWire(next))) {
          // Still return `next`: the position re-index is a local
          // normalisation the canvas relies on, and suppressing the PATCH is
          // the only behaviour being changed here.
          return next;
        }
        queueSave(next);
        return next;
      });
    },
    [queueSave, setSteps],
  );

  // Reversible removal: a destructive action paired with a 6-second undo is
  // strictly better than a pre-confirm — the common case costs zero taps and
  // the misfire costs one. Only reachable when the canvas is editable, which
  // is where the two gates above are enforced.
  const onDeleteStep = useCallback(
    (stepId: string) => {
      const previous = stepsRef.current;
      const target = previous.find((s) => s.id === stepId);
      if (!target) return;
      haptics.warning();
      applyAndSave((prev) => prev.filter((s) => s.id !== stepId));
      toast({
        kind: "info",
        message: `Removed the ${stepTypeLabel(target.type)} step.`,
        action: {
          label: "Undo",
          onPress: () => applyAndSave(() => previous),
        },
      });
    },
    [applyAndSave, toast],
  );

  const onSaveEdit = useCallback(
    (next: CanvasStep) => {
      applyAndSave((prev) => prev.map((s) => (s.id === next.id ? next : s)));
      onEditCommitted();
    },
    [applyAndSave, onEditCommitted],
  );

  const onMoveStep = useCallback(
    (stepId: string, direction: "up" | "down") => {
      applyAndSave((prev) => {
        const idx = prev.findIndex((s) => s.id === stepId);
        if (idx === -1) return prev;
        const nextIdx = direction === "up" ? idx - 1 : idx + 1;
        if (nextIdx < 0 || nextIdx >= prev.length) return prev;
        const next = prev.slice();
        const current = next[idx];
        const target = next[nextIdx];
        if (!current || !target) return prev;
        next[idx] = target;
        next[nextIdx] = current;
        return next.map((s, i) => ({ ...s, position: i }));
      });
    },
    [applyAndSave],
  );

  return { onDeleteStep, onEditStep: onEditRequested, onSaveEdit, onMoveStep };
}
