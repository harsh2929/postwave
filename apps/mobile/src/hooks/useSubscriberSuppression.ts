/**
 * useSubscriberSuppression — the deliverability suppression record for one
 * contact, read straight from the compliance table rather than inferred
 * from the subscriber's status.
 *
 *   GET /api/v1/deliverability/suppressions?page=1&size=5&email=<address>
 *
 * `email=` is an exact citext match server-side (apps/api/internal/
 * suppressions/handlers.go List, "A20"), so this is a point lookup, not a
 * scan. `size=5` rather than 1 only so a legacy gateway that ignores the
 * filter still has a chance of containing the row — `matchSuppressionForEmail`
 * re-checks the address either way and refuses to claim a suppression it
 * cannot prove.
 *
 * Query key sits UNDER the "suppressions" root so the existing
 * `invalidateQueries({queryKey: ["suppressions"]})` in useUnsuppressSubscriber
 * (and the suppressions screen's own writes) refresh this card by prefix
 * match — no second invalidation contract to keep in sync.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { normalizeSuppressionPage } from "@/lib/suppressionPage";
import { isLikelyEmail } from "@/lib/suppressionSearch";
import {
  matchSuppressionForEmail,
  type SuppressionMatch,
} from "@/lib/subscriberSuppression";

/** Small page: the filter is exact, this is only defence-in-depth. */
const LOOKUP_SIZE = 5;

export function subscriberSuppressionKey(
  tenantId: string | null | undefined,
  email: string,
): readonly unknown[] {
  return ["suppressions", tenantId ?? null, "subscriber", email];
}

export function useSubscriberSuppression(email: string | undefined) {
  const gate = useOnlineQueryGate();
  const address = (email ?? "").trim().toLowerCase();
  return useQuery({
    queryKey: subscriberSuppressionKey(gate.tenantId, address),
    // A malformed address can only produce a useless round trip, and the
    // profile renders fine without this card.
    enabled: gate.enabled && Boolean(gate.tenantId) && isLikelyEmail(address),
    queryFn: async (): Promise<SuppressionMatch | null> => {
      const { client } = getClient();
      const page = normalizeSuppressionPage(
        await client.request<unknown>(
          "GET",
          `/api/v1/deliverability/suppressions?page=1&size=${LOOKUP_SIZE}&email=${encodeURIComponent(address)}`,
        ),
      );
      return matchSuppressionForEmail(page.items, address);
    },
  });
}
