/**
 * useSubscriberResubscribeConsent — re-enable a subscriber THROUGH a consent
 * review, the way desktop's SubscriberStatusConsentModal does.
 *
 * Mobile's Resubscribe used to be a bare `{status:"enabled"}` PATCH with an
 * undo toast. Same route, same role — but no consent evidence, so the phone's
 * re-enable was compliance-weaker than the identical act on desktop and the
 * ledger could not say who reviewed what. This mutation submits the FULL
 * evidence envelope built by `buildResubscribeConsentPatch`.
 *
 * ONLINE-ONLY AND NO UNDO, DELIBERATELY:
 *  - a consent grant must never replay from an offline queue hours later —
 *    the subscriber may have unsubscribed again in between, and a replayed
 *    grant would overwrite their decision (desktop enforces the same with
 *    `requireOnline: true, maxAttempts: 1`);
 *  - there is no "undo" that un-records evidence — the reversal of a grant is
 *    an unsubscribe, which is its own deliberate act.
 *
 * The write runs inside the per-subscriber serial queue with a freshly read
 * If-Match token (api/subscriberConditionalWrite.ts), like every other
 * subscriber PATCH on mobile.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { updateSubscriberConditionally } from "@/api/subscriberConditionalWrite";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  subscriberWriteKey,
  subscriberWriteQueue,
} from "@/lib/serialQueue";
import { buildResubscribeConsentPatch } from "@/lib/subscriberConsentEvidence";
import type { ConsentEvidenceDraft } from "@/lib/subscriberConsentEvidence";
import { invalidateKeys } from "@/lib/subscriberQueryCache";
import { subscriberMutationInvalidationKeys } from "@/lib/subscriberQueryKeys";

export interface ResubscribeConsentInput {
  id: string;
  draft: ConsentEvidenceDraft;
}

export function useSubscriberResubscribeConsent() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: ResubscribeConsentInput): Promise<unknown> => {
      const patch = buildResubscribeConsentPatch(input.draft);
      // The sheet validates before submitting; this guard is what makes a
      // half-filled envelope impossible to POST even if a future caller skips
      // the sheet.
      if (!patch) {
        throw new Error(
          "The consent evidence is incomplete, so nothing was recorded.",
        );
      }
      return subscriberWriteQueue(subscriberWriteKey(input.id), () =>
        updateSubscriberConditionally(input.id, patch),
      );
    },
    // No optimistic projection: the pill flipping to "Subscribed" before the
    // server accepted the EVIDENCE would show a grant that may yet be refused
    // (409 on a protected suppression, 412 on a concurrent change).
    onSettled: (_data, _error, input) => {
      if (!tenantId) return;
      invalidateKeys(
        queryClient,
        subscriberMutationInvalidationKeys(tenantId, input.id),
      );
    },
  });
}
