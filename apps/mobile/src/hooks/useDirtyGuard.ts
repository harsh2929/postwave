/**
 * useDirtyGuard — declare that this editor is holding unsaved changes.
 *
 *   useDirtyGuard("workspace", "Workspace", dirty);
 *
 * The screen that owns the back affordance reads the registry
 * (src/lib/dirtyGuard.ts) at the moment the user tries to leave. Nothing
 * re-renders on a keystroke: the flag is written by an effect and read once.
 *
 * Unregistering on unmount is not optional — a section that is hidden by a role
 * change, or a screen that is torn down after a successful save, would
 * otherwise leave a permanent "unsaved changes" claim behind it and make the
 * back button warn forever.
 */
import { useEffect } from "react";

import { clearDirty, markDirty } from "@/lib/dirtyGuard";

export function useDirtyGuard(
  id: string,
  label: string,
  dirty: boolean,
): void {
  useEffect(() => {
    if (dirty) markDirty(id, label);
    else clearDirty(id);
  }, [id, label, dirty]);

  useEffect(() => () => clearDirty(id), [id]);
}
