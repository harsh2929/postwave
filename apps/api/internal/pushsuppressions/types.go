// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultPageLimit       = 50
	maxPageLimit           = 100
	fingerprintHexLength   = 16
	maxCursorBytes         = 2048
	maxSingleJSONBodyBytes = 16 << 10
	maxBulkJSONBodyBytes   = 512 << 10
	maxBulkItems           = 100
)

var validPlatforms = map[string]bool{"apns": true, "fcm": true, "web": true}
var validReasons = map[string]bool{
	"manual": true, "unregistered": true, "expired": true,
	"complaint": true, "user_opt_out": true,
}

// Row is an active authority fact as seen at one list snapshot. Despite the
// compatibility field name, DeviceTokenHash is only a 16-character lowercase
// hexadecimal fingerprint. The full digest never crosses the HTTP boundary.
// Source is the finite public enum dashboard|provider|user|complaint|legacy;
// internal provider/source identifiers are never copied into this shape.
type Row struct {
	ID              string    `json:"id"`
	TenantID        string    `json:"tenant_id"`
	DeviceTokenHash string    `json:"device_token_hash"`
	Platform        string    `json:"platform"`
	Reason          string    `json:"reason"`
	Source          string    `json:"source"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	Version         int64     `json:"version"`
	Reversible      bool      `json:"reversible"`
	LockedReason    string    `json:"locked_reason,omitempty"`

	authority string
}

type ListFilter struct {
	Platform         string
	Reason           string
	HashPrefix       string
	Limit            int
	SnapshotAt       time.Time
	SnapshotRevision int64
	AfterAt          time.Time
	AfterID          string
}

type ListResult struct {
	Items            []Row
	Total            int64
	SnapshotAt       time.Time
	SnapshotRevision int64
	HasMore          bool
}

type ManualAdd struct {
	DeviceToken string
	Platform    string
}

type AddResult struct {
	Row     Row
	Created bool
}

type RemoveRequest struct {
	ID              string `json:"id,omitempty"`
	ExpectedVersion int64  `json:"expected_version"`
}

type RemoveReceipt struct {
	OK              bool   `json:"ok"`
	TenantID        string `json:"tenantId"`
	ID              string `json:"id"`
	Version         int64  `json:"version"`
	StillSuppressed bool   `json:"stillSuppressed"`
}

type BulkImportResult struct {
	Rows     []Row
	Created  int
	Existing int
}

type BulkRemoveResult struct {
	Receipts        []RemoveReceipt
	Removed         int
	StillSuppressed int
}

var (
	ErrNotFound = errors.New("push suppression authority not found")
	ErrStale    = errors.New("push suppression authority version is stale")
)

type LockedError struct{ Reason string }

func (e *LockedError) Error() string { return "push suppression authority is locked: " + e.Reason }

type AuthorityStore interface {
	List(context.Context, string, ListFilter, db.AuditMeta) (ListResult, error)
	AddManual(context.Context, string, ManualAdd, db.AuditMeta) (AddResult, error)
	BulkAddManual(context.Context, string, []ManualAdd, db.AuditMeta) (BulkImportResult, error)
	RemoveManual(context.Context, string, RemoveRequest, db.AuditMeta) (RemoveReceipt, error)
	BulkRemoveManual(context.Context, string, []RemoveRequest, db.AuditMeta) (BulkRemoveResult, error)
}

func lockedReason(authority string) string {
	switch authority {
	case "provider":
		return "provider_authority"
	case "user":
		return "user_opt_out_authority"
	case "complaint":
		return "complaint_authority"
	case "legacy_unknown":
		return "legacy_authority_requires_review"
	default:
		// The database authority constraint makes this branch unreachable for
		// persisted rows. Project any future/unknown authority as legacy rather
		// than widening the public enum or accidentally making it reversible.
		return "legacy_authority_requires_review"
	}
}

// publicSource is deliberately derived from the bounded authority class. The
// database source column is internal provenance and admits bounded provider
// identifiers; exposing it would make the customer API an open-ended enum.
func publicSource(authority string) string {
	switch authority {
	case "manual":
		return "dashboard"
	case "provider":
		return "provider"
	case "user":
		return "user"
	case "complaint":
		return "complaint"
	case "legacy_unknown":
		return "legacy"
	default:
		return "legacy"
	}
}
