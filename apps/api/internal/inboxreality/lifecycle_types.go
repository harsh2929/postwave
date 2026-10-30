// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

const (
	KindCampaignAssurance Kind = "campaign_assurance"

	RequirementRequired CapabilityRequirement = "required"
	RequirementOptional CapabilityRequirement = "optional"
	RequirementDisabled CapabilityRequirement = "disabled"

	DispatchQueued     DispatchState = "queued"
	DispatchLeased     DispatchState = "leased"
	DispatchRetryWait  DispatchState = "retry_wait"
	DispatchDispatched DispatchState = "dispatched"
	DispatchFailed     DispatchState = "failed"
	DispatchExpired    DispatchState = "expired"
	DispatchCancelled  DispatchState = "cancelled"
)

var (
	ErrIdempotencyConflict = errors.New("inboxreality: idempotency key reused with different input")
	ErrArtifactUnavailable = errors.New("inboxreality: exact artifact is unavailable")
	ErrLeaseLost           = errors.New("inboxreality: dispatch lease lost")
	ErrNoDispatchCommand   = errors.New("inboxreality: no claimable dispatch command")
	ErrInvalidLifecycle    = errors.New("inboxreality: invalid exact-artifact lifecycle input")
	ErrNoActiveSeeds       = errors.New("inboxreality: no active controlled seed mailboxes")
)

type CapabilityRequirement string

// CapabilityRequirements is a request, not an observed capability claim. The
// deliverability service freezes the actual snapshot at execution time. A
// controlled seed never promises a provider/client UI summary.
type CapabilityRequirements struct {
	Placement       CapabilityRequirement `json:"placement"`
	Headers         CapabilityRequirement `json:"headers"`
	RawMIME         CapabilityRequirement `json:"raw_mime"`
	BodyParts       CapabilityRequirement `json:"body_parts"`
	ObservedSurface CapabilityRequirement `json:"observed_surface"`
}

func DefaultCapabilityRequirements() CapabilityRequirements {
	return CapabilityRequirements{
		Placement: RequirementRequired, Headers: RequirementRequired,
		RawMIME: RequirementRequired, BodyParts: RequirementRequired,
		ObservedSurface: RequirementDisabled,
	}
}

func (r CapabilityRequirements) normalized() (CapabilityRequirements, error) {
	defaults := DefaultCapabilityRequirements()
	values := []*CapabilityRequirement{&r.Placement, &r.Headers, &r.RawMIME, &r.BodyParts, &r.ObservedSurface}
	defaultValues := []CapabilityRequirement{defaults.Placement, defaults.Headers, defaults.RawMIME, defaults.BodyParts, defaults.ObservedSurface}
	for index, value := range values {
		if *value == "" {
			*value = defaultValues[index]
		}
		switch *value {
		case RequirementRequired, RequirementOptional, RequirementDisabled:
		default:
			return CapabilityRequirements{}, ErrInvalidLifecycle
		}
	}
	if r.ObservedSurface == RequirementRequired {
		// A seed IMAP/API connector cannot prove a named provider UI surface.
		return CapabilityRequirements{}, ErrInvalidLifecycle
	}
	return r, nil
}

type DispatchState string

type DispatchCommand struct {
	ID                    string                 `json:"id"`
	TenantID              string                 `json:"-"`
	TestID                string                 `json:"test_id"`
	IdempotencyKey        string                 `json:"-"`
	RequestHash           string                 `json:"request_hash"`
	CampaignID            string                 `json:"campaign_id"`
	ContentRevisionID     string                 `json:"content_revision_id"`
	SendPlanID            string                 `json:"send_plan_id"`
	ArtifactID            string                 `json:"artifact_id"`
	ScenarioID            string                 `json:"scenario_id"`
	ArtifactMIMEObjectRef string                 `json:"-"`
	ArtifactMIMEHash      string                 `json:"artifact_mime_hash"`
	ArtifactStructureHash string                 `json:"artifact_structure_hash"`
	RequestedCapabilities CapabilityRequirements `json:"requested_capabilities"`
	State                 DispatchState          `json:"state"`
	AvailableAt           time.Time              `json:"available_at"`
	AttemptCount          int                    `json:"attempt_count"`
	MaxAttempts           int                    `json:"max_attempts"`
	LeaseOwner            string                 `json:"-"`
	LeaseToken            string                 `json:"-"`
	LeaseExpiresAt        *time.Time             `json:"-"`
	ExecutionReceipt      json.RawMessage        `json:"execution_receipt,omitempty"`
	LastErrorCode         string                 `json:"last_error_code,omitempty"`
	FailureCode           string                 `json:"failure_code,omitempty"`
	CreatedAt             time.Time              `json:"created_at"`
	UpdatedAt             time.Time              `json:"updated_at"`
	CompletedAt           *time.Time             `json:"completed_at,omitempty"`
}

type ExactCreateParams struct {
	TenantID              string
	HeaderToken           string
	ArtifactID            string
	ScenarioID            string
	IdempotencyKey        string
	RequestHash           string
	RequestedCapabilities CapabilityRequirements
	ExpiresAt             time.Time
}

type ExactCreateResult struct {
	Test    Test
	Command DispatchCommand
	Replay  bool
}

type ObservationReceipt struct {
	TenantID                string          `json:"tenant_id"`
	TestID                  string          `json:"test_id"`
	ArtifactID              string          `json:"artifact_id"`
	ScenarioID              string          `json:"scenario_id"`
	ObservationKey          string          `json:"observation_key"`
	MailboxID               string          `json:"mailbox_id"`
	Provider                Provider        `json:"provider"`
	Placement               Placement       `json:"placement"`
	Folder                  string          `json:"folder"`
	CapabilitySnapshot      json.RawMessage `json:"capability_snapshot"`
	RawMIMEStatus           string          `json:"raw_mime_status"`
	ReceivedMIMESHA256      string          `json:"received_mime_sha256,omitempty"`
	ReceivedStructureSHA256 string          `json:"received_mime_structure_sha256,omitempty"`
	StructureComparison     string          `json:"structure_comparison"`
	CapturedAt              time.Time       `json:"captured_at"`
}

// LifecycleStore is the gateway authority for exact tests. All cross-tenant
// methods are called only by dedicated workers or a signed internal callback.
type LifecycleStore interface {
	CreateExactTest(ctx context.Context, params ExactCreateParams) (ExactCreateResult, error)
	GetDispatch(ctx context.Context, tenantID, testID string) (DispatchCommand, error)
	ClaimDispatch(ctx context.Context, ownerID string, leaseTTL time.Duration) (DispatchCommand, error)
	CompleteDispatch(ctx context.Context, command DispatchCommand, receipt json.RawMessage) error
	RetryDispatch(ctx context.Context, command DispatchCommand, retryAt time.Time, errorCode string) error
	FailDispatch(ctx context.Context, command DispatchCommand, failureCode string) error
	CancelTest(ctx context.Context, tenantID, testID string, at time.Time) error
	ExpireDue(ctx context.Context, limit int, at time.Time) (int, error)
	RecordObservation(ctx context.Context, receipt ObservationReceipt) (Result, error)
}
