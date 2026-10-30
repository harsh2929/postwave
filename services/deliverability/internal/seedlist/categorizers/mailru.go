package categorizers

import (
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// MailRu uses "Spam" (Russian: Спам). We match either.
type MailRu struct{}

func (MailRu) Provider() domain.Provider { return domain.ProviderMailRu }

func (MailRu) Categorize(m Message) domain.Placement {
	f := strings.ToLower(m.Folder)
	switch {
	case strings.Contains(f, "spam"), strings.Contains(f, "спам"):
		return domain.PlacementSpam
	case f == "inbox", strings.Contains(f, "входящ"):
		return domain.PlacementPrimary
	case f == "":
		return domain.PlacementMissing
	}
	return domain.PlacementPrimary
}
