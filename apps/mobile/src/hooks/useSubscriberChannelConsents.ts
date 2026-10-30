/**
 * useSubscriberChannelConsents — read and set one contact's per-channel
 * consent rows (SUB-042), the mobile half of desktop's ChannelConsentsPanel.
 *
 * ONLINE-ONLY, like every consent write on this profile: a channel consent is
 * a permission decision, and one replayed from an offline queue hours later
 * would overwrite whatever the subscriber decided in between. The card also
 * refuses the verb while the gate is closed, so this hook never fires from a
 * cached session.
 *
 * `staleTime: 0` for the read — consent-adjacent state the subscriber can
 * change from their own inbox; a cached "opted in" is a claim someone will
 * act on.
 *
 * The write runs inside the per-subscriber serial queue: the PATCH is a
 * conditional write against the PARENT profile version (see the api module),
 * and two interleaved read-token/write pairs would guarantee a spurious 412.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchChannelConsents,
  setChannelConsent,
} from "@/api/subscriberChannelConsents";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberWriteKey, subscriberWriteQueue } from "@/lib/serialQueue";
import {
  parseChannelConsents,
  type ChannelConsentRow,
} from "@/lib/subscriberChannelConsents";
import { buildChannelConsentBody } from "@/lib/subscriberConsentEvidence";
import type { ConsentEvidenceDraft } from "@/lib/subscriberConsentEvidence";
import { invalidateKeys } from "@/lib/subscriberQueryCache";
import { subscriberMutationInvalidationKeys } from "@/lib/subscriberQueryKeys";

export function subscriberChannelConsentsKey(
  tenantId: string | null | undefined,
  subscriberId: string,
): readonly unknown[] {
  return ["subscriber-channel-consents", tenantId ?? null, subscriberId];
}

export function useSubscriberChannelConsents(
  subscriberId: string | undefined,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberChannelConsentsKey(gate.tenantId, subscriberId ?? ""),
    enabled:
      enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    staleTime: 0,
    queryFn: async (): Promise<ChannelConsentRow[]> =>
      parseChannelConsents(await fetchChannelConsents(subscriberId!)),
  });
}

export interface ChannelConsentWrite {
  subscriberId: string;
  channel: string;
  nextStatus: "opted_in" | "opted_out";
  draft: ConsentEvidenceDraft;
}

export function useSetSubscriberChannelConsent() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: ChannelConsentWrite): Promise<unknown> => {
      const body = buildChannelConsentBody(input.draft, input.nextStatus);
      // The sheet validates before submitting; this guard makes a half-filled
      // envelope impossible to PATCH even if a future caller skips the sheet.
      if (!body) {
        throw new Error(
          "The consent evidence is incomplete, so nothing was recorded.",
        );
      }
      return subscriberWriteQueue(subscriberWriteKey(input.subscriberId), () =>
        setChannelConsent(input.subscriberId, input.channel, body),
      );
    },
    // No optimistic projection — a consent row must never SHOW granted before
    // the server accepted the evidence (409 protected suppression, 412 on a
    // concurrent change are both live outcomes).
    onSettled: (_data, _error, input) => {
      if (!tenantId) return;
      void queryClient.invalidateQueries({
        queryKey: subscriberChannelConsentsKey(tenantId, input.subscriberId),
      });
      // The PATCH bumps the parent profile version and may cascade into the
      // email channel's suppression state, so the detail + list caches are
      // stale too.
      invalidateKeys(
        queryClient,
        subscriberMutationInvalidationKeys(tenantId, input.subscriberId),
      );
    },
  });
}
