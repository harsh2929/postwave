/**
 * hooks/useCampaignViewControls.ts — the three axes the campaign list can be
 * looked at along (status bucket, folder, sort order), and the motion that
 * makes changing one of them read as a filter rather than as a redraw.
 *
 * Lifted out of the route because they belong together and were not treated as
 * though they did: each was declared separately, with its own paragraph of
 * reasoning, forty lines apart, and the fact that all three feed the same
 * `items` memo and re-compose the same list was invisible.
 *
 * THE PERSISTENCE RULE, in one place. Sort IS remembered per workspace, and is
 * VALIDATED on read: stored preferences outlive the code that wrote them, and
 * an unknown sort key would fall through every comparator branch to "recent"
 * while the chip row showed nothing selected. Bucket and folder are NOT
 * remembered — reopening the app onto a subset of the workspace, with the
 * reason three scroll positions off screen, is the trap the status chips avoid
 * by always starting at "All".
 *
 * THE MOTION RULE, also in one place. Changing any of the three re-composes
 * the whole list under a header whose "n shown" count changes at the same
 * instant, and picking Scheduled additionally swaps flat rows for day-grouped
 * agenda sections. Without a layout transition every element lands in its new
 * position in a single frame, which reads as a glitch rather than as a filter
 * — the exact "filter chips swap instantly, rows pop in" complaint lib/motion
 * exists to answer. Sort uses `move` rather than `enter` because nothing
 * appears or leaves: the same rows travel, and `move` is the token intent for
 * an element travelling.
 *
 * `animateLayout` carries the OS Reduce Motion decision with it, so no call
 * site here can forget to honour it.
 */
import { useState } from "react";

import { useListPreferences } from "@/hooks/useListPreferences";
import { ALL_FOLDERS, type CampaignFolderFilter } from "@/lib/campaignFolders";
import {
  DEFAULT_CAMPAIGN_SORT,
  isCampaignSort,
  type CampaignSort,
} from "@/lib/campaignSort";
import type { CampaignStatusFilter } from "@/lib/campaignStatusFilter";
import { useMotion } from "@/lib/motion";

export interface CampaignViewControls {
  filter: CampaignStatusFilter;
  folder: CampaignFolderFilter;
  sort: CampaignSort;
  /**
   * True while the Scheduled bucket is active, where the order is fixed and
   * chronological: the send that matters is the NEXT one, so that bucket
   * renders as a day-grouped agenda instead of a flat sortable list.
   */
  agenda: boolean;
  changeFilter: (next: CampaignStatusFilter) => void;
  changeFolder: (next: CampaignFolderFilter) => void;
  changeSort: (next: CampaignSort) => void;
}

export function useCampaignViewControls(): CampaignViewControls {
  const { animateLayout } = useMotion();
  const [filter, setFilter] = useState<CampaignStatusFilter>("all");
  const [folder, setFolder] = useState<CampaignFolderFilter>(ALL_FOLDERS);
  const [prefs, setPrefs] = useListPreferences("campaigns", {
    sort: DEFAULT_CAMPAIGN_SORT as string,
  });
  const sort: CampaignSort = isCampaignSort(prefs.sort)
    ? prefs.sort
    : DEFAULT_CAMPAIGN_SORT;

  return {
    filter,
    folder,
    sort,
    agenda: filter === "scheduled",
    changeFilter: (next) => {
      animateLayout("enter");
      setFilter(next);
    },
    changeFolder: (next) => {
      animateLayout("enter");
      setFolder(next);
    },
    changeSort: (next) => {
      animateLayout("move");
      setPrefs({ sort: next });
    },
  };
}
