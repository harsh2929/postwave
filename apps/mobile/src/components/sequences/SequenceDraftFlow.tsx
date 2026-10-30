/**
 * SequenceDraftFlow — brief → model → review → saved draft, as one act.
 *
 * Holds the whole of AUTOMATION#15 that is not policy (lib/sequenceDraft) or
 * chrome (the two sheets). It exists as its own component so the list screen
 * stays a list screen: the only thing `sequences/index.tsx` knows about
 * drafting is when to make it visible and what to do with the id that comes
 * back.
 *
 * WHY THE DRAFT LIVES IN COMPONENT STATE AND NOT IN THE QUERY CACHE. The
 * drafting endpoint persists nothing, so there is no server object to key a
 * query on and nothing to refetch — a cached "draft" would be a client-side
 * fiction that survives sign-out. It is deliberately lost when this flow
 * closes, and the Discard confirm is what makes that loss a decision rather
 * than an accident (it cost the workspace a metered AI request).
 *
 * TWO MUTATIONS, TWO FAILURE VOCABULARIES. Generation fails in the model's
 * terms (quota, not configured, nothing usable came back) and saving fails in
 * the sequence API's (role, endpoint, validation). They map through
 * `sequenceDraftErrorMessage` and `sequenceCreateErrorMessage` respectively —
 * sharing one mapper would put "the model couldn't produce a usable sequence"
 * in front of someone whose ROLE was refused.
 *
 * NEITHER IS OFFLINE-QUEUED. `OFFLINE_MUTATION_KEYS.sequenceCreate` is for the
 * blank create sheet, whose payload is a name. Replaying a save of drafted
 * emails hours later, after the review sheet is long gone, would resurrect
 * content the operator may have decided against — so this save is online-only
 * and the affordance is hidden when the gate is closed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { SequenceDraftReview } from "@/components/sequences/SequenceDraftReview";
import { SequenceDraftSheet } from "@/components/sequences/SequenceDraftSheet";
import { draftSequenceFromBrief } from "@/api/sequenceDraft";
import { createSequence } from "@/api/sequences";
import { haptics } from "@/lib/haptics";
import { newOfflineOperationId } from "@/lib/offlineMutations";
import { sequenceCreateErrorMessage } from "@/lib/sequenceCreate";
import {
  normalizeSequenceDraft,
  sequenceDraftErrorMessage,
  type SequenceDraftEmail,
  type SequenceDraftPlan,
} from "@/lib/sequenceDraft";
import { draftEmailsToWireSteps } from "@/lib/sequenceDraftSave";

export interface SequenceDraftFlowProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the new sequence's id once the server has confirmed one. */
  onCreated: (id: string) => void;
}

/** An API failure carried across a mutation boundary with its status and
 *  machine code intact — `Error` alone would collapse a quota refusal and a
 *  role refusal into the same 429/403-less sentence. */
class DraftRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string | undefined) {
    super(message);
    this.name = "DraftRequestError";
    this.status = status;
    this.code = code;
  }
}

function statusOf(error: unknown): number {
  return error instanceof DraftRequestError ? error.status : 0;
}
function codeOf(error: unknown): string | undefined {
  return error instanceof DraftRequestError ? error.code : undefined;
}
function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function SequenceDraftFlow({
  visible,
  onClose,
  onCreated,
}: SequenceDraftFlowProps) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<SequenceDraftPlan | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Cancels an in-flight generation when the operator leaves. The request is
  // metered, so this does not un-spend it — but it does stop a draft arriving
  // into a sheet nobody is looking at.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (visible) return;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [visible]);

  const reset = useCallback(() => {
    setPlan(null);
    setDraftError(null);
    setSaveError(null);
  }, []);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    reset();
    onClose();
  }, [onClose, reset]);

  const draft = useMutation({
    mutationFn: async (input: {
      brief: string;
      stepCount: number;
      tone: string;
    }): Promise<SequenceDraftPlan> => {
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await draftSequenceFromBrief(
        {
          brief: input.brief,
          stepCount: input.stepCount,
          ...(input.tone ? { tone: input.tone } : {}),
        },
        { signal: controller.signal },
      );
      if (result.error) {
        throw new DraftRequestError(
          result.error.status,
          result.error.message,
          result.error.code,
        );
      }
      const normalized = normalizeSequenceDraft(result.data);
      if (!normalized) {
        // A 200 whose body has no usable step. Reported as the model failing,
        // which is what it is — never as an empty success.
        throw new DraftRequestError(
          502,
          "The model returned no usable emails.",
        );
      }
      return normalized;
    },
    onSuccess: (result) => {
      haptics.success();
      setDraftError(null);
      setPlan(result);
    },
    onError: (error: unknown) => {
      haptics.error();
      setDraftError(
        sequenceDraftErrorMessage(
          statusOf(error),
          messageOf(error),
          codeOf(error),
        ),
      );
    },
  });

  const save = useMutation({
    mutationFn: async (input: {
      name: string;
      emails: readonly SequenceDraftEmail[];
    }): Promise<string | null> => {
      const result = await createSequence(
        { name: input.name, steps: draftEmailsToWireSteps(input.emails) },
        // A save retried after a dropped response must not create the same
        // sequence twice; the drafted emails are identical on both attempts,
        // so only the key can tell the server they are one write.
        { idempotencyKey: newOfflineOperationId() },
      );
      if (result.error) {
        throw new DraftRequestError(
          result.error.status,
          result.error.message,
          result.error.code,
        );
      }
      const id = result.data?.id;
      return typeof id === "string" && id.trim() ? id : null;
    },
    onSuccess: (id) => {
      haptics.success();
      void qc.invalidateQueries({ queryKey: ["sequences"] });
      toast({
        kind: "success",
        message: "Saved as a draft. Nothing is scheduled or sending.",
      });
      close();
      if (id) onCreated(id);
    },
    onError: (error: unknown) => {
      haptics.error();
      setSaveError(
        sequenceCreateErrorMessage(statusOf(error), messageOf(error)),
      );
    },
  });

  const discard = useCallback(() => {
    if (save.isPending) return;
    void (async () => {
      const confirmed = await confirm({
        title: "Discard this draft?",
        message:
          "The emails the model wrote are not saved anywhere. Drafting again spends another AI request.",
        confirmLabel: "Discard",
        cancelLabel: "Keep reviewing",
        destructive: true,
      });
      if (confirmed) close();
    })();
  }, [close, confirm, save.isPending]);

  const reviewing = visible && plan !== null;

  return (
    <>
      <SequenceDraftSheet
        visible={visible && plan === null}
        onClose={close}
        busy={draft.isPending}
        error={draftError}
        onGenerate={(input) => {
          setDraftError(null);
          draft.mutate(input);
        }}
      />
      <SequenceDraftReview
        visible={reviewing}
        plan={plan}
        saving={save.isPending}
        error={saveError}
        onDiscard={discard}
        onSave={(input) => {
          setSaveError(null);
          save.mutate(input);
        }}
      />
    </>
  );
}
