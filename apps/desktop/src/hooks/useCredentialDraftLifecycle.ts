import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { useBlockingLifecycleOperation } from "./useBlockingLifecycleOperation";

interface CredentialDraftLifecycleOptions {
  /** Stable surface identity; `useId` makes every mounted copy unique. */
  ownerId: string;
  label: string;
  values: Record<string, string>;
  setValues: Dispatch<SetStateAction<Record<string, string>>>;
  busy: boolean;
  onClose: () => void;
  detail?: string;
}

export interface CredentialDraftLifecycle {
  dirty: boolean;
  operationActive: boolean;
  discardConfirmOpen: boolean;
  requestClose: () => void;
  keepEditing: () => void;
  discardAndClose: () => void;
  closeAfterSuccess: () => void;
  beginOperation: () => boolean;
  finishOperation: () => void;
}

/**
 * Protect a write-only credential/reference draft without ever persisting it.
 *
 * Hiding the app is safe. Exit, restart and identity changes either wait for an
 * active request or require an explicit discard that releases every plaintext
 * field. The operation ref closes React's same-tick double-submit/close gap;
 * the state mirror keeps the global lifecycle owner active on later renders.
 */
export function useCredentialDraftLifecycle({
  ownerId,
  label,
  values,
  setValues,
  busy,
  onClose,
  detail = "These write-only credentials are not saved. Return to the dialog or explicitly discard and clear them.",
}: CredentialDraftLifecycleOptions): CredentialDraftLifecycle {
  const instanceId = useId();
  const operationRef = useRef(false);
  const [operationStarted, setOperationStarted] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const dirty = Object.values(values).some((value) => value.length > 0);
  const operationActive = busy || operationStarted;

  const zeroize = useCallback((): void => {
    setValues({});
  }, [setValues]);

  const keepEditing = useCallback((): void => {
    if (!operationRef.current && !busy) setDiscardConfirmOpen(false);
  }, [busy]);

  const discardAndClose = useCallback((): void => {
    if (operationRef.current || busy) return;
    zeroize();
    setDiscardConfirmOpen(false);
    onClose();
  }, [busy, onClose, zeroize]);

  const requestClose = useCallback((): void => {
    if (operationRef.current || busy) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    zeroize();
    onClose();
  }, [busy, dirty, onClose, zeroize]);

  const closeAfterSuccess = useCallback((): void => {
    zeroize();
    setDiscardConfirmOpen(false);
    onClose();
  }, [onClose, zeroize]);

  const beginOperation = useCallback((): boolean => {
    if (operationRef.current) return false;
    operationRef.current = true;
    setOperationStarted(true);
    setDiscardConfirmOpen(false);
    return true;
  }, []);

  const finishOperation = useCallback((): void => {
    operationRef.current = false;
    setOperationStarted(false);
  }, []);

  useBlockingLifecycleOperation(
    `credential-${ownerId}-${instanceId}`,
    `${label} operation`,
    operationActive,
    "Wait for the credential request to finish before leaving Moosewave.",
  );

  useEffect(() => {
    if (!dirty) return;
    return registerLifecycleGuard({
      id: `credential-draft-${ownerId}-${instanceId}`,
      label,
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        if (operationRef.current || operationActive) {
          return {
            level: "blocking",
            detail:
              "Wait for the credential request to finish before leaving Moosewave.",
            canSave: false,
            canDiscard: false,
            canRecover: false,
          };
        }
        return {
          level: "blocking",
          detail,
          canSave: false,
          canDiscard: true,
          canRecover: false,
        };
      },
      discard: () => {
        if (!operationRef.current) discardAndClose();
      },
    });
  }, [
    detail,
    dirty,
    discardAndClose,
    instanceId,
    label,
    operationActive,
    ownerId,
  ]);

  return {
    dirty,
    operationActive,
    discardConfirmOpen,
    requestClose,
    keepEditing,
    discardAndClose,
    closeAfterSuccess,
    beginOperation,
    finishOperation,
  };
}
