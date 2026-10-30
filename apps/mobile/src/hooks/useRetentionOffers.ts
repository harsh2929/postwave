/**
 * hooks/useRetentionOffers.ts — TanStack wiring for the save-offer funnel.
 *
 * Parsing lives in `lib/retentionOffers` (pure, unit-tested under node); this
 * file is only the query layer.
 *
 * FOUR QUERIES, NOT ONE COMBINED FETCH. The offers list, the funnel rollup,
 * the win-back settings and the tier names are four independent server reads
 * that fail independently, and the screen's central honesty claim depends on
 * that separation: a funnel outage must render as "unknown" next to offers
 * that still listed fine. Folding them into one query would make any single
 * failure take the whole screen down, and folding them into one `Promise.all`
 * fetcher would make it impossible to say WHICH part is missing.
 *
 * OFFLINE. Every query sits behind `useOnlineQueryGate`, so offline they never
 * run — which in TanStack v5 is status "pending" with fetchStatus "idle", i.e.
 * `isLoading` false and `isError` false. A screen that fell through that to an
 * empty state would be claiming the workspace has no retention offers;
 * `QueryStates` owns the offline branch instead.
 *
 * NO MUTATIONS. The server mounts three GETs and nothing else for this
 * subsystem (retention_offers/handlers.go:46-53 — `Upsert`, `Deactivate` and
 * the portal handlers are registered on no router). There is deliberately no
 * `useUpsertRetentionOffer` here waiting for someone to wire a button to it.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchPaywallTierNames,
  fetchRetentionFunnel,
  fetchWinbackSettings,
  listRetentionOffers,
} from "@/api/retentionOffers";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  canLoadRetentionOffers,
  retentionOffersQueryKey,
  type RetentionOffersAccessIdentity,
} from "@/lib/retentionOffersAccess";
import type {
  RetentionFunnelTile,
  RetentionOffer,
  WinbackSettings,
} from "@/lib/retentionOffers";
import { useAuthStore } from "@/store/auth";

export type {
  RetentionFunnelTile,
  RetentionFunnelTotals,
  RetentionObservation,
  RetentionOffer,
  RetentionOfferRow,
  WinbackSettings,
} from "@/lib/retentionOffers";

/**
 * Stored catalogue and historical-event rows can change out-of-band. Their
 * separate cache horizons limit staleness without implying that an authoring,
 * cancel-flow, or event-producing runtime is mounted in this release.
 */
const OFFERS_STALE_MS = 60_000;
const FUNNEL_STALE_MS = 30_000;
/**
 * Settings and tier names are reference reads with a longer cache horizon. The
 * distinction is a fetch policy only, not a claim that their dormant mutation
 * paths are available.
 */
const SETTINGS_STALE_MS = 5 * 60_000;

export function useRetentionOffersAccess() {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((state) => state.mode);
  const viewerMode = useAuthStore((state) =>
    Boolean(state.session?.viewerMode),
  );
  const identity: RetentionOffersAccessIdentity = {
    gateEnabled: gate.enabled,
    tenantId: gate.tenantId,
    userId: gate.userId,
    effectiveRole: gate.effectiveRole,
    mode,
    viewerMode,
  };
  const authorized = canLoadRetentionOffers({
    ...identity,
    // Authorization is an identity decision. Network readiness is applied
    // separately below so an offline admin is not mislabeled as unauthorized.
    gateEnabled: true,
  });
  return {
    gate,
    identity,
    mode,
    viewerMode,
    authorized,
    allowed: authorized && gate.enabled,
  };
}

export function useRetentionOffers() {
  const access = useRetentionOffersAccess();
  return useQuery<RetentionOffer[]>({
    queryKey: retentionOffersQueryKey("list", access.identity),
    enabled: access.allowed,
    staleTime: OFFERS_STALE_MS,
    queryFn: () => {
      if (!access.identity.tenantId) {
        throw new Error("Retention offer query has no active tenant identity");
      }
      return listRetentionOffers(access.identity.tenantId);
    },
  });
}

export function useRetentionFunnel() {
  const access = useRetentionOffersAccess();
  return useQuery<RetentionFunnelTile[]>({
    queryKey: retentionOffersQueryKey("funnel", access.identity),
    enabled: access.allowed,
    staleTime: FUNNEL_STALE_MS,
    queryFn: () => fetchRetentionFunnel(),
  });
}

export function useWinbackSettings() {
  const access = useRetentionOffersAccess();
  return useQuery<WinbackSettings>({
    queryKey: retentionOffersQueryKey("winback-settings", access.identity),
    enabled: access.allowed,
    staleTime: SETTINGS_STALE_MS,
    queryFn: () => fetchWinbackSettings(),
  });
}

/**
 * Tier names, keyed id → name.
 *
 * `retry: false` because this is the one read whose failure the screen absorbs
 * silently — a row falls back to a truncated tier id. Spending three retries
 * on a cosmetic enrichment would delay nothing visible and cost a phone three
 * round trips.
 */
export function usePaywallTierNames() {
  const access = useRetentionOffersAccess();
  return useQuery<Record<string, string>>({
    queryKey: retentionOffersQueryKey("tier-names", access.identity),
    enabled: access.allowed,
    staleTime: SETTINGS_STALE_MS,
    retry: false,
    queryFn: () => fetchPaywallTierNames(),
  });
}
