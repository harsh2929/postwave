import type { ContactHistoryEvent } from "../../lib/api-client";

export interface SubscriberHistoryDetail {
  label: string;
  value: string;
}

export interface SubscriberHistoryDisplay {
  title: string;
  details: SubscriberHistoryDetail[];
  detailsHidden: boolean;
}

function validRating(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 5
    ? value
    : null;
}

/**
 * Convert an API history event into the complete allowlisted display model.
 * Unknown kinds and malformed payloads never fall back to raw JSON.
 */
export function subscriberHistoryDisplay(
  event: Pick<ContactHistoryEvent, "kind" | "payload">,
): SubscriberHistoryDisplay {
  if (event.kind === "rating.changed") {
    const rating = validRating(event.payload?.rating);
    return {
      title: "Contact rating changed",
      details:
        rating == null
          ? []
          : [
              {
                label: "Rating",
                value: rating === 0 ? "Cleared" : `${rating} of 5`,
              },
            ],
      detailsHidden: rating == null,
    };
  }

  return {
    title: "Subscriber activity recorded",
    details: [],
    detailsHidden: true,
  };
}
