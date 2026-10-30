package reviews

import "testing"

func TestValidateReview(t *testing.T) {
	out := ValidateReview(Review{Rating: 5, Title: "Great", Status: "pending"})
	if !out.Valid {
		t.Fatalf("expected valid review, got %#v", out.Errors)
	}

	out = ValidateReview(Review{Rating: 6, Body: "Nope"})
	if out.Valid {
		t.Fatalf("expected invalid rating")
	}
}

func TestPublicReviewRedactsEmail(t *testing.T) {
	public := ToPublicReview(&Review{
		ID:            "r1",
		ReviewerName:  "",
		ReviewerEmail: "secret@example.com",
		Rating:        4,
		Body:          "Helpful",
		VerifiedBuyer: true,
	})
	if public.ReviewerName != "Verified customer" {
		t.Fatalf("unexpected reviewer name: %q", public.ReviewerName)
	}
}

func TestSummaryFromReviews(t *testing.T) {
	summary := SummaryFromReviews("p1", []Review{
		{Rating: 5, Status: "approved"},
		{Rating: 3, Status: "approved"},
		{Rating: 1, Status: "pending"},
	})
	if summary.ApprovedCount != 2 {
		t.Fatalf("approved count = %d", summary.ApprovedCount)
	}
	if summary.AverageRating != 4 {
		t.Fatalf("average rating = %f", summary.AverageRating)
	}
	if summary.RatingCounts["5"] != 1 || summary.RatingCounts["3"] != 1 || summary.RatingCounts["1"] != 0 {
		t.Fatalf("unexpected counts: %#v", summary.RatingCounts)
	}
}

func TestValidateMediaRejectsUnsafeKey(t *testing.T) {
	out := ValidateMedia(Media{ReviewID: "r1", StorageKey: "../escape.jpg", Status: "uploaded"})
	if out.Valid {
		t.Fatalf("expected unsafe storage key to fail")
	}
}
