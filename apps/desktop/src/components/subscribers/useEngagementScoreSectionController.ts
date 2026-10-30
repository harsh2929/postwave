import { useEffect, useRef, useState } from "react";

import {
  type EngagementScoreSubscriber,
  engagementScoresApi,
} from "../../lib/api-client";
import {
  type DistributionView,
  buildDistributionView,
  parseScoreRange,
} from "./engagement-score-helpers";

const BROWSE_PER_PAGE = 25;

export function useEngagementScoreSectionController() {
  const [view, setView] = useState<DistributionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [minRaw, setMinRaw] = useState("");
  const [maxRaw, setMaxRaw] = useState("");
  const [rangeErr, setRangeErr] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseErr, setBrowseErr] = useState<string | null>(null);
  const [items, setItems] = useState<EngagementScoreSubscriber[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(BROWSE_PER_PAGE);
  const mountedRef = useRef(false);
  const browseRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      browseRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setUnavailable(false);
    setView(null);
    void (async () => {
      try {
        const response = await engagementScoresApi.distribution();
        if (cancelled) return;
        setLoading(false);
        if (response.error) {
          if (response.error.kind === "http" && response.error.status === 404) {
            setUnavailable(true);
          } else {
            setErr(response.error.message);
          }
          return;
        }
        setView(buildDistributionView(response.data.buckets ?? []));
      } catch (requestError) {
        if (cancelled) return;
        setLoading(false);
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Engagement score distribution request failed.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const loadBrowsePage = async (
    targetPage: number,
    minOverride?: string,
    maxOverride?: string,
  ): Promise<void> => {
    if (!mountedRef.current) return;
    const token = ++browseRequestRef.current;
    const parsed = parseScoreRange(
      minOverride ?? minRaw,
      maxOverride ?? maxRaw,
    );
    if (!parsed.ok) {
      setRangeErr(parsed.error);
      setBrowseLoading(false);
      setItems(null);
      setTotal(0);
      return;
    }
    setRangeErr(null);
    setBrowseErr(null);
    setBrowseLoading(true);
    setItems(null);
    try {
      const response = await engagementScoresApi.subscribers({
        ...(parsed.min !== undefined ? { min: parsed.min } : {}),
        ...(parsed.max !== undefined ? { max: parsed.max } : {}),
        page: targetPage,
        perPage: BROWSE_PER_PAGE,
      });
      if (!mountedRef.current || token !== browseRequestRef.current) return;
      setBrowseLoading(false);
      if (response.error) {
        setBrowseErr(response.error.message);
        setTotal(0);
        return;
      }
      setItems(response.data.items ?? []);
      setTotal(response.data.total);
      setPage(response.data.page);
      setPerPage(response.data.per_page);
    } catch (requestError) {
      if (!mountedRef.current || token !== browseRequestRef.current) return;
      setBrowseLoading(false);
      setTotal(0);
      setBrowseErr(
        requestError instanceof Error
          ? requestError.message
          : "Engagement score subscriber request failed.",
      );
    }
  };

  const browseSlice = (min: number, max: number): void => {
    const low = String(min);
    const high = String(max);
    setMinRaw(low);
    setMaxRaw(high);
    setBrowseOpen(true);
    void loadBrowsePage(1, low, high);
  };

  const toggleBrowse = (): void => {
    const opening = !browseOpen;
    setBrowseOpen(opening);
    if (opening && items == null) void loadBrowsePage(1);
  };

  return {
    view,
    err,
    unavailable,
    loading,
    retryDistribution: () => setReloadTick((tick) => tick + 1),
    browseOpen,
    toggleBrowse,
    minRaw,
    setMinRaw,
    maxRaw,
    setMaxRaw,
    rangeErr,
    browseLoading,
    browseErr,
    items,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, perPage))),
    loadBrowsePage,
    browseSlice,
  };
}

export type EngagementScoreSectionController = ReturnType<
  typeof useEngagementScoreSectionController
>;
