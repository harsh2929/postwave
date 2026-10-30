// SPDX-License-Identifier: AGPL-3.0-only
package inboxreality

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned when a test or result lookup misses.
var ErrNotFound = errors.New("inboxreality: not found")

// ErrTokenCollision is returned when MintToken happened to produce a
// token already in the DB. The handler retries on this; the cosmic-ray
// odds are 1 in 2^128 but tests cover the retry path because we want
// the contract to be explicit.
var ErrTokenCollision = errors.New("inboxreality: token collision")

// CreateTestParams is the parameter bag for Store.CreateTest. We don't
// take a *Test directly because the store assigns id/created_at/etc.;
// callers shouldn't have to zero those fields.
type CreateTestParams struct {
	TenantID    string
	HeaderToken string
	Kind        Kind
	Subject     string
	FromAddress string
	ExpiresAt   time.Time
	Meta        []byte // raw JSON; "{}" when empty
}

// RecordResultParams is the parameter bag for Store.RecordResult.
type RecordResultParams struct {
	TestID     string
	MailboxID  string
	Provider   Provider
	Placement  Placement
	FolderName string
	RawHeaders []byte // raw JSON; nil when not supplied
}

// Store is the persistence seam. The Postgres impl lives in
// store_pg.go; the in-memory impl in store_memory.go is what tests use.
type Store interface {
	// CreateTest inserts a new inbox_reality_tests row. Returns the
	// fully-hydrated Test (with id + timestamps populated). On
	// UNIQUE violation of header_token returns ErrTokenCollision so
	// the caller can retry.
	CreateTest(ctx context.Context, p CreateTestParams) (Test, error)

	// GetTest fetches one test by id within the tenant scope. RLS
	// enforces the tenant boundary; the tenantID arg is what we bind
	// into app.tenant_id for that transaction.
	GetTest(ctx context.Context, tenantID, testID string) (Test, error)

	// ListTests returns the most recent tests for a tenant, capped
	// at limit (max 100).
	ListTests(ctx context.Context, tenantID string, limit int) ([]Test, error)

	// ListResults returns all results for a test. Order: classified_at
	// ASC so the live UI can append rows as they arrive.
	ListResults(ctx context.Context, tenantID, testID string) ([]Result, error)

	// RecordResult writes a single (test, mailbox) row. UNIQUE on
	// (test_id, mailbox_id) — a re-classification of the same mailbox
	// updates the existing row rather than inserting twice.
	RecordResult(ctx context.Context, p RecordResultParams) (Result, error)

	// UpdateStatus transitions a test's status with conditional set
	// of completed_at. Used by the orchestrator when finalising.
	UpdateStatus(ctx context.Context, tenantID, testID string, status TestStatus, completedAt *time.Time) error

	// FindTestByToken looks up a test by header_token. Used by the
	// deliverability-service pivot when a poller reports a classified
	// message — it has the token from the header but not the test_id.
	// This lookup is global (no tenant guard) because the token IS
	// the auth: knowing the random 128-bit value is proof. RLS still
	// applies on the row read.
	FindTestByToken(ctx context.Context, token string) (Test, error)
}
