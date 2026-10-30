// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignsendruntime compiles and dispatches real-recipient RFC822
// messages from migration 1923's immutable Campaign Assurance binding. It is a
// convergence boundary, not another renderer: all projections flow through
// campaigncompiler and all provider calls flow through campaigndelivery.
package campaignsendruntime

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigndelivery"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

const Version = "postwave.campaign-send-runtime.v1"

var ErrRecipientValuesUnsupported = errors.New("campaign send runtime: recipient values unsupported")

const (
	ReasonInvalidBinding              = "BOUND_BINDING_INVALID"
	ReasonRevisionUnavailable         = "BOUND_REVISION_UNAVAILABLE"
	ReasonPlanUnavailable             = "BOUND_PLAN_UNAVAILABLE"
	ReasonRunUnavailable              = "BOUND_RUN_UNAVAILABLE"
	ReasonArtifactsUnavailable        = "BOUND_ARTIFACTS_UNAVAILABLE"
	ReasonSourceMismatch              = "BOUND_SOURCE_HASH_MISMATCH"
	ReasonPlanMismatch                = "BOUND_PLAN_HASH_MISMATCH"
	ReasonRunMismatch                 = "BOUND_RUN_MANIFEST_MISMATCH"
	ReasonGateMismatch                = "BOUND_GATE_MISMATCH"
	ReasonCoverageMismatch            = "BOUND_COVERAGE_MISMATCH"
	ReasonArtifactMismatch            = "BOUND_ARTIFACT_RECEIPT_MISMATCH"
	ReasonArtifactObjectUnavailable   = "BOUND_ARTIFACT_OBJECT_UNAVAILABLE"
	ReasonArtifactObjectMismatch      = "BOUND_ARTIFACT_OBJECT_MISMATCH"
	ReasonVariantUnsupported          = "BOUND_VARIANT_UNSUPPORTED"
	ReasonLocaleUnsupported           = "BOUND_LOCALE_UNSUPPORTED"
	ReasonBranchUnsupported           = "BOUND_BRANCH_UNSUPPORTED"
	ReasonFixtureUnsupported          = "BOUND_FIXTURE_UNSUPPORTED"
	ReasonPersonalizationUnavailable  = "BOUND_PERSONALIZATION_UNAVAILABLE"
	ReasonPollLinksUnavailable        = "BOUND_POLL_LINKS_UNAVAILABLE"
	ReasonReplyCorrelationUnavailable = "BOUND_REPLY_CORRELATION_UNAVAILABLE"
	ReasonEnvelopeInvalid             = "BOUND_ENVELOPE_INVALID"
	ReasonCompileFailed               = "BOUND_RECIPIENT_COMPILE_FAILED"
	ReasonMIMEIntegrity               = "BOUND_REAL_MIME_HASH_MISMATCH"
	ReasonDeliveryRejected            = "BOUND_DELIVERY_REJECTED"
	ReasonDeliveryIndeterminate       = "BOUND_DELIVERY_INDETERMINATE"
	ReasonDeliveryUnavailable         = "BOUND_DELIVERY_UNAVAILABLE"
)

// ArtifactReader is implemented by *campaignartifact.Repo. Every method is
// tenant/campaign scoped; a runtime must never query "latest" state.
type ArtifactReader interface {
	GetRevision(ctx context.Context, tenantID, campaignID, revisionID string) (*campaignartifact.Revision, error)
	GetPlan(ctx context.Context, tenantID, campaignID, planID string) (*campaignartifact.Plan, error)
	ListArtifacts(ctx context.Context, tenantID, campaignID, planID string) ([]campaignartifact.Artifact, error)
}

// AssuranceReader is implemented by *campaignassurance.Repo. The manifest is
// the exact run snapshot and includes every artifact/configuration/target cell.
type AssuranceReader interface {
	GetRunManifest(ctx context.Context, tenantID, runID string) (*campaignassurance.ClaimedRun, error)
}

// ObjectReader matches the read half of uploads.MemoryStore/S3UploadStore.
// The runtime reads only the selected synthetic .eml proof, within a hard
// bound, and never writes or retains real-recipient MIME.
type ObjectReader interface {
	Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error)
}

type RecipientResolveInput struct {
	TenantID         string
	CampaignID       string
	Recipient        string
	RequestedSlots   []semanticemail.SlotID
	AvailableLocales []string
}

type RecipientValues struct {
	Locale string
	Slots  map[semanticemail.SlotID]string
}

// RecipientResolver supplies only declared semantic slots. Implementations
// must return a fresh map and must not persist recipient values as evidence.
type RecipientResolver interface {
	ResolveRecipient(context.Context, RecipientResolveInput) (RecipientValues, error)
}

// PollLinkMinter supplies recipient-specific links for poll nodes in the exact
// immutable campaign revision selected by the queue binding. Implementations
// accept only opaque recipient references, never mailbox addresses.
// HoneypotDecoyMinter produces the recipient-specific decoy markup for one
// message. Returning an empty slice is always valid and means no decoy is
// embedded for this recipient.
type HoneypotDecoyMinter interface {
	MintDecoys(tenantID, campaignID string, campaignRecipientID int64, issuedAt time.Time) ([]string, error)
}

type PollLinkMinter interface {
	MintLinks(
		ctx context.Context,
		tenantID, campaignID, contentRevisionID, recipientReference string, issuedAt time.Time,
		document semanticemail.DocumentV2,
	) (semanticemail.PollOptionLinks, error)
}

type DeliveryCoordinator interface {
	Dispatch(context.Context, campaigndelivery.Request) (campaigndelivery.Result, error)
}

// ReplyCorrelationMinter returns a deterministic, opaque identity bound to
// the exact preallocated delivery UUID. Production uses
// *replycorrelation.Service; the interface keeps runtime tests hermetic.
type ReplyCorrelationMinter interface {
	Mint(replycorrelation.MintInput) (replycorrelation.Correlation, error)
}

type Runtime struct {
	Artifacts ArtifactReader
	Assurance AssuranceReader
	// Gate revalidates the exact queue receipt immediately before recipient
	// compilation. It catches run staleness and finding-scoped waiver
	// revocation before any provider-bound work; the delivery ledger trigger is
	// the final database-enforced copy of the same rule.
	Gate       campaignassurancegate.BoundAuthorizer
	Objects    ObjectReader
	Recipients RecipientResolver
	Polls      PollLinkMinter
	// Honeypot mints the F01 decoys embedded in each recipient's HTML. Optional
	// by design: nil means this deployment has not opted into embedding decoys
	// in customer mail, and a send proceeds unchanged rather than failing. That
	// asymmetry is deliberate — a poll link is content the recipient needs, so
	// its absence withholds the send, whereas a decoy is measurement and losing
	// it must never cost a delivery.
	Honeypot         HoneypotDecoyMinter
	ReplyCorrelation ReplyCorrelationMinter
	Delivery         DeliveryCoordinator
	Now              func() time.Time
}

var _ sending.AssuranceBoundDispatcher = (*Runtime)(nil)
