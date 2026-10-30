import { useEffect, useRef } from "react";

import { toast } from "../components/Toast";
import {
  DESKTOP_TASK_INTENTS,
  consumeDesktopTaskIntent,
  desktopTaskIntentFromRoute,
  type DesktopTaskIntent,
} from "../lib/desktop-task-intents";
import { useDesktopRoute } from "../lib/desktop-router";
import { useRoleStatus } from "../lib/store";

interface WriteDesktopTaskIntentOptions {
  intent: DesktopTaskIntent;
  open: boolean;
  canMutate: boolean;
  onOpen: () => void;
  /** Close local UI after a lifecycle-approved Back/Forward transition. */
  onRouteExit: () => void;
}

/**
 * Activate a routed write task exactly once and keep local modal state aligned
 * with history. Explicit close/completion remains the destination owner's job:
 * it must call consumeDesktopTaskIntent only after its lifecycle is resolved.
 */
export function useWriteDesktopTaskIntent({
  intent,
  open,
  canMutate,
  onOpen,
  onRouteExit,
}: WriteDesktopTaskIntentOptions): void {
  const route = useDesktopRoute();
  const roleStatus = useRoleStatus();
  const onOpenRef = useRef(onOpen);
  const onRouteExitRef = useRef(onRouteExit);
  const wasActiveRef = useRef(false);
  const requestedRef = useRef(false);
  const deniedRef = useRef(false);
  onOpenRef.current = onOpen;
  onRouteExitRef.current = onRouteExit;
  const active = desktopTaskIntentFromRoute(route) === intent;

  useEffect(() => {
    if (!active) {
      if (wasActiveRef.current && open) onRouteExitRef.current();
      wasActiveRef.current = false;
      requestedRef.current = false;
      deniedRef.current = false;
      return;
    }
    wasActiveRef.current = true;
    if (roleStatus === "loading") return;
    if (roleStatus !== "resolved" || !canMutate) {
      if (!deniedRef.current) {
        deniedRef.current = true;
        toast.error(
          `A write role is required to start ${DESKTOP_TASK_INTENTS[intent].label.toLowerCase()}.`,
        );
      }
      consumeDesktopTaskIntent(intent);
      return;
    }
    if (open || requestedRef.current) return;
    requestedRef.current = true;
    onOpenRef.current();
  }, [active, canMutate, intent, open, roleStatus]);
}
