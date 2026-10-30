package categorizers

import "github.com/postwave/postwave/services/deliverability/internal/domain"

// Gmail uses label IDs (CATEGORY_*) plus the SPAM and INBOX system labels.
type Gmail struct{}

func (Gmail) Provider() domain.Provider { return domain.ProviderGmail }

func (Gmail) Categorize(m Message) domain.Placement {
	has := func(lbl string) bool {
		for _, l := range m.Labels {
			if l == lbl {
				return true
			}
		}
		return false
	}
	switch {
	case has("SPAM"), has("CATEGORY_SPAM"):
		return domain.PlacementSpam
	case has("CATEGORY_PROMOTIONS"):
		return domain.PlacementPromotions
	case has("CATEGORY_UPDATES"):
		return domain.PlacementUpdates
	case has("CATEGORY_SOCIAL"):
		return domain.PlacementSocial
	case has("CATEGORY_PRIMARY"), has("INBOX"):
		return domain.PlacementPrimary
	}
	return domain.PlacementMissing
}
