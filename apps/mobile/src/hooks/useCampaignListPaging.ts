/**
 * hooks/useCampaignListPaging.ts — the bounded auto-pager behind the status
 * chips.
 *
 * The campaign list endpoint has no status parameter, so status filtering
 * happens client-side over server-paginated pages. That leaves a real
 * problem: the loaded window can hold zero matching rows while matches sit on
 * pages not yet fetched, and FlatList then renders empty and never fires
 * onEndReached.
 *
 * The previous fix drained pages until a match surfaced — with no page
 * ceiling and no cancel. CAMPAIGN_PAGE_SIZE is 100, so a workspace with 5,000
 * sent campaigns and one very old draft walked 50 sequential requests and
 * ~5,000 rows into memory on cellular before rendering a single row.
 *
 * This version stops at a ceiling and hands the user an explicit control, and
 * skips the drain entirely when the server's per-status counts already prove
 * the bucket is empty.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  bucketIsProvenEmpty,
  type CampaignStatusCounts,
  type CampaignStatusFilter,
} from "@/lib/campaignStatusFilter";

/** Pages the auto-pager may fetch before it stops and asks. */
export const CAMPAIGN_AUTO_PAGE_LIMIT = 5;

export interface CampaignListPagingInput {
  filter: CampaignStatusFilter;
  /** The debounced search term; a change resets the page budget. */
  query: string;
  /** How many rows the current filter matches in the loaded window. */
  matchCount: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  fetchNextPage: () => void;
  /** Server counts, when authoritative; null while they are unavailable. */
  counts: CampaignStatusCounts | null;
}

export interface CampaignListPaging {
  /** The bucket is provably empty — no point draining anything. */
  provenEmpty: boolean;
  /** The pager is still working through pages looking for matches. */
  draining: boolean;
  /** The pager stopped at its ceiling without finding a match. */
  capped: boolean;
  /** Grant another budget of pages. */
  loadMore: () => void;
}

export function useCampaignListPaging(
  input: CampaignListPagingInput,
): CampaignListPaging {
  const {
    filter,
    query,
    matchCount,
    hasNextPage,
    isFetchingNextPage,
    isError,
    fetchNextPage,
    counts,
  } = input;

  const pagesRef = useRef(0);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    pagesRef.current = 0;
    setCapped(false);
  }, [filter, query]);

  const provenEmpty = counts != null && bucketIsProvenEmpty(counts, filter);

  useEffect(() => {
    if (
      filter === "all" ||
      matchCount > 0 ||
      provenEmpty ||
      !hasNextPage ||
      isFetchingNextPage ||
      isError
    ) {
      return;
    }
    if (pagesRef.current >= CAMPAIGN_AUTO_PAGE_LIMIT) {
      setCapped(true);
      return;
    }
    pagesRef.current += 1;
    fetchNextPage();
  }, [
    filter,
    matchCount,
    provenEmpty,
    hasNextPage,
    isFetchingNextPage,
    isError,
    fetchNextPage,
  ]);

  const loadMore = useCallback(() => {
    pagesRef.current = 0;
    setCapped(false);
  }, []);

  return {
    provenEmpty,
    draining:
      filter !== "all" &&
      matchCount === 0 &&
      !provenEmpty &&
      !capped &&
      (hasNextPage || isFetchingNextPage),
    capped: capped && matchCount === 0,
    loadMore,
  };
}
