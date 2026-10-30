/**
 * hooks/useInboundRouteEnabled.ts — the projected off switch for one rule.
 *
 * Wiring only. The policy — refuse offline before projecting, project the
 * tenant's rules list, roll back on failure, refetch on either outcome — is
 * lib/inboundRouteOptimistic.ts, where a node test drives every branch
 * through a real QueryClient; this file injects the two runtime edges it
 * cannot see (connectivity and the transport).
 *
 * The mutation-level callbacks are the point. Per-call `mutate(vars, {...})`
 * callbacks are dropped when the component that called them unmounts, but a
 * rollback must land whether or not the operator is still looking, so the
 * projection and its undo live on the mutation itself. The screen keeps only
 * the toasts per call.
 *
 * The transport is api/inboundRouteEnabled.patchInboundRouteEnabled — NOT
 * api/inboundRoutes.setInboundRouteEnabled. The two differ only in the
 * `actions` field of the body, and that difference is the one the handler as
 * it stands in the working tree refuses with 409 (see the lib header of
 * lib/inboundRouteEnabledPayload.ts). The render test pins this injection.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { patchInboundRouteEnabled } from "@/api/inboundRouteEnabled";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  inboundRouteEnabledMutation,
  type InboundRouteEnabledVars,
} from "@/lib/inboundRouteOptimistic";
import type { OptimisticSnapshot } from "@/lib/optimisticQueries";

export type { InboundRouteEnabledVars } from "@/lib/inboundRouteOptimistic";

export function useSetInboundRouteEnabled() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation<void, Error, InboundRouteEnabledVars, OptimisticSnapshot>(
    inboundRouteEnabledMutation(queryClient, gate.tenantId, {
      isOnline: isProbablyOnline,
      patch: patchInboundRouteEnabled,
    }),
  );
}
