/**
 * hooks/useAuditAlertActions.ts — the audit-alert screen's write verbs,
 * assembled once: pause/resume, the Slack fan-out switch, create, delete.
 *
 * Extracted whole from app/(tabs)/audit-alerts.tsx when the create and delete
 * verbs pushed the route file past the 450-line source budget; the house rule
 * is to split rather than to breach. This hook owns the confirm ceremonies,
 * the haptics, the toasts and the create sheet's open/error state — the screen
 * keeps only which row is open.
 *
 * Governance discipline is unchanged from the day this surface shipped:
 * nothing here is optimistic and nothing is queued. Every verb reports
 * through a toast on the answer, never on the press.
 */
import { useCallback, useState } from "react";

import type { useConfirm } from "@/components/ConfirmSheet";
import type { useToast } from "@/components/Toast";
import {
  useCreateAuditAlert,
  useDeleteAuditAlert,
  useSetAuditAlertNotifySlack,
  useToggleAuditAlert,
} from "@/hooks/useAuditAlerts";
import type { AuditAlertCreateBody } from "@/lib/auditAlertCreate";
import {
  auditAlertErrorMessage,
  toggleCopy,
  toggleSuccessMessage,
} from "@/lib/auditAlertPolicy";
import type { AuditAlertRule } from "@/lib/auditAlertRules";
import { haptics } from "@/lib/haptics";

export interface AuditAlertActionsInput {
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>["toast"];
  /** Close the detail sheet — a deleted rule must not stay open. */
  closeDetail: () => void;
}

export function useAuditAlertActions({
  confirm,
  toast,
  closeDetail,
}: AuditAlertActionsInput) {
  const toggle = useToggleAuditAlert();
  const slackToggle = useSetAuditAlertNotifySlack();
  const create = useCreateAuditAlert();
  const destroy = useDeleteAuditAlert();
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onToggle = useCallback(
    async (rule: AuditAlertRule) => {
      if (toggle.isPending) return;
      const copy = toggleCopy(rule);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press now; the success thump waits for the server so a
      // failing network never feels like a success followed by an error.
      haptics.impact();
      const next = !rule.enabled;
      try {
        await toggle.mutateAsync({ id: rule.id, enabled: next });
        haptics.success();
        toast({ kind: "success", message: toggleSuccessMessage(rule, next) });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `${copy.confirmLabel} failed. ${auditAlertErrorMessage(error)}`,
        });
      }
    },
    [confirm, toast, toggle],
  );

  // The Slack fan-out switch. No pre-confirm — a switch that asks "are you
  // sure?" is double-asking — but nothing is optimistic either: the row only
  // flips once the server has said so, and a failure lands as a toast.
  const onToggleSlack = useCallback(
    async (rule: AuditAlertRule, next: boolean) => {
      if (slackToggle.isPending) return;
      haptics.impact();
      try {
        await slackToggle.mutateAsync({ id: rule.id, notifySlack: next });
        haptics.success();
        toast({
          kind: "success",
          message: next
            ? `Fires from “${rule.name}” now also go to the workspace Slack.`
            : `Fires from “${rule.name}” no longer go to the workspace Slack.`,
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `Slack routing change failed. ${auditAlertErrorMessage(error)}`,
        });
      }
    },
    [slackToggle, toast],
  );

  const onCreate = useCallback(
    async (body: AuditAlertCreateBody) => {
      if (create.isPending) return;
      setCreateError(null);
      try {
        await create.mutateAsync(body);
        haptics.success();
        setCreateOpen(false);
        toast({
          kind: "success",
          message: `“${body.name}” is watching. It fires on new events only.`,
        });
      } catch (error) {
        haptics.error();
        // The refusal renders INSIDE the sheet, next to the fields it is
        // about — a toast would dismiss itself while the operator is reading.
        setCreateError(auditAlertErrorMessage(error));
      }
    },
    [create, toast],
  );

  const onDelete = useCallback(
    async (rule: AuditAlertRule) => {
      if (destroy.isPending) return;
      const ok = await confirm({
        title: `Delete “${rule.name}”?`,
        message:
          "The rule and its delivery configuration are removed permanently. Its channel credentials cannot be read back from any client, so rebuilding it later means re-entering them.",
        confirmLabel: "Delete",
        destructive: true,
        // Typed, because this is the irreversible verb on this screen: the
        // fire history goes with the rule and the credential set is gone.
        confirmPhrase: rule.name,
        consequence: "Nothing will be watching for these events afterwards.",
      });
      if (!ok) return;
      try {
        await destroy.mutateAsync(rule.id);
        haptics.success();
        closeDetail();
        toast({ kind: "success", message: `Deleted “${rule.name}”.` });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `Delete failed. ${auditAlertErrorMessage(error)}`,
        });
      }
    },
    [closeDetail, confirm, destroy, toast],
  );

  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setCreateError(null);
  }, []);
  const openCreate = useCallback(() => setCreateOpen(true), []);

  return {
    onToggle,
    onToggleSlack,
    onCreate,
    onDelete,
    toggling: toggle.isPending,
    // Which rule the pause is working on, for the row spinner.
    togglingId: toggle.isPending ? (toggle.variables?.id ?? null) : null,
    slackToggling: slackToggle.isPending,
    creating: create.isPending,
    deleting: destroy.isPending,
    createOpen,
    openCreate,
    closeCreate,
    createError,
  };
}
