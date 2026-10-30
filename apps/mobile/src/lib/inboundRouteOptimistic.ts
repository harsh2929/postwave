/**
 * lib/inboundRouteOptimistic.ts — switching one inbound routing rule off or
 * on as a PROJECTED write: the row moves on tap, and moves back if the
 * server refuses.
 *
 * WHY OPTIMISM IS HONEST FOR THIS WRITE. `enabled` is a stored boolean the
 * server writes verbatim — `enabled = COALESCE($6, enabled)`
 * (apps/api/internal/inbound_email/routes.go:787) — and the PATCH answers
 * 204 with no body (:823). There is nothing in the response the client could
 * learn that it did not already know, so the projected row and the refetched
 * row agree by construction; the only visible effect of projecting is that
 * the verb on the control, the "switched off" note and the live/off pill on
 * the rule's row stop disagreeing with the tap for one round trip.
 * Everything the server COMPUTES on the row — `match_count`,
 * `last_matched_at` — is left untouched, which is the line
 * optimisticQueries.ts draws.
 *
 * THE ORDER OF THE THREE STEPS IS THE POLICY:
 *   1. refuse offline BEFORE projecting — a rule toggle is never outboxed
 *      (lib/inboundRouteToggle.ts), and a projection that could only ever be
 *      rolled back is a flicker, not feedback;
 *   2. cancel in-flight fetches, snapshot, project the rules list under its
 *      tenant key;
 *   3. on failure restore the snapshot verbatim; on either outcome refetch
 *      the list, so the row ends on the server's answer.
 *
 * WHY THE QUERY KEY IS DECLARED HERE. A projection aimed at a key the list
 * query does not use fails SILENTLY (setQueriesData matching nothing is not
 * an error). hooks/useInboundRoutes.ts declares its key inline, so the test
 * beside this file reads that source and pins its shape to this function.
 *
 * Free of react-native imports so the whole policy — refusal, projection,
 * rollback, invalidation — is driven under the node vitest environment by a
 * real QueryClient and MutationObserver.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { InboundRouteOfflineError, toggleVerb } from "./inboundRouteToggle";
import type { InboundRoute } from "./inboundRoutes";
import {
  optimisticTriad,
  patchRowById,
  type OptimisticSnapshot,
  type OptimisticTriad,
} from "./optimisticQueries";

/** Query-key root shared by every inbound-routing query. */
export const INBOUND_ROUTES_KEY = "inbound-routes";

/** The rules list, per tenant — the ONE cache entry a toggle projects into. */
export function inboundRoutesRulesKey(
  tenantId: string | null | undefined,
): QueryKey {
  return [INBOUND_ROUTES_KEY, "rules", tenantId ?? null];
}

/**
 * The whole route, not an id: the PATCH payload must echo the row's priority
 * and matchers (lib/inboundRouteEnabledPayload.ts), and the projection needs
 * nothing more than its id.
 */
export interface InboundRouteEnabledVars {
  route: InboundRoute;
  enabled: boolean;
}

/** Flip `enabled` on the addressed row only; the same array back if absent. */
export function projectRouteEnabled(
  rows: InboundRoute[] | undefined,
  vars: InboundRouteEnabledVars,
): InboundRoute[] | undefined {
  return patchRowById(rows, vars.route.id, { enabled: vars.enabled });
}

export function inboundRouteEnabledTriad(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
): OptimisticTriad<InboundRouteEnabledVars> {
  return optimisticTriad<InboundRoute[], InboundRouteEnabledVars>(
    queryClient,
    inboundRoutesRulesKey(tenantId),
    projectRouteEnabled,
  );
}

export interface InboundRouteEnabledDeps {
  /** Read at CALL time, not render time — connectivity moves between the two. */
  isOnline: () => boolean;
  /** The transport: api/inboundRouteEnabled.patchInboundRouteEnabled. */
  patch: (route: InboundRoute, enabled: boolean) => Promise<void>;
}

/** Spread-ready for useMutation; structurally a MutationObserverOptions. */
export interface InboundRouteEnabledMutation {
  mutationFn: (vars: InboundRouteEnabledVars) => Promise<void>;
  onMutate: (vars: InboundRouteEnabledVars) => Promise<OptimisticSnapshot>;
  onError: (
    error: Error,
    vars: InboundRouteEnabledVars,
    context: OptimisticSnapshot | undefined,
  ) => void;
  onSettled: () => void;
}

/**
 * The complete mutation policy, with the transport and the connectivity
 * read injected so a node test can drive every branch through a real
 * QueryClient. hooks/useInboundRouteEnabled.ts is the one production caller.
 */
export function inboundRouteEnabledMutation(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
  deps: InboundRouteEnabledDeps,
): InboundRouteEnabledMutation {
  const triad = inboundRouteEnabledTriad(queryClient, tenantId);
  return {
    mutationFn: ({ route, enabled }) => deps.patch(route, enabled),
    onMutate: async (vars) => {
      // Thrown from onMutate, not mutationFn: TanStack runs onMutate first,
      // so a refusal here reaches onError with NO context and nothing to
      // undo — the row never moves for a write that was never going to be
      // sent, and the refusal copy is still what rejects the mutation.
      if (!deps.isOnline()) throw new InboundRouteOfflineError();
      return triad.onMutate(vars);
    },
    onError: triad.onError,
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: inboundRoutesRulesKey(tenantId),
      });
    },
  };
}

function isOfflineRefusal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "offline_write_refused"
  );
}

/**
 * The sentence raised when the row has just moved back.
 *
 * `attemptedEnabled` is the value the tap tried to SET. The verb pairs in
 * lib/inboundRouteToggle.ts are keyed by the state a rule is IN, so the
 * attempt to set `false` is described by the verbs for an enabled rule —
 * "Couldn't switch the rule off" — never the other way round.
 *
 * The server's sentence (or the transport's) is appended verbatim when there
 * is one; nothing is paraphrased and no cause is invented. An offline
 * refusal stands alone: nothing was projected, so there is no "moved back"
 * to explain, and its copy already says what to do.
 */
export function rollbackNotice(
  error: unknown,
  attemptedEnabled: boolean,
): string {
  if (isOfflineRefusal(error)) return error.message;
  const lead = toggleVerb(!attemptedEnabled).failureToast.replace(/\.$/, "");
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `${lead} — ${detail}` : `${lead}.`;
}
