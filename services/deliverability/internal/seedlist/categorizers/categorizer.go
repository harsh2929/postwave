// Package categorizers provides per-provider strategies for translating raw
// IMAP message metadata (folder, labels, headers) into the canonical Placement
// enum. Adding a new provider = one new file implementing Categorizer.
package categorizers

import (
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Message contains transport-agnostic placement metadata and, when the
// connector supports it, a bounded raw-MIME acquisition. Categorizers only
// consume Folder, Labels, and Headers, so older callers and fixtures remain
// source-compatible when RawMIME is absent.
type Message struct {
	// Folder is the IMAP mailbox name the message was found in (e.g. "INBOX",
	// "Junk", "Spam", "Bulk Mail").
	Folder string
	// Labels are Gmail-style label IDs attached to the message
	// (e.g. "CATEGORY_PROMOTIONS").
	Labels []string
	// Headers is a flat copy of selected RFC-822 headers.
	Headers map[string]string
	// ReceivedAt is connector evidence (IMAP INTERNALDATE or a vendor receipt
	// timestamp), not the sender-controlled Date header.
	ReceivedAt time.Time `json:"received_at,omitempty"`
	// UID/UIDValidity identify one IMAP message independently from raw-MIME
	// availability and drive durable cursor/idempotency handling.
	UID         uint32 `json:"uid,omitempty"`
	UIDValidity uint32 `json:"uid_validity,omitempty"`
	// RawMIME is nil only for legacy callers. Production connectors set an
	// explicit complete, truncated, failed, or unavailable result.
	RawMIME *RawMIMEAcquisition `json:"raw_mime,omitempty"`
}

// Categorizer translates a Message into a Placement.
type Categorizer interface {
	Provider() domain.Provider
	Categorize(m Message) domain.Placement
}
