package categorizers

import (
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Outlook covers both outlook.com and Office 365. Folder name is the source
// of truth; "Junk Email" / "Junk" = spam, INBOX = primary.
type Outlook struct {
	// O365 toggles the Provider() return value so the same logic powers both
	// outlook.com and managed M365 tenants.
	O365 bool
}

func (o Outlook) Provider() domain.Provider {
	if o.O365 {
		return domain.ProviderO365
	}
	return domain.ProviderOutlookCom
}

func (Outlook) Categorize(m Message) domain.Placement {
	f := strings.ToLower(m.Folder)
	switch {
	case strings.Contains(f, "junk"), strings.Contains(f, "spam"):
		return domain.PlacementSpam
	case strings.Contains(f, "deleted"):
		return domain.PlacementBlocked
	case f == "inbox":
		return domain.PlacementPrimary
	}
	if f == "" {
		return domain.PlacementMissing
	}
	return domain.PlacementPrimary
}
