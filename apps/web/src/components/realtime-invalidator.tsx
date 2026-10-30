// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect } from "react";
import {
  partialMatchKey,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { connectRealtimeBus } from "@/lib/realtime/event-bus-client";
import { queryKeysForEvent } from "@/lib/realtime/event-query-map";
import type { RoleKey } from "@postwave/query-contract";

interface Props {
  /** Resolved tenant id from whoami; null until auth boots. */
  tenantId: string | null | undefined;
  /** Resolved role from whoami; null keeps keys well-formed pre-resolution. */
  role: RoleKey;
}

/**
 * Whether `candidate` is cached under `key` — `[resource, tenant, role, …]` —
 * with the role slot ignored. Screens partition the cache by role, most by the
 * role the session acts as and some by its durable role, but an event says the
 * tenant's data moved, which makes every role's copy of it stale.
 */
function matchesUnderAnyRole(
  candidate: QueryKey,
  key: readonly unknown[],
): boolean {
  if (candidate.length < Math.max(key.length, 3)) return false;
  return partialMatchKey(candidate, [
    key[0],
    key[1],
    candidate[2],
    ...key.slice(3),
  ]);
}

/**
 * Mounts the realtime event-bus subscription for the authenticated dashboard
 * and invalidates the matching @postwave/query-contract `qk` keys when a
 * domain event arrives, so the TanStack Query cache stays fresh without a
 * manual refetch.
 *
 * Gated on a resolved tenant: the SSE handshake requires a tenant context
 * (the Go handler 401s without one), and the invalidation keys are
 * tenant-scoped, so we only connect once whoami has resolved an identity.
 * Renders nothing.
 */
export function RealtimeInvalidator({ tenantId, role }: Props): null {
  const queryClient = useQueryClient();

  useEffect(() => {
    // No tenant yet (pre-auth / logged out) — don't open a stream that would
    // 401, and don't invalidate against an `anon` cache scope.
    if (!tenantId) return;

    const pending = new Map<string, readonly unknown[]>();
    let trailingTimer: number | null = null;
    let maxTimer: number | null = null;

    const flush = (): void => {
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      if (maxTimer !== null) window.clearTimeout(maxTimer);
      trailingTimer = null;
      maxTimer = null;
      const keys = Array.from(pending.values());
      pending.clear();
      if (keys.length === 0) return;
      void queryClient.invalidateQueries({
        predicate: (query) =>
          keys.some((key) => matchesUnderAnyRole(query.queryKey, key)),
      });
    };

    const disconnect = connectRealtimeBus((evt) => {
      const keys = queryKeysForEvent(evt, { tenantId, role });
      for (const queryKey of keys) {
        pending.set(JSON.stringify(queryKey), queryKey);
      }
      if (keys.length === 0) return;
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      trailingTimer = window.setTimeout(flush, 2_000);
      // Sustained event traffic must not postpone freshness forever.
      if (maxTimer === null) maxTimer = window.setTimeout(flush, 5_000);
    });

    return () => {
      disconnect();
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      if (maxTimer !== null) window.clearTimeout(maxTimer);
      pending.clear();
    };
  }, [queryClient, tenantId, role]);

  return null;
}
