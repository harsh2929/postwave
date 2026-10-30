package handlers

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
)

const sequenceIdentifierMaxBytes = 128

// UUIDs are the canonical production identifier. A narrow legacy grammar is
// retained for old development fixtures and imported IDs; production
// Postgres stores reject non-UUID values as not-found before issuing a cast.
// Arbitrary text, separators, control characters, and unbounded values never
// reach persistence.
var sequenceIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func sequenceIDFromRequest(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := chi.URLParam(r, "id")
	id := strings.TrimSpace(raw)
	if raw != id || !isAcceptedSequenceIdentifier(id) {
		http.Error(w, "invalid sequence id", http.StatusBadRequest)
		return "", false
	}
	return id, true
}

func isAcceptedSequenceIdentifier(id string) bool {
	return len(id) > 0 && len(id) <= sequenceIdentifierMaxBytes && sequenceIdentifierPattern.MatchString(id)
}

func validateOpaqueSubscriberID(id string) error {
	id = strings.TrimSpace(id)
	if !isAcceptedSequenceIdentifier(id) || strings.Contains(id, "@") {
		return errors.New("subscriber_id must be an opaque identifier using 1-128 letters, digits, dots, underscores, or dashes")
	}
	return nil
}
