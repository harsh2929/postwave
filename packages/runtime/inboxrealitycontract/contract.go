// SPDX-License-Identifier: AGPL-3.0-only

// Package inboxrealitycontract is the versioned wire contract between the API
// gateway and the deliverability execution service. It intentionally carries
// an exact synthetic artifact body but never seed credentials, recipient UI
// content, or real-recipient MIME.
package inboxrealitycontract

import (
	"encoding/json"
	"time"
)

const (
	Version         = "postwave.inbox-reality-dispatch.v1"
	SeedlistVersion = "postwave.inbox-reality-seedlist.v1"
	DispatchPath    = "/internal/inbox-reality/dispatch"
	SeedlistPath    = "/internal/inbox-reality/seedlist"
	ObservationPath = "/api/internal/inbox-reality/observations"

	// SeedlistRequestID is a constant on purpose. internalsign's request
	// identity is a stable OPERATION identity whose job is to make a replay
	// converge on the durable store instead of repeating a side effect. A
	// catalog read has no side effect to repeat, so every fetch genuinely is
	// the same operation; a per-attempt random value would misdescribe that.
	SeedlistRequestID = "inbox-reality-seedlist"
)

// SeedEntry is one controlled mailbox as the gateway is allowed to see it.
//
// It is deliberately NOT seedlist.Inbox, and not an embedding of it. The
// service-side Inbox carries IMAPUser, IMAPPasswordEnv and two secret
// references; reusing that type here would mean every field added to it in
// future silently crosses the trust boundary. Three fields is everything the
// gateway needs to advertise a manual test, so a credential has nowhere to go.
//
// Address is present because a manual test is the customer sending mail TO
// these mailboxes — the address is the deliverable, not a secret. The IMAP
// credentials that READ those mailboxes are what must never leave the service.
// No display label travels on this wire: the gateway owns customer-facing
// copy via Provider.DisplayName(), and sending a second copy from the service
// would let the two drift apart with no test able to see it.
type SeedEntry struct {
	MailboxID string `json:"mailbox_id"`
	Provider  string `json:"provider"`
	Address   string `json:"address"`
}

// SeedProvider is one row of the provider catalog. SeedCount counts only
// active mailboxes, so a provider whose seeds are all flagged reports zero
// rather than advertising capacity that cannot execute.
type SeedProvider struct {
	Provider       string `json:"provider"`
	SeedCount      int    `json:"seed_count"`
	HasCategorizer bool   `json:"has_categorizer"`
}

// SeedlistResponse is the internal seed catalog projection. Seeds contains
// ONLY active mailboxes: a flagged or banned seed cannot produce a placement
// observation, and handing one to the gateway would mint a test that silently
// never completes.
type SeedlistResponse struct {
	ContractVersion string         `json:"contract_version"`
	Seeds           []SeedEntry    `json:"seeds"`
	Providers       []SeedProvider `json:"providers"`
	CapturedAt      time.Time      `json:"captured_at"`
}

type CapabilityRequirements struct {
	Placement       string `json:"placement"`
	Headers         string `json:"headers"`
	RawMIME         string `json:"raw_mime"`
	BodyParts       string `json:"body_parts"`
	ObservedSurface string `json:"observed_surface"`
}

type CapabilitySnapshot struct {
	Version         string    `json:"version"`
	Connector       string    `json:"connector"`
	Placement       string    `json:"placement"`
	Headers         string    `json:"headers"`
	RawMIME         string    `json:"raw_mime"`
	BodyParts       string    `json:"body_parts"`
	ObservedSurface string    `json:"observed_surface"`
	CapturedAt      time.Time `json:"captured_at"`
}

type DispatchRequest struct {
	ContractVersion       string                 `json:"contract_version"`
	CommandID             string                 `json:"command_id"`
	TenantID              string                 `json:"tenant_id"`
	TestID                string                 `json:"test_id"`
	LeaseToken            string                 `json:"lease_token"`
	RequestHash           string                 `json:"request_hash"`
	HeaderValue           string                 `json:"header_value"`
	CampaignID            string                 `json:"campaign_id"`
	ContentRevisionID     string                 `json:"content_revision_id"`
	SendPlanID            string                 `json:"send_plan_id"`
	ArtifactID            string                 `json:"artifact_id"`
	ScenarioID            string                 `json:"scenario_id"`
	ArtifactMIMEHash      string                 `json:"artifact_mime_hash"`
	ArtifactStructureHash string                 `json:"artifact_structure_hash"`
	RequestedCapabilities CapabilityRequirements `json:"requested_capabilities"`
	RawMIME               []byte                 `json:"raw_mime"`
	ExpiresAt             time.Time              `json:"expires_at"`
}

type SeedDispatchReceipt struct {
	MailboxID          string          `json:"mailbox_id"`
	Provider           string          `json:"provider"`
	State              string          `json:"state"`
	AttemptCount       int             `json:"attempt_count"`
	DispatchedMIMEHash string          `json:"dispatched_mime_hash"`
	FailureCode        string          `json:"failure_code,omitempty"`
	CapabilitySnapshot json.RawMessage `json:"capability_snapshot"`
}

type ExecutionReceipt struct {
	ContractVersion    string                `json:"contract_version"`
	CommandID          string                `json:"command_id"`
	TestID             string                `json:"test_id"`
	ArtifactID         string                `json:"artifact_id"`
	ScenarioID         string                `json:"scenario_id"`
	ArtifactMIMEHash   string                `json:"artifact_mime_hash"`
	DispatchedMIMEHash string                `json:"dispatched_mime_hash"`
	CapabilitySnapshot CapabilitySnapshot    `json:"capability_snapshot"`
	Status             string                `json:"status"`
	SeedCount          int                   `json:"seed_count"`
	AcceptedCount      int                   `json:"accepted_count"`
	RejectedCount      int                   `json:"rejected_count"`
	IndeterminateCount int                   `json:"indeterminate_count"`
	RetryWaitCount     int                   `json:"retry_wait_count"`
	Deliveries         []SeedDispatchReceipt `json:"deliveries"`
	CompletedAt        time.Time             `json:"completed_at"`
}

// ObservationReceipt is the sanitized, address-free projection emitted only
// after the append-only deliverability observation has committed. It carries
// no raw MIME, header token, seed address, credentials, or UI-summary claim.
type ObservationReceipt struct {
	TenantID                string          `json:"tenant_id"`
	TestID                  string          `json:"test_id"`
	ArtifactID              string          `json:"artifact_id"`
	ScenarioID              string          `json:"scenario_id"`
	ObservationKey          string          `json:"observation_key"`
	MailboxID               string          `json:"mailbox_id"`
	Provider                string          `json:"provider"`
	Placement               string          `json:"placement"`
	Folder                  string          `json:"folder"`
	CapabilitySnapshot      json.RawMessage `json:"capability_snapshot"`
	RawMIMEStatus           string          `json:"raw_mime_status"`
	ReceivedMIMESHA256      string          `json:"received_mime_sha256,omitempty"`
	ReceivedStructureSHA256 string          `json:"received_mime_structure_sha256,omitempty"`
	StructureComparison     string          `json:"structure_comparison"`
	CapturedAt              time.Time       `json:"captured_at"`
}
