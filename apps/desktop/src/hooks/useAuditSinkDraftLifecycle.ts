import { useEffect, useId, type RefObject } from "react";

import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { useBlockingLifecycleOperation } from "./useBlockingLifecycleOperation";

interface AuditSinkDraftLifecycleOptions {
  ownerId: string;
  draftLabel: string;
  operationLabel: string;
  dirty: boolean;
  operationActive: boolean;
  operationRef: RefObject<boolean>;
  onDiscard: () => void;
  draftDetail?: string;
  operationDetail?: string;
}

/**
 * Audit-sink configuration may contain write-only credentials, so its local
 * draft is deliberately discard-only. There is no prepare/save callback and
 * therefore no path that can journal plaintext or auto-run create, test,
 * update, or rotation during a global lifecycle transition.
 */
export function useAuditSinkDraftLifecycle({
  ownerId,
  draftLabel,
  operationLabel,
  dirty,
  operationActive,
  operationRef,
  onDiscard,
  draftDetail = "This audit sink configuration and its write-only credentials are not saved. Return to the dialog or explicitly discard and clear them.",
  operationDetail = "Wait for the audit sink request to finish before leaving Moosewave.",
}: AuditSinkDraftLifecycleOptions): void {
  const instanceId = useId();

  useBlockingLifecycleOperation(
    `${ownerId}-${instanceId}`,
    operationLabel,
    operationActive,
    operationDetail,
  );

  useEffect(() => {
    if (!dirty || operationActive) return;
    return registerLifecycleGuard({
      id: `${ownerId}-draft-${instanceId}`,
      label: draftLabel,
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        if (operationRef.current) {
          return {
            level: "blocking",
            detail: operationDetail,
            canSave: false,
            canDiscard: false,
            canRecover: false,
          };
        }
        return {
          level: "blocking",
          detail: draftDetail,
          canSave: false,
          canDiscard: true,
          canRecover: false,
        };
      },
      discard: () => {
        if (!operationRef.current) onDiscard();
      },
    });
  }, [
    draftDetail,
    draftLabel,
    dirty,
    instanceId,
    onDiscard,
    operationActive,
    operationDetail,
    operationRef,
    ownerId,
  ]);
}
