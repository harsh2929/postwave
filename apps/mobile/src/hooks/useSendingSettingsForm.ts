/**
 * hooks/useSendingSettingsForm — the controller behind app/(tabs)/sending-settings.
 *
 * Extracted because the screen's surface function had grown to 642 lines at
 * cyclomatic complexity 48, against a recorded ratchet of 397/30. An earlier
 * extraction in this repo shrank the FILE (1026 -> 750 lines) by moving the
 * read-only summary and the form primitives out, but left every piece of
 * controller logic inside the component, so the function-level debt got worse
 * while the file-level number improved.
 *
 * The split follows the house shape (see useDashboardScreen, useAuditScreen,
 * useDiscountsScreen): all state, refs, effects and write callbacks live here;
 * the screen renders what this returns and owns nothing but layout.
 *
 * The form and its compare-and-set revision are accepted as one baseline. A
 * background refetch can therefore never pair an R1 draft with an R2 token:
 * clean forms adopt the new baseline, while dirty forms pause for an explicit
 * rebase.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextInput } from "react-native";
import { useIsFocused } from "expo-router";

import { useToast } from "@/components/Toast";
import {
  useSendingWrites,
  type ReconciliationHold,
} from "@/hooks/useSendingWrites";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useSendingSettings,
  useSendingStatus,
  useUpdateSendingSettings,
  type SendingSettingsRow,
} from "@/hooks/useSendingOps";
import { haptics } from "@/lib/haptics";
import {
  deviceTimezone,
  dstWarning,
  firstSendingError,
  isThrottleConfigured,
  savedAtValue,
  sendingFormDirty,
  sendingFormFromRow,
  sendingSettingsExpectedRevision,
  sendingStatusReason,
  validateSendingForm,
  type SendingFormState,
} from "@/lib/sendingForm";

interface AppliedSendingBaseline {
  form: SendingFormState;
  revision: string | null;
  row: SendingSettingsRow | undefined;
}

function baselineFromRow(
  row: SendingSettingsRow | undefined,
): AppliedSendingBaseline {
  return {
    form: sendingFormFromRow(row),
    revision: sendingSettingsExpectedRevision(row?.updated_at),
    row,
  };
}

function sameBaseline(
  left: AppliedSendingBaseline,
  right: AppliedSendingBaseline,
): boolean {
  return (
    left.revision === right.revision && !sendingFormDirty(left.form, right.form)
  );
}

export function useSendingSettingsForm() {
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const now = useNowTicker();
  useScreenViewed("sending-settings");

  // Expo Router keeps this hidden tab mounted after a visit; the status poll
  // follows focus so a blurred screen stops asking (useSendingOps.ts).
  const focused = useIsFocused();
  const settings = useSendingSettings();
  const status = useSendingStatus({ focused });
  const update = useUpdateSendingSettings();
  const refresh = useManualRefresh([settings.refetch, status.refetch]);

  const loadedRow = settings.data?.value;
  const loadedBaseline = useMemo(() => baselineFromRow(loadedRow), [loadedRow]);

  const [appliedBaseline, setAppliedBaseline] =
    useState<AppliedSendingBaseline>(loadedBaseline);
  const appliedBaselineRef = useRef(appliedBaseline);
  const processedLoadedRowRef = useRef(loadedRow);
  const [remoteBaseline, setRemoteBaseline] =
    useState<AppliedSendingBaseline | null>(null);
  const [form, setForm] = useState<SendingFormState>(loadedBaseline.form);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [reconciliationHold, setReconciliationHold] =
    useState<ReconciliationHold | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const commitAppliedBaseline = useCallback((next: AppliedSendingBaseline) => {
    appliedBaselineRef.current = next;
    setAppliedBaseline(next);
  }, []);

  // A reconnect can produce a new query row while an operator is editing.
  // Compare the whole accepted baseline, including its revision. Updating only
  // the token would let an R1 draft overwrite R2 without a conflict.
  useEffect(() => {
    if (!loadedRow || loadedRow === processedLoadedRowRef.current) return;
    if (reconciliationHold) return;

    processedLoadedRowRef.current = loadedRow;
    const currentForm = formRef.current;
    const applied = appliedBaselineRef.current;

    if (sameBaseline(applied, loadedBaseline)) {
      // Ancillary read-only fields (for example the IP pool) may still have
      // changed, so retain the newest complete row without touching the draft.
      commitAppliedBaseline(loadedBaseline);
      setRemoteBaseline(null);
      return;
    }

    if (
      !sendingFormDirty(currentForm, applied.form) ||
      !sendingFormDirty(currentForm, loadedBaseline.form)
    ) {
      commitAppliedBaseline(loadedBaseline);
      setForm(loadedBaseline.form);
      setRemoteBaseline(null);
      return;
    }

    setRemoteBaseline(loadedBaseline);
  }, [commitAppliedBaseline, loadedBaseline, loadedRow, reconciliationHold]);

  const acceptSettingsRow = useCallback(
    (settingsRow: SendingSettingsRow): SendingFormState => {
      const next = baselineFromRow(settingsRow);
      // The query may still contain the pre-mutation row until invalidation
      // completes. Mark it observed so clearing a reconciliation hold cannot
      // roll the just-accepted mutation back to that stale row.
      processedLoadedRowRef.current = loadedRow;
      commitAppliedBaseline(next);
      setRemoteBaseline(null);
      return next.form;
    },
    [commitAppliedBaseline, loadedRow],
  );

  const adoptRemoteBaseline = useCallback(() => {
    if (!remoteBaseline) return;
    processedLoadedRowRef.current = remoteBaseline.row;
    commitAppliedBaseline(remoteBaseline);
    setForm(remoteBaseline.form);
    setMutationError(null);
    setRemoteBaseline(null);
    haptics.tap();
    toast({ kind: "info", message: "Current server settings loaded" });
  }, [commitAppliedBaseline, remoteBaseline, toast]);

  const endRef = useRef<TextInput>(null);
  const tzRef = useRef<TextInput>(null);

  const dirty = sendingFormDirty(form, appliedBaseline.form);
  const fieldErrors = validateSendingForm(form);
  const firstError = firstSendingError(fieldErrors);
  const hasError = firstError != null;
  const savedAt = savedAtValue(appliedBaseline.row?.updated_at);
  const expectedRevision = appliedBaseline.revision;
  const configured = isThrottleConfigured(appliedBaseline.row);
  const dst = dstWarning(form.quietTz);
  const deviceTz = deviceTimezone();
  const busy = update.isPending || reconciling;
  const settingsStale = settings.isError && Boolean(appliedBaseline.row);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const statusReason = sendingStatusReason({
    online: gate.enabled,
    failed: status.isError,
  });

  const {
    reconcilePending,
    adoptCurrentServerVersion,
    onSave,
    onClear,
    onBack,
  } = useSendingWrites({
    form,
    setForm,
    formRef,
    mountedRef,
    acceptSettingsRow,
    expectedRevision,
    hasError,
    firstError,
    busy,
    settingsStale,
    dirty,
    remoteBaselineChanged: remoteBaseline !== null,
    reconciliationHold,
    setReconciliationHold,
    setMutationError,
    setReconciling,
    settings,
    status,
    update,
  });
  const loading = settings.isLoading && !appliedBaseline.row;
  const settingsUnavailableOffline =
    !gate.enabled && !gate.canReadOfflineSnapshots && !appliedBaseline.row;
  const failed =
    (settings.isError || settingsUnavailableOffline) && !appliedBaseline.row;
  return {
    now,
    settings,
    status,
    refresh,
    row: appliedBaseline.row,
    initial: appliedBaseline.form,
    form,
    setForm,
    mutationError,
    reconciliationHold,
    remoteBaselineChanged: remoteBaseline !== null,
    adoptRemoteBaseline,
    reconciling,
    endRef,
    tzRef,
    dirty,
    fieldErrors,
    hasError,
    savedAt,
    expectedRevision,
    configured,
    dst,
    deviceTz,
    busy,
    settingsStale,
    reconcilePending,
    adoptCurrentServerVersion,
    statusReason,
    onSave,
    onClear,
    onBack,
    loading,
    failed,
    settingsUnavailableOffline,
  };
}
