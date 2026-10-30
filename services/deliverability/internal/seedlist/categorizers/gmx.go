package categorizers

import (
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// GMX uses "Spam" / "Junk" depending on locale.
type GMX struct{}

func (GMX) Provider() domain.Provider { return domain.ProviderGMX }

func (GMX) Categorize(m Message) domain.Placement {
	f := strings.ToLower(m.Folder)
	switch {
	case strings.Contains(f, "spam"), strings.Contains(f, "junk"):
		return domain.PlacementSpam
	case f == "inbox":
		return domain.PlacementPrimary
	case f == "":
		return domain.PlacementMissing
	}
	return domain.PlacementPrimary
}
