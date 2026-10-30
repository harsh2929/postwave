package seedlist

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

// ErrObservationIdentityNotFound is returned when a syntactically valid
// gateway token has no durable test row. Pollers keep the folder cursor in
// place so a cross-service commit race can recover rather than lose evidence.
var ErrObservationIdentityNotFound = errors.New("seed observation identity not found")

// FolderCursor is the durable IMAP cursor for one seed mailbox folder.
type FolderCursor struct {
	Folder      string    `json:"folder"`
	UIDValidity uint32    `json:"uid_validity"`
	LastUID     uint32    `json:"last_uid"`
	Generation  uint64    `json:"generation"`
	LastSeenAt  time.Time `json:"last_seen_at,omitempty"`
	UpdatedAt   time.Time `json:"updated_at,omitempty"`
}

// FolderWatermark describes the highest UID completely enumerated in one
// connector batch. A UIDVALIDITY change is explicit even when no messages were
// found, allowing storage to record a generation reset.
type FolderWatermark struct {
	Folder      string
	UIDValidity uint32
	LastUID     uint32
	ObservedAt  time.Time
}

type CursorMessageBatch struct {
	Messages   []categorizers.Message
	Watermarks []FolderWatermark
}

// CursorConnector is an optional stronger connector contract. Legacy/vendor
// implementations continue through FetchTaggedMessages; IMAP uses this path
// whenever the sink exposes durable cursor storage.
type CursorConnector interface {
	FetchTaggedMessagesFromCursors(context.Context, *Inbox, map[string]FolderCursor) (CursorMessageBatch, error)
}

// MailboxCursorStore persists platform-owned seed mailbox cursors. It contains
// mailbox IDs and folders only—never addresses or credentials.
type MailboxCursorStore interface {
	LoadSeedMailboxCursors(context.Context, string) (map[string]FolderCursor, error)
	AdvanceSeedMailboxCursors(context.Context, string, []FolderWatermark) error
}
