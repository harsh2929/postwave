/**
 * hooks/useTemplateFavoriteToggle.ts — the star on a library row, and the
 * sentence for when it fails.
 *
 * Favouriting is mounted with `read` scope server-side
 * (server/campaign_sending.go:83-84), so every role — including a viewer
 * browsing the library — may star a design. It needs a live session, though:
 * the mutation is not in lib/offlineMutationContract, so the ROW withholds the
 * star while offline (the screen passes the handler only when online) rather
 * than replaying a tap hours later against a library that has moved on.
 *
 * The mutation is OPTIMISTIC and rolls the star back in `onError`
 * (hooks/useCampaignTemplates), and a rollback with nothing said is the same
 * defect the notification inbox names about its own optimistic read receipt:
 * "a silently-reappearing dot reads as a bug". The star filled and then
 * emptied itself, and the only reading available was that the tap missed. So
 * say which way it failed too — the star's whole meaning is its direction,
 * and "couldn't add" and "couldn't remove" are different facts to somebody
 * clearing a shortlist.
 *
 * Lifted out of app/(tabs)/templates.tsx unchanged, to keep the route inside
 * its function-span budget.
 */
import { useCallback } from "react";

import { useToast } from "@/components/Toast";
import { useSetTemplateFavorite } from "@/hooks/useCampaignTemplates";
import type { MobileTemplate } from "@/lib/templateCatalog";

export function useTemplateFavoriteToggle(): (template: MobileTemplate) => void {
  const { toast } = useToast();
  const favorite = useSetTemplateFavorite();
  return useCallback(
    (template: MobileTemplate) => {
      const wasFavorited = template.isFavorited;
      favorite.mutate(
        { id: template.id, favorited: !wasFavorited },
        {
          onError: () =>
            toast({
              kind: "error",
              message: wasFavorited
                ? `Couldn't remove ${template.name} from your favourites.`
                : `Couldn't add ${template.name} to your favourites.`,
            }),
        },
      );
    },
    [favorite, toast],
  );
}
