/**
 * hooks/useSendingWrites — the write half of the sending-settings controller.
 *
 * Split out of useSendingSettingsForm because that hook's own function had
 * grown past the 300-line ceiling once the screen's logic moved into it. The
 * seam is real rather than arbitrary: everything here either performs a
 * revision-fenced write or reconciles one whose outcome the app does not know.
 *
 * The dependency list is long and deliberately explicit. These callbacks need
 * the form, its baseline refs and the mount guard, because the invariants they
 * protect are not local:
 *   - every write carries the revision accepted with its form baseline, so an
 *     R1 draft can never be submitted with an R2 token;
 *   - a result is only adopted when the submission still matches the form the
 *     operator submitted, so a late reply cannot clobber newer typing;
 *   - nothing touches state after unmount, so a slow reply on a screen the
 *     user has left cannot resurrect it.
 */
import { useCallback } from "react";
import type { MutableRefObject } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  CLEARED_SENDING_SETTINGS,
  type SendingSettingsMutationResult,
  type SendingSettingsRow,
  type SendingSettingsWriteInput,
} from "@/hooks/useSendingOps";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { haptics } from "@/lib/haptics";
import { goBackOrMore } from "@/lib/nav";
import { sendingFormFromRow, type SendingFormState } from "@/lib/sendingForm";

export interface ReconciliationHold {
  kind: "save" | "clear";
  input: SendingSettingsWriteInput;
  submitted: SendingFormState;
  message: string;
  currentSettings?: SendingSettingsRow;
  mutationDispatchedAt?: number;
}

interface SendingWritesInput {
  form: SendingFormState;
  setForm: (next: SendingFormState) => void;
  formRef: MutableRefObject<SendingFormState>;
  mountedRef: MutableRefObject<boolean>;
  acceptSettingsRow: (row: SendingSettingsRow) => SendingFormState;
  expectedRevision: string | null;
  hasError: boolean;
  firstError: string | null;
  busy: boolean;
  settingsStale: boolean;
  dirty: boolean;
  remoteBaselineChanged: boolean;
  reconciliationHold: ReconciliationHold | null;
  setReconciliationHold: (next: ReconciliationHold | null) => void;
  setMutationError: (next: string | null) => void;
  setReconciling: (next: boolean) => void;
  settings: { refetch: () => Promise<unknown> };
  status: { refetch: () => Promise<unknown> };
  update: {
    isPending: boolean;
    mutateAsync: (
      input: SendingSettingsWriteInput,
    ) => Promise<SendingSettingsMutationResult>;
    reconcileAsync: (
      input: SendingSettingsWriteInput,
      mutationDispatchedAt?: number,
    ) => Promise<SendingSettingsMutationResult>;
  };
}

function mutationIsBlocked(
  deps: Pick<
    SendingWritesInput,
    "busy" | "settingsStale" | "reconciliationHold" | "remoteBaselineChanged"
  >,
): boolean {
  return (
    deps.busy ||
    deps.settingsStale ||
    deps.reconciliationHold !== null ||
    deps.remoteBaselineChanged
  );
}

export function useSendingWrites(deps: SendingWritesInput) {
  const {
    form,
    setForm,
    formRef,
    mountedRef,
    acceptSettingsRow,
    expectedRevision,
    hasError,
    firstError,
    busy,
    dirty,
    reconciliationHold,
    setReconciliationHold,
    setMutationError,
    setReconciling,
    settings,
    status,
    update,
  } = deps;
  const { toast } = useToast();
  const confirm = useConfirm();
  const mutationBlocked = mutationIsBlocked(deps);

  const adoptMutationSettings = useCallback(
    (settingsRow: SendingSettingsRow, submission: ReconciliationHold) => {
      const next = acceptSettingsRow(settingsRow);
      if (
        submission.kind === "clear" ||
        formRef.current === submission.submitted
      ) {
        setForm(next);
      }
      setMutationError(null);
      setReconciliationHold(null);
      haptics.success();
      toast({
        kind: "success",
        message:
          submission.kind === "clear"
            ? "Workspace limits removed and verified"
            : "Sending settings saved and verified",
      });
      void Promise.all([settings.refetch(), status.refetch()]);
    },
    [
      acceptSettingsRow,
      formRef,
      setForm,
      setMutationError,
      setReconciliationHold,
      settings,
      status,
      toast,
    ],
  );

  const handleMutationResult = useCallback(
    (result: SendingSettingsMutationResult, submission: ReconciliationHold) => {
      if (result.kind === "applied") {
        adoptMutationSettings(result.settings, submission);
        return;
      }
      if (result.kind === "not-applied") {
        setReconciliationHold(null);
        setMutationError(result.message);
      } else {
        setReconciliationHold({
          ...submission,
          message: result.message,
          ...(result.kind === "pending" &&
          Number.isFinite(result.mutationDispatchedAt)
            ? { mutationDispatchedAt: result.mutationDispatchedAt }
            : {}),
          ...(result.kind === "conflict"
            ? { currentSettings: result.settings }
            : {}),
        });
        setMutationError(result.message);
      }
      haptics.error();
      toast({ kind: "error", message: result.message });
    },
    [adoptMutationSettings, setMutationError, setReconciliationHold, toast],
  );

  const reconcilePending = useCallback(async () => {
    const submission = reconciliationHold;
    if (!submission || busy) return;
    setReconciling(true);
    setMutationError(null);
    try {
      const result = await update.reconcileAsync(
        submission.input,
        submission.mutationDispatchedAt,
      );
      if (mountedRef.current) handleMutationResult(result, submission);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = writeFailureMessage(
        error,
        "The outcome is still unknown. Restore connectivity and refresh again before retrying.",
      );
      setMutationError(message);
      setReconciliationHold({ ...submission, message });
      haptics.error();
      toast({ kind: "error", message });
    } finally {
      if (mountedRef.current) setReconciling(false);
    }
  }, [
    busy,
    handleMutationResult,
    mountedRef,
    reconciliationHold,
    setMutationError,
    setReconciling,
    setReconciliationHold,
    toast,
    update,
  ]);

  const adoptCurrentServerVersion = useCallback(() => {
    const current = reconciliationHold?.currentSettings;
    if (!current) return;
    const next = acceptSettingsRow(current);
    setForm(next);
    setMutationError(null);
    setReconciliationHold(null);
    toast({ kind: "info", message: "Current server settings loaded" });
    void Promise.all([settings.refetch(), status.refetch()]);
  }, [
    acceptSettingsRow,
    reconciliationHold,
    setForm,
    setMutationError,
    setReconciliationHold,
    settings,
    status,
    toast,
  ]);

  const onSave = useCallback(() => {
    if (hasError) {
      haptics.error();
      toast({
        kind: "error",
        message: firstError ?? "Fix the highlighted fields.",
      });
      return;
    }
    if (mutationBlocked) return;
    if (expectedRevision === null) {
      haptics.error();
      toast({
        kind: "error",
        message:
          "The exact settings revision is unavailable. Refresh before saving so an older view cannot overwrite a newer policy.",
      });
      return;
    }
    const trimmedMax = form.maxSendsPerHour.trim();
    const input: SendingSettingsWriteInput = {
      max_sends_per_hour: trimmedMax === "" ? null : Number(trimmedMax),
      quiet_hours_start: form.quietStart.trim(),
      quiet_hours_end: form.quietEnd.trim(),
      quiet_hours_tz: form.quietTz.trim(),
      quiet_hours_per_recipient: form.perRecipient,
      expected_updated_at: expectedRevision,
    };
    const submission: ReconciliationHold = {
      kind: "save",
      input,
      submitted: form,
      message: "",
    };
    setMutationError(null);
    update
      .mutateAsync(input)
      .then((result) => {
        if (!mountedRef.current) return;
        handleMutationResult(result, submission);
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        const message = writeFailureMessage(
          e,
          "Couldn't save sending settings.",
        );
        setMutationError(message);
        haptics.error();
        toast({ kind: "error", message });
      });
  }, [
    expectedRevision,
    firstError,
    form,
    handleMutationResult,
    hasError,
    mountedRef,
    mutationBlocked,
    setMutationError,
    toast,
    update,
  ]);

  const onClear = useCallback(async () => {
    if (mutationBlocked) return;
    if (expectedRevision === null) {
      haptics.error();
      toast({
        kind: "error",
        message:
          "The exact settings revision is unavailable. Refresh before removing workspace limits.",
      });
      return;
    }
    // Removing every throttle is not a typo-recoverable edit: it takes effect
    // on the next batch, so it earns a confirmation rather than an undo toast.
    const ok = await confirm({
      title: "Remove workspace limits?",
      message:
        "The workspace hourly cap and quiet hours will both be cleared. Provider, quota, and safety controls still apply.",
      confirmLabel: "Remove",
      destructive: true,
      consequence:
        "These workspace settings will no longer hold new sends, and recipients can receive mail at any hour, including overnight in their timezone.",
    });
    if (!ok || !mountedRef.current) return;
    const input: SendingSettingsWriteInput = {
      ...CLEARED_SENDING_SETTINGS,
      expected_updated_at: expectedRevision,
    };
    const submission: ReconciliationHold = {
      kind: "clear",
      input,
      submitted: sendingFormFromRow(input),
      message: "",
    };
    setMutationError(null);
    update
      .mutateAsync(input)
      .then((result) => {
        if (!mountedRef.current) return;
        handleMutationResult(result, submission);
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        const message = writeFailureMessage(e, "Couldn't clear the throttles.");
        setMutationError(message);
        haptics.error();
        toast({ kind: "error", message });
      });
  }, [
    confirm,
    expectedRevision,
    handleMutationResult,
    mountedRef,
    mutationBlocked,
    setMutationError,
    toast,
    update,
  ]);

  const onBack = useCallback(async () => {
    if (reconciliationHold) {
      haptics.error();
      toast({
        kind: "error",
        message:
          "Refresh and reconcile this settings request before leaving the workspace.",
      });
      return;
    }
    if (!dirty) {
      goBackOrMore();
      return;
    }
    const leave = await confirm({
      title: "Discard your changes?",
      message: "Your edits to the sending throttles haven't been saved.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (leave) goBackOrMore();
  }, [confirm, dirty, reconciliationHold, toast]);

  return {
    reconcilePending,
    adoptCurrentServerVersion,
    onSave,
    onClear,
    onBack,
  };
}
