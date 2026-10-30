package categorizers

import (
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Proton exposes IMAP via Proton Bridge. Folder names match the web UI:
// Inbox, Spam, Archive, Sent.
type Proton struct{}

func (Proton) Provider() domain.Provider { return domain.ProviderProton }

func (Proton) Categorize(m Message) domain.Placement {
	f := strings.ToLower(m.Folder)
	switch {
	case strings.Contains(f, "spam"):
		return domain.PlacementSpam
	case f == "inbox":
		return domain.PlacementPrimary
	case f == "":
		return domain.PlacementMissing
	}
	return domain.PlacementPrimary
}
