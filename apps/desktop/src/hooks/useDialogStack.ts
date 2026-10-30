/**
 * useDialogStack — React binding for lib/dialogStack.
 *
 * Returns whether the given id is currently top-of-stack. Components
 * that handle the Escape key should gate their handler on `isTop` so
 * only the top-most dialog reacts.
 *
 *   const id = useId();
 *   useEffect(() => {
 *     if (!open) return;
 *     pushDialog(id);
 *     return () => popDialog(id);
 *   }, [open, id]);
 *
 *   const { isTop } = useDialogStack(id);
 *   useEffect(() => {
 *     if (!open || !isTop) return;
 *     ...esc handler...
 *   }, [open, isTop, ...]);
 */

import { useEffect, useState } from "react";

import { isTopDialog, subscribeDialogStack } from "../lib/dialogStack";

export function useDialogStack(id: string): { isTop: boolean } {
  const [isTop, setIsTop] = useState<boolean>(() => isTopDialog(id));

  useEffect(() => {
    /* Re-read on every stack change. Cheap; stack changes are rare. */
    return subscribeDialogStack(() => {
      setIsTop(isTopDialog(id));
    });
  }, [id]);

  return { isTop };
}
