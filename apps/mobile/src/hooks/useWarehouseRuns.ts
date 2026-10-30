/**
 * hooks/useWarehouseRuns.ts — TanStack wiring for the warehouse sync monitor.
 *
 * The parsing and every judgement live in `lib/warehouseRuns`,
 * `lib/warehouseRunErrors` and `lib/warehouseVerdict` (pure, node-tested);
 * this file is only the query layer.
 *
 * TWO GATES ON EVERY QUERY, NOT ONE.
 *
 *  - `useOnlineQueryGate` is the usual offline/auth gate. Offline a query never
 *    runs, which in TanStack v5 is status "pending" with fetchStatus "idle" —
 *    `isLoading` FALSE and `isError` FALSE — so a screen that falls through to
 *    "no runs" would be inventing a fact. `QueryStates` owns that branch.
 *  - `allowed` carries the ROLE decision. Every `/api/v1/warehouse/*` route is
 *    owner/admin-only once `routeauth.Middleware` has had its say (see the
 *    note at the top of `api/warehouseRuns.ts`), so for any other role these
 *    requests can only ever answer 403. Firing them anyway would spend a
 *    cellular round trip to be told something the client already knows, and
 *    would paint a generic error over a screen whose real state is "your role
 *    cannot see this".
 *
 * STALENESS. Runs are the live thing on this screen and get the short window;
 * the connection roster is configuration that changes when somebody edits it
 * on a desktop, so it gets a long one. Row errors belong to a run that has
 * already finished — they are IMMUTABLE once written, so their window is the
 * longest of the three and re-selecting a run re-reads nothing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchWarehouseConnectionHealth,
  listWarehouseConnections,
  listWarehouseRunErrors,
  listWarehouseRuns,
  pauseWarehouseConnection,
  WAREHOUSE_RUNS_PAGE_SIZE,
} from "@/api/warehouseRuns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { WarehouseRowError } from "@/lib/warehouseRunErrors";
import type {
  WarehouseConnection,
  WarehouseConnectionHealth,
  WarehouseRun,
} from "@/lib/warehouseRuns";

export type {
  WarehouseConnection,
  WarehouseConnectionHealth,
  WarehouseRun,
} from "@/lib/warehouseRuns";
export type { WarehouseRowError } from "@/lib/warehouseRunErrors";

const RUNS_STALE_MS = 20_000;
const CONNECTIONS_STALE_MS = 300_000;
const RUN_ERRORS_STALE_MS = 600_000;
const HEALTH_STALE_MS = 60_000;

export function useWarehouseRuns(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<WarehouseRun[]>({
    queryKey: ["warehouse", "runs", gate.tenantId, WAREHOUSE_RUNS_PAGE_SIZE],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: RUNS_STALE_MS,
    queryFn: () => listWarehouseRuns(WAREHOUSE_RUNS_PAGE_SIZE),
  });
}

export function useWarehouseConnections(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<WarehouseConnection[]>({
    queryKey: ["warehouse", "connections", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: CONNECTIONS_STALE_MS,
    queryFn: () => listWarehouseConnections(),
  });
}

/**
 * One run's row-error ledger.
 *
 * Fetched for whichever run is selected, INCLUDING failed ones. A failed run's
 * ledger is empty by construction (`failRun` rolls back the transaction the
 * errors were written in — see `lib/warehouseRunErrors`), and this could skip
 * the call on that reasoning alone. It does not: the reading is from source,
 * not from a contract, and a skipped fetch would silently hide rows if that
 * reading is ever wrong. One cheap request, and `runEvidence` explains what
 * came back.
 */
export function useWarehouseRunErrors(runId: string | null, allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<WarehouseRowError[]>({
    queryKey: ["warehouse", "run-errors", gate.tenantId, runId],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && allowed && Boolean(runId),
    staleTime: RUN_ERRORS_STALE_MS,
    queryFn: () => listWarehouseRunErrors(String(runId)),
  });
}

export function useWarehouseConnectionHealth(
  connectionId: string | null,
  allowed: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<WarehouseConnectionHealth>({
    queryKey: ["warehouse", "health", gate.tenantId, connectionId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      allowed &&
      Boolean(connectionId),
    staleTime: HEALTH_STALE_MS,
    queryFn: () => fetchWarehouseConnectionHealth(String(connectionId)),
  });
}

/**
 * Pause a connection.
 *
 * NOT optimistic. The server answers with the updated connection, so the truth
 * arrives on the next read; flipping the card to "paused" locally would be
 * asserting a state change before the server confirmed one, and this is the
 * one write on the screen whose whole value is that it definitely happened.
 *
 * Invalidates `health` and `connections` — the two reads whose answers this
 * changes. `runs` is deliberately left alone: pausing does not rewrite history,
 * and re-fetching fifty rows to show the same fifty rows is a cellular cost
 * with no information in it.
 */
export function usePauseWarehouseConnection() {
  const client = useQueryClient();
  return useMutation<unknown, unknown, string>({
    mutationFn: (connectionId: string) =>
      pauseWarehouseConnection(connectionId),
    onSuccess: (_data, connectionId) => {
      void client.invalidateQueries({ queryKey: ["warehouse", "connections"] });
      void client.invalidateQueries({
        queryKey: ["warehouse", "health"],
        predicate: (query) => query.queryKey.includes(connectionId),
      });
    },
  });
}
