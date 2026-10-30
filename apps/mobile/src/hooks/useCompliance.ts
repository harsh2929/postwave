/**
 * hooks/useCompliance.ts — TanStack wiring for the compliance posture monitor.
 *
 * Every judgement lives in `lib/compliancePosture` and `lib/complianceLabels`
 * (pure, node-tested); this file is only the query layer.
 *
 * TWO GATES ON EVERY QUERY, NOT ONE.
 *
 *  - `useOnlineQueryGate` is the usual offline/auth gate. Offline a query never
 *    runs, which in TanStack v5 is status "pending" with fetchStatus "idle" —
 *    `isLoading` FALSE and `isError` FALSE — so a screen that fell through to
 *    "nothing attested" would be inventing a compliance verdict out of a
 *    missing network. `QueryStates` owns that branch.
 *  - `allowed` carries the ROLE decision. Every `/api/v1/compliance/*` route is
 *    owner/admin-only (see the header of `api/compliance.ts`), so for any other
 *    role these requests can only ever answer 403. Firing them anyway spends a
 *    cellular round trip to learn something the client already knows and paints
 *    a generic error over a screen whose real state is "your role cannot see
 *    this".
 *
 * STALENESS IS LONG HERE, AND THAT IS THE DOMAIN. An attestation changes when
 * a human signs one — a handful of times a year — and its renewal date moves
 * only when somebody edits it on a desktop. Polling this every twenty seconds
 * like a send queue would be a battery cost with no information in it. Five
 * minutes for the posture, fifteen for a ledger that is append-only.
 */
import { useQuery } from "@tanstack/react-query";

import {
  listComplianceEvents,
  listCompliancePrograms,
} from "@/api/compliance";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  ComplianceEvent,
  ComplianceProgram,
} from "@/lib/compliancePrograms";

export type {
  ComplianceEvent,
  ComplianceProgram,
} from "@/lib/compliancePrograms";

const PROGRAMS_STALE_MS = 300_000;
const EVENTS_STALE_MS = 900_000;

export function useCompliancePrograms(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<ComplianceProgram[]>({
    queryKey: ["compliance", "programs", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: PROGRAMS_STALE_MS,
    queryFn: () => listCompliancePrograms(),
  });
}

/**
 * One framework's ledger.
 *
 * HIPAA IS REFUSED AT THE GATE. `ListEvents` short-circuits it to a fixed
 * empty response (compliance.go:447-455), so the request cannot return
 * anything the catalogue does not already say — and an empty ledger rendered
 * under the one framework nobody may attest to reads as "nothing has happened
 * yet" rather than "this can never happen". The screen shows the server's own
 * refusal sentence there instead.
 */
export function useComplianceEvents(framework: string | null, allowed: boolean) {
  const gate = useOnlineQueryGate();
  const slug = framework && framework !== "hipaa" ? framework : null;
  return useQuery<ComplianceEvent[]>({
    queryKey: ["compliance", "events", gate.tenantId, slug],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed && Boolean(slug),
    staleTime: EVENTS_STALE_MS,
    queryFn: () => listComplianceEvents(String(slug)),
  });
}
