// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Moderation inbox — the decision queue behind /app/reviews.
 *
 * Loads reviews by server status (filter rail), searches and sorts INSIDE the
 * loaded window only, and opens the evidence modal for a card. The server
 * caps the list at 200 with no total or cursor, so the UI says "loaded
 * window", never "backlog": an operator must not infer completeness from a
 * capped page.
 */
import { useId, useMemo, useRef, useState, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, Search, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { STALE } from "@/lib/query-keys";
import { listReviews, type Review } from "@/lib/reviews-api";
import {
  REVIEW_LIST_CAP,
  excerpt,
  formatDateTime,
  reviewMatchesQuery,
  sortReviewsForQueue,
  statusBadgeVariant,
  statusLabel,
  widgetTypeLabel,
  type ReviewSortDirection,
} from "@/lib/reviews-helpers";
import {
  EngagementEmpty,
  EngagementLoading,
  EngagementQueryError,
} from "../../_engagement/engagement-ui";

// The evidence dialog renders nothing until a row is opened, so its module
// (and the decision workflow it carries) loads after the inbox has painted.
const ReviewDetailDialog = dynamic(
  () =>
    import("./review-detail-dialog").then(
      (module) => module.ReviewDetailDialog,
    ),
  { loading: () => null },
);

const ALL = "__all__";
const DEFAULT_STATUS = "pending";

export interface ModerationInboxProps {
  identity: MeResponse | null;
  /** Server-advertised statuses; null while the catalog is unresolved. */
  statuses: string[] | null;
  catalogUnavailable: boolean;
  canAdmin: boolean;
  keyBase: readonly unknown[];
}

function uniqueStatuses(statuses: string[] | null): string[] {
  const out = new Set<string>([DEFAULT_STATUS]);
  for (const status of statuses ?? []) {
    const normalized = status.trim();
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function reviewName(review: Review): string {
  return review.reviewer_name?.trim() || "Anonymous reviewer";
}

function reviewHeading(review: Review): string {
  return review.title?.trim() || "Untitled review";
}

function compactReference(value: string | null | undefined): string | null {
  const reference = value?.trim();
  if (!reference) return null;
  const points = Array.from(reference);
  if (points.length <= 22) return reference;
  return `${points.slice(0, 10).join("")}…${points.slice(-7).join("")}`;
}

function ReviewCard({
  review,
  canAdmin,
  selected,
  onOpen,
}: {
  review: Review;
  canAdmin: boolean;
  selected: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const body = excerpt(review.body, 320);
  const submittedAt = review.submitted_at ?? review.created_at;
  const submittedLabel = formatDateTime(submittedAt);
  const actionable = canAdmin && review.status === "pending";
  const heading = reviewHeading(review);
  const name = reviewName(review);

  return (
    <article
      className={`flex min-w-0 flex-col gap-3 rounded-lg border bg-background/60 p-4 ${
        selected ? "ring-2 ring-ring" : ""
      }`}
      aria-label={`${heading} by ${name}`}
      data-review-status={review.status}
      data-review-id={review.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="text-sm tabular-nums text-warning-emphasis"
          aria-label={`${review.rating} out of 5 stars`}
        >
          {"★".repeat(review.rating)}
          {"☆".repeat(Math.max(0, 5 - review.rating))}
        </span>
        <Badge variant={statusBadgeVariant(review.status)}>
          {statusLabel(review.status)}
        </Badge>
      </div>

      <div className="min-w-0">
        <h3 className="break-words text-sm font-semibold">{heading}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">{name}</strong>
          {submittedAt && submittedLabel ? (
            <>
              <span aria-hidden> · </span>
              Reported <time dateTime={submittedAt}>{submittedLabel}</time>
            </>
          ) : null}
        </p>
      </div>

      <ul
        className="flex flex-wrap gap-2 text-xs text-muted-foreground"
        aria-label="Service-reported review flags; authenticity is not independently verified"
      >
        <li className="rounded-full border px-2 py-0.5">
          {review.verified_buyer
            ? "Buyer verification reported"
            : "Verification not reported"}
        </li>
        {review.incentivized ? (
          <li className="rounded-full border border-warning/40 px-2 py-0.5 text-warning-emphasis">
            Incentive reported
          </li>
        ) : null}
        {review.featured ? (
          <li className="rounded-full border px-2 py-0.5">
            Featured flag reported
          </li>
        ) : null}
      </ul>

      {body ? (
        <p className="break-words text-sm leading-relaxed">{body}</p>
      ) : (
        <p className="text-sm italic text-muted-foreground">
          No written review was supplied.
        </p>
      )}

      <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Reported product</dt>
          <dd className="break-all">
            {compactReference(review.product_id) ?? "Not linked"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reported source</dt>
          <dd className="break-words">
            {review.source_platform?.trim() || "Not reported"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reported type</dt>
          <dd className="break-words">
            {review.review_type
              ? widgetTypeLabel(review.review_type)
              : "Not reported"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {actionable
            ? "A full-evidence review is required before publication."
            : "Open the evidence record for the complete public state."}
        </span>
        <Button
          type="button"
          size="sm"
          variant={actionable ? "default" : "outline"}
          onClick={onOpen}
          aria-label={`${actionable ? "Review and decide" : "Inspect"} ${heading} by ${name}`}
        >
          {actionable ? "Review & decide" : "Inspect evidence"}
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </article>
  );
}

export function ModerationInbox({
  identity,
  statuses,
  catalogUnavailable,
  canAdmin,
  keyBase,
}: ModerationInboxProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ReviewSortDirection>("queue");
  const [selected, setSelected] = useState<Review | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [openToken, setOpenToken] = useState(0);
  const [revisions, setRevisions] = useState<Record<string, Review>>({});
  const [announcement, setAnnouncement] = useState("");
  const queueHeadingRef = useRef<HTMLDivElement | null>(null);
  const searchId = useId();

  const list = useQuery({
    queryKey: [...keyBase, "list", status === ALL ? "" : status],
    queryFn: ({ signal }) =>
      listReviews(status === ALL ? undefined : status, { signal }),
    enabled: identity !== null,
    staleTime: STALE.list,
  });

  const statusOptions = useMemo(() => uniqueStatuses(statuses), [statuses]);
  const snapshot = list.data;
  const loadedCount = snapshot?.items?.length ?? 0;

  const visibleReviews = useMemo(() => {
    const revised = (Array.isArray(snapshot?.items) ? snapshot.items : []).map(
      (review) => revisions[review.id] ?? review,
    );
    return sortReviewsForQueue(
      revised.filter((review) => reviewMatchesQuery(review, query)),
      status === ALL ? undefined : status,
      sort,
    );
  }, [query, revisions, snapshot, sort, status]);

  const selectedReview = selected ? (revisions[selected.id] ?? selected) : null;
  const initialLoading = list.isPending;
  const terminalFailure = list.isError && !snapshot;
  const staleFailure = list.isError && Boolean(snapshot);
  const refreshing = list.isFetching && Boolean(snapshot);
  const atServerWindow = loadedCount >= REVIEW_LIST_CAP;

  function selectStatus(next: string): void {
    if (next === status) return;
    setStatus(next);
    setRevisions({});
    setQuery("");
    setSelected(null);
    setDetailOpen(false);
  }

  function openReview(review: Review): void {
    setSelected(review);
    setOpenToken((token) => token + 1);
    setDetailOpen(true);
  }

  function recordDecision(updated: Review): void {
    setRevisions((current) => ({ ...current, [updated.id]: updated }));
    setAnnouncement(
      `${statusLabel(updated.status)} state recorded. The queue is being verified again.`,
    );
    if (status !== ALL && updated.status !== status) {
      queueHeadingRef.current?.focus();
    }
  }

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: [...keyBase, "list"] });
  }

  return (
    <div className="space-y-4" data-reviews-view="moderation">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground tabular-nums">
            {snapshot ? loadedCount : "—"}
          </strong>{" "}
          loaded records
        </span>
        <span>
          {list.dataUpdatedAt
            ? `Verified ${formatDateTime(new Date(list.dataUpdatedAt).toISOString())}`
            : "Not yet verified"}
        </span>
      </div>

      {!canAdmin ? (
        <Alert>
          <AlertTitle>Read-only review access</AlertTitle>
          <AlertDescription>
            You can inspect review evidence and public replies. Publishing,
            rejecting, and replying require workspace administration authority.
          </AlertDescription>
        </Alert>
      ) : null}

      {catalogUnavailable ? (
        <Alert variant="warning">
          <AlertTitle>Filter catalog unavailable</AlertTitle>
          <AlertDescription>
            The queue remains explicitly filtered to Pending. Additional
            server-defined states are withheld until the catalog can be
            verified.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor={searchId} className="sr-only">
            Search loaded reviews
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              autoComplete="off"
              className="pl-9 pr-10"
              placeholder="Search title, review text, product, or source"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear review search"
                className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <div className="w-full sm:w-48">
          <Label htmlFor={`${searchId}-sort`}>Order</Label>
          <Select
            id={`${searchId}-sort`}
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as ReviewSortDirection)
            }
          >
            <option value="queue">Queue priority</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={refresh}
          loading={list.isFetching}
          aria-label={
            refreshing ? "Refreshing review queue" : "Refresh review queue"
          }
        >
          <RefreshCw aria-hidden />
          {list.isFetching ? "Verifying…" : "Refresh"}
        </Button>
      </div>

      <div
        role="group"
        aria-label="Filter reviews by moderation state"
        className="flex flex-wrap gap-2"
      >
        <Button
          type="button"
          size="sm"
          variant={status === ALL ? "default" : "outline"}
          aria-pressed={status === ALL}
          onClick={() => selectStatus(ALL)}
        >
          All loaded
        </Button>
        {statusOptions.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={status === option ? "default" : "outline"}
            aria-pressed={status === option}
            onClick={() => selectStatus(option)}
          >
            {statusLabel(option)}
          </Button>
        ))}
      </div>

      {staleFailure ? (
        <Alert variant="warning">
          <AlertTitle>Showing the last verified queue</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              list.error,
              "The service did not return a usable review list.",
            )}{" "}
            Existing records are timestamped and remain readable, but no new
            decisions should be inferred from this snapshot.
          </AlertDescription>
          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={list.isFetching}
              onClick={refresh}
            >
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}

      {snapshot && snapshot.invalidCount > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {snapshot.invalidCount} malformed{" "}
            {snapshot.invalidCount === 1 ? "record was" : "records were"}{" "}
            withheld
          </AlertTitle>
          <AlertDescription>
            Only rows with a stable identifier and a moderation state are shown.
          </AlertDescription>
        </Alert>
      ) : null}

      {atServerWindow ? (
        <Alert variant="warning">
          <AlertTitle>
            This server returned its {REVIEW_LIST_CAP}-record maximum
          </AlertTitle>
          <AlertDescription>
            The API does not provide a total or next-page cursor. Treat this as
            a loaded window, not proof that the moderation backlog is complete.
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        ref={queueHeadingRef}
        tabIndex={-1}
        className="flex flex-wrap items-baseline justify-between gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="text-sm">
          <span className="text-muted-foreground">
            {status === ALL ? "All loaded states" : statusLabel(status)}
          </span>{" "}
          <strong className="tabular-nums">
            {visibleReviews.length}{" "}
            {visibleReviews.length === 1 ? "review" : "reviews"}
          </strong>
        </p>
        <p className="text-xs text-muted-foreground">
          {query
            ? `Matching “${query}” inside the verified loaded window.`
            : sort === "queue" && status === DEFAULT_STATUS
              ? "Oldest pending reviews are surfaced first."
              : "Ordering applies only to the currently loaded window."}
        </p>
      </div>

      <section aria-label="Review queue" aria-busy={list.isFetching}>
        {terminalFailure ? (
          <EngagementQueryError
            title="The review queue could not be verified"
            description={apiErrorMessage(
              list.error,
              "The service did not return a usable review list.",
            )}
            retrying={list.isFetching}
            onRetry={refresh}
          />
        ) : initialLoading ? (
          <EngagementLoading label="Loading reviews" rows={3} />
        ) : loadedCount === 0 ? (
          <EngagementEmpty
            title={
              status === DEFAULT_STATUS
                ? "No pending reviews in this loaded window"
                : "No reviews in this state"
            }
            description="Refresh to verify again, or choose another state. An empty response is distinct from an unavailable queue."
          />
        ) : visibleReviews.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
            <p className="text-sm font-medium">
              No loaded reviews match this search
            </p>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
              Clear the search to return to the current moderation window.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setQuery("")}
            >
              Clear search
            </Button>
          </div>
        ) : (
          <ol className="grid gap-3 lg:grid-cols-2">
            {visibleReviews.map((review) => (
              <li key={review.id}>
                <ReviewCard
                  review={review}
                  canAdmin={canAdmin}
                  selected={detailOpen && selectedReview?.id === review.id}
                  onOpen={() => openReview(review)}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <ReviewDetailDialog
        key={`${selectedReview?.id ?? "none"}:${openToken}`}
        open={detailOpen && selectedReview !== null}
        review={selectedReview}
        canAdmin={canAdmin}
        identity={identity}
        keyBase={keyBase}
        onOpenChange={(next) => {
          if (!next) setDetailOpen(false);
        }}
        onDecision={recordDecision}
      />
    </div>
  );
}
