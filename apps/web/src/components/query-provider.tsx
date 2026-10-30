// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { QueryClientProvider } from "@tanstack/react-query";

import {
  buildCacheBuster,
  idbPersister,
  makeQueryClient,
  purgeLegacyQueryCache,
} from "@/lib/query-client";
import { subscribeContextEpochCacheReset } from "@/lib/context-epoch";
import {
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
} from "@/lib/offline-storage-identity";
import type { MeResponse } from "@/lib/auth-api";
import { VerifiedAuthScopeProvider } from "@/lib/auth-scope";
import { qk } from "@/lib/query-keys";

const RealtimeInvalidator = dynamic(
  () =>
    import("@/components/realtime-invalidator").then(
      (mod) => mod.RealtimeInvalidator,
    ),
  { ssr: false, loading: () => null },
);

interface Props {
  children?: ReactNode;
  initialMe: MeResponse;
  onIdentityChange?: (me: MeResponse | null) => void;
}

/**
 * Client boundary mounted inside the (dashboard) route group only.
 * SSR pages and the marketing/public/archive routes never see this
 * provider — they continue to use Next's server fetch + revalidate.
 *
 * The cache buster includes APP_VERSION + identity (user/tenant) so a deploy
 * or re-login atomically invalidates the tab-memory snapshot. Customer query
 * data is intentionally not persisted by the web client.
 */
export function QueryProvider({
  children,
  initialMe,
  onIdentityChange,
}: Props) {
  // Build a fresh client whenever the server-resolved identity object changes.
  // This makes an in-place account/workspace transition a synchronous render
  // boundary: children can never paint from the previous client's live cache.
  const queryClient = useMemo(() => {
    const client = makeQueryClient();
    client.setQueryData(qk.authMe(), initialMe);
    return client;
  }, [initialMe]);

  useEffect(() => {
    void purgeLegacyQueryCache();
    setOfflineStorageIdentity(initialMe.user_id, initialMe.tenant_id);
    return () => {
      // Clear both the live client and module-memory persisted snapshot before
      // another identity can mount in this layout instance.
      queryClient.clear();
      void idbPersister.removeClient();
      resetOfflineStorageIdentity();
    };
  }, [initialMe.tenant_id, initialMe.user_id, queryClient]);

  useEffect(() => {
    queryClient.setQueryData(qk.authMe(), initialMe);
    onIdentityChange?.(initialMe);
  }, [initialMe, onIdentityChange, queryClient]);

  useEffect(() => {
    let active = true;
    void import("@/lib/tanstack-online-bridge").then(
      ({ installTanstackOnlineBridge }) => {
        if (active) installTanstackOnlineBridge();
      },
      () => {
        // A failed optional bridge load must not break the authenticated tree.
        // TanStack retains its navigator-based default until a later mount can
        // retry the chunk.
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // Drop everything when the server says the context moved.
  //
  // The client is already rebuilt when the SERVER-RESOLVED identity object
  // changes, which covers signing in as someone else. It cannot cover a change
  // that leaves `initialMe` byte-identical: an admin demoting this user to
  // viewer, a plan downgrade, a View-as-Viewer preview ending. Same user id,
  // same tenant id, same query keys — and a cache full of answers computed
  // under permissions they no longer have, behind buttons the UI still offers.
  //
  // `clear()` rather than `invalidateQueries()`: invalidation marks entries
  // stale but keeps serving them while refetching, so the old answer is still
  // on screen during the window that matters most.
  useEffect(
    () =>
      subscribeContextEpochCacheReset(queryClient, () => {
        void idbPersister.removeClient();
      }),
    [queryClient],
  );

  const buster = useMemo(
    () => buildCacheBuster(initialMe.user_id, initialMe.tenant_id),
    [initialMe],
  );
  const me = initialMe;
  // The role the session acts as (the preview role while viewer mode is on) —
  // `effectiveAuthRole`, spelled inline so this provider does not pull the auth
  // client's module graph in. Screens key their reads by it.
  const role = me.effective_role ?? me.role;

  return (
    <QueryClientProvider key={buster} client={queryClient}>
      {/* Realtime cache freshness: subscribe to the server event bus and
          invalidate matching qk keys. Gated on a resolved tenant inside the
          component (no stream / no invalidation pre-auth). */}
      <VerifiedAuthScopeProvider
        scope={{
          userId: me.user_id,
          tenantId: me.tenant_id,
          canWriteCampaigns: role !== "viewer",
        }}
      >
        <RealtimeInvalidator tenantId={me.tenant_id} role={role} />
        {children}
      </VerifiedAuthScopeProvider>
    </QueryClientProvider>
  );
}
