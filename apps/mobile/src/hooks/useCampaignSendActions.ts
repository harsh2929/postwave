/**
 * hooks/useCampaignSendActions.ts — the campaign writes that PUT MAIL IN
 * FLIGHT: the one-off test send and the resend-to-non-openers follow-up.
 *
 * Split out of useCampaigns.ts, which had grown past its file budget carrying
 * types, list/detail reads, the report read and every mutation at once. The
 * reads and the writes have genuinely different concerns — a read is
 * snapshot-backed and cacheable, a send is neither — so they now live apart.
 *
 * Re-exported from `@/hooks/useCampaigns` so existing call sites are unchanged.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { plural } from "@/lib/format";

/**
 * isValidTestEmail — minimal, deliberately lenient email shape check for
 * the test-send recipient field. Pure so it can be unit-tested and reused
 * to gate the Send button. Trims; requires a single `@` with non-empty
 * local + domain parts and a dot in the domain. Not RFC-complete — the
 * gateway is the real validator — just enough to catch obvious typos
 * before a round-trip.
 */
export function isValidTestEmail(raw: string | undefined | null): boolean {
  const v = (raw ?? "").trim();
  if (!v || v.length > 254) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  if (!domain || /\s/.test(v)) return false;
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/**
 * useSendTestCampaign — send a one-off test of a draft to a recipient
 * before approve/send. Thin wrapper over the SDK's typed
 * `campaigns.sendTest` (POST /api/v1/campaigns/{id}/test-send). No cache
 * invalidation: a test send doesn't mutate the campaign or its report.
 */
export function useSendTestCampaign() {
  return useMutation({
    mutationFn: async (input: { campaignId: string; toEmail: string }) => {
      const { client } = getClient();
      return client.campaigns.sendTest({
        campaignId: input.campaignId,
        toEmail: input.toEmail.trim(),
      });
    },
  });
}

/**
 * Response shape of POST /api/v1/campaigns/{id}/resend-to-non-openers.
 * Mirrors the Go handler `Deps.ResendToNonOpeners` in
 * apps/api/internal/campaigns/handlers_send_domain.go: it clones the
 * parent campaign and enqueues only the subscribers who received but
 * never opened it, returning the clone plus recipient counts.
 */
export interface ResendToNonOpenersResponse {
  /** The freshly minted clone campaign (subset of CampaignDetail). */
  campaign: { id: string; name?: string; subject?: string; status?: string };
  /** How many non-opener recipients were enqueued on the clone. */
  recipients_queued: number;
  /** Total non-openers found for the parent (== recipients_queued today). */
  non_openers_total: number;
}

/**
 * resendSummaryMessage — pure copy-builder for the post-resend success
 * Alert. Exported so the count/pluralisation logic is unit-testable and
 * can't silently regress. Falls back to `non_openers_total` when the
 * queued count is absent, and reads cleanly when there were no openers
 * to chase.
 */
export function resendSummaryMessage(
  res: Pick<
    ResendToNonOpenersResponse,
    "recipients_queued" | "non_openers_total"
  >,
): string {
  const n = res.recipients_queued ?? res.non_openers_total ?? 0;
  if (n <= 0) {
    return "No non-openers to resend to — everyone who received this campaign opened it.";
  }
  return `Queued a follow-up to ${plural(n, "non-opener")}. The clone is in your campaigns list.`;
}

/**
 * useResendToNonOpeners — POST /api/v1/campaigns/{id}/resend-to-non-openers.
 *
 * Clones an already-sent campaign and queues a follow-up send to the
 * subscribers who received the original but never opened it.
 *
 * The Go handler accepts `{ subject, send_at }` (handlers_send_domain.go
 * resendInput). Mobile used to send NEITHER, so the clone inherited the
 * parent's subject and went out immediately — re-mailing an identical
 * subject line to the same inboxes minutes apart, which is the exact
 * pattern that gets a sending domain flagged. Both are now required of the
 * caller and are guarded by src/lib/campaignResend.ts, matching the rules
 * desktop's equivalent route enforces server-side.
 *
 * The SDK doesn't expose a typed method for this send-domain route, so this
 * uses the SDK's typed public transport until the endpoint gains a generated
 * domain resource.
 */
export function useResendToNonOpeners() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      campaignId: string;
      subject?: string;
      sendAt?: string | null;
    }): Promise<ResendToNonOpenersResponse> => {
      const { client } = getClient();
      const body = {
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.sendAt ? { send_at: input.sendAt } : {}),
      };
      return client.request<ResendToNonOpenersResponse>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(input.campaignId)}/resend-to-non-openers`,
        { body },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
    },
  });
}
