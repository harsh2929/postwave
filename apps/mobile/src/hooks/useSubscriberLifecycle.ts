/**
 * useSubscriberLifecycle — `GET /api/v1/subscribers/{id}/lifecycle`.
 *
 * Read-only on mobile. The WRITE half (PUT) requires an exact `If-Match`
 * parent revision and rejects stale ones rather than overwriting a
 * concurrent profile edit — correct, and not something to drive from a
 * phone card that has no way to show the operator what it would clobber.
 * Reading answers the question a phone actually asks ("where is this
 * person in our funnel?"); editing stays desktop work.
 *
 * A 404 here is legitimate on older gateways, so the card renders nothing
 * on error instead of an alarming failure line.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseSubscriberLifecycle,
  type SubscriberLifecycle,
} from "@/lib/subscriberLifecycle";

export function subscriberLifecycleKey(
  tenantId: string | null | undefined,
  id: string | null | undefined,
): readonly unknown[] {
  return ["sub-lifecycle", tenantId ?? null, id ?? null];
}

export function useSubscriberLifecycle(id: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberLifecycleKey(gate.tenantId, id),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    // A funnel stage does not move while you look at it, and this rides
    // alongside the profile's other reads on every open.
    staleTime: 60_000,
    // A gateway without the route answers 404; retrying it three times per
    // profile open is pure latency.
    retry: false,
    queryFn: async (): Promise<SubscriberLifecycle | null> => {
      const { client } = getClient();
      return parseSubscriberLifecycle(
        await client.request<unknown>(
          "GET",
          `/api/v1/subscribers/${encodeURIComponent(id!)}/lifecycle`,
        ),
      );
    },
  });
}
