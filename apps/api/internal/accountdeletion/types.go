// SPDX-License-Identifier: AGPL-3.0-only

// Package accountdeletion owns deletion of one authenticated Moosewave user.
// It intentionally does not delete tenants or workspace-owned content; that
// higher-blast-radius operation remains in the separately labelled privacy
// administration workflow.
package accountdeletion

import (
	"context"
	"errors"
	"time"
)

const ConfirmationPhrase = "DELETE MY ACCOUNT"

var (
	ErrActorNotFound = errors.New("acting user not found")
	ErrLastOwner     = errors.New("last workspace owner")
	ErrNoSession     = errors.New("a browser or mobile session is required")
	ErrReauthFailed  = errors.New("reauthentication failed")
	ErrFreshAuth     = errors.New("fresh provider authentication required")
	ErrMFARequired   = errors.New("a current MFA code is required")
)

// Request is the safe, non-PII request projection returned to the acting
// user. The durable privacy row never needs to expose another account.
type Request struct {
	ID                 string     `json:"request_id"`
	Status             string     `json:"status"`
	RequestedAt        time.Time  `json:"requested_at"`
	ExecuteAfter       time.Time  `json:"execute_after"`
	DueAt              time.Time  `json:"due_at"`
	CompletedAt        *time.Time `json:"completed_at,omitempty"`
	LegalHold          bool       `json:"legal_hold"`
	RetentionExpiresAt time.Time  `json:"retention_expires_at"`
}

// CreateParams contains only identifiers already resolved from the signed-in
// request. Email is intentionally absent so a queued certificate cannot turn
// into another plaintext PII store.
type CreateParams struct {
	TenantID          string
	UserID            string
	Region            string
	ReauthMethod      string
	IdempotencyDigest []byte
	Now               time.Time
	ExecuteAfter      time.Time
	DueAt             time.Time
	RetentionExpires  time.Time
}

type Store interface {
	Create(ctx context.Context, p CreateParams) (request Request, replayed bool, err error)
	Status(ctx context.Context, tenantID, userID string) (*Request, error)
}

type ReauthInput struct {
	Password string
	MFACode  string
}

type Reauthenticator interface {
	Verify(ctx context.Context, sessionCookie string, tenantID, userID string, in ReauthInput) (method string, err error)
}

// CompletionNotifier is deliberately optional. Implementations must send to
// the in-memory email captured before deletion; the worker never persists it
// into fulfillment metadata or logs.
type CompletionNotifier interface {
	NotifyAccountDeleted(ctx context.Context, email, requestID string) error
}

func isLastOwner(role string, otherOwners int) bool {
	return role == "owner" && otherOwners == 0
}
