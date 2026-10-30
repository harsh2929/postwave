import {
  type MouseEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { type Review, reviewsApi } from "../../lib/api-client";
import {
  REVIEW_LIST_CAP,
  parseReviewList,
  reviewMatchesQuery,
  sortReviewsForQueue,
  statusLabel,
} from "../../lib/reviews-helpers";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { ReviewCard } from "./ReviewCard";
import { ReviewDetailModal } from "./ReviewDetailModal";

const ALL = "__all__";
const DEFAULT_STATUS = "pending";

type SortDirection = "queue" | "newest" | "oldest";

interface Props {
  statuses: string[] | null;
  catalogUnavailable?: boolean;
  canAdmin: boolean;
}

function uniqueStatuses(statuses: string[] | null): string[] {
  const out = new Set<string>([DEFAULT_STATUS]);
  for (const status of statuses ?? []) {
    const normalized = status.trim();
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function verifiedTime(timestamp: number | null): string {
  if (timestamp === null) return "Not yet verified";
  return `Verified ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp))}`;
}

function reviewIdentity(review: Review): string {
  return review.id?.trim() ?? "";
}

export function ModerationTab({
  statuses,
  catalogUnavailable = false,
  canAdmin,
}: Props): ReactElement {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortDirection>("queue");
  const [selected, setSelected] = useState<Review | null>(null);
  const [revisions, setRevisions] = useState<Record<string, Review>>({});
  const [announcement, setAnnouncement] = useState("");
  const queueFocusRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const resource = useRemoteResource(
    async () => {
      const response = await reviewsApi.list(status === ALL ? {} : { status });
      if (response.error) return { error: response.error };
      const parsed = parseReviewList(response.data);
      if (!parsed.envelopeValid) {
        return {
          error: {
            message: "The review list response was malformed.",
            kind: "parse" as const,
          },
        };
      }
      return { data: parsed };
    },
    { identity: `reviews:moderation:${status}` },
  );

  useEffect(() => {
    setRevisions({});
    setSelected(null);
    setQuery("");
  }, [status]);

  const statusOptions = useMemo(() => uniqueStatuses(statuses), [statuses]);
  const snapshot = resource.data;
  const visibleReviews = useMemo(() => {
    const revised = (snapshot?.items ?? []).map((review) => {
      const id = reviewIdentity(review);
      return (id && revisions[id]) || review;
    });
    return sortReviewsForQueue(
      revised.filter((review) => reviewMatchesQuery(review, query)),
      status === ALL ? undefined : status,
      sort,
    );
  }, [query, resource.data, revisions, sort, status]);

  const selectedReview = selected
    ? (revisions[reviewIdentity(selected)] ?? selected)
    : null;
  const initialLoading =
    resource.data === null && resource.transport === "loading";
  const terminalFailure =
    resource.data === null && resource.transport === "error";
  const refreshing = resource.data !== null && resource.transport === "loading";
  const atServerWindow = (snapshot?.items.length ?? 0) >= REVIEW_LIST_CAP;

  const openReview = (
    review: Review,
    event: MouseEvent<HTMLButtonElement>,
  ): void => {
    returnFocusRef.current = event.currentTarget;
    setSelected(review);
  };

  const recordDecision = (updated: Review): void => {
    const id = reviewIdentity(updated);
    if (id) {
      setRevisions((current) => ({ ...current, [id]: updated }));
    }
    if (status !== ALL && updated.status !== status) {
      returnFocusRef.current = queueFocusRef.current;
    }
    setAnnouncement(
      `${statusLabel(updated.status)} state recorded. The queue is being verified again.`,
    );
    void resource.reload();
  };

  return (
    <div className="reviews-workspace" data-reviews-view="moderation">
      <header className="reviews-section-header">
        <div>
          <span className="reviews-section-eyebrow">Decision workspace</span>
          <h2>Moderation inbox</h2>
          <p>
            Inspect the complete record before changing anything that customers
            can see.
          </p>
        </div>
        <div className="reviews-section-state" aria-label="Queue status">
          <span className="reviews-live-dot" aria-hidden="true" />
          <span>
            <strong>{snapshot?.items.length ?? "—"}</strong>
            <small>loaded records</small>
          </span>
          <span>
            <strong>{verifiedTime(resource.lastVerifiedAt)}</strong>
            <small>current filter</small>
          </span>
        </div>
      </header>

      {!canAdmin ? (
        <Notice
          tone="neutral"
          title="Read-only review access"
          className="reviews-notice"
        >
          You can inspect review evidence and public replies. Publishing,
          rejecting, and replying require workspace administration authority.
        </Notice>
      ) : null}

      {catalogUnavailable ? (
        <Notice
          tone="warning"
          title="Filter catalog unavailable"
          className="reviews-notice"
        >
          The queue remains explicitly filtered to Pending. Additional
          server-defined states are withheld until the catalog can be verified.
        </Notice>
      ) : null}

      <div className="reviews-toolbar">
        <label className="reviews-search">
          <span className="visually-hidden">Search loaded reviews</span>
          <Icon name="users" size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, review text, product, or source"
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear review search"
            >
              <Icon name="x" size={15} />
            </button>
          ) : null}
        </label>

        <label className="reviews-sort">
          <span>Order</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortDirection)}
          >
            <option value="queue">Queue priority</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>

        <button
          type="button"
          className="reviews-refresh"
          onClick={() => void resource.reload()}
          disabled={resource.transport === "loading"}
          aria-label={
            refreshing ? "Refreshing review queue" : "Refresh review queue"
          }
        >
          <Icon name="clock" size={16} />
          {resource.transport === "loading" ? "Verifying…" : "Refresh"}
        </button>
      </div>

      <div
        className="reviews-filter-rail"
        role="group"
        aria-label="Filter reviews by moderation state"
      >
        <button
          type="button"
          aria-pressed={status === ALL}
          className={status === ALL ? "is-active" : ""}
          onClick={() => setStatus(ALL)}
        >
          All loaded
        </button>
        {statusOptions.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={status === option}
            className={status === option ? "is-active" : ""}
            onClick={() => setStatus(option)}
          >
            {statusLabel(option)}
          </button>
        ))}
      </div>

      {resource.stale && resource.failure ? (
        <Notice
          tone="warning"
          title="Showing the last verified queue"
          className="reviews-notice"
          action={
            <button
              type="button"
              className="reviews-notice-action"
              onClick={() => void resource.reload()}
            >
              Retry
            </button>
          }
        >
          {resource.failure.message} Existing records are timestamped and remain
          readable, but no new decisions should be inferred from this snapshot.
        </Notice>
      ) : null}

      {snapshot && snapshot.invalidCount > 0 ? (
        <Notice
          tone="warning"
          title={`${snapshot.invalidCount} malformed ${
            snapshot.invalidCount === 1 ? "record was" : "records were"
          } withheld`}
          className="reviews-notice"
        >
          Only rows with a stable identifier, a valid rating, and complete
          moderation state are shown.
        </Notice>
      ) : null}

      {atServerWindow ? (
        <Notice
          tone="warning"
          title={`This server returned its ${REVIEW_LIST_CAP}-record maximum`}
          className="reviews-notice"
        >
          The API does not provide a total or next-page cursor. Treat this as a
          loaded window, not proof that the moderation backlog is complete.
        </Notice>
      ) : null}

      <div
        ref={queueFocusRef}
        className="reviews-results-heading"
        tabIndex={-1}
      >
        <div>
          <span>
            {status === ALL ? "All loaded states" : statusLabel(status)}
          </span>
          <strong>
            {visibleReviews.length}{" "}
            {visibleReviews.length === 1 ? "review" : "reviews"}
          </strong>
        </div>
        <p>
          {query
            ? `Matching “${query}” inside the verified loaded window.`
            : sort === "queue" && status === DEFAULT_STATUS
              ? "Oldest pending reviews are surfaced first."
              : "Ordering applies only to the currently loaded window."}
        </p>
      </div>

      <section
        className="reviews-results"
        aria-label="Review queue"
        aria-busy={resource.transport === "loading"}
      >
        {terminalFailure ? (
          <div className="reviews-terminal-state">
            <span className="reviews-state-icon" aria-hidden="true">
              <Icon name="alert-triangle" size={22} />
            </span>
            <h3>The review queue could not be verified</h3>
            <p>
              {resource.failure?.message ??
                "The service did not return a usable review list."}
            </p>
            <button type="button" onClick={() => void resource.reload()}>
              Try again
            </button>
          </div>
        ) : initialLoading ? (
          <div className="reviews-skeleton-list" aria-label="Loading reviews">
            {Array.from({ length: 3 }, (_, index) => (
              <div className="reviews-card-skeleton" key={index}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : (snapshot?.items.length ?? 0) === 0 ? (
          <div className="reviews-empty-state">
            <span className="reviews-state-icon" aria-hidden="true">
              <Icon name="shield-check" size={22} />
            </span>
            <h3>
              {status === DEFAULT_STATUS
                ? "No pending reviews in this loaded window"
                : "No reviews in this state"}
            </h3>
            <p>
              Refresh to verify again, or choose another state. An empty
              response is distinct from an unavailable queue.
            </p>
          </div>
        ) : visibleReviews.length === 0 ? (
          <div className="reviews-empty-state">
            <span className="reviews-state-icon" aria-hidden="true">
              <Icon name="users" size={22} />
            </span>
            <h3>No loaded reviews match this search</h3>
            <p>Clear the search to return to the current moderation window.</p>
            <button type="button" onClick={() => setQuery("")}>
              Clear search
            </button>
          </div>
        ) : (
          <ol className="reviews-queue-list">
            {visibleReviews.map((review) => (
              <li key={review.id}>
                <ReviewCard
                  review={review}
                  canAdmin={canAdmin}
                  selected={selectedReview?.id === review.id}
                  onOpen={(event) => openReview(review, event)}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <ReviewDetailModal
        open={selectedReview !== null}
        review={selectedReview}
        canAdmin={canAdmin}
        returnFocusRef={returnFocusRef}
        onClose={() => setSelected(null)}
        onDecision={recordDecision}
      />
    </div>
  );
}
