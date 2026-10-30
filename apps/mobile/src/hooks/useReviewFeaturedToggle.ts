/**
 * hooks/useReviewFeaturedToggle.ts — the merchandising toggle's
 * confirm/haptic/toast choreography, split from the Reviews route at its
 * source budget. Takes `toast` and `online` as parameters so the route stays
 * the owner of its contexts (the useDiscountsScreen idiom).
 *
 * Reversible, so no ConfirmSheet — the confirm dialog's value comes from
 * being rare. Online-only like every reviews verb: a paused mutation would
 * latch `isPending` for the life of the screen.
 */
import { useCallback } from "react";

import type { ToastOptions } from "@/components/Toast";
import { useSetReviewFeatured } from "@/hooks/useReviews";
import { haptics } from "@/lib/haptics";
import type { MobileReview } from "@/lib/reviewQueue";

type ToastFn = (options: ToastOptions) => void;

export function useReviewFeaturedToggle(
  toast: ToastFn,
  online: boolean,
  messageFor: (error: unknown) => string,
) {
  const setFeatured = useSetReviewFeatured();

  const toggleFeatured = useCallback(
    async (review: MobileReview, next: boolean) => {
      if (setFeatured.isPending) return;
      if (!online) {
        haptics.error();
        toast({
          kind: "error",
          message:
            "You're offline. Featuring changes your storefront, so it is never queued — reconnect and try again.",
        });
        return;
      }
      haptics.impact();
      try {
        await setFeatured.mutateAsync({ id: review.id, featured: next });
        haptics.success();
        toast({
          kind: "success",
          message: next
            ? "Featured — storefront widgets will spotlight this review."
            : "No longer featured.",
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `${next ? "Feature" : "Unfeature"} failed. ${messageFor(error)}`,
        });
      }
    },
    [messageFor, online, setFeatured, toast],
  );

  return { toggleFeatured, toggling: setFeatured.isPending };
}
