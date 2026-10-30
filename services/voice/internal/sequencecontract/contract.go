// Package sequencecontract owns persistence-level invariants shared by the
// sequence HTTP handlers and the production sequence store.
//
// Keeping these values in a dependency-neutral package prevents the memory and
// Postgres implementations from drifting behind look-alike error sentinels or
// status allow-lists that only fail once a request reaches the database.
package sequencecontract

import (
	"errors"
	"fmt"
	"strings"
)

const (
	StatusDraft    = "draft"
	StatusActive   = "active"
	StatusArchived = "archived"
)

var (
	// ErrNotFound is the shared missing-row sentinel used by the HTTP boundary
	// and every sequence persistence implementation. Callers must use
	// errors.Is rather than matching database error text.
	ErrNotFound = errors.New("sequence: not found")

	// ErrVersionMismatch is returned when an optimistic-concurrency write is
	// based on a row version that is no longer current.
	ErrVersionMismatch = errors.New("sequence: version mismatch")

	// ErrUnsupportedStatus is returned before persistence when a status is not
	// representable by the voice_sequences database constraint.
	ErrUnsupportedStatus = errors.New("sequence: unsupported status")
)

// NormalizeStatus applies the wire-level normalization used by the handler and
// returns only values accepted by the production voice_sequences CHECK
// constraint. An omitted status is the persisted draft default.
func NormalizeStatus(status string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(status))
	if normalized == "" {
		return StatusDraft, nil
	}
	switch normalized {
	case StatusDraft, StatusActive, StatusArchived:
		return normalized, nil
	default:
		return "", fmt.Errorf("%w: %q (allowed: draft, active, archived)", ErrUnsupportedStatus, normalized)
	}
}
