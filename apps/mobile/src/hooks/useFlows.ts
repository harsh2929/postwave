/**
 * hooks/useFlows.ts — the flow catalogue, one flow's version history, the
 * manual-review queue, and the two verbs this surface exposes.
 *
 * WHY THE LIST IS NOT PAGINATED HERE. `ListFlows` supports a keyset cursor and
 * this app asks for 50 (api/flows.FLOW_PAGE_SIZE). A flow row carries the
 * ENTIRE graph — `flowSelectSQL` LEFT JOINs the newest version and `scanFlow`
 * prefers its graph — so rows are heavy, and 50 heavy rows is already more
 * automation than any workspace has. `nextCursor` is still parsed and surfaced
 * so the screen can SAY there are more rather than silently showing a subset:
 * a truncated list that looks complete is the failure this codebase keeps
 * finding.
 *
 * WHY THE DETAIL QUERY EXISTS AT ALL, GIVEN THE LIST HAS THE GRAPH. It makes
 * what you are reading CURRENT, not complete. The sheet renders the tapped
 * row's graph on the first frame — no spinner, no empty topology — and the
 * single-flow read refreshes it underneath. That is why `useFlow` is not
 * gated behind the sheet's data being absent, and why the sheet never blocks
 * on it.
 *
 * WHY NOTHING IS OPTIMISTIC AND NOTHING IS QUEUED OFFLINE. A decision is
 * FINAL: nothing in `flow_approvals` returns a decided row to `requested`, and
 * `Decide` 409s on a second attempt. A decision released from an offline queue
 * hours later would let a flow past a human gate at a moment nobody chose, and
 * could not be taken back. The mutation is online-only by construction — it is
 * never registered in lib/offlineMutationContract, so the queue in
 * lib/offlineMutations never sees it.
 *
 * WHY THE APPROVALS QUERY ASKS FOR A STATUS. `Repo.List` (flow_approvals.go:52)
 * is a bare SELECT with NO LIMIT and no cursor. Asking for the whole table
 * would put a tenant's entire decision history on a phone connection, so the
 * queue asks for exactly the set it can act on.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  decideFlowApproval,
  fetchFlow,
  fetchFlowApprovals,
  fetchFlowCatalog,
  fetchFlowVersions,
  fetchFlows,
  validateFlowGraph,
} from "@/api/flows";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { FlowPage, MobileFlow, MobileFlowVersion } from "@/lib/flowWire";
import type {
  FlowApprovalDecision,
  MobileFlowApproval,
} from "@/lib/flowApprovals";
import type { MobileFlowCatalog } from "@/lib/flowCatalog";
import type {
  FlowValidateBody,
  MobileFlowValidation,
} from "@/lib/flowValidation";

const FLOWS_KEY = "flows";
const FLOW_DETAIL_KEY = "flow-detail";
const FLOW_VERSIONS_KEY = "flow-versions";
const FLOW_APPROVALS_KEY = "flow-approvals";
const FLOW_CATALOG_KEY = "flow-catalog";

/**
 * Flows are standing configuration authored on a desktop, not a live feed. The
 * runtime is contained (flowbuilder.go:27), so nothing about a flow changes on
 * its own — only an edit changes it, and edits do not happen on this device.
 */
const FLOWS_STALE_MS = 120_000;

/**
 * The review queue is the one thing here another human moves while you are
 * looking at it. Short, so a teammate's decision shows up rather than leaving
 * two people to race for a 409.
 */
const APPROVALS_STALE_MS = 15_000;

/**
 * The pending set — `Repo.Decide`'s own predicate is `IN
 * ('requested','marketing')`, but a query can only carry one value, and
 * `requested` is the one the engine's gate actually writes
 * (`RequestOrCheck` inserts it literally). `marketing` rows are the column
 * DEFAULT and are decidable but never requested by the gate, so they are not
 * part of the queue this screen asks the server for.
 */
export const PENDING_APPROVAL_STATUS = "requested";

export function flowsQueryKey(
  tenantId: string | null | undefined,
  status: string,
): readonly unknown[] {
  return [FLOWS_KEY, tenantId ?? null, status];
}

export function flowDetailQueryKey(
  tenantId: string | null | undefined,
  flowId: string | null,
): readonly unknown[] {
  return [FLOW_DETAIL_KEY, tenantId ?? null, flowId];
}

export function flowVersionsQueryKey(
  tenantId: string | null | undefined,
  flowId: string | null,
): readonly unknown[] {
  return [FLOW_VERSIONS_KEY, tenantId ?? null, flowId];
}

export function flowApprovalsQueryKey(
  tenantId: string | null | undefined,
  status: string,
): readonly unknown[] {
  return [FLOW_APPROVALS_KEY, tenantId ?? null, status];
}

export function flowCatalogQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [FLOW_CATALOG_KEY, tenantId ?? null];
}

/**
 * `Catalog()` builds a Go LITERAL — no database, no tenant state, nothing that
 * can change without a deploy. So this is stale for a working day and the
 * persisted cache carries it across cold starts; the whole point is that a
 * screen already holding a graph never waits on it.
 */
const CATALOG_STALE_MS = 8 * 60 * 60_000;

/**
 * The server's node/trigger catalogue, used to LABEL a stored graph.
 *
 * Keyed by tenant like every other query here — not because the catalogue
 * varies by tenant (it does not) but because this app persists its cache to an
 * encrypted vault and every entry in it must be evictable with one tenant's
 * key when that session ends.
 *
 * A failure is not surfaced anywhere. `flowLabels(null)` is the shipped
 * behaviour of the last fifteen builds, so a catalogue that does not arrive
 * costs nothing an operator can see — and an error banner over a screen that
 * is rendering correctly would be worse than silence.
 */
export function useFlowCatalog() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowCatalogQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CATALOG_STALE_MS,
    queryFn: (): Promise<MobileFlowCatalog | null> => fetchFlowCatalog(),
  });
}

/**
 * Ask the server's validator about one stored graph.
 *
 * A MUTATION RATHER THAN A QUERY, and not because of the verb. It is on-demand
 * by design: the answer is a considered question an operator asks about ONE
 * flow, not something to fetch for every row in a list — `POST` behind
 * `write:campaigns` is not a thing to fire on render. Nothing is cached either,
 * because a cached verdict outlives the graph it judged.
 *
 * NEVER QUEUED OFFLINE. It has no `offlineSafeMutationMeta` and is not in
 * lib/offlineMutationContract, so the offline queue never sees it: a verdict
 * replayed from a plane hours later would describe a graph, on a screen that
 * has closed, that someone may have since fixed.
 */
export function useValidateFlowGraph() {
  return useMutation<MobileFlowValidation, Error, FlowValidateBody>({
    mutationFn: (body) => validateFlowGraph(body),
  });
}

/** `status` of "" means every status — the server treats it as no filter. */
export function useFlows(status: string) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowsQueryKey(gate.tenantId, status),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: FLOWS_STALE_MS,
    queryFn: (): Promise<FlowPage> => fetchFlows({ status }),
  });
}

/**
 * One flow, refreshed. `staleTime: 0` because the sheet is opened precisely to
 * read the graph, and the list behind it may be two minutes old.
 */
export function useFlow(flowId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowDetailQueryKey(gate.tenantId, flowId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(flowId),
    staleTime: 0,
    queryFn: (): Promise<MobileFlow | null> => fetchFlow(flowId!),
  });
}

/**
 * Version history. Lazy — it is a second request, and the list row already
 * carries `latest_version`, so the sheet can name the newest version before
 * this resolves and only needs the rest when someone looks.
 */
export function useFlowVersions(flowId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowVersionsQueryKey(gate.tenantId, flowId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(flowId),
    staleTime: FLOWS_STALE_MS,
    queryFn: (): Promise<readonly MobileFlowVersion[]> =>
      fetchFlowVersions(flowId!),
  });
}

export function useFlowApprovals(status: string) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowApprovalsQueryKey(gate.tenantId, status),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: APPROVALS_STALE_MS,
    queryFn: (): Promise<MobileFlowApproval[]> => fetchFlowApprovals(status),
  });
}

export interface DecideApprovalInput {
  id: string;
  decision: FlowApprovalDecision;
}

export function useDecideFlowApproval() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<MobileFlowApproval | null, Error, DecideApprovalInput>({
    mutationFn: ({ id, decision }) => decideFlowApproval(id, decision),
    onSuccess: () => {
      // The decided row LEAVES the pending set, so the queue this screen is
      // showing is now wrong by exactly one row. Invalidating the whole
      // approvals family rather than one status key also catches the "decided"
      // list, which has gained that same row.
      void queryClient.invalidateQueries({
        queryKey: [FLOW_APPROVALS_KEY, gate.tenantId],
      });
    },
  });
}
