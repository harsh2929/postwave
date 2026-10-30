package categorizers

import (
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Yahoo uses "Bulk Mail" for spam (not "Junk" / "Spam").
type Yahoo struct{}

func (Yahoo) Provider() domain.Provider { return domain.ProviderYahoo }

func (Yahoo) Categorize(m Message) domain.Placement {
	f := strings.ToLower(m.Folder)
	switch {
	case strings.Contains(f, "bulk"), strings.Contains(f, "spam"), strings.Contains(f, "junk"):
		return domain.PlacementSpam
	case f == "inbox":
		return domain.PlacementPrimary
	case f == "":
		return domain.PlacementMissing
	}
	return domain.PlacementPrimary
}
