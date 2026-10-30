/**
 * hooks/useInboundRoutes.ts — TanStack wiring for the inbound-routing monitor.
 *
 * Every judgement lives in `lib/inboundRoutes` and `lib/inboundRouteVerdict`
 * (pure, node-tested); this file is only the query layer.
 *
 * TWO GATES ON EVERY QUERY, NOT ONE.
 *
 *  - `useOnlineQueryGate` is the offline/auth gate. Offline a query never runs,
 *    which in TanStack v5 is status "pending" with fetchStatus "idle" —
 *    `isLoading` FALSE and `isError` FALSE — so a screen falling through to
 *    "this rule never matched" would be inventing a fact about the workspace.
 *  - `allowed` carries the ROLE decision. All eight /api/v1/inbound-routes
 *    routes are behind `RequireScope(ScopeAdmin)` (see the note at the top of
 *    api/inboundRoutes.ts), so for any other role these can only answer 403.
 *
 * STALENESS. The rule list is configuration and changes when somebody edits it
 * on a desktop, so it gets the long window. Matches are the live thing and get
 * the short one. Action runs belong to a match that has already been handled —
 * they are IMMUTABLE once written, so re-selecting a match re-reads nothing.
 */
import { useQuery } from "@tanstack/react-query";

import {
  INBOUND_MATCHES_PAGE_SIZE,
  listInboundActionRuns,
  listInboundRouteMatches,
  listInboundRoutes,
} from "@/api/inboundRoutes";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  InboundActionRun,
  InboundRoute,
  InboundRouteMatch,
} from "@/lib/inboundRoutes";

export type {
  InboundActionRun,
  InboundRoute,
  InboundRouteMatch,
} from "@/lib/inboundRoutes";

const ROUTES_STALE_MS = 300_000;
const MATCHES_STALE_MS = 20_000;
const RUNS_STALE_MS = 600_000;

export function useInboundRoutes(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<InboundRoute[]>({
    queryKey: ["inbound-routes", "rules", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: ROUTES_STALE_MS,
    queryFn: () => listInboundRoutes(),
  });
}

export function useInboundRouteMatches(routeId: string | null, allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<InboundRouteMatch[]>({
    queryKey: ["inbound-routes", "matches", gate.tenantId, routeId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed && Boolean(routeId),
    staleTime: MATCHES_STALE_MS,
    queryFn: () =>
      listInboundRouteMatches(String(routeId), INBOUND_MATCHES_PAGE_SIZE),
  });
}

/**
 * One match's action-run ledger.
 *
 * Fetched for whichever match is selected, INCLUDING one whose rule has no
 * actions — where the answer is empty by construction. This could skip the call
 * on that reasoning, and does not: the reading is from the rule's `actions`
 * array, which is configuration that may have changed since the match, and a
 * skipped fetch would silently hide runs from when the rule still had them.
 * One cheap request, and `emptyRunsNotice` explains what came back.
 */
export function useInboundActionRuns(matchId: number | null, allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<InboundActionRun[]>({
    queryKey: ["inbound-routes", "runs", gate.tenantId, matchId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      allowed &&
      matchId !== null &&
      matchId > 0,
    staleTime: RUNS_STALE_MS,
    queryFn: () => listInboundActionRuns(Number(matchId)),
  });
}

