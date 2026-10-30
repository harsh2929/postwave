// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassuranceretention deletes expired Campaign Assurance raw
// model output only when the object store can prove and address an immutable
// storage version. Key-only deletion is intentionally unsupported: checking a
// hash and then deleting "the current key" has a race that can remove a newer
// object.
package campaignassuranceretention

import (
	"context"
	"errors"
	"time"
)

var (
	ErrInvalidConfiguration     = errors.New("campaign assurance raw-output retention: invalid configuration")
	ErrInvalidIdentity          = errors.New("campaign assurance raw-output retention: invalid identity")
	ErrLeaseLost                = errors.New("campaign assurance raw-output retention: lease lost")
	ErrIdentityConflict         = errors.New("campaign assurance raw-output retention: immutable identity conflict")
	ErrExactVersionUnavailable  = errors.New("campaign assurance raw-output retention: exact storage version unavailable")
	ErrDeletionNotAuthorized    = errors.New("campaign assurance raw-output retention: deletion not authorized")
	ErrUnprovenDeletionResponse = errors.New("campaign assurance raw-output retention: exact deletion response is unproven")
)

const (
	objectReferencePrefix = "postwave.tenant-object-ref.v1:"
	maxRawOutputBytes     = int64(1 << 20)

	DispositionDeleted        = "deleted"
	DispositionAlreadyMissing = "already_missing"
)

// Claim is one bounded, fenced attempt over one tenant-relative raw-output
// object. ObjectKey is derived from the opaque database reference and is never
// accepted from an external caller.
type Claim struct {
	TenantID            string
	TaskID              string
	ObjectReference     string
	ObjectKey           string
	ObjectReferenceHash string
	RawOutputHash       string
	SourceManifestHash  string
	CampaignScopeHash   string
	ExpiresAt           time.Time
	Attempt             int64
	LeaseToken          string
	LeaseExpiresAt      time.Time
}

// VersionIdentity is proof returned by a version-aware store. VersionID must
// identify an immutable version, ContentSHA256 must equal the extraction's
// retained raw-output hash, and ProviderProofSHA256 must bind the provider's
// version/head response. A store that cannot provide all of these must return
// ErrExactVersionUnavailable.
type VersionIdentity struct {
	Backend             string
	Bucket              string
	ObjectKey           string
	VersionID           string
	ContentSHA256       string
	ByteSize            int64
	ProviderProofSHA256 string
	ReceiptHash         string // populated only after the repository records it
}

// DeleteResult proves what happened when VersionID—not the current key—was
// requested. Already-missing is a valid idempotent replay outcome. A non-empty
// response version must equal the requested version.
type DeleteResult struct {
	Disposition     string
	ResponseVersion string
	DeleteMarker    bool
	// Provider request identifiers are sensitive operational correlators. The
	// storage adapter hashes them at ingress; the retention layer never accepts
	// or carries their plaintext form.
	ProviderRequestIDHash string
}

// ExactVersionStore is deliberately not satisfied by uploads.Store. That
// interface exposes key-only Delete and no version identity; adapting it would
// weaken this package's central safety property.
type ExactVersionStore interface {
	ResolveExactVersion(context.Context, string, string, string) (VersionIdentity, error)
	DeleteExactVersion(context.Context, string, VersionIdentity) (DeleteResult, error)
}

// Repository owns durable discovery, leases, version receipts, attempt
// receipts, and the legal-hold transaction fence.
type Repository interface {
	ClaimExpired(context.Context, string, int, time.Duration) ([]Claim, error)
	LoadVersion(context.Context, Claim) (*VersionIdentity, error)
	RecordVersion(context.Context, Claim, VersionIdentity) (VersionIdentity, error)
	RecordFailure(context.Context, Claim, string, error, string, time.Duration) error
	DeleteUnderLegalHoldFence(
		context.Context,
		Claim,
		VersionIdentity,
		string,
		time.Duration,
		func(context.Context) (DeleteResult, error),
	) (AttemptOutcome, error)
}

type AttemptOutcome struct {
	Outcome     string
	FailureCode string
	Disposition string
}

type SweepResult struct {
	Claimed         int
	Deleted         int
	AlreadyMissing  int
	Deferred        int
	Failed          int
	VersionResolved int
}

type Configuration struct {
	WorkerID       string
	BatchSize      int
	Concurrency    int
	LeaseTTL       time.Duration
	ResolveTimeout time.Duration
	DeleteTimeout  time.Duration
	RetryBackoff   func(attempt int64) time.Duration
}

func DefaultConfiguration(workerID string) Configuration {
	return Configuration{
		WorkerID: workerID, BatchSize: 100, Concurrency: 4,
		LeaseTTL: 5 * time.Minute, ResolveTimeout: 30 * time.Second,
		DeleteTimeout: 30 * time.Second,
		RetryBackoff: func(attempt int64) time.Duration {
			if attempt < 1 {
				attempt = 1
			}
			shift := attempt - 1
			if shift > 6 {
				shift = 6
			}
			return time.Minute * time.Duration(1<<shift)
		},
	}
}
