import { type MouseEvent, type ReactElement, useId } from "react";

import type { Review } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import {
  excerpt,
  statusBadgeClass,
  statusLabel,
  widgetTypeLabel,
} from "../../lib/reviews-helpers";
import { Icon } from "../Icon";
import { Stars } from "./Stars";

export interface ReviewCardProps {
  review: Review;
  canAdmin: boolean;
  selected?: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}

function compactReference(value: string | null | undefined): string | null {
  const reference = value?.trim();
  if (!reference) return null;
  const points = Array.from(reference);
  if (points.length <= 22) return reference;
  return `${points.slice(0, 10).join("")}…${points.slice(-7).join("")}`;
}

function reviewName(review: Review): string {
  return review.reviewer_name?.trim() || "Anonymous reviewer";
}

function reviewHeading(review: Review): string {
  return review.title?.trim() || "Untitled review";
}

export function ReviewCard({
  review,
  canAdmin,
  selected = false,
  onOpen,
}: ReviewCardProps): ReactElement {
  const headingId = useId();
  const body = excerpt(review.body, 320);
  const submittedAt = review.submitted_at ?? review.created_at;
  const productReference = compactReference(review.product_id);
  const source = review.source_platform?.trim();
  const actionable = canAdmin && review.status === "pending";
  const reviewId = review.id?.trim();

  return (
    <article
      className={`reviews-card${selected ? " is-selected" : ""}`}
      aria-labelledby={headingId}
      data-review-status={review.status}
    >
      <div className="reviews-card-rating-row">
        <Stars rating={review.rating} />
        <span className={statusBadgeClass(review.status)}>
          {statusLabel(review.status)}
        </span>
      </div>

      <div className="reviews-card-heading">
        <div>
          <h3 id={headingId}>{reviewHeading(review)}</h3>
          <p>
            <strong>{reviewName(review)}</strong>
            {submittedAt ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>Reported </span>
                <time dateTime={submittedAt}>{fmtDate(submittedAt)}</time>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div
        className="reviews-card-signals"
        aria-label="Service-reported review flags; authenticity is not independently verified"
      >
        {review.verified_buyer ? (
          <span className="reviews-signal is-positive">
            <Icon name="shield-check" size={14} />
            Buyer verification reported
          </span>
        ) : (
          <span className="reviews-signal">
            <Icon name="eye" size={14} />
            Verification not reported
          </span>
        )}
        {review.incentivized ? (
          <span className="reviews-signal is-warning">Incentive reported</span>
        ) : null}
        {review.featured ? (
          <span className="reviews-signal">Featured flag reported</span>
        ) : null}
      </div>

      {body ? (
        <p className="reviews-card-excerpt">{body}</p>
      ) : (
        <p className="reviews-card-excerpt is-empty">
          No written review was supplied.
        </p>
      )}

      <dl className="reviews-card-context">
        <div>
          <dt>Reported product</dt>
          <dd>{productReference ?? "Not linked"}</dd>
        </div>
        <div>
          <dt>Reported source</dt>
          <dd>{source || "Not reported"}</dd>
        </div>
        <div>
          <dt>Reported type</dt>
          <dd>
            {review.review_type
              ? widgetTypeLabel(review.review_type)
              : "Not reported"}
          </dd>
        </div>
      </dl>

      <div className="reviews-card-footer">
        <span>
          {actionable
            ? "A full-evidence review is required before publication."
            : "Open the evidence record for the complete public state."}
        </span>
        <button
          type="button"
          className="reviews-card-open"
          onClick={onOpen}
          disabled={!reviewId}
          aria-label={`${actionable ? "Review and decide" : "Inspect"} ${reviewHeading(review)} by ${reviewName(review)}`}
        >
          {actionable ? "Review & decide" : "Inspect evidence"}
          <Icon name="arrow-right" size={16} />
        </button>
      </div>

      {!reviewId ? (
        <p className="reviews-card-integrity" role="status">
          This row has no stable review identifier, so its evidence cannot be
          opened.
        </p>
      ) : null}
    </article>
  );
}
