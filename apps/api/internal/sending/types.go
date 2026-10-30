// Send-loop guard — shared types.
//
// The send-loop guard (see sendloop.go) drains pending campaign_recipients
// rows under tenant-scoped RLS, while consulting the per-tenant rate
// limiter (ratelimit.go) and quiet-hours checker (quiet_hours.go). The
// guard turns the marketing claim "Sandbox · Budgets · Approvals" into
// real enforcement: tenant_sending_settings is now read at send-time, not
// just written by the settings UI.
//
// This file only contains shared, no-IO types so the guard's concrete
// implementation files don't all reach into each other.

package sending

import (
	"context"
	"errors"
	"time"
)

// Recipient-row status values. They mirror the CHECK constraint on
// campaign_recipients (migration 0068):
//
//	pending | sent | failed | cancelled | skipped
//
// The guard does NOT use a transient `sending` state — the schema doesn't
// allow it (see migration 0068's CHECK clause). Instead, idempotency on
// gateway restart relies on a SELECT … FOR UPDATE SKIP LOCKED + send +
// commit-or-rollback transaction per batch. If the gateway crashes
// after Listmonk accepts the message but before the row flips to 'sent',
// the row stays 'pending' and the next pass re-sends. This is at-least-
// once, which is the contract Listmonk's /api/tx already gives us.
const (
	RecipientPending   = "pending"
	RecipientSent      = "sent"
	RecipientFailed    = "failed"
	RecipientCancelled = "cancelled"
	RecipientSkipped   = "skipped"
)

// Sentinel errors surfaced by the guard. Tests assert against these to
// distinguish "we deliberately stopped this batch" from "the database
// blew up".
var (
	// ErrQuietHours signals that the tenant is currently inside the
	// configured quiet window and the batch was skipped on purpose.
	ErrQuietHours = errors.New("sending: quiet hours active")

	// ErrRateLimited signals that the tenant's hourly token bucket is
	// full. The batch was skipped; retry after the bucket window resets.
	ErrRateLimited = errors.New("sending: rate limited")

	// ErrCancelled signals that the parent campaign flipped to status=
	// cancelled mid-drain. Pending recipients are flipped to cancelled
	// by Repo.SetStatus; the loop just exits the batch.
	ErrCancelled = errors.New("sending: campaign cancelled")
)

// ListmonkSender is the narrow per-recipient send surface the guard
// needs. The implementation is wrapped over *listmonk.Client in main.go
// (see ListmonkTransactional below) so tests can supply a fake without
// standing up Listmonk.
//
// We deliberately model the per-recipient transactional API and not
// Listmonk's /api/campaigns batch endpoint:
//
//   - The campaigns endpoint hands fan-out to Listmonk's own worker,
//     which has no concept of Moosewave tenant_sending_settings. The
//     existing Send handler (campaigns/send.go) uses that path; the
//     queue-driven path here is the alternative that DOES enforce
//     tenant rate + quiet hours per recipient.
//   - /api/tx accepts a single recipient at a time and is the only
//     hook where the guard can interleave its checks.
type ListmonkSender interface {
	// Send fires one transactional email. tenantID is informational —
	// it does not change Listmonk routing but lets the wrapper attach
	// per-tenant headers if a deployment adapter wires sub-accounts.
	Send(ctx context.Context, tenantID, email, subject, htmlBody string) error
	// SendIdempotent is Send with an Idempotency-Key header attached
	// on the wire. Used by the send loop so a crash-then-replay of a
	// row that already hit Listmonk doesn't produce a duplicate at
	// the recipient — same key → same dedup. Empty key falls back to
	// Send (no header). See D2 in PRODUCTION_READINESS.md.
	SendIdempotent(ctx context.Context, tenantID, email, subject, htmlBody, idempotencyKey string) error
	// SendWithRouting is SendIdempotent + an optional Listmonk
	// `messenger` name that routes the send through a specific
	// SMTP backend (per-tenant dedicated IP pool). Empty messenger
	// falls through to Listmonk's default = same as SendIdempotent.
	// Audit (send-pipeline HIGH): dedicated-IP assignments were
	// decorative in the drain path because the send call never
	// specified a messenger.
	SendWithRouting(ctx context.Context, tenantID, email, subject, htmlBody, idempotencyKey, messenger string) error
	// SendWithHeaders is SendWithRouting + an arbitrary map of
	// per-recipient HTTP headers forwarded to Listmonk's /api/tx
	// (and ultimately into the outgoing message). Used to attach
	// the RFC 2369 List-Unsubscribe + RFC 8058 List-Unsubscribe-Post
	// values per recipient so the mailbox provider surfaces a
	// one-click unsubscribe gesture. Nil/empty headers map = same
	// as SendWithRouting.
	SendWithHeaders(ctx context.Context, tenantID, email, subject, htmlBody, idempotencyKey, messenger string, headers map[string]string) error
}

// AssuranceBinding is the immutable queue-time authorization copied onto a
// campaign_recipient by migration 1923. A row is legacy only when every field
// is empty. Any partially populated shape is still treated as bound so a
// corrupt/stale row can never fall through to the HTML-only Listmonk path.
type AssuranceBinding struct {
	ContentRevisionID string
	SendPlanID        string
	RunID             string
	RunAttempt        int
	ArtifactSetHash   string
	SourceHash        string
	PlanHash          string
	GateDecision      string
	OverrideIDs       []string
	BoundAt           *time.Time
}

// Any reports whether any assurance identity is present. It intentionally
// does not mean the shape is valid; validation belongs to the raw-MIME runtime.
func (b AssuranceBinding) Any() bool {
	return b.ContentRevisionID != "" || b.SendPlanID != "" || b.RunID != "" ||
		b.RunAttempt != 0 || b.ArtifactSetHash != "" || b.SourceHash != "" ||
		b.PlanHash != "" || b.GateDecision != "" || len(b.OverrideIDs) != 0 ||
		b.BoundAt != nil
}

type BoundDispatchStatus string

const (
	BoundDispatchAccepted      BoundDispatchStatus = "accepted"
	BoundDispatchRejected      BoundDispatchStatus = "rejected"
	BoundDispatchIndeterminate BoundDispatchStatus = "indeterminate"
	BoundDispatchWithheld      BoundDispatchStatus = "withheld"
	BoundDispatchRetryable     BoundDispatchStatus = "retryable"
)

// BoundDispatchInput contains recipient data only for the duration of one
// compile/send call. Implementations must not retain Recipient or real MIME.
// Headers have already passed the send-loop's consent and unsubscribe policy;
// the canonical compiler still validates them against its reserved-header set.
type BoundDispatchInput struct {
	TenantID            string
	CampaignID          string
	CampaignRecipientID int64
	// SubscriberID is subscribers.id for Recipient, or "" when the address has
	// no subscriber row. It is NOT a second spelling of CampaignRecipientID:
	// that is a per-campaign bigint queue row, this is the tenant-wide uuid
	// every reply, event and engagement surface keys on, and the two are not
	// interchangeable in either direction: internal/replies writes a subscriber
	// uuid into campaign_replies.subscriber_id, so an implementation that
	// substituted the per-campaign recipient id would produce
	// authoritative-looking replies attributed to nobody.
	//
	// It is carried for that reason, NOT because verp.go stamps it. Reply
	// correlation on the raw-MIME path binds to the DELIVERY id
	// (replycorrelation.MintInput), and the subscriber is recovered from the
	// delivery ledger rather than embedded in the address — which is what keeps
	// recipient identity out of a header that crosses the internet. The legacy
	// verp.go mint is deliberately inert and stays that way; see
	// TestLegacyGuardCannotClaimHeaderlessReplyCorrelation.
	SubscriberID string
	Recipient    string
	VariantID    string
	Binding      AssuranceBinding
	FromName     string
	FromEmail    string
	ReplyTo      string
	Headers      map[string]string
	Messenger    string
	// EnvelopeReturnPath is the signed VERP address for the SMTP envelope
	// sender (PRD F05). Empty means the envelope keeps the RFC822 From, which is
	// the default and the behaviour every deployment had before F05.
	//
	// Distinct from the Reply-To VERP even though both come from the same mint:
	// a Reply-To catches what a PERSON sends back, the return path catches what a
	// MAIL SYSTEM sends back — bounces and RFC 3834 auto-replies. Those are
	// exactly the messages that carry no References header for the matcher to
	// use, so the envelope is the only place their identity can be encoded.
	EnvelopeReturnPath string
}

// BoundDispatchResult deliberately carries a stable, non-PII reason code
// instead of an upstream error string. Replayed means the delivery coordinator
// returned an already accepted exact request without crossing the provider
// boundary again.
type BoundDispatchResult struct {
	Status   BoundDispatchStatus
	Reason   string
	Replayed bool
}

// AssuranceBoundDispatcher is the only provider boundary for a recipient row
// carrying migration 1923's assurance identity. The implementation compiles
// exact raw MIME and delegates to campaigndelivery.Coordinator. Listmonk does
// not implement this contract.
type AssuranceBoundDispatcher interface {
	DispatchBound(context.Context, BoundDispatchInput) (BoundDispatchResult, error)
}

// EmailSendControls is the tenant-level production email kill switch. The
// send loop checks it before claiming rows so queued work stops immediately
// when an operator pauses the tenant.
type EmailSendControls interface {
	EmailSendingPaused(ctx context.Context, tenantID string) (paused bool, reason string, err error)
}
