// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Subscriber insights (desktop parity rows audience-78/79) and the DSAR data
// export (audience-50):
//
//   * AI profile summary — "Why is this person here?" drivers + refresh, with
//     the summary's authorship (model vs. rule-based fallback) disclosed.
//   * Engagement score — the stored worker score, or an honest "not scored".
//   * Contact rating — manual 1–5 stars (choose the current star to clear),
//     the rating signals behind it, the rating/contact history, and the
//     tenant-wide heuristic recompute (owner/admin only).
//   * DSAR export — the subscriber's confidential data package as a ZIP.
//
// Role gating mirrors the server: reads are open to every role; setting a
// rating needs subscriber write authority (editor+); the recompute and the
// DSAR export are admin-scoped routes, so they are withheld with the reason
// for anyone below owner/admin rather than left to answer 403.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Download, RefreshCw, Sparkles, Star } from "lucide-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { downloadBlobFile } from "@/lib/download";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { base } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  contactHistoryDisplay,
  downloadSubscriberDataExport,
  getSubscriberAiSummary,
  getSubscriberEngagementScore,
  getSubscriberRatingView,
  listSubscriberContactHistory,
  manualRatingOf,
  recomputeContactRatingsTenantWide,
  setSubscriberRating,
  type ContactRatingRecomputeResult,
  type SubscriberAiSummary,
  type SubscriberRatingView,
} from "@/lib/subscriber-detail-api";

function errorText(err: unknown, fallback: string): string {
  if (isApiError(err)) return apiErrorMessage(err, fallback);
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

function isNotFound(err: unknown): boolean {
  return isApiError(err) && Number(err.status) === 404;
}

function isAdminAuthority(authority: SubscriberAuthority | null): boolean {
  return authority?.role === "owner" || authority?.role === "admin";
}

interface InsightsProps {
  id: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
}

export function SubscriberInsightsPanel(props: InsightsProps) {
  return (
    <div className="space-y-4">
      <AiSummaryCard {...props} />
      <EngagementScoreRow {...props} />
      <ContactRatingSection {...props} />
    </div>
  );
}

/* =============================== AI summary ============================== */

function AiSummaryCard({ id, tenantId, role }: InsightsProps) {
  const queryClient = useQueryClient();
  const key = [...base("subscriber-ai-summary", tenantId, role), id];
  const summaryQuery = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getSubscriberAiSummary(id, { signal }),
    staleTime: 5 * 60_000,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const refreshingRef = useRef(false);
  const driversId = useId();
  const refreshHelpId = useId();

  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const next = await getSubscriberAiSummary(id, { refresh: true });
      queryClient.setQueryData<SubscriberAiSummary>(key, next);
    } catch (err) {
      setRefreshError(errorText(err, "Couldn't refresh the summary."));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  // Desktop hides the card when the deployment has no summary route or the
  // subscriber does not resolve; a 404 is not an error worth shouting about.
  if (summaryQuery.isError && isNotFound(summaryQuery.error)) return null;

  const summary = summaryQuery.data;
  return (
    <section
      aria-labelledby={`${driversId}-title`}
      className="rounded-lg border bg-primary/[0.035] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles aria-hidden className="h-4 w-4 text-primary" />
        <h3 id={`${driversId}-title`} className="text-sm font-medium">
          Profile summary
        </h3>
        {summary ? (
          <Badge variant={summary.source === "ai" ? "secondary" : "outline"}>
            {summary.source === "ai" ? "AI-generated" : "Rule-based"}
          </Badge>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refreshing || summaryQuery.isLoading}
          aria-describedby={refreshHelpId}
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden className="h-4 w-4" />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <p id={refreshHelpId} className="mt-1 text-xs text-muted-foreground">
        Refresh asks for the summary again. An unchanged profile returns the
        stored summary for up to 24 hours.
      </p>
      {summaryQuery.isLoading ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Generating subscriber summary…
        </p>
      ) : summaryQuery.isError ? (
        <div role="alert" className="mt-2 space-y-2 text-sm">
          <p>{errorText(summaryQuery.error, "Couldn't load the summary.")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void summaryQuery.refetch()}
          >
            Retry summary
          </Button>
        </div>
      ) : summary ? (
        <div className="mt-2 space-y-2">
          {refreshError ? (
            <p role="alert" className="text-xs text-destructive-emphasis">
              {refreshError} The previous summary is still shown.
            </p>
          ) : null}
          <p className="text-sm leading-relaxed">{summary.summary}</p>
          <p className="text-xs text-muted-foreground">
            {summary.source === "ai"
              ? "Written by an AI model from this subscriber's activity signals (personal data is tokenised before it is sent). Check it before acting on it."
              : "Written from rule-based activity signals; no AI model was used for this summary."}
            {summary.cache_hit ? (
              <>
                {" "}
                Stored summary · last updated{" "}
                <time
                  dateTime={summary.last_updated}
                  title={absoluteTime(summary.last_updated)}
                >
                  {timeAgo(summary.last_updated)}
                </time>
                .
              </>
            ) : null}
          </p>
          {summary.drivers.length > 0 ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                aria-controls={driversId}
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? "▾" : "▸"} Why is this person here?
              </Button>
              {expanded ? (
                <ul
                  id={driversId}
                  className="mt-1 list-disc space-y-1 pl-6 text-sm text-muted-foreground"
                >
                  {summary.drivers.map((driver) => (
                    <li key={driver.key}>
                      <span className="text-foreground">{driver.label}:</span>{" "}
                      {driver.value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ============================ Engagement score =========================== */

function EngagementScoreRow({ id, tenantId, role }: InsightsProps) {
  const scoreQuery = useQuery({
    queryKey: [...base("subscriber-engagement-score", tenantId, role), id],
    queryFn: ({ signal }) => getSubscriberEngagementScore(id, signal),
    staleTime: 60_000,
  });
  if (scoreQuery.isError && isNotFound(scoreQuery.error)) return null;
  const score = scoreQuery.data;
  return (
    <section
      aria-label="Engagement score"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
    >
      <h3 className="text-sm font-medium">Engagement score</h3>
      {scoreQuery.isLoading ? (
        <Skeleton className="h-4 w-16" />
      ) : scoreQuery.isError ? (
        <span role="alert" className="text-sm text-muted-foreground">
          {errorText(scoreQuery.error, "Couldn't load the score.")}
        </span>
      ) : score && score.score !== null ? (
        <>
          <span
            data-testid="engagement-score-value"
            className="text-sm font-semibold tabular-nums"
          >
            {score.score} / 100
          </span>
          {score.computed_at ? (
            <span className="text-xs text-muted-foreground">
              · computed{" "}
              <time
                dateTime={score.computed_at}
                title={absoluteTime(score.computed_at)}
              >
                {timeAgo(score.computed_at)}
              </time>
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-sm text-muted-foreground">
          Not scored yet — the scoring worker sweeps every 15 minutes over the
          last 90 days of events.
        </span>
      )}
      <p className="basis-full text-xs text-muted-foreground">
        Computed from the last 90 days of events and the workspace&apos;s
        scoring-rule weights.
      </p>
    </section>
  );
}

/* ============================= Contact rating ============================ */

function ratingSourceLabel(view: SubscriberRatingView): string {
  return view.source === "manual"
    ? "Manual — set by an operator; recompute never overwrites it"
    : "Heuristic — derived from the engagement score";
}

function ContactRatingSection({
  id,
  tenantId,
  role,
  authority,
}: InsightsProps) {
  const queryClient = useQueryClient();
  const viewKey = [...base("subscriber-rating", tenantId, role), id];
  const historyKey = [
    ...base("subscriber-contact-history", tenantId, role),
    id,
  ];
  const viewQuery = useQuery({
    queryKey: viewKey,
    queryFn: ({ signal }) => getSubscriberRatingView(id, signal),
    staleTime: 30_000,
  });
  const historyQuery = useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam, signal }) =>
      listSubscriberContactHistory(id, {
        before: pageParam ?? undefined,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    staleTime: 30_000,
  });
  const [ratingBusy, setRatingBusy] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [recomputed, setRecomputed] =
    useState<ContactRatingRecomputeResult | null>(null);
  const ratingBusyRef = useRef(false);
  const ratingErrorRef = useRef<HTMLDivElement>(null);
  const guidanceId = useId();
  const recomputeReasonId = useId();
  const canRate = authority !== null;
  const canRecompute = isAdminAuthority(authority);

  useEffect(() => {
    if (ratingError) ratingErrorRef.current?.focus();
  }, [ratingError]);

  // A 404 means "no rating signal recorded yet" — the subscriber exists but
  // has neither a manual rating nor an engagement score.
  const noSignal = viewQuery.isError && isNotFound(viewQuery.error);
  const view = viewQuery.data ?? null;
  const manual = manualRatingOf(view);

  const chooseRating = async (stars: number) => {
    if (!authority || ratingBusyRef.current) return;
    const next = manual === stars ? 0 : stars;
    ratingBusyRef.current = true;
    setRatingBusy(true);
    setRatingError(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      const receipt = await setSubscriberRating(id, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: viewKey }),
        queryClient.invalidateQueries({ queryKey: historyKey }),
      ]);
      toast.success(
        receipt.rating === null
          ? "Manual rating cleared."
          : `Rated ${receipt.rating} of 5 stars.`,
      );
    } catch (err) {
      const message = errorText(err, "Couldn't set the rating.");
      setRatingError(message);
      toast.error(message);
    } finally {
      ratingBusyRef.current = false;
      setRatingBusy(false);
    }
  };

  const recompute = async () => {
    if (!authority || !canRecompute) {
      throw new Error("Recomputing ratings needs an owner or admin role.");
    }
    await reauthorizeSubscriberMutation(authority);
    const result = await recomputeContactRatingsTenantWide();
    setRecomputed(result);
    await queryClient.invalidateQueries({ queryKey: viewKey });
    toast.success(
      `Recomputed ratings: ${result.updated.toLocaleString()} updated of ${result.scanned.toLocaleString()} scanned.`,
    );
  };

  const pages = Array.isArray(historyQuery.data?.pages)
    ? historyQuery.data.pages
    : [];
  const events = pages.flatMap((page) => page.items);

  return (
    <section aria-label="Contact rating" className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Rating</h3>
        <StarRating
          value={manual ?? 0}
          busy={ratingBusy || viewQuery.isLoading}
          canRate={canRate}
          describedBy={guidanceId}
          onChoose={(stars) => void chooseRating(stars)}
        />
        <span
          className="text-xs text-muted-foreground"
          data-testid="rating-value"
        >
          {manual !== null ? `${manual}/5` : "Unrated"}
        </span>
        <p
          id={guidanceId}
          role="status"
          className="basis-full text-xs text-muted-foreground"
        >
          {ratingBusy
            ? "Saving rating."
            : !canRate
              ? "Viewer access can see the rating but can't change it."
              : "Choose the current star again to clear a manual rating."}
        </p>
      </div>
      {ratingError ? (
        <div
          ref={ratingErrorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {ratingError}
        </div>
      ) : null}

      <div className="rounded-md border bg-card p-3 text-sm">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Rating signals
        </h4>
        {viewQuery.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : noSignal ? (
          <p className="text-muted-foreground">
            No rating signal recorded yet — neither a manual rating nor an
            engagement score exists for this subscriber.
          </p>
        ) : viewQuery.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <span>
              {errorText(viewQuery.error, "Couldn't load rating signals.")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void viewQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : view ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Stars</dt>
            <dd>{view.stars !== null ? `${view.stars}/5` : "Unrated"}</dd>
            <dt className="text-muted-foreground">Engagement score</dt>
            <dd>
              {view.engagement_score !== null
                ? `${view.engagement_score}/100`
                : "No engagement signal yet"}
            </dd>
            {view.engagement_score_at ? (
              <>
                <dt className="text-muted-foreground">Score computed</dt>
                <dd title={absoluteTime(view.engagement_score_at)}>
                  {timeAgo(view.engagement_score_at)}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Source</dt>
            <dd>{ratingSourceLabel(view)}</dd>
          </dl>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canRecompute ? (
            <ConfirmDialog
              title="Recompute ratings for the whole workspace?"
              description="This writes derived star ratings for every subscriber in this workspace that has no manual rating, from their engagement score over the last 90 days. Manual ratings are never overwritten. The derived ratings can't be undone in bulk."
              confirmLabel="Recompute ratings"
              confirmVariant="default"
              onConfirm={recompute}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  Recompute (workspace-wide)
                </Button>
              }
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              aria-describedby={recomputeReasonId}
            >
              Recompute (workspace-wide)
            </Button>
          )}
          <p id={recomputeReasonId} className="text-xs text-muted-foreground">
            {!canRecompute
              ? "Recomputing ratings needs an owner or admin role. "
              : ""}
            Sweeps every subscriber without a manual rating; manual ratings are
            never overwritten.
          </p>
        </div>
        {recomputed ? (
          <p role="status" className="mt-2 text-xs text-success">
            Recomputed ratings workspace-wide:{" "}
            {recomputed.updated.toLocaleString()} updated of{" "}
            {recomputed.scanned.toLocaleString()} scanned (
            {recomputed.window_days}-day window).
          </p>
        ) : null}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium">Rating history</h4>
        {historyQuery.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : historyQuery.isError && events.length === 0 ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span>
              {errorText(historyQuery.error, "Couldn't load contact history.")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void historyQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No history events recorded.
          </p>
        ) : (
          <>
            <ol className="divide-y rounded-md border bg-card text-sm">
              {events.map((event) => {
                const display = contactHistoryDisplay(event);
                return (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 p-3"
                  >
                    <span>
                      <span className="font-medium">{display.title}</span>
                      {display.detail ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {display.detail}
                        </span>
                      ) : null}
                    </span>
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={event.at}
                      title={absoluteTime(event.at)}
                    >
                      {timeAgo(event.at)}
                    </time>
                  </li>
                );
              })}
            </ol>
            {historyQuery.isFetchNextPageError ? (
              <p
                role="alert"
                className="mt-2 text-sm text-destructive-emphasis"
              >
                {errorText(
                  historyQuery.error,
                  "Older history couldn't be loaded.",
                )}
              </p>
            ) : null}
            {historyQuery.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={historyQuery.isFetchingNextPage}
                aria-busy={historyQuery.isFetchingNextPage}
                onClick={() =>
                  void loadNextQueryPage(historyQuery, historyQuery.isEnabled)
                }
              >
                {historyQuery.isFetchingNextPage
                  ? "Loading older events…"
                  : "Load older events"}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function StarRating({
  value,
  busy,
  canRate,
  describedBy,
  onChoose,
}: {
  value: number;
  busy: boolean;
  canRate: boolean;
  describedBy: string;
  onChoose: (stars: number) => void;
}) {
  const unavailable = busy || !canRate;
  const move = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (unavailable) return;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = current === 5 ? 1 : current + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = current === 1 ? 5 : current - 1;
    } else if (event.key === "Home") {
      next = 1;
    } else if (event.key === "End") {
      next = 5;
    }
    if (next === null) return;
    event.preventDefault();
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`button[data-rating="${next}"]`)
      ?.focus();
    onChoose(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Rating"
      aria-describedby={describedBy}
      className="inline-flex gap-0.5"
    >
      {[1, 2, 3, 4, 5].map((stars) => {
        const filled = stars <= value;
        return (
          <button
            key={stars}
            type="button"
            role="radio"
            aria-checked={value === stars}
            aria-label={`${stars} star${stars === 1 ? "" : "s"}`}
            aria-describedby={describedBy}
            disabled={unavailable}
            data-rating={stars}
            tabIndex={value === stars || (value === 0 && stars === 1) ? 0 : -1}
            onClick={() => onChoose(stars)}
            onKeyDown={(event) => move(event, stars)}
            className="rounded p-0.5 text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Star
              aria-hidden
              className="h-4 w-4"
              fill={filled ? "currentColor" : "none"}
            />
          </button>
        );
      })}
    </div>
  );
}

/* ============================== DSAR export ============================== */

export function SubscriberDataExportButton({
  id,
  authority,
}: {
  id: string;
  authority: SubscriberAuthority | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const canExport = isAdminAuthority(authority);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const exportData = async () => {
    if (!authority || !canExport || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      const bundle = await downloadSubscriberDataExport(id);
      downloadBlobFile(bundle.filename, bundle.blob);
      setSaved(bundle.filename);
    } catch (err) {
      const message = errorText(
        err,
        "Couldn't prepare the subscriber data export. Try again.",
      );
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" aria-busy={busy}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canExport || busy}
        aria-describedby={reasonId}
        onClick={() => void exportData()}
      >
        <Download aria-hidden className="h-4 w-4" />
        {busy ? "Exporting…" : "Export data (DSAR)"}
      </Button>
      <p id={reasonId} className="text-xs text-muted-foreground">
        {canExport
          ? "Downloads this subscriber's confidential data package (profile, events, consent, notes, suppressions) as a ZIP. The export is recorded in the audit log and can take about 30 seconds."
          : "Exporting a subscriber's data package needs an owner or admin role."}
      </p>
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : saved ? (
        <p role="status" className="text-sm text-success">
          Data export downloaded ({saved}).
        </p>
      ) : null}
    </div>
  );
}
