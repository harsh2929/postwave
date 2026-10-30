/**
 * useSubscriberViewControls — the remembered view state of the subscribers
 * list, and the motion that goes with changing it.
 *
 * The exact counterpart of `useCampaignViewControls`, extracted for the same
 * two reasons:
 *
 *  1. LOVE#7. `lib/motion.ts` was written to end "44 screens, zero animation",
 *     and the busiest list in the product was still one of them. Every setter
 *     here schedules the NEXT layout pass before it changes the state, which
 *     is the only ordering that works: `LayoutAnimation.configureNext`
 *     configures the pass that is about to run, and from an effect the pass
 *     that moved everything has already committed. `animateLayout` collapses
 *     to scheduling nothing at all under Reduce Motion — an animation that
 *     ignores that setting is an accessibility defect, not a polish nit.
 *
 *  2. `app/(tabs)/subscribers/index.tsx`'s component sits against its 300-line
 *     budget (scripts/source-budgets.json). Three preference-backed controls
 *     with their own comments do not belong inline in a file that also owns
 *     search, paging, selection, saved segments and five read states.
 *
 * The INTENT is chosen per control, and the distinction is real:
 *   - re-sorting is `move` — the same rows travel to new positions, and fading
 *     them in would claim they are new data;
 *   - widening the list with archived rows, or opening the growth card, is
 *     `enter` — rows and height genuinely appear.
 */
import { useListPreferences } from "@/hooks/useListPreferences";
import { useMotion } from "@/lib/motion";
import { DEFAULT_SUBSCRIBER_SORT } from "@/lib/subscriberSort";

export interface SubscriberViewControls {
  /** Sort key; resolve it through `subscriberSortByKey`. */
  sortKey: string;
  /** Whether soft-deleted rows are in the list. */
  includeArchived: boolean;
  /** Whether the audience-growth card is expanded. */
  growthOpen: boolean;
  changeSort: (next: string) => void;
  toggleArchived: () => void;
  toggleGrowth: () => void;
}

export function useSubscriberViewControls(): SubscriberViewControls {
  const { animateLayout } = useMotion();
  // One preference bag: the chosen ordering, the growth card's collapsed
  // state and the archived toggle all survive a trip to a profile and the
  // next launch. An operator working a restore queue should not have to
  // re-enable archived rows every time they open the app. Values are strings
  // because `useListPreferences` is a string bag.
  const [prefs, setPrefs] = useListPreferences("subscribers", {
    sort: DEFAULT_SUBSCRIBER_SORT.key,
    growth: "open",
    archived: "hidden",
  });
  const includeArchived = prefs.archived === "shown";

  return {
    sortKey: prefs.sort,
    includeArchived,
    growthOpen: prefs.growth !== "closed",
    changeSort: (next: string) => {
      animateLayout("move");
      setPrefs({ sort: next });
    },
    toggleArchived: () => {
      animateLayout("enter");
      setPrefs({ archived: includeArchived ? "hidden" : "shown" });
    },
    toggleGrowth: () => {
      // The textbook case for animating the next layout pass: the card
      // changes height and pushes every row below it. A self-contained fade
      // on the card alone would leave the whole list jumping to its new
      // offset in a single frame.
      animateLayout("enter");
      setPrefs({ growth: prefs.growth === "closed" ? "open" : "closed" });
    },
  };
}
