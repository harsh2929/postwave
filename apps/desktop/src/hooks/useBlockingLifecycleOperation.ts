import { useEffect } from "react";

import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";

/**
 * Keep an in-flight, non-cancellable local/native operation alive across every
 * destructive lifecycle boundary. Hiding the live process is safe; exit,
 * restart, or identity change waits for the operation to settle instead of
 * pretending it was saved or offering an unsafe automatic retry.
 */
export function useBlockingLifecycleOperation(
  id: string,
  label: string,
  active: boolean,
  detail = "Wait for this operation to finish before leaving Moosewave.",
): void {
  useEffect(() => {
    if (!active) return;
    return registerLifecycleGuard({
      id: `active-operation-${id}`,
      label,
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail,
              canSave: false,
              canDiscard: false,
              canRecover: false,
            },
    });
  }, [active, detail, id, label]);
}
