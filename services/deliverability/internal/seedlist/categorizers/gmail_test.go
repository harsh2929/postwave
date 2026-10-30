package categorizers

import (
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

func TestGmailCategorize(t *testing.T) {
	cases := []struct {
		name string
		msg  Message
		want domain.Placement
	}{
		{"primary", Message{Labels: []string{"INBOX", "CATEGORY_PRIMARY"}}, domain.PlacementPrimary},
		{"promotions", Message{Labels: []string{"INBOX", "CATEGORY_PROMOTIONS"}}, domain.PlacementPromotions},
		{"updates", Message{Labels: []string{"INBOX", "CATEGORY_UPDATES"}}, domain.PlacementUpdates},
		{"social", Message{Labels: []string{"INBOX", "CATEGORY_SOCIAL"}}, domain.PlacementSocial},
		{"spam", Message{Labels: []string{"SPAM"}}, domain.PlacementSpam},
		{"missing", Message{Labels: []string{}}, domain.PlacementMissing},
	}
	g := Gmail{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := g.Categorize(tc.msg); got != tc.want {
				t.Fatalf("got=%s want=%s", got, tc.want)
			}
		})
	}
}
