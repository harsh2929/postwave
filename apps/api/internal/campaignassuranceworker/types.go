// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassuranceworker executes one tenant/run-scoped Campaign
// Assurance command against immutable synthetic artifacts. It deliberately
// contains no recipient lookup, outbound transport, model client, URL fetcher,
// or mailbox client.
package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	Version = "postwave.campaign-assurance-worker.v1"

	DeterministicConfigurationID = "deterministic.campaignchecks.v2"

	OutcomeComplete   Outcome = "complete"
	OutcomeIncomplete Outcome = "incomplete"
	OutcomeRequeued   Outcome = "requeued"
	OutcomeFailed     Outcome = "failed"
	OutcomeDeferred   Outcome = "deferred"
	OutcomeDuplicate  Outcome = "duplicate"
	OutcomeCancelled  Outcome = "cancelled"
	OutcomeStale      Outcome = "stale"
)

var (
	ErrInvalidWorker         = errors.New("campaign assurance worker: invalid worker configuration")
	ErrInvalidCommand        = errors.New("campaign assurance worker: invalid command")
	ErrManifestIntegrity     = errors.New("campaign assurance worker: claimed manifest integrity failure")
	ErrArtifactIntegrity     = errors.New("campaign assurance worker: artifact integrity failure")
	ErrObjectTooLarge        = errors.New("campaign assurance worker: object exceeds byte limit")
	ErrObjectMediaType       = errors.New("campaign assurance worker: object media type mismatch")
	ErrUnsupportedAnalyzer   = errors.New("campaign assurance worker: analyzer configuration unavailable")
	ErrSyntheticOnly         = errors.New("campaign assurance worker: artifact contains a non-synthetic recipient")
	ErrQueue                 = errors.New("campaign assurance worker: command queue failure")
	ErrHeartbeat             = errors.New("campaign assurance worker: lease heartbeat failed")
	ErrLifecycle             = errors.New("campaign assurance worker: lifecycle persistence failed")
	ErrWorkerContextCanceled = errors.New("campaign assurance worker: execution context cancelled")
)

// Command is the complete durable dispatch identity. Workers never scan across
// tenants; a queue/outbox supplies both UUIDs.
type Command struct {
	DeliveryID string `json:"delivery_id,omitempty"`
	TenantID   string `json:"tenant_id"`
	RunID      string `json:"run_id"`
}

type Outcome string

// Result tells a queue consumer whether the durable command is terminal or
// needs delayed redelivery. Run never contains a claim token in JSON.
type Result struct {
	Outcome      Outcome                `json:"outcome"`
	Run          *campaignassurance.Run `json:"run,omitempty"`
	RetryAt      *time.Time             `json:"retry_at,omitempty"`
	FindingCount int                    `json:"finding_count"`
	BlockerCount int                    `json:"blocker_count"`
}

// AssuranceRepository is implemented by *campaignassurance.Repo. Keeping the
// exact leased surface here makes scheduler mounting and isolated tests
// possible without weakening the persistence package's worker fences.
type AssuranceRepository interface {
	ClaimRun(context.Context, string, string, string, time.Duration) (*campaignassurance.ClaimedRun, error)
	RenewLease(context.Context, string, string, string, int, time.Duration) (*campaignassurance.Run, error)
	RecordExtraction(context.Context, string, string, string, int, campaignassurance.ExtractionInput) (*campaignassurance.Extraction, error)
	FindReusableModeledExtraction(context.Context, string, string, string, int, campaignassurance.ModeledCacheLookupInput) (*campaignassurance.ReusableModeledExtraction, error)
	RecordModeledCacheReuse(context.Context, string, string, string, int, campaignassurance.ModeledCacheReuseInput) (*campaignassurance.Extraction, error)
	ReserveModeledInvocation(context.Context, string, string, string, int, campaignassurance.ModeledInvocationReservationInput) (*campaignassurance.ModeledInvocationReservation, error)
	RecordModeledInvocationResult(context.Context, string, string, string, int, campaignassurance.ModeledInvocationResultInput) (*campaignassurance.ModeledInvocationResult, error)
	RecordFinding(context.Context, string, string, string, int, campaignassurance.FindingInput) (*campaignassurance.Finding, error)
	FinalizeRun(context.Context, string, string, string, int, campaignassurance.FinalizeInput) (*campaignassurance.Run, error)
	RetryRun(context.Context, string, string, string, int, time.Time, campaignassurance.RunFailure) (*campaignassurance.Run, error)
	FailRun(context.Context, string, string, string, int, campaignassurance.RunFailure) (*campaignassurance.Run, error)
	GetRun(context.Context, string, string) (*campaignassurance.Run, error)
}

// ArtifactRepository is implemented by *campaignartifact.Repo. All reads bind
// tenant, campaign, plan, and child identity before returning object refs.
type ArtifactRepository interface {
	GetRevision(context.Context, string, string, string) (*campaignartifact.Revision, error)
	GetPlan(context.Context, string, string, string) (*campaignartifact.Plan, error)
	GetArtifact(context.Context, string, string, string, string) (*campaignartifact.Artifact, error)
}

// ObjectReader is the read-only subset of uploads.Store. The only expected
// implementation is tenant-namespaced internal object storage. Object refs are
// parsed before this interface is called; arbitrary URLs are never accepted.
type ObjectReader interface {
	Get(context.Context, string, string) (io.ReadCloser, string, error)
}

// RawOutputStore is the tenant-scoped encrypted object-storage subset required
// before modeled execution can be enabled. Put returns only after durable
// exact-version write provenance exists for the unique key; Delete supports
// exact-version compensating cleanup if the extraction receipt fails.
type RawOutputStore interface {
	CampaignAssuranceRawOutputStore()
	Put(context.Context, string, string, string, io.Reader) (string, error)
	Get(context.Context, string, string) (io.ReadCloser, string, error)
	Delete(context.Context, string, string) error
}

// Configuration controls bounded execution behavior, not analyzer
// methodology. Methodology identities are frozen on each run/configuration.
type Configuration struct {
	WorkerID         string
	LeaseTTL         time.Duration
	HeartbeatEvery   time.Duration
	CleanupTimeout   time.Duration
	MaxModelTimeout  time.Duration
	RawOutputTTL     time.Duration
	RetryBackoff     func(attempt int) time.Duration
	Now              func() time.Time
	MaxHTMLBytes     int64
	MaxTextBytes     int64
	MaxMIMEBytes     int64
	MaxRevisionBytes int
}

type Worker struct {
	Assurance      AssuranceRepository
	Artifacts      ArtifactRepository
	Objects        ObjectReader
	RawOutputs     RawOutputStore
	ModelExecutor  ModelExecutor
	ImageInspector campaignimagebroker.Inspector
	// OfferResolver resolves the F15 canonical-offer bridge. Optional: nil means
	// no bridge is resolved, and the checks report nothing assessed rather than
	// agreement. An interface rather than a repository so this package keeps no
	// dependency on offer storage, matching how every other collaborator here is
	// declared.
	OfferResolver OfferResolver
	Config        Configuration
}

// OfferResolver resolves in-email canonical offer references against the
// entities an agent would query.
//
// The read is deliberately performed per run rather than cached: the answer is
// SUPPOSED to change when the entity changes, which is why the message carries a
// reference and not a snapshot.
type OfferResolver interface {
	ResolveCanonicalOffers(
		ctx context.Context, tenantID string, document semanticemail.DocumentV2,
	) ([]campaignchecks.CanonicalOfferBinding, error)
}

// DeterministicConfiguration is the only locally executable analyzer shape.
// The detector and gate-policy identities are explicit and frozen into the run.
type DeterministicConfiguration struct {
	AnalyzerVersion string `json:"analyzer_version"`
	PolicyVersion   string `json:"policy_version"`
}

// NewDeterministicConfiguration returns the configuration a run creator should
// freeze for this worker. It performs no I/O and carries no model/OCR claim.
func NewDeterministicConfiguration(policyVersion string) (campaignassurance.ConfigurationInput, error) {
	configuration := DeterministicConfiguration{
		AnalyzerVersion: campaignchecks.DetectorVersion,
		PolicyVersion:   policyVersion,
	}
	raw, err := json.Marshal(configuration)
	if err != nil {
		return campaignassurance.ConfigurationInput{}, err
	}
	if err := validateDeterministicConfiguration(raw, policyVersion); err != nil {
		return campaignassurance.ConfigurationInput{}, err
	}
	return campaignassurance.ConfigurationInput{
		ID:            DeterministicConfigurationID,
		SourceClass:   campaignassurance.SourceDeterministic,
		Configuration: raw,
	}, nil
}
