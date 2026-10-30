/**
 * hooks/useSinkLifecycle.ts — the audit-sink LIFECYCLE verbs (disable/enable,
 * delete) and the replay sheet's open state, extracted so the audit-sinks
 * route file stays inside its source budget when the health/remediation verbs
 * it already had gained these three.
 *
 * The confirm ceremonies live here and are graded by what each verb destroys:
 *
 *  - DISABLE stops delivery but keeps everything — a plain confirm. While a
 *    sink is disabled the worker skips it entirely: matching events are NOT
 *    queued to its DLQ, they simply never stream, and the confirm says so.
 *  - DELETE drops the row, its encrypted credentials and its job history — a
 *    TYPED confirm on the sink's name, the same ceremony as every other
 *    unrecoverable delete in the app.
 *
 * Online-only, never optimistic, never queued — the standing governance
 * discipline of this cluster (see useGovernanceOps).
 */
import { useCallback, useState } from "react";

import type { useConfirm } from "@/components/ConfirmSheet";
import type { useToast } from "@/components/Toast";
import type { MobileAuditSink } from "@/api/ops";
import { useDeleteSink, useSetSinkEnabled } from "@/hooks/useGovernanceOps";
import { haptics } from "@/lib/haptics";

export interface SinkLifecycleInput {
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>["toast"];
}

export function useSinkLifecycle({ confirm, toast }: SinkLifecycleInput) {
  const setEnabled = useSetSinkEnabled();
  const destroy = useDeleteSink();
  const [busyId, setBusyId] = useState<{
    id: string;
    action: "disable" | "delete";
  } | null>(null);
  const [replaySink, setReplaySink] = useState<MobileAuditSink | null>(null);

  const onSetEnabled = useCallback(
    async (sink: MobileAuditSink, enabled: boolean) => {
      if (setEnabled.isPending) return;
      const ok = await confirm({
        title: enabled
          ? `Enable ${sink.name || "this sink"}?`
          : `Disable ${sink.name || "this sink"}?`,
        message: enabled
          ? "Delivery resumes with the next matching audit event."
          : "Audit events stop streaming to this destination until it is re-enabled. Events that occur while it is disabled are not queued for it — they are simply never delivered here.",
        confirmLabel: enabled ? "Enable" : "Disable",
        destructive: !enabled,
        ...(enabled
          ? {}
          : { consequence: "This destination goes dark until re-enabled." }),
      });
      if (!ok) return;
      setBusyId({ id: sink.id, action: "disable" });
      try {
        await setEnabled.mutateAsync({ id: sink.id, enabled });
        haptics.success();
        toast({
          kind: "success",
          message: enabled ? "Sink enabled — delivery resumed." : "Sink disabled.",
        });
      } catch (err) {
        haptics.error();
        toast({ kind: "error", message: lifecycleErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, setEnabled, toast],
  );

  const onDelete = useCallback(
    async (sink: MobileAuditSink) => {
      if (destroy.isPending) return;
      const ok = await confirm({
        title: `Delete ${sink.name || "this sink"}?`,
        message:
          "The sink is removed permanently, with its stored credentials and replay history. Its past dead-letter entries lose their destination.",
        confirmLabel: "Delete",
        destructive: true,
        // Typed on the sink's own name: the delete is unrecoverable and the
        // credentials cannot be read back to rebuild it.
        confirmPhrase: sink.name || "delete",
        consequence: "Audit events stop streaming to this destination forever.",
      });
      if (!ok) return;
      setBusyId({ id: sink.id, action: "delete" });
      try {
        await destroy.mutateAsync(sink.id);
        haptics.success();
        toast({
          kind: "success",
          message: `Deleted ${sink.name || "the sink"}.`,
        });
      } catch (err) {
        haptics.error();
        toast({ kind: "error", message: lifecycleErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, destroy, toast],
  );

  return {
    onSetEnabled,
    onDelete,
    /** "disable" | "delete" in flight for this sink id, else null. */
    busyFor: useCallback(
      (id: string): "disable" | "delete" | null =>
        busyId && busyId.id === id ? busyId.action : null,
      [busyId],
    ),
    replaySink,
    openReplay: useCallback((sink: MobileAuditSink) => setReplaySink(sink), []),
    closeReplay: useCallback(() => setReplaySink(null), []),
  };
}

function lifecycleErrorMessage(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status) || 0
      : 0;
  if (status === 403) {
    return "Your role is not permitted to change audit sinks. Ask an admin.";
  }
  if (status === 404) return "That sink no longer exists.";
  return "The change did not reach the server, so nothing changed. Check your connection and try again.";
}
