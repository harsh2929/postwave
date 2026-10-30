/**
 * hooks/useCampaignAbHandoff.ts — turn a set of AI subject variants into a
 * real A/B test.
 *
 * Lifted out of CampaignSubjectModal, where it was a ~60-line inline async
 * closure inside a JSX prop, so the split percentage and the audience
 * pre-check (src/lib/campaignAbSplit.ts) can be reasoned about — and tested —
 * separately from the sheet's layout.
 *
 * Behaviour it adds over the inline version:
 *   - passes `split_percentage`, which ABTestCreateInput has always declared
 *     and mobile never sent, so a phone could only ever start an even split;
 *   - refuses BEFORE the POST when the campaign has no list or segment, which
 *     the Go handler rejects (abtest.go:492-494) — previously the operator
 *     lost the streamed variants to a validation error.
 *
 * The request BODY itself is built by lib/campaignAbVariants (pure, node-
 * tested): that is where the G14 multivariate from-name axis and the one-tap
 * bandit's delivery_settings live, along with the ≤8-combo pre-check that
 * refuses a cross-product the server would 400.
 */
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { createABTestCampaign } from "@/api/abTests";
import { useToast } from "@/components/Toast";
import type { CampaignDetail } from "@/hooks/useCampaigns";
import { abHandoffBlockReason } from "@/lib/campaignAbSplit";
import {
  abComboBlockReason,
  buildAbHandoffPayload,
  type AbHandoffOptions,
} from "@/lib/campaignAbVariants";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { haptics } from "@/lib/haptics";

export interface CampaignAbHandoff {
  /** Non-null when the hand-off cannot run; render it instead of the button. */
  blockedReason: string | null;
  pending: boolean;
  run: (
    variants: string[],
    splitPercentage: number | null,
    options?: Omit<AbHandoffOptions, "splitPercentage">,
  ) => void;
}

export function useCampaignAbHandoff(input: {
  campaign: CampaignDetail;
  onDone: () => void;
}): CampaignAbHandoff {
  const { campaign, onDone } = input;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const blockedReason = abHandoffBlockReason(campaign);

  const run = useCallback(
    (
      variants: string[],
      splitPercentage: number | null,
      options?: Omit<AbHandoffOptions, "splitPercentage">,
    ) => {
      if (pending) return;
      if (blockedReason) {
        haptics.warning();
        toast({ kind: "warning", message: blockedReason });
        return;
      }
      if (variants.length < 2) {
        haptics.warning();
        toast({
          kind: "warning",
          message:
            "An A/B test needs at least two variants — wait for the suggestions to finish.",
        });
        return;
      }
      // The ≤8-combo cap, checked before the POST for the same reason the
      // audience is: the server would 400 and the variants would be lost.
      const comboBlock = abComboBlockReason(
        variants.length,
        options?.fromNameVariants ?? [],
      );
      if (comboBlock) {
        haptics.warning();
        toast({ kind: "warning", message: comboBlock });
        return;
      }
      setPending(true);
      void (async () => {
        try {
          const res = await createABTestCampaign(
            buildAbHandoffPayload(campaign, variants, {
              splitPercentage,
              ...(options ?? {}),
            }),
          );
          if (res.error) {
            haptics.error();
            toast({
              kind: "error",
              message: campaignErrorMessage(
                res.error,
                "Couldn't create the A/B test.",
              ),
            });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
          void queryClient.invalidateQueries({
            queryKey: ["campaign-counts"],
          });
          onDone();
          toast({
            kind: "success",
            message: options?.bandit
              ? `Bandit test created with ${variants.length} subject variants — traffic shifts toward the winner as opens land.`
              : `A/B test created with ${variants.length} subject variant${
                  variants.length === 1 ? "" : "s"
                }${splitPercentage !== null ? ` at a ${splitPercentage}% split` : ""}.`,
          });
          // PUSH (not replace) to the new parent's DETAIL screen: the test has
          // not sent, so ab-results would only show an empty state — and
          // replace would have stranded the back path.
          router.push({
            pathname: "/(tabs)/campaigns/[id]",
            params: { id: res.data.parent.id },
          });
        } finally {
          setPending(false);
        }
      })();
    },
    [blockedReason, campaign, onDone, pending, queryClient, toast],
  );

  return { blockedReason, pending, run };
}
