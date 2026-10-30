// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Review-widget authoring release policy.
 *
 * Keep this synchronized with the "Widget authoring is review-gated" notice in
 * apps/desktop/src/components/reviews/WidgetsTab.tsx. The server mounts
 * POST /api/v1/reviews/widgets (reviews.go, admin scope) and accepts a widget
 * in any lifecycle state, but exposes no later edit or transition command.
 * Desktop therefore withholds authoring; web does the same, from one flag so
 * the transport and the form cannot disagree.
 */
export const REVIEW_WIDGET_AUTHORING_AVAILABLE = false;

export const REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON =
  "The current API accepts a one-shot widget in any lifecycle state, including active, but provides no later edit or transition command. Authoring is withheld here to prevent immediate, unreviewed publication and unrecoverable lifecycle states. Existing inventory remains inspectable.";

export class ReviewWidgetAuthoringUnavailableError extends Error {
  readonly code = "review_widget_authoring_unavailable";
  readonly status = 503;
  readonly retryable = false;

  constructor() {
    super(REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON);
    this.name = "ReviewWidgetAuthoringUnavailableError";
  }
}
