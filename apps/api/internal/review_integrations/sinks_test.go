// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/reviews"
)

type captureReviewCreator struct {
	review reviews.Review
}

func (c *captureReviewCreator) CreateReview(_ context.Context, _ string, in reviews.Review) (*reviews.Review, error) {
	c.review = in
	return &reviews.Review{ID: "review_1"}, nil
}

func TestProductReviewSinkPersistsResolvedCustomerID(t *testing.T) {
	creator := &captureReviewCreator{}
	sink := ProductReviewSink{Repo: creator}
	submittedAt := time.Date(2026, 6, 20, 10, 11, 12, 0, time.UTC)

	if _, err := sink.ImportReview(context.Background(), "tenant-1", ProviderYotpo, ReviewInput{
		SourceID:      "yotpo://review/42",
		CustomerID:    "66666666-6666-6666-6666-666666666666",
		ReviewerEmail: "buyer@example.com",
		Rating:        5,
		Title:         "Great",
		Status:        "approved",
		SubmittedAt:   &submittedAt,
	}); err != nil {
		t.Fatalf("import review: %v", err)
	}
	if creator.review.CustomerID != "66666666-6666-6666-6666-666666666666" {
		t.Fatalf("customer id = %q", creator.review.CustomerID)
	}
	if !creator.review.SubmittedAt.Equal(submittedAt) {
		t.Fatalf("submitted_at = %v", creator.review.SubmittedAt)
	}
}
