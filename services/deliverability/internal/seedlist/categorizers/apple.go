package categorizers

import (
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Apple iCloud uses "Junk" for spam.
type Apple struct{}

func (Apple) Provider() domain.Provider { return domain.ProviderICloud }

func (Apple) Categorize(m Message) domain.Placement {
	f := strings.ToLower(m.Folder)
	switch {
	case strings.Contains(f, "junk"), strings.Contains(f, "spam"):
		return domain.PlacementSpam
	case f == "inbox":
		return domain.PlacementPrimary
	case f == "":
		return domain.PlacementMissing
	}
	return domain.PlacementPrimary
}
