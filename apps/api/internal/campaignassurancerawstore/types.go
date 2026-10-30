// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassurancerawstore stores Campaign Assurance model output in
// immutable, versioned S3 objects. A durable write intent is created before the
// object write and an immutable exact-version receipt is committed before Put
// returns an object key. That ordering prevents an extraction from pointing at
// storage whose version cannot later be proven or erased exactly.
package campaignassurancerawstore

import (
	"context"
	"errors"
	"time"
)

var (
	ErrInvalidConfiguration = errors.New("campaign assurance raw store: invalid configuration")
	ErrInvalidIdentity      = errors.New("campaign assurance raw store: invalid identity")
	ErrNotReady             = errors.New("campaign assurance raw store: storage is not ready")
	ErrObjectConflict       = errors.New("campaign assurance raw store: immutable object conflict")
	ErrReceiptUnavailable   = errors.New("campaign assurance raw store: durable version receipt unavailable")
	ErrCleanupNotAuthorized = errors.New("campaign assurance raw store: cleanup is not authorized")
	ErrExactVersionMissing  = errors.New("campaign assurance raw store: exact version is missing")
)

const (
	ContentTypeJSON = "application/json"

	CleanupDeleted        = "deleted"
	CleanupAlreadyMissing = "already_missing"
)

// Configuration is deliberately narrow. Bucket and KMSKeyID are mandatory:
// accepting bucket defaults would make it impossible to prove the exact key
// that encrypted a particular version.
type Configuration struct {
	Bucket           string
	KMSKeyID         string
	WorkerID         string
	OperationTimeout time.Duration
	CleanupLeaseTTL  time.Duration
	OrphanGrace      time.Duration
	RetryBackoff     func(attempt int64) time.Duration
}

type WriteIntentInput struct {
	TenantID       string
	IntentID       string
	ObjectRest     string
	ObjectKey      string
	ObjectRef      string
	ContentSHA256  string
	ChecksumBase64 string
	ContentType    string
	ByteSize       int64
	Bucket         string
	KMSKeyIDHash   string
}

type WriteIntent struct {
	WriteIntentInput
	State          string
	Attempt        int64
	LeaseToken     string
	LeaseOwner     string
	LeaseExpiresAt time.Time
	CreatedAt      time.Time
	Version        *VersionReceipt
}

// VersionReceipt is the immutable provider identity captured immediately after
// PutObject and verified with HeadObject against the exact VersionID.
type VersionReceipt struct {
	TenantID          string
	IntentID          string
	ObjectRest        string
	ObjectKey         string
	ObjectRef         string
	Bucket            string
	VersionID         string
	ContentSHA256     string
	ChecksumBase64    string
	ContentType       string
	ByteSize          int64
	KMSKeyIDHash      string
	ProviderProofHash string
	ReceiptHash       string
	RecordedAt        time.Time
}

type CleanupResult struct {
	Disposition           string
	ResponseVersion       string
	DeleteMarker          bool
	ProviderRequestIDHash string
}

type ReconcileResult struct {
	Claimed        int
	Deleted        int
	AlreadyMissing int
	Failed         int
	VersionsFound  int
}

// Repository is the durable half of the store. Implementations must serialize
// cleanup claims with the extraction receipt gate installed by migration 2016.
type Repository interface {
	Ready(context.Context) error
	BeginWrite(context.Context, WriteIntentInput) (WriteIntent, error)
	RecordVersion(context.Context, WriteIntent, VersionReceipt) (VersionReceipt, error)
	LoadVersion(context.Context, string, string, string) (VersionReceipt, error)
	ClaimCleanup(context.Context, string, string, string, time.Duration) (WriteIntent, error)
	ClaimOrphans(context.Context, string, int, time.Duration, time.Duration) ([]WriteIntent, error)
	RecordCleanup(context.Context, WriteIntent, VersionReceipt, CleanupResult) error
	RecordCleanupFailure(context.Context, WriteIntent, *VersionReceipt, string, error, time.Duration) error
}
