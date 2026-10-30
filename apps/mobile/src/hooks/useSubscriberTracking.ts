/**
 * useSubscriberTracking — read + set one contact's tracking preferences.
 *
 * The QUERY carries the strong ETag alongside the parsed prefs, because the
 * write is conditional on exactly that token (api/subscribersTracking.ts):
 * the toggle the operator flips must bind to the state they were shown, and
 * a 412 after someone else moved it is the correct outcome, surfaced as a
 * refresh prompt rather than retried blind.
 *
 * ONLINE-ONLY: tracking consent is subscriber evidence — the same class as
 * every other consent write on this profile, and none of them queue offline.
 * `staleTime: 0` — the subscriber can change this from their own inbox.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchTrackingPrefs,
  patchTrackingPrefs,
} from "@/api/subscribersTracking";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberWriteKey, subscriberWriteQueue } from "@/lib/serialQueue";
import {
  buildTrackingPatchBody,
  parseTrackingPrefs,
  type TrackingPrefsState,
} from "@/lib/subscriberTracking";

export function subscriberTrackingKey(
  tenantId: string | null | undefined,
  subscriberId: string,
): readonly unknown[] {
  return ["subscriber-tracking", tenantId ?? null, subscriberId];
}

export interface TrackingPrefsWithTag {
  prefs: TrackingPrefsState | null;
  etag: string;
}

export function useSubscriberTracking(
  subscriberId: string | undefined,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberTrackingKey(gate.tenantId, subscriberId ?? ""),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    staleTime: 0,
    queryFn: async (): Promise<TrackingPrefsWithTag> => {
      const res = await fetchTrackingPrefs(subscriberId!);
      return { prefs: parseTrackingPrefs(res.body), etag: res.etag };
    },
  });
}

export interface TrackingToggleWrite {
  subscriberId: string;
  dimension: "open" | "click";
  nextOptOut: boolean;
  /** The token from the query the operator was LOOKING AT. */
  etag: string;
}

export function useSetSubscriberTracking() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (input: TrackingToggleWrite) =>
      subscriberWriteQueue(subscriberWriteKey(input.subscriberId), () =>
        patchTrackingPrefs(
          input.subscriberId,
          input.etag,
          buildTrackingPatchBody(input.dimension, input.nextOptOut),
        ),
      ),
    // No optimistic projection — the EFFECTIVE state (incl. GPC) is computed
    // server-side, and a guessed switch position misreports the law.
    onSettled: (_data, _error, input) => {
      if (!tenantId) return;
      void queryClient.invalidateQueries({
        queryKey: subscriberTrackingKey(tenantId, input.subscriberId),
      });
    },
  });
}
