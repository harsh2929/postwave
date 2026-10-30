/**
 * optimisticWrites — the per-surface optimistic projections, next to the
 * query keys they patch.
 *
 * Why the keys live HERE and not in the hooks: a projection that addresses a
 * key the query does not actually use fails SILENTLY (setQueriesData matching
 * nothing is not an error), so the hook and the projection must read the key
 * from one definition. The hooks below import these; nothing re-declares a
 * key literal.
 *
 * Everything in this module is free of react-native imports so the triads can
 * be driven end to end — including the failure path — by a real QueryClient
 * and MutationObserver under the node test environment.
 *
 * Each triad is paired with a note on why optimism is HONEST for that write.
 * See optimisticQueries.ts for the general rule.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  appendRowIfAbsent,
  optimisticTriad,
  patchRowById,
  type OptimisticTriad,
} from "./optimisticQueries";
import { markConversationReadInPage } from "./smsConversation";
import type { SmsConversationsPage } from "./smsConversation";
import { subscriberListsKey } from "./subscriberQueryKeys";

/* ============================================================
 * Outbound webhooks — pause / resume
 * ============================================================ */

/** Query-key root for the endpoint list. */
export const OUTBOUND_WEBHOOKS_KEY = "outbound-webhooks";

export function outboundWebhookEndpointsKey(
  tenantId: string | null | undefined,
): QueryKey {
  return [OUTBOUND_WEBHOOKS_KEY, tenantId ?? null];
}

/**
 * Pause/resume is a single boolean on one row that the server stores
 * verbatim (PATCH /outbound-webhooks/{id} {active}) — the client already
 * knows the answer, so the switch has no business waiting for a round trip.
 * A failure puts the switch back and the screen raises an error toast.
 *
 * Deliberately NOT applied to the sibling `reEnable`: that one resets the
 * circuit breaker, and `consecutive_failures` is a server-computed counter.
 */
export function webhookActiveTriad<TRow extends { id: string; active: boolean }>(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
): OptimisticTriad<{ id: string; active: boolean }> {
  return optimisticTriad<TRow[], { id: string; active: boolean }>(
    queryClient,
    outboundWebhookEndpointsKey(tenantId),
    (rows, vars) =>
      patchRowById(rows, vars.id, { active: vars.active } as Partial<TRow>),
  );
}

/* ============================================================
 * SMS inbox — mark a conversation read
 * ============================================================ */

/** Query-key root for the conversation list (one entry per filter tab). */
export const SMS_CONVERSATIONS_KEY = "sms-conversations";

/**
 * PREFIX key: the list query appends its filter (`all` | `unread` |
 * `unknown`), and marking a thread read must clear the badge on every tab
 * that has it cached, not just the one on screen.
 */
export function smsConversationsKey(
  tenantId: string | null | undefined,
): QueryKey {
  return [SMS_CONVERSATIONS_KEY, tenantId ?? null];
}

/**
 * Opening a thread IS reading it, and the screen fires this as background
 * bookkeeping. The unread pip and the inbox total are both computed from
 * numbers already in the cache, so the projection is exact rather than a
 * guess — and until now the pip stayed lit all the way back to the inbox.
 */
export function conversationReadTriad(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
): OptimisticTriad<string> {
  return optimisticTriad<SmsConversationsPage, string>(
    queryClient,
    smsConversationsKey(tenantId),
    (page, phoneE164) => markConversationReadInPage(page, phoneE164),
  );
}

/* ============================================================
 * Subscriber list membership — add
 * ============================================================ */

/** One list a subscriber belongs to (apps/api SubscriberListRef). */
export interface SubscriberListMembership {
  id: string;
  name: string;
}

export interface MembershipAddVars {
  id: string;
  listId: string | number;
}

/**
 * The mirror of the removal projection that already ships: removing a
 * membership was instant while adding one — including the UNDO of a removal —
 * sat on a spinner, so the same card behaved two different ways depending on
 * which direction the user went.
 *
 * The write is idempotent server-side (ON CONFLICT DO NOTHING) and its result
 * is fully known client-side once the name is resolved, so nothing is being
 * invented. `resolveName` reads the already-cached list catalogue; when the
 * catalogue is not loaded the caller passes the id and the row is corrected
 * by the refetch in onSettled.
 */
export function membershipAddTriad(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
  resolveName: (listId: string) => string,
): OptimisticTriad<MembershipAddVars> {
  return optimisticTriad<SubscriberListMembership[], MembershipAddVars>(
    queryClient,
    (vars) => subscriberListsKey(tenantId, vars.id) as QueryKey,
    (rows, vars) => {
      const listId = String(vars.listId);
      return appendRowIfAbsent(rows, { id: listId, name: resolveName(listId) });
    },
  );
}
