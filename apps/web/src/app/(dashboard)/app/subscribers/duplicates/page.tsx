// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-037 — the Duplicates surface: scan the workspace for duplicate contacts,
// review each candidate pair (why they matched + how confident), then merge one
// pair at a time through a mandatory server-computed preview. The merge is
// irreversible, so this surface never bulk-merges and never merges without a
// reviewed plan. All reads run client-side (the scan endpoint materializes a
// fresh manifest on GET and can 409/410, which must not blow up the route).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Users } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { apiErrorMessage, isApiError } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { subscriberAuthorityFromMe } from "@/lib/subscriber-authority";
import {
  duplicatePairMatchesSelection,
  listDuplicates,
  listScanPairs,
  parseSelectedDuplicatePairIds,
  type DuplicatePair,
} from "@/lib/subscriber-dedupe-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageShell } from "@/components/dashboard/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { MergePreviewDialog } from "./merge-preview-dialog";
import { pluralizeCount } from "@/lib/pluralize";

const SCAN_PAGE_LIMIT = 50;

export default function DuplicatesPage() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const selectedParam = searchParams.get("selected");
  const selectedIds = useMemo(
    () => parseSelectedDuplicatePairIds(selectedParam),
    [selectedParam],
  );
  const invalidSelectedScope = selectedParam !== null && selectedIds === null;
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const authority = meQuery.data
    ? subscriberAuthorityFromMe(meQuery.data)
    : null;
  const canMerge = authority !== null;

  const duplicatesKey = useMemo(
    () => [...base("subscriber-duplicates", tenantId, role)],
    [tenantId, role],
  );

  const scanQuery = useQuery({
    queryKey: duplicatesKey,
    queryFn: ({ signal }) => listDuplicates({ limit: SCAN_PAGE_LIMIT, signal }),
    enabled: meQuery.isSuccess && !invalidSelectedScope,
    staleTime: STALE.list,
    retry: false,
    // This GET materializes a FRESH scan every call, so a silent background
    // refetch would swap the scan out from under accumulated pagination state.
    // Only an explicit Re-scan re-runs it.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Accumulated pairs beyond the first page (cursor pagination). cursor is a
  // three-state: null = not yet paginated (use the scan's first next_cursor);
  // a string = the next page; undefined = the end was reached (hide "Load more").
  const [extraPairs, setExtraPairs] = useState<DuplicatePair[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  // Which pair ids the operator has already merged, plus the subscriber ids
  // touched by any merge — a sibling pair referencing a merged record is now
  // stale and must be re-scanned before it can be merged (G8).
  const [mergedPairKeys, setMergedPairKeys] = useState<Set<string>>(new Set());
  const [touchedIds, setTouchedIds] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<DuplicatePair | null>(null);
  const reviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const rescanFallbackRef = useRef<HTMLButtonElement>(null);

  const scan = scanQuery.data?.scan;
  // null → haven't paged past the first page yet, use the scan's cursor;
  // otherwise the accumulated cursor (undefined once the end is reached).
  const nextCursor = cursor === null ? scanQuery.data?.next_cursor : cursor;
  const scanId = scan?.scan_id ?? "";

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
    },
    [],
  );

  const pairs = useMemo(
    () => [
      ...(Array.isArray(scanQuery.data?.pairs) ? scanQuery.data?.pairs : []),
      ...extraPairs,
    ],
    [scanQuery.data?.pairs, extraPairs],
  );

  const firstFocusedPair = useMemo(
    () =>
      selectedIds
        ? (scanQuery.data?.pairs?.find((pair) =>
            duplicatePairMatchesSelection(pair, selectedIds),
          ) ?? null)
        : null,
    [scanQuery.data?.pairs, selectedIds],
  );
  const focusedPairQuery = useQuery({
    queryKey: [
      ...duplicatesKey,
      "selected-pair",
      scanId,
      selectedIds?.[0] ?? "none",
      selectedIds?.[1] ?? "none",
    ],
    enabled: Boolean(
      selectedIds && scanId && scanQuery.data && !firstFocusedPair,
    ),
    retry: false,
    queryFn: async ({ signal }) => {
      if (!selectedIds || !scanQuery.data) return null;
      let pageCursor = scanQuery.data.next_cursor;
      const seenCursors = new Set<string>();
      const maximumPages =
        Math.ceil(
          (scanQuery.data.scan.candidate_count || 0) / SCAN_PAGE_LIMIT,
        ) + 1;
      for (let pageNumber = 0; pageCursor; pageNumber += 1) {
        if (pageNumber >= maximumPages || seenCursors.has(pageCursor)) {
          throw new Error(
            "The duplicate manifest returned an invalid paging sequence.",
          );
        }
        seenCursors.add(pageCursor);
        const page = await listScanPairs(scanId, {
          cursor: pageCursor,
          limit: SCAN_PAGE_LIMIT,
          signal,
        });
        const match = page.pairs.find((pair) =>
          duplicatePairMatchesSelection(pair, selectedIds),
        );
        if (match) return match;
        pageCursor = page.next_cursor;
      }
      return null;
    },
  });
  const focusedPair = firstFocusedPair ?? focusedPairQuery.data ?? null;
  const displayedPairs = selectedIds ? (focusedPair ? [focusedPair] : []) : pairs;

  function pairKey(p: DuplicatePair): string {
    return `${p.primary_id}:${p.duplicate_id}`;
  }

  async function rescan() {
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setExtraPairs([]);
    setCursor(null);
    setMergedPairKeys(new Set());
    setTouchedIds(new Set());
    await queryClient.invalidateQueries({ queryKey: duplicatesKey });
  }

  async function loadMore() {
    if (!scanId || !nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const generation = ++loadGenerationRef.current;
    const controller = new AbortController();
    loadAbortRef.current?.abort();
    loadAbortRef.current = controller;
    setLoadingMore(true);
    try {
      const page = await listScanPairs(scanId, {
        cursor: nextCursor,
        limit: SCAN_PAGE_LIMIT,
        signal: controller.signal,
      });
      if (
        generation !== loadGenerationRef.current ||
        page.scan.scan_id !== scanId
      ) {
        return;
      }
      setExtraPairs((prev) => {
        const existing = new Set(
          [
            ...(Array.isArray(scanQuery.data?.pairs)
              ? scanQuery.data.pairs
              : []),
            ...prev,
          ].map((pair) => pairKey(pair)),
        );
        if (page.pairs.some((pair) => existing.has(pairKey(pair)))) {
          toast.error(
            "The duplicate scan changed while paging. Re-scan before reviewing merges.",
          );
          return prev;
        }
        return [...prev, ...page.pairs];
      });
      setCursor(page.next_cursor);
    } catch (err) {
      if (generation === loadGenerationRef.current) {
        toast.error(apiErrorMessage(err));
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        loadingMoreRef.current = false;
        loadAbortRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  // Scan endpoint conflicts are expected states, not route errors.
  const scanErrorCode = isApiError(scanQuery.error)
    ? scanQuery.error.code
    : null;

  return (
    <PageShell>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Duplicate contacts
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Find and merge contacts that are the same person under more than one
            record.{" "}
            <Link
              href="/app/subscribers"
              className="inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-0"
            >
              Back to subscribers
            </Link>
          </p>
        </div>
        <Button
          ref={rescanFallbackRef}
          type="button"
          variant="outline"
          onClick={() => void rescan()}
          disabled={scanQuery.isFetching}
          className="gap-2"
        >
          <RefreshCw
            className={`size-4 ${scanQuery.isFetching ? "animate-spin" : ""}`}
            aria-hidden
          />
          Re-scan
        </Button>
      </div>

      {invalidSelectedScope ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive" role="alert">
            The selected duplicate scope is invalid. Return to subscribers and
            choose exactly two current rows.
          </CardContent>
        </Card>
      ) : scanErrorCode === "duplicate_scan_in_progress" ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            A duplicate scan is already running for this workspace. Re-scan in a
            moment.
          </CardContent>
        </Card>
      ) : scanErrorCode === "scan_expired" ? (
        <Card>
          <CardContent className="flex flex-col items-start justify-between gap-4 py-6 text-sm sm:flex-row sm:items-center">
            <span className="text-muted-foreground">
              This scan expired. Start a new one to review current duplicates.
            </span>
            <Button type="button" size="sm" onClick={() => void rescan()}>
              Re-scan
            </Button>
          </CardContent>
        </Card>
      ) : scanQuery.isError ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive" role="alert">
            {apiErrorMessage(scanQuery.error)}
          </CardContent>
        </Card>
      ) : scanQuery.isPending || !meQuery.isFetched ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4 text-muted-foreground" aria-hidden />
                {selectedIds
                  ? "Selected duplicate review"
                  : `${(scan?.candidate_count ?? 0).toLocaleString()} duplicate ${scan?.candidate_count === 1 ? "pair" : "pairs"} found`}
              </CardTitle>
              <CardDescription>
                {selectedIds
                  ? "The two opaque subscriber ids from your selection are matched only against this workspace's complete, current scan manifest."
                  : `Across ${pluralizeCount(scan?.subscriber_count ?? 0, "contact")}. This is a complete scan — a count of zero means no duplicates.`}
              </CardDescription>
            </CardHeader>
            {!canMerge ? (
              <CardContent className="pt-0 text-xs text-muted-foreground">
                You can review duplicates, but merging requires an editor role
                or higher.
              </CardContent>
            ) : null}
          </Card>

          {selectedIds && focusedPairQuery.isPending ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground" role="status">
                Checking the complete scan for the two selected subscribers…
              </CardContent>
            </Card>
          ) : selectedIds && focusedPairQuery.isError ? (
            <Card>
              <CardContent className="py-6 text-sm text-destructive" role="alert">
                {apiErrorMessage(focusedPairQuery.error)}
              </CardContent>
            </Card>
          ) : displayedPairs.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {selectedIds
                  ? "These selected subscribers are not a current deterministic duplicate candidate. Nothing can be merged from this scope."
                  : "No duplicate contacts found. Your list is clean."}
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-3">
              {displayedPairs.map((pair) => {
                const key = pairKey(pair);
                const merged = mergedPairKeys.has(key);
                const touched =
                  touchedIds.has(pair.primary_id) ||
                  touchedIds.has(pair.duplicate_id);
                return (
                  <PairCard
                    key={key}
                    pair={pair}
                    merged={merged}
                    touched={touched}
                    canMerge={canMerge}
                    onReview={(trigger) => {
                      reviewReturnFocusRef.current = trigger;
                      setReviewing(pair);
                    }}
                  />
                );
              })}
            </ul>
          )}

          {!selectedIds && nextCursor ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <MergePreviewDialog
        pair={reviewing}
        scanId={scanId}
        authority={authority}
        returnFocusRef={reviewReturnFocusRef}
        fallbackFocusRef={rescanFallbackRef}
        onClose={() => setReviewing(null)}
        onMerged={(result) => {
          const key = reviewing ? pairKey(reviewing) : "";
          setMergedPairKeys((prev) => new Set(prev).add(key));
          setTouchedIds((prev) => {
            const next = new Set(prev);
            next.add(result.primary_id);
            next.add(result.duplicate_id);
            return next;
          });
          setReviewing(null);
          // The survivor/tombstone changed — refresh any subscriber list.
          void queryClient.invalidateQueries({
            queryKey: base("subscribers", tenantId, role),
          });
        }}
      />
    </PageShell>
  );
}

function PairCard({
  pair,
  merged,
  touched,
  canMerge,
  onReview,
}: {
  pair: DuplicatePair;
  merged: boolean;
  touched: boolean;
  canMerge: boolean;
  onReview: (trigger: HTMLElement) => void;
}) {
  const topSignal = pair.evidence[0];
  const confidencePct = Math.round(pair.confidence * 100);
  const risky = pair.confidence < 1;
  // Guard G2/G8: a stale pair (or one touched by an earlier merge) is guaranteed
  // to fail the merge preview — block it before the click.
  const blocked = pair.stale || touched;

  return (
    <li
      className={`rounded-lg border p-4 ${merged ? "opacity-60" : ""}`}
      data-testid="duplicate-pair"
    >
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{pair.primary_email}</span>
            <span className="text-muted-foreground">&amp;</span>
            <span className="truncate font-medium">{pair.duplicate_email}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                risky
                  ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
                  : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500"
              }`}
            >
              {confidencePct}% match
            </span>{" "}
            {topSignal ? (
              <span>
                · {topSignal.kind} — {topSignal.reason}
              </span>
            ) : null}
          </p>
        </div>
        <div className="w-full shrink-0 sm:w-auto">
          {merged ? (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-500">
              Merged
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={(event) => onReview(event.currentTarget)}
              disabled={!canMerge || blocked}
              className="w-full sm:w-auto"
              title={
                !canMerge
                  ? "Merging requires an editor role"
                  : blocked
                    ? "This pair changed since the scan — re-scan to refresh"
                    : undefined
              }
            >
              Review &amp; merge
            </Button>
          )}
        </div>
      </div>
      {blocked && !merged ? (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
          Changed since the scan — re-scan to refresh before merging.
        </p>
      ) : null}
    </li>
  );
}
