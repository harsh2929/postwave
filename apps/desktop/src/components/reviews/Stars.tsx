import type { ReactElement } from "react";

import { clampRating, starString } from "../../lib/reviews-helpers";

export function Stars({
  rating,
}: {
  rating: number | null | undefined;
}): ReactElement {
  const value = clampRating(rating);
  return (
    <span className="reviews-stars" data-rating={value}>
      <span className="visually-hidden">{value} out of 5 stars</span>
      <span aria-hidden="true">{starString(value)}</span>
      <span className="reviews-stars-value" aria-hidden="true">
        {value}.0
      </span>
    </span>
  );
}
