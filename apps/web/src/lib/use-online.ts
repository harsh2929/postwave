// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useSyncExternalStore } from "react";

import {
  getOnlineStatus,
  getServerOnlineStatus,
  subscribeOnlineStatus,
  type OnlineStatus,
} from "./online-manager";

/**
 * React adapter kept separate from online-manager's server-safe transport.
 *
 * The third argument must be the SERVER snapshot, not the live one. Passing
 * `getOnlineStatus` in both slots meant the hydration pass read whatever the
 * manager had already become ("online") while the server HTML had been built
 * from the seed ("connecting"), and React reported a mismatch on every consumer
 * — most visibly the /app layout-customizer button, rendered disabled by the
 * server and enabled by the client.
 */
export function useOnline(): OnlineStatus {
  return useSyncExternalStore(
    subscribeOnlineStatus,
    getOnlineStatus,
    getServerOnlineStatus,
  );
}
