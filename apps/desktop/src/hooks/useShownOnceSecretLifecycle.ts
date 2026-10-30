import { useCallback, useEffect, useId, useRef } from "react";

import {
  registerLifecycleGuard,
  signalLifecycleOwnerChanged,
} from "../lib/lifecycle-coordinator";

export interface ShownOnceSecretLifecycle {
  /** Acquire protection synchronously before publishing a fresh plaintext. */
  activate: () => void;
  /** Release protection synchronously immediately before zeroization. */
  resolve: () => void;
}

/**
 * Prevent a shown-once credential from disappearing behind quit, restart,
 * identity change, or OS shutdown. Hiding the still-live window is safe; all
 * destructive transitions require the operator to return, copy/store the
 * value, and explicitly acknowledge the owning surface first.
 */
export function useShownOnceSecretLifecycle(
  id: string,
  label: string,
  active: boolean,
): ShownOnceSecretLifecycle {
  const instanceId = useId();
  const activeRef = useRef(active);
  activeRef.current = active;
  const activate = useCallback((): void => {
    activeRef.current = true;
    signalLifecycleOwnerChanged();
  }, []);
  const resolve = useCallback((): void => {
    activeRef.current = false;
    signalLifecycleOwnerChanged();
  }, []);

  useEffect(
    () =>
      registerLifecycleGuard({
        // Public owner ids are renderer-global. A page can be mounted twice
        // during a routed transition or in a secondary window, so retain the
        // semantic owner id while making each mounted copy unambiguous.
        id: `shown-once-${id}-${instanceId}`,
        label,
        inspect: (intent) =>
          !activeRef.current || intent.disposition === "hide"
            ? null
            : {
                level: "blocking",
                detail:
                  "This value cannot be retrieved again. Return to its dialog, store it securely, and acknowledge it before leaving Moosewave.",
                canSave: false,
                canDiscard: false,
                canRecover: false,
              },
      }),
    [id, instanceId, label],
  );

  useEffect(() => {
    signalLifecycleOwnerChanged();
  }, [active]);

  return { activate, resolve };
}
