// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/reviews"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type ReviewSink interface {
	ImportReview(ctx context.Context, tenantID, provider string, review ReviewInput) (string, error)
}

type ProfileSink interface {
	UpsertReviewer(ctx context.Context, tenantID, provider string, review ReviewInput) (string, error)
}

type EventSink interface {
	TrackReviewEvent(ctx context.Context, tenantID, provider string, review ReviewInput) (int64, error)
}

type reviewCreator interface {
	CreateReview(context.Context, string, reviews.Review) (*reviews.Review, error)
}

type ProductReviewSink struct {
	Repo reviewCreator
}

func (s ProductReviewSink) ImportReview(ctx context.Context, tenantID, provider string, in ReviewInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("review_integrations: review sink unavailable")
	}
	meta := map[string]any{}
	for k, v := range in.Metadata {
		meta[k] = v
	}
	meta["review_provider"] = provider
	if in.SubmittedAt != nil {
		meta["provider_submitted_at"] = in.SubmittedAt.UTC().Format(time.RFC3339)
	}
	raw := map[string]any{}
	for k, v := range in.RawPayload {
		raw[k] = v
	}
	mapped := reviews.Review{
		ProductID:      in.ProductID,
		VariantID:      in.VariantID,
		OrderID:        in.OrderID,
		CustomerID:     in.CustomerID,
		SourcePlatform: provider,
		SourceRef:      in.SourceID,
		ReviewType:     firstString(in.ReviewType, "product"),
		ReviewerName:   in.ReviewerName,
		ReviewerEmail:  in.ReviewerEmail,
		Rating:         in.Rating,
		Title:          in.Title,
		Body:           in.Body,
		Status:         firstString(in.Status, "pending"),
		VerifiedBuyer:  in.VerifiedBuyer,
		Incentivized:   in.Incentivized,
		Featured:       in.Featured,
		Metadata:       meta,
		RawPayload:     raw,
	}
	if in.SubmittedAt != nil {
		mapped.SubmittedAt = in.SubmittedAt.UTC()
	}
	if validation := reviews.ValidateReview(mapped); !validation.Valid {
		return "", fmt.Errorf("review validation failed: %s", strings.Join(validation.Errors, "; "))
	}
	out, err := s.Repo.CreateReview(ctx, tenantID, mapped)
	if err != nil {
		return "", err
	}
	return out.ID, nil
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type ReviewerProfileSink struct {
	Repo subscriberUpserter
}

func (s ReviewerProfileSink) UpsertReviewer(ctx context.Context, tenantID, provider string, review ReviewInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("review_integrations: profile sink unavailable")
	}
	if strings.TrimSpace(review.ReviewerEmail) == "" {
		return "", fmt.Errorf("reviewer_email is required")
	}
	props := map[string]any{
		"review_provider":    provider,
		"last_review_rating": review.Rating,
	}
	if review.SourceID != "" {
		props["last_review_source_id"] = review.SourceID
	}
	if review.ProductID != "" {
		props["last_review_product_id"] = review.ProductID
	}
	if review.OrderID != "" {
		props["last_review_order_id"] = review.OrderID
	}
	if customerID := firstString(review.CustomerID, reviewMetadataString(review.Metadata, "resolved_customer_id")); customerID != "" {
		props["last_review_customer_id"] = customerID
	}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(review.ReviewerEmail)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 []string{provider, "reviewer"},
		SourceID:             review.SourceID,
		SourcePlatform:       provider,
		FullName:             review.ReviewerName,
		DisplayName:          review.ReviewerName,
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_review_sync_at": time.Now().UTC().Format(time.RFC3339)},
	})
	if err != nil {
		return "", err
	}
	return sub.ID, nil
}

type trackRepo interface {
	ResolveSubscriberIdentity(context.Context, string, string, string) (track.SubscriberIdentity, error)
	Insert(context.Context, string, string, string, []byte, time.Time, string) (int64, error)
}

type TrackEventSink struct {
	Repo trackRepo
}

func (s TrackEventSink) TrackReviewEvent(ctx context.Context, tenantID, provider string, review ReviewInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("review_integrations: event sink unavailable")
	}
	if strings.TrimSpace(review.ReviewerEmail) == "" {
		return 0, fmt.Errorf("reviewer_email is required")
	}
	sub, err := s.Repo.ResolveSubscriberIdentity(ctx, tenantID, "", strings.ToLower(strings.TrimSpace(review.ReviewerEmail)))
	if err != nil {
		return 0, err
	}
	props := map[string]any{
		"review_provider": provider,
		"rating":          review.Rating,
		"status":          firstString(review.Status, "pending"),
	}
	if review.SourceID != "" {
		props["review_source_id"] = review.SourceID
	}
	if review.ProductID != "" {
		props["product_id"] = review.ProductID
	}
	if review.OrderID != "" {
		props["order_id"] = review.OrderID
	}
	if customerID := firstString(review.CustomerID, reviewMetadataString(review.Metadata, "resolved_customer_id")); customerID != "" {
		props["customer_id"] = customerID
	}
	if review.Title != "" {
		props["title"] = review.Title
	}
	raw, _ := json.Marshal(props)
	occurred := time.Now().UTC()
	if review.SubmittedAt != nil {
		occurred = review.SubmittedAt.UTC()
	}
	eventName := firstString(review.EventName, "review.submitted")
	return s.Repo.Insert(ctx, tenantID, sub.ID, eventName, raw, occurred, "")
}
