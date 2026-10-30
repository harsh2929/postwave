/**
 * hooks/usePrivacyIncidents.ts — query wiring for the breach-response
 * register.
 *
 * THE GATE. All three reads use `useOnlineQueryGate` with
 * `enabled: gate.enabled && Boolean(gate.tenantId)`, the app-wide contract
 * enforced by hooks/online-query-gating.test.ts. It matters more here than
 * almost anywhere else: a disabled TanStack query reports `data: undefined,
 * isLoading: false, isError: false`, so without the gate term this screen
 * would render "No open incidents" — an all-clear about a breach register —
 * for a workspace whose incidents were simply never fetched.
 *
 * NO OFFLINE SNAPSHOT, DELIBERATELY. Several surfaces in this app cache their
 * last payload so it can be read on a plane. This one must not: the whole
 * value of the screen is the current recorded state and operational target; a countdown
 * rendered from a snapshot of unknown age is a wrong number wearing the
 * clothes of a right one. Offline, `QueryStates` says so instead.
 *
 * THE STALENESS WINDOW IS SHORT because the register is a shared workspace
 * of record: a colleague on a laptop is moving the same incident through the
 * same state machine, and a phone that believed a 60-second-old status would
 * offer a transition the server has already refused.
 */
import { useEffect } from "react";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  createPrivacyIncident,
  fetchPrivacyIncident,
  listPrivacyIncidentEvents,
  listPrivacyIncidents,
  transitionPrivacyIncident,
  type DeclareIncidentInput,
  type IncidentTransitionInput,
} from "@/api/privacyIncidents";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  IncidentEvent,
  PrivacyIncidentDetail,
  PrivacyIncidentPage,
} from "@/lib/privacyIncidents";

export type {
  IncidentEvent,
  IncidentState,
  PrivacyIncident,
  PrivacyIncidentDetail,
  PrivacyIncidentPage,
} from "@/lib/privacyIncidents";

const LIST_KEY = "privacy-incidents";
const DETAIL_KEY = "privacy-incident";
const EVENTS_KEY = "privacy-incident-events";

const LIST_STALE_MS = 15_000;

function clearPrivacyIncidentQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: [LIST_KEY] });
  queryClient.removeQueries({ queryKey: [DETAIL_KEY] });
  queryClient.removeQueries({ queryKey: [EVENTS_KEY] });
}

export function privacyIncidentsQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [LIST_KEY, tenantId ?? null];
}

/**
 * @param allowed `incidentReadAccess(...).allowed` — withhold the request from
 * a session the app has already established is not owner/admin, so the screen's
 * explanation is not preceded by a guaranteed 403 in the server log. The screen
 * still handles a 403 as its own state: a role can change mid-session, and
 * `storedGrantsCoverScopes` (apikeys/middleware.go:216) can additively grant
 * the admin scope to a custom role the phone cannot see.
 */
export function usePrivacyIncidents(allowed = true) {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const enabled = gate.enabled && Boolean(gate.tenantId) && allowed;
  const query = useQuery({
    queryKey: privacyIncidentsQueryKey(gate.tenantId),
    enabled,
    staleTime: LIST_STALE_MS,
    queryFn: (): Promise<PrivacyIncidentPage> => listPrivacyIncidents(),
  });
  useEffect(() => {
    if (!enabled) clearPrivacyIncidentQueries(queryClient);
  }, [enabled, queryClient]);
  return query;
}

/**
 * One incident, fetched only while the detail sheet is open.
 *
 * `staleTime: 0` because this read is the only source of the explicit
 * jurisdiction-rules release hold and recognition-only metadata; list rows
 * omit that field. The sheet is also opened to answer "where is this right
 * now", for which a cached answer is the wrong answer.
 */
export function usePrivacyIncident(id: string | null) {
  const gate = useOnlineQueryGate();
  const enabled = gate.enabled && Boolean(gate.tenantId) && Boolean(id);
  return useQuery({
    queryKey: [DETAIL_KEY, gate.tenantId, id ?? null],
    enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: (): Promise<PrivacyIncidentDetail> => fetchPrivacyIncident(id!),
  });
}

/**
 * The merged transition + notification ledger.
 *
 * A SEPARATE READ FROM THE DETAIL, and a different question. The detail says
 * where the incident is; the ledger says which state changes and legacy manual
 * notification assertions were recorded. A notification row is not proof of
 * provider delivery or evidence that a packet left the building.
 */
export function usePrivacyIncidentEvents(id: string | null) {
  const gate = useOnlineQueryGate();
  const enabled = gate.enabled && Boolean(gate.tenantId) && Boolean(id);
  return useQuery({
    queryKey: [EVENTS_KEY, gate.tenantId, id ?? null],
    enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: (): Promise<IncidentEvent[]> => listPrivacyIncidentEvents(id!),
  });
}

/**
 * Declare (create) a preliminary breach record.
 *
 * ONLINE-ONLY, never the offline outbox: a declaration replayed later, out of
 * context, would invent audit evidence — the same doctrine as every
 * governance write (hooks/useGovernanceOps.ts). The Idempotency-Key travels
 * WITH the variables because its lifecycle belongs to the DRAFT (kept across
 * ambiguous failures, rotated after definite rejection — see
 * lib/privacyIncidentWrite), which only the declare sheet can know.
 *
 * NETWORK MODE "always": react-query's default PAUSES a mutation started with
 * no connection and replays it on reconnect — an in-session outbox by another
 * name. Here the write fails at once into the sheet's onError instead (the
 * useInboundEndpointAdmin pattern).
 */
export function useDeclarePrivacyIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: DeclareIncidentInput & { idempotencyKey: string }) =>
      createPrivacyIncident(
        { severity: vars.severity, summary: vars.summary },
        vars.idempotencyKey,
      ),
    networkMode: "always",
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

/**
 * Move an incident through the state machine (non-closure only).
 *
 * ONLINE-ONLY for the same reason as declare, with the same network mode.
 * Success invalidates the list, the detail AND the ledger: all three now
 * describe a record whose state the server just changed, and the open sheet's
 * `staleTime: 0` reads refetch immediately.
 */
export function useTransitionPrivacyIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IncidentTransitionInput & { incidentId: string }) =>
      transitionPrivacyIncident(vars.incidentId, {
        to: vars.to,
        reason: vars.reason,
        expectedFrom: vars.expectedFrom,
      }),
    networkMode: "always",
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
      void queryClient.invalidateQueries({ queryKey: [DETAIL_KEY] });
      void queryClient.invalidateQueries({ queryKey: [EVENTS_KEY] });
    },
  });
}
