// SPDX-License-Identifier: AGPL-3.0-only
//
// flow_events.go wires native review actions into the Klaviyo-style
// product_event → flow mechanism. Before this, only externally-ingested reviews
// triggered flows (review_integrations.TrackEventSink emits a "review.submitted"
// product_event); a review submitted on the native storefront/dashboard fired
// nothing, so post-review flows could not run for first-party reviews.
//
// We emit the SAME "review.submitted" metric external ingestion uses, plus
// "review.requested" when a review request is created (the post-purchase
// "ready to review" trigger). main.go bridges FlowEventEmitter to internal/track
// so this package needn't import it (mirrors the EventSink wiring pattern).
package reviews

import (
	"context"
	"time"
)

// Product-event names that native review actions emit. review.submitted is
// intentionally identical to the name review_integrations.TrackEventSink emits,
// so native and integration-sourced reviews trigger the same flows.
const (
	EventReviewSubmitted = "review.submitted"
	EventReviewRequested = "review.requested"
)

// FlowEvent is a product-event emitted by a native review action.
type FlowEvent struct {
	EventName    string
	SubscriberID string         // when already known (review requests carry one)
	Email        string         // identity fallback when SubscriberID is empty
	OccurredAt   time.Time      // zero → now (the emitter substitutes)
	Props        map[string]any // product_id, rating, status, …
}

// FlowEventEmitter resolves the subscriber (by id or email), records the
// product_event, and fans it out to matching flows. Implementations MUST be
// best-effort and non-blocking on the request path; a nil emitter (the default)
// means native review actions simply don't trigger flows, exactly as before.
type FlowEventEmitter interface {
	EmitFlowEvent(ctx context.Context, tenantID string, ev FlowEvent)
}

// emitReviewSubmitted fires review.submitted for a freshly created/submitted
// review. No-op without an emitter or a reviewer email (the identity needed to
// resolve a subscriber to enroll).
func (d *Deps) emitReviewSubmitted(ctx context.Context, tenantID string, rv *Review) {
	if d.FlowEvents == nil || rv == nil || rv.ReviewerEmail == "" {
		return
	}
	d.FlowEvents.EmitFlowEvent(ctx, tenantID, FlowEvent{
		EventName:  EventReviewSubmitted,
		Email:      rv.ReviewerEmail,
		OccurredAt: rv.SubmittedAt,
		Props: map[string]any{
			"review_id":      rv.ID,
			"product_id":     rv.ProductID,
			"rating":         rv.Rating,
			"status":         rv.Status,
			"title":          rv.Title,
			"verified_buyer": rv.VerifiedBuyer,
			"review_type":    rv.ReviewType,
		},
	})
}

// emitReviewRequested fires review.requested when a review request is created —
// the post-purchase "ready to review" flow trigger. Prefers the request's
// subscriber id, falling back to its email.
func (d *Deps) emitReviewRequested(ctx context.Context, tenantID string, req *ReviewRequest) {
	if d.FlowEvents == nil || req == nil || (req.SubscriberID == "" && req.Email == "") {
		return
	}
	d.FlowEvents.EmitFlowEvent(ctx, tenantID, FlowEvent{
		EventName:    EventReviewRequested,
		SubscriberID: req.SubscriberID,
		Email:        req.Email,
		Props: map[string]any{
			"request_id": req.ID,
			"product_id": req.ProductID,
			"order_id":   req.OrderID,
			"channel":    req.Channel,
		},
	})
}
