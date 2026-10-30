/**
 * Exact-admin state machine for the private SMS suppression roster.
 *
 * Keeping the verified read and its writes together matters: manual changes
 * are available only from a fresh, exact-phone response for the current SMS
 * identity. The ref-backed lock also covers confirmation, so repeated presses
 * cannot race two owner/admin reauthorizations before React paints `writeBusy`.
 */
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSmsInboxAccess } from "@/hooks/useSmsInbox";
import {
  useAddSmsSuppression,
  useRemoveSmsSuppression,
  useSmsSuppressions,
} from "@/hooks/useSuppressionOps";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  releaseSmsSuppressionWrite,
  tryAcquireSmsSuppressionWrite,
} from "@/lib/smsSuppressionWriteLock";
import {
  formatE164,
  isReversibleManualSmsSuppression,
  mergeSmsSuppressionPages,
  normalizeSmsSuppressionSearch,
  type SmsSuppression,
} from "@/lib/suppressionContracts";
import { useAuthStore } from "@/store/auth";

export function useSmsSuppressionRoster() {
  const focused = useIsFocused();
  const access = useSmsInboxAccess(focused);
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const mode = useAuthStore((state) => state.mode);
  const [q, setQ] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);
  const writeBusyRef = useRef(false);

  const searchPhone = normalizeSmsSuppressionSearch(q);
  const listAccess = useMemo(
    () => ({
      ...access,
      canRequest: access.canRequest && searchPhone !== null,
    }),
    [access, searchPhone],
  );
  const list = useSmsSuppressions(
    listAccess,
    searchPhone && searchPhone.length > 0 ? searchPhone : undefined,
  );
  const remove = useRemoveSmsSuppression();
  const addHold = useAddSmsSuppression();
  const canWrite =
    access.roleAllowed &&
    canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const merged = useMemo(() => {
    try {
      const pages = Array.isArray(list.data?.pages) ? list.data.pages : [];
      return { value: mergeSmsSuppressionPages(pages), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [list.data?.pages]);
  const loaded = list.isSuccess && Boolean(merged.value) && !merged.error;
  const rows = searchPhone === null ? [] : (merged.value?.items ?? []);
  const mutationReady =
    canWrite &&
    access.canRequest &&
    loaded &&
    searchPhone !== null &&
    !list.isError &&
    !list.isFetching;
  const canAddManual =
    mutationReady &&
    Boolean(searchPhone) &&
    rows.length === 0 &&
    merged.value?.total === 0;

  const onRemove = useCallback(
    async (row: SmsSuppression) => {
      if (!mutationReady) {
        toast({
          kind: "error",
          message:
            "Refresh this exact tenant roster before changing a manual hold. Stale rows are orientation only.",
        });
        return;
      }
      if (!isReversibleManualSmsSuppression(row)) {
        toast({
          kind: "error",
          message:
            "This carrier, consent, complaint, or system suppression is locked and was not changed.",
        });
        return;
      }
      if (!tryAcquireSmsSuppressionWrite(writeBusyRef)) return;
      setWriteBusy(true);
      try {
        const ok = await confirm({
          title: "Remove this manual workspace hold?",
          message: `${formatE164(row.phone)} has a manual sending hold. Removing it does not restore consent or make texting lawful. Current consent, carrier, and complaint rules still apply.`,
          confirmLabel: "Remove manual hold",
          destructive: true,
          confirmPhrase: row.phone,
          consequence:
            "Only the manual hold is removed. STOP and other system-authoritative suppressions cannot be cleared here.",
        });
        if (!ok) return;
        await remove.mutateAsync(row);
        haptics.success();
        toast({
          kind: "success",
          message: `Manual hold removed for ${formatE164(row.phone)}. This only changes future eligibility under that hold; consent and every other policy still apply, and dispatch remains release-held.`,
        });
      } catch (error: unknown) {
        haptics.error();
        toast({
          kind: "error",
          message: writeFailureMessage(
            error,
            "Couldn't remove the manual hold.",
          ),
        });
      } finally {
        releaseSmsSuppressionWrite(writeBusyRef);
        setWriteBusy(false);
      }
    },
    [confirm, mutationReady, remove, toast],
  );

  const onAdd = useCallback(async () => {
    if (!canAddManual || !searchPhone) return;
    if (!tryAcquireSmsSuppressionWrite(writeBusyRef)) return;
    setWriteBusy(true);
    try {
      const ok = await confirm({
        title: "Add a manual workspace hold?",
        message: `${formatE164(searchPhone)} will receive a reversible manual sending hold. This does not record a carrier STOP or change consent evidence.`,
        confirmLabel: "Add manual hold",
        confirmPhrase: searchPhone,
        consequence:
          "The exact owner/admin identity is revalidated before the hold is created.",
      });
      if (!ok) return;
      await addHold.mutateAsync(searchPhone);
      haptics.success();
      toast({
        kind: "success",
        message: `Manual workspace hold confirmed for ${formatE164(searchPhone)}.`,
      });
    } catch (error: unknown) {
      haptics.error();
      toast({
        kind: "error",
        message: writeFailureMessage(
          error,
          "Couldn't confirm the manual hold.",
        ),
      });
    } finally {
      releaseSmsSuppressionWrite(writeBusyRef);
      setWriteBusy(false);
    }
  }, [addHold, canAddManual, confirm, searchPhone, toast]);

  return {
    access,
    canAddManual,
    canWrite,
    list,
    listAccess,
    loaded,
    merged,
    mutationReady,
    onAdd,
    onRemove,
    q,
    rows,
    searchPhone,
    setQ,
    writeBusy,
  };
}
