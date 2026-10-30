// SPDX-License-Identifier: AGPL-3.0-only

// Package campaigndelivery coordinates exact-byte campaign transport with a
// durable, tenant-scoped delivery attempt ledger. It deliberately treats a
// provider timeout as indeterminate: raw SES delivery has no provider-side
// idempotency token, so automatically retrying an ambiguous call can duplicate
// a message.
package campaigndelivery

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
)

const (
	StatePrepared      = "prepared"
	StateDispatching   = "dispatching"
	StateAccepted      = "accepted"
	StateRejected      = "rejected"
	StateIndeterminate = "indeterminate"

	GatePass       = "pass"
	GateWarn       = "warn"
	GateOverridden = "overridden"
)

var (
	ErrNotFound              = errors.New("campaign delivery: not found")
	ErrInvalidInput          = errors.New("campaign delivery: invalid input")
	ErrIntegrityMismatch     = errors.New("campaign delivery: identity or receipt mismatch")
	ErrIdempotencyConflict   = errors.New("campaign delivery: idempotency key reused with different input")
	ErrInvalidTransition     = errors.New("campaign delivery: invalid lifecycle transition")
	ErrAttemptInFlight       = errors.New("campaign delivery: attempt is already in flight")
	ErrAttemptRejected       = errors.New("campaign delivery: prior attempt was rejected")
	ErrDeliveryIndeterminate = errors.New("campaign delivery: provider acceptance is indeterminate")
	ErrLeaseLost             = errors.New("campaign delivery: attempt lease lost")
)

// AttemptInput contains only immutable identities and hashes. It never stores
// a recipient address or real-recipient MIME body.
type AttemptInput struct {
	DeliveryID            string `json:"delivery_id"`
	TenantID              string `json:"-"`
	CampaignID            string `json:"campaign_id"`
	CampaignRecipientID   int64  `json:"campaign_recipient_id"`
	SendPlanID            string `json:"send_plan_id"`
	ArtifactID            string `json:"artifact_id"`
	AssuranceRunID        string `json:"assurance_run_id"`
	AssuranceAttemptCount int    `json:"assurance_attempt_count"`
	ArtifactSetHash       string `json:"artifact_set_hash"`
	GateDecision          string `json:"gate_decision"`
	// GateOverrideIDs is the complete, exact set of latest live
	// finding-scoped governance receipts that authorized an overridden send.
	// A single representative waiver is insufficient because one blocked run
	// can contain several independently governed blockers.
	GateOverrideIDs           []string        `json:"gate_override_ids,omitempty"`
	ScenarioID                string          `json:"scenario_id"`
	SourceHash                string          `json:"source_hash"`
	PlanHash                  string          `json:"plan_hash"`
	CompilerVersion           string          `json:"compiler_version"`
	OutboundMIMEHash          string          `json:"outbound_mime_hash"`
	MessageID                 string          `json:"message_id"`
	ReplyTo                   string          `json:"reply_to"`
	ReplyCorrelationVersion   int             `json:"reply_correlation_version"`
	ReplyCorrelationKeyID     string          `json:"reply_correlation_key_id"`
	ReplyCorrelationExpiresAt *time.Time      `json:"reply_correlation_expires_at,omitempty"`
	ReplyCorrelationTokenHash string          `json:"reply_correlation_token_hash"`
	IdempotencyKey            string          `json:"idempotency_key"`
	TransportName             string          `json:"transport_name"`
	TransportContract         string          `json:"transport_contract_version"`
	CapabilitySnapshot        json.RawMessage `json:"capability_snapshot"`
}

// Attempt is the safe receipt projection used by the coordinator. Recipient
// identity remains behind CampaignRecipientID in the pre-existing queue.
type Attempt struct {
	ID string `json:"id"`
	AttemptInput
	AttemptNo            int        `json:"attempt_no"`
	RequestHash          string     `json:"request_hash"`
	State                string     `json:"state"`
	ClaimToken           string     `json:"-"`
	LeaseOwner           string     `json:"-"`
	LeaseExpiresAt       *time.Time `json:"lease_expires_at,omitempty"`
	ProviderMessageID    string     `json:"provider_message_id,omitempty"`
	ReceiptHash          string     `json:"receipt_hash,omitempty"`
	IdempotencyMode      string     `json:"idempotency_mode,omitempty"`
	FailureDisposition   string     `json:"failure_disposition,omitempty"`
	FailureCode          string     `json:"failure_code,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	DispatchStartedAt    *time.Time `json:"dispatch_started_at,omitempty"`
	AcceptedAt           *time.Time `json:"accepted_at,omitempty"`
	RejectedAt           *time.Time `json:"rejected_at,omitempty"`
	IndeterminateAt      *time.Time `json:"indeterminate_at,omitempty"`
	ProviderReconciledAt *time.Time `json:"provider_reconciled_at,omitempty"`
	ReconciliationSource string     `json:"reconciliation_source,omitempty"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

type Acquisition struct {
	Attempt  Attempt
	Acquired bool
}

type TerminalInput struct {
	TenantID             string
	AttemptID            string
	ClaimToken           string
	Receipt              campaigntransport.Receipt
	FailureCode          string
	ReconciliationSource string
}

type ReconcileInput struct {
	TenantID   string
	AttemptID  string
	Source     string
	Receipt    campaigntransport.Receipt
	RejectCode string
}

// Store owns atomic idempotency, claim fencing, lifecycle transitions, and
// replay reads. Acquire may reclaim an expired prepared attempt, but it must
// never reclaim a dispatching attempt; the latter becomes indeterminate.
type Store interface {
	Acquire(ctx context.Context, input AttemptInput, leaseOwner string, leaseDuration time.Duration) (Acquisition, error)
	MarkDispatching(ctx context.Context, tenantID, attemptID, claimToken string) error
	MarkAccepted(ctx context.Context, input TerminalInput) (Attempt, error)
	MarkRejected(ctx context.Context, input TerminalInput) (Attempt, error)
	MarkIndeterminate(ctx context.Context, input TerminalInput) (Attempt, error)
}

type Request struct {
	Attempt   AttemptInput
	Recipient string
	Messenger string
	Message   campaigntransport.CompiledMessage
}

type Result struct {
	Attempt  Attempt
	Receipt  campaigntransport.Receipt
	Replayed bool
}
