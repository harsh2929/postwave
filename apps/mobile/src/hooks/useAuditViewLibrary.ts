/**
 * hooks/useAuditViewLibrary.ts — the interaction layer over saved audit views:
 * the save sheet's state, and what each of apply / save / delete says when it
 * succeeds, fails, or turns out to have been unnecessary.
 *
 * Kept out of the screen because two of these three verbs have a non-obvious
 * correct answer:
 *
 *  - DELETE CAN SUCCEED AND STILL NOT HAVE DELETED ANYTHING. The server
 *    returns 404 when the row is already gone (audit_extras.go:341, which
 *    documents the earlier bug where an unconditional 200 let the UI claim a
 *    deletion that never happened). The toast distinguishes the two.
 *  - APPLYING A VIEW FROM ANOTHER CLIENT IS AN APPROXIMATION. Desktop's
 *    filter vocabulary is not mobile's; lib/auditViews projects between them.
 *    The apply toast says when a projection happened, so nobody reads an
 *    adapted view as an exact recall.
 */
import { useCallback, useState } from "react";

import type { useConfirm } from "@/components/ConfirmSheet";
import type { useToast } from "@/components/Toast";
import {
  useDeleteAuditView,
  useSaveAuditView,
  type AuditSavedView,
} from "@/hooks/useAuditSavedViews";
import {
  describeAuditView,
  encodeAuditView,
  isNativeAuditView,
  savedViewNameError,
  type AuditViewState,
} from "@/lib/auditViews";
import { serverActorTypeFor } from "@/lib/auditSeverity";
import { haptics } from "@/lib/haptics";

export interface AuditViewLibraryInput {
  view: AuditViewState;
  views: readonly AuditSavedView[];
  applyView: (next: AuditViewState) => void;
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>["toast"];
}

export function useAuditViewLibrary({
  view,
  views,
  applyView,
  confirm,
  toast,
}: AuditViewLibraryInput) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useSaveAuditView();
  const remove = useDeleteAuditView();

  const openSave = useCallback(() => {
    setName("");
    setError(null);
    setSheetOpen(true);
  }, []);

  const closeSave = useCallback(() => {
    setSheetOpen(false);
    setError(null);
  }, []);

  const submitSave = useCallback(() => {
    const problem = savedViewNameError(
      name,
      views.map((v) => v.name),
    );
    if (problem) {
      setError(problem);
      return;
    }
    save
      .mutateAsync({
        name,
        // The description doubles as the human record of what was captured,
        // so a view opened on another client still explains itself.
        description: describeAuditView(view),
        filters: encodeAuditView(view, serverActorTypeFor(view.actor)),
      })
      .then((saved) => {
        haptics.success();
        setSheetOpen(false);
        setError(null);
        toast({ kind: "success", message: `Saved “${saved.name}”.` });
      })
      .catch(() => {
        haptics.error();
        setError("Couldn't save the view. Check your connection and retry.");
      });
  }, [name, save, toast, view, views]);

  const apply = useCallback(
    (saved: AuditSavedView, state: AuditViewState) => {
      applyView(state);
      haptics.tap();
      toast({
        kind: "info",
        message: isNativeAuditView(saved.filters)
          ? `Showing “${saved.name}”.`
          : `Showing “${saved.name}” — adapted from another device.`,
      });
    },
    [applyView, toast],
  );

  const destroy = useCallback(
    (saved: AuditSavedView) => {
      void (async () => {
        const ok = await confirm({
          title: `Delete “${saved.name}”?`,
          message:
            "This removes the saved view for everyone in the workspace, on every device.",
          consequence: "The audit events themselves are not affected.",
          confirmLabel: "Delete view",
          destructive: true,
        });
        if (!ok) return;
        try {
          const result = await remove.mutateAsync(saved.id);
          haptics.success();
          toast({
            kind: result.existed ? "success" : "info",
            message: result.existed
              ? `Deleted “${saved.name}”.`
              : `“${saved.name}” had already been deleted.`,
          });
        } catch {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't delete “${saved.name}”. Nothing was changed.`,
          });
        }
      })();
    },
    [confirm, remove, toast],
  );

  return {
    sheetOpen,
    name,
    setName,
    error,
    busy: save.isPending || remove.isPending,
    openSave,
    closeSave,
    submitSave,
    apply,
    destroy,
    summary: describeAuditView(view),
  };
}
