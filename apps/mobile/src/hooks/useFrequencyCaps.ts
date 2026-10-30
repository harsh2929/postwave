/**
 * hooks/useFrequencyCaps.ts — the per-subscriber send caps, read and toggled.
 *
 * Endpoint choice, authorisation and the two-parallel-surfaces trap are all
 * explained in lib/frequencyCaps.ts; parsing lives there too. This file is the
 * query wiring and the one mutation.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  parseFrequencyCap,
  parseFrequencyCaps,
  type FrequencyCap,
} from "@/lib/frequencyCaps";

/**
 * Caps change when a human edits them, which on this workspace happens on
 * desktop and rarely. A minute of staleness is generous and a focus refetch of
 * a handful of rows is cheap, so this is tuned for "correct after a pull",
 * not for live-ness.
 */
const CAPS_STALE_MS = 30_000;

export function useFrequencyCaps() {
  const gate = useOnlineQueryGate();
  return useQuery<FrequencyCap[]>({
    queryKey: ["frequency-caps", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CAPS_STALE_MS,
    queryFn: async (): Promise<FrequencyCap[]> => {
      const { client } = getClient();
      return parseFrequencyCaps(
        await client.request<unknown>("GET", "/api/v1/frequency-caps"),
      );
    },
  });
}

/**
 * Writes here are online-only and never queued.
 *
 * A queued "turn this cap off" replayed an hour later lands on a rule someone
 * may have deliberately turned back on, and silently undoes them — with nobody
 * watching for the result. Worse, the reason to touch a cap from a phone is
 * usually urgent ("the send is being throttled, let it through"), and an
 * urgent action that quietly waits for connectivity is the failure mode
 * queueing is supposed to prevent. Refusing at the moment of the tap is the
 * honest answer. Mirrors DiscountOfflineError.
 */
export class FrequencyCapOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super("Changing a frequency cap needs a connection. Reconnect and try again.");
    this.name = "FrequencyCapOfflineError";
  }
}

export function useToggleFrequencyCap() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { id: string; active: boolean }) => {
      if (!isProbablyOnline()) throw new FrequencyCapOfflineError();
      const { client } = getClient();
      return parseFrequencyCap(
        await client.request<unknown>(
          "PATCH",
          `/api/v1/frequency-caps/${encodeURIComponent(input.id)}`,
          { body: { active: input.active } },
        ),
      );
    },
    // Re-read rather than patching the row in place: `Patch` runs the same
    // `ValidateCap` the create path runs and can legitimately return a row
    // that differs from what was sent.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["frequency-caps", tenantId],
      });
    },
  });
}
