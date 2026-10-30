// SPDX-License-Identifier: AGPL-3.0-only

import type { QueryClient } from "@tanstack/react-query";

/** Resources whose safe mutations can enter the in-tab offline outbox. */
export const OUTBOX_RESOURCES = ["segments", "forms"] as const;
export type OutboxResource = (typeof OUTBOX_RESOURCES)[number];

/**
 * Install the retry/lifetime contract without importing the replay engine.
 * The transport and outbox each own one idempotency key; TanStack must never
 * add a second mutation invocation around either one.
 */
export function installOutboxMutationDefaults(client: QueryClient): void {
  for (const resource of OUTBOX_RESOURCES) {
    client.setMutationDefaults([resource], {
      retry: false,
      networkMode: "offlineFirst",
      gcTime: 24 * 60 * 60 * 1000,
    });
  }
}
