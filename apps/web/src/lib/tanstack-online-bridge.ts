// SPDX-License-Identifier: AGPL-3.0-only

import { onlineManager as tanstackOnlineManager } from "@tanstack/react-query";

import { getOnlineStatus, subscribeOnlineStatus } from "./online-manager";

let onlineWired = false;

/**
 * Connect TanStack's paused-query state to Moosewave's unified connectivity
 * signal. QueryProvider loads this after hydration: the bridge installs in an
 * effect in either form, while deferring its heartbeat/request dependencies
 * keeps them out of every dashboard route's initial graph.
 */
export function installTanstackOnlineBridge(): void {
  if (onlineWired) return;
  onlineWired = true;
  tanstackOnlineManager.setEventListener((setOnline) => {
    const push = (): void => {
      setOnline(getOnlineStatus() !== "offline");
    };
    push();
    return subscribeOnlineStatus(push);
  });
}
