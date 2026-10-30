// SPDX-License-Identifier: AGPL-3.0-only
//
// Package approvals implements the human-in-the-loop approval gate. Mutating
// operations that flag `requires_approval=true` (campaign send, sequence
// activate, automation send_email step) call Request to create a pending
// approval row and short-circuit; an admin then Decide()s the row.
//
// The notify hook fires a Postmark transactional email with a one-click
// approve/reject link that is HMAC-signed with a 24h TTL.
package approvals

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// Status enumerates the lifecycle states. Mirrors the CHECK constraint in
// 0023_approvals.sql.
type Status string

const (
	StatusPending  Status = "pending"
	StatusApproved Status = "approved"
	StatusRejected Status = "rejected"
	StatusExpired  Status = "expired"
)

// ResourceType enumerates the gated resource kinds.
type ResourceType string

const (
	ResourceCampaign       ResourceType = "campaign"
	ResourceSequence       ResourceType = "sequence"
	ResourceAutomationSend ResourceType = "automation_send"
)

// DefaultTTL is how long a pending approval stays actionable before expiry.
const DefaultTTL = 24 * time.Hour
const notificationTimeout = 10 * time.Second

// Approval mirrors the approvals row.
type Approval struct {
	ID                    string  `json:"id"`
	TenantID              string  `json:"tenantId"`
	ResourceType          string  `json:"resourceType"`
	ResourceID            string  `json:"resourceId"`
	RequestedByActorType  string  `json:"requestedByActorType,omitempty"`
	RequestedByActorLabel string  `json:"requestedByActorLabel,omitempty"`
	RequestedByAPIKeyID   *string `json:"requestedByApiKeyId,omitempty"`
	// RequestedByUserID is the canonical id of the human who created
	// this approval. Compared against DecidedByUserID by Service.Decide
	// to enforce the two-person rule (audit approvals HIGH F5: prior
	// code let any owner/admin decide their own request). Nullable for
	// agent-/API-initiated requests, where the no-self-approval rule
	// degenerates trivially (no human requester to match against).
	RequestedByUserID *string    `json:"requestedByUserId,omitempty"`
	Status            Status     `json:"status"`
	RequestedAt       time.Time  `json:"requestedAt"`
	DecidedAt         *time.Time `json:"decidedAt,omitempty"`
	DecidedByUserID   *string    `json:"decidedByUserId,omitempty"`
	Notes             string     `json:"notes,omitempty"`
	ExpiresAt         time.Time  `json:"expiresAt"`
	// ContentHash fingerprints the approval scope (e.g. subject +
	// body + segment for a campaign). Caller computes via
	// FingerprintCampaign and stores at Request time; at consume
	// time the gate compares the current campaign's fingerprint vs
	// this value and rejects if they differ. Prevents "approve
	// benign content → edit to spam → queue" bypasses. Nullable for
	// back-compat with pre-0160 approvals. See D7 in
	// PRODUCTION_READINESS.md.
	ContentHash string `json:"contentHash,omitempty"`
	// ConsumedAt is set when the approval's side-effect (e.g.
	// campaign queue) has fired. Subsequent queue attempts MUST
	// re-request approval rather than re-using this row. Nullable.
	// See D11 in PRODUCTION_READINESS.md.
	ConsumedAt *time.Time `json:"consumedAt,omitempty"`
}

// FingerprintCampaign returns a stable hex digest of the campaign's
// approval-relevant content. Used to detect post-approval edits that
// would otherwise let an editor bypass the approval workflow.
// Hash is SHA-256 of "subject\x00body_html\x00segment_id".
func FingerprintCampaign(subject, bodyHTML, segmentID string) string {
	return FingerprintCampaignAudience(subject, bodyHTML, segmentID, "")
}

// FingerprintCampaignAudience is FingerprintCampaign plus a digest of the
// segment DEFINITION the campaign sends to.
//
// The segment id alone names the audience without describing it. A segment's
// `query_ast` is editable at any time, so between "approved" and "send" an
// editor can rewrite the rule from "customers who bought last month" to
// "everyone" and this fingerprint would not move — the approver signed off on a
// message to one group and a different group receives it, with nothing in the
// trail showing a discrepancy because by every value compared, nothing changed.
//
// The digest is a distinct field rather than being folded into segmentID so the
// two failures stay distinguishable: "you pointed the campaign at a different
// segment" and "someone changed what this segment means" are different things
// to tell an approver.
//
// An empty digest reproduces the historical hash exactly. That matters only for
// callers that pass one; the production path no longer does, because
// `AudienceFingerprint` always returns a non-empty selector. See
// FingerprintReviewBundle for what that means for approvals in flight.
func FingerprintCampaignAudience(subject, bodyHTML, segmentID, audienceDigest string) string {
	return FingerprintReviewBundle(ReviewBundle{
		Subject:        subject,
		BodyHTML:       bodyHTML,
		SegmentID:      segmentID,
		AudienceDigest: audienceDigest,
	})
}

// ReviewBundle is everything an approver is signing off on.
//
// The fingerprint began as subject + body + segment id, then gained the
// audience. What it still did not cover is the rest of what a reviewer is
// actually agreeing to:
//
//   - WHO IT IS FROM. `from_name` and `reply_to` are editable after approval.
//     Changing the sender on an approved campaign changes what recipients see
//     in their inbox and where their replies go — and, for a regulated sender,
//     who is legally making the statement.
//   - WHEN IT SENDS. `scheduled_at` is editable after approval. An approval for
//     a Tuesday-morning send silently becoming a Friday-evening send is a
//     different decision, and one nobody re-made.
//   - WHAT THE VARIANTS ARE. An A/B campaign's variants carry their own subject
//     and body. Approving two variants and then editing one — or adding a
//     third — puts unreviewed content in front of a share of the audience while
//     the top-level subject and body are untouched.
//
// IN-FLIGHT APPROVALS ARE INVALIDATED BY THIS CHANGE. An earlier version of
// this comment claimed the opposite — that empty fields contribute nothing so
// nothing breaks. That is true of the FIELDS and false of the whole: the
// audience digest is never empty for a real campaign (it is `workspace`,
// `list:<id>`, `static:<id>` or `segment:<id>:<digest>`), and `from_name` is
// almost always set. So a hash stored before this deploy will not match the one
// computed after it, and every approval pending across the deploy is refused
// once with "campaign X changed after it was approved" and must be re-requested.
//
// That is the RIGHT direction to fail — those approvals were granted without
// the audience, sender, schedule or variants bound, so re-asking is honest —
// but it is a deploy-visible behaviour change, and saying otherwise in three
// separate doc blocks was the kind of reassurance nobody checks.
type ReviewBundle struct {
	Subject        string
	BodyHTML       string
	SegmentID      string
	AudienceDigest string
	FromName       string
	ReplyTo        string
	// ScheduledAt as RFC3339, or empty for an unscheduled campaign.
	ScheduledAt string
	// VariantsDigest summarises the A/B variants. A digest rather than the raw
	// content so the fingerprint stays a fixed size regardless of how many
	// variants a campaign carries.
	VariantsDigest string
}

// FingerprintReviewBundle hashes everything an approver signed off on.
//
// Field-separated with a NUL and each optional field prefixed by its own name,
// so moving a value between fields cannot produce the same hash — without the
// labels, a campaign with from_name "X" and empty reply_to would collide with
// one that has empty from_name and reply_to "X".
func FingerprintReviewBundle(b ReviewBundle) string {
	h := sha256.New()
	h.Write([]byte(b.Subject))
	h.Write([]byte{0})
	h.Write([]byte(b.BodyHTML))
	h.Write([]byte{0})
	h.Write([]byte(b.SegmentID))
	writeLabelled := func(label, value string) {
		if value == "" {
			return
		}
		h.Write([]byte{0})
		h.Write([]byte(label))
		h.Write([]byte{0})
		h.Write([]byte(value))
	}
	// `audience` keeps its historical unlabelled position so existing hashes
	// for audience-only campaigns are unchanged.
	if b.AudienceDigest != "" {
		h.Write([]byte{0})
		h.Write([]byte(b.AudienceDigest))
	}
	writeLabelled("from", b.FromName)
	writeLabelled("reply-to", b.ReplyTo)
	writeLabelled("schedule", b.ScheduledAt)
	writeLabelled("variants", b.VariantsDigest)
	return hex.EncodeToString(h.Sum(nil))
}

// Resource describes the thing being gated. ID + Type uniquely identify it
// inside the tenant.
type Resource struct {
	Type ResourceType
	ID   string
}

// Actor describes who requested the approval. APIKeyID is optional but
// strongly recommended when the caller is an agent. UserID is the
// canonical id of the human who initiated the request when the caller
// is a logged-in dashboard user; nil for API-key / agent flows. It is
// what Service.Decide compares decided_by_user_id against to enforce
// the two-person rule.
type Actor struct {
	Type     string
	Label    string
	APIKeyID *string
	UserID   *string
}

// Decision is the input to Decide.
type Decision string

const (
	DecisionApprove Decision = "approve"
	DecisionReject  Decision = "reject"
)

// Errors that handlers translate into 4xx responses.
var (
	ErrNotFound    = errors.New("approvals: not found")
	ErrNotPending  = errors.New("approvals: already decided")
	ErrExpired     = errors.New("approvals: expired")
	ErrBadDecision = errors.New("approvals: bad decision")
	ErrBadToken    = errors.New("approvals: bad token")
	// ErrSelfApproval is returned when the user who requested an
	// approval also tries to decide it. Audit closes HIGH F5: any
	// owner/admin could previously approve their own request, which
	// defeats the entire human-in-the-loop gate.
	ErrSelfApproval = errors.New("approvals: requester cannot decide their own approval")
	// ErrTokenAlreadyUsed is returned by the public one-click path
	// when the token's sha256 is already present in
	// approval_token_consumption. Audit closes CRITICAL F2: a
	// captured token could previously be replayed for the full 24h
	// expiry window because the verifier had no "this token has been
	// consumed" marker.
	ErrTokenAlreadyUsed = errors.New("approvals: token already used")
)

// Service is the package-facing API. Constructed in main.go with a Repo and
// (optionally) a Notifier.
type Service struct {
	Repo     *Repo
	Notifier Notifier
	Now      func() time.Time
	TTL      time.Duration
	// HMACKey signs public one-click decide tokens.
	HMACKey []byte
	// Delegations, when non-nil, lets the service suppress
	// ErrSelfApproval when a delegation row covers
	// (requester → decider). Production wiring injects the
	// *Repo (which satisfies DelegationLookup); tests pass a
	// fake. Nil disables delegation — the two-person rule then
	// behaves exactly as in migration 0173.
	Delegations DelegationLookup
	// EventEmitter, when set, receives per-row `approval.expired`
	// events as the sweep flips them. Nil-safe — production wiring
	// passes the realtime events bus; tests omit it. Customer webhook
	// delivery is deliberately not coupled to this best-effort path.
	EventEmitter EventEmitter
	// GoldenCapture, when set, snapshots the approved output of an
	// approve decision into the ai_golden_examples table (AI-output
	// regression harness, #1). The apps/api adapter resolves the
	// approved resource's (brief -> output) content. Fired best-effort
	// from Decide in its own goroutine with panic recovery, like the
	// Notifier; nil disables it.
	GoldenCapture GoldenCapturer

	// insertFn is an optional override for the Repo.Insert call inside
	// Request(). Tests set this to bypass the real pgx-backed Repo;
	// production wiring leaves it nil so the default `s.Repo.Insert` path
	// is used. Kept unexported so external callers can't poke around the
	// persistence boundary.
	insertFn func(ctx context.Context, a *Approval) error
}

// Notifier is the optional best-effort email-out hook. nil disables it.
type Notifier interface {
	NotifyRequested(ctx context.Context, tenantID string, a *Approval) error
}

// GoldenCapturer is the optional best-effort hook fired after a successful
// approve in Decide. The apps/api adapter reads the approved resource's
// content and snapshots a (brief -> approved-output) golden example for the
// AI-output regression harness (#1). Defined as an interface here so the
// approvals package does not import ai_regression (cycle hygiene). nil
// disables it.
type GoldenCapturer interface {
	CaptureGolden(ctx context.Context, a *Approval) error
}

// EventEmitter is the optional, presentation-only hook that forwards
// lifecycle events (currently `approval.expired`) to the realtime events bus.
// Defined as an interface to avoid importing the events package (cycle
// hygiene; the handler already imports events.Bus).
type EventEmitter interface {
	Emit(tenantID, topic string, payload map[string]any)
}

// RequestOpt customises a single Service.Request call without mutating the
// shared Service. Compose with the With* helpers below.
//
// The functional-options shape replaces an earlier hack in
// RequestApprovalHandler where the handler temporarily set
// d.Service.Notifier = nil and restored it via defer; that mutation raced
// with concurrent Request calls on the same Service. A per-call opt is
// race-free because each Request constructs its own requestState.
type RequestOpt func(*requestState)

// requestState carries per-Request flags assembled from the opts. Kept
// unexported so opts remain the only way to tweak behaviour.
type requestState struct {
	// silenceNotifier suppresses the configured s.Notifier hook for this
	// single Request call. Used when the caller (typically
	// RequestApprovalHandler) has already gated against
	// notification_preferences and decided no email should fire.
	silenceNotifier bool
	// contentHash fingerprints the approval scope (subject + body +
	// segment for a campaign). Persisted on the row so the
	// consumption gate can detect post-approval content edits.
	contentHash string
}

// WithSilencedNotifier returns a RequestOpt that suppresses the
// configured Notifier for this single Request call. Used when the
// caller (typically RequestApprovalHandler) has already gated against
// notification_preferences and decided no email should fire. Other
// Request calls running concurrently on the same Service are unaffected.
func WithSilencedNotifier() RequestOpt {
	return func(s *requestState) { s.silenceNotifier = true }
}

// WithContentHash returns a RequestOpt that stamps the supplied hash
// onto the approval row. See FingerprintCampaign for the standard
// recipe (subject + body_html + segment_id). Empty hash is allowed
// and disables the post-approval-edit guard for that one request.
func WithContentHash(hash string) RequestOpt {
	return func(s *requestState) { s.contentHash = hash }
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *Service) ttl() time.Duration {
	if s.TTL > 0 {
		return s.TTL
	}
	return DefaultTTL
}

// Request creates a pending approval row for the given resource.
//
// opts is variadic so existing callers (Service.Request(ctx, tenant, res,
// actor)) keep compiling and behaving identically — no opt = full default
// behaviour, including firing the configured Notifier when one is wired.
// Pass WithSilencedNotifier() to skip the Notifier hook for one call
// without touching shared state.
func (s *Service) Request(ctx context.Context, tenantID string, res Resource, actor Actor, opts ...RequestOpt) (*Approval, error) {
	if tenantID == "" {
		return nil, fmt.Errorf("approvals: tenantID required")
	}
	if res.ID == "" || res.Type == "" {
		return nil, fmt.Errorf("approvals: resource type+id required")
	}
	state := &requestState{}
	for _, opt := range opts {
		if opt != nil {
			opt(state)
		}
	}
	now := s.now()
	a := &Approval{
		TenantID:              tenantID,
		ResourceType:          string(res.Type),
		ResourceID:            res.ID,
		RequestedByActorType:  actor.Type,
		RequestedByActorLabel: actor.Label,
		RequestedByAPIKeyID:   actor.APIKeyID,
		RequestedByUserID:     actor.UserID,
		Status:                StatusPending,
		RequestedAt:           now,
		ExpiresAt:             now.Add(s.ttl()),
		ContentHash:           state.contentHash,
	}
	if err := s.insert(ctx, a); err != nil {
		return nil, err
	}
	if !state.silenceNotifier && s.Notifier != nil {
		// Best-effort; never block the request. Capture s.Notifier here
		// (not inside the goroutine) so a concurrent reassignment of
		// the shared field by some other code path doesn't change which
		// notifier this dispatch fires.
		notifier := s.Notifier
		go func(approval Approval) {
			ctx, cancel := context.WithTimeout(context.Background(), notificationTimeout)
			defer cancel()
			notifyRequestedBestEffort(ctx, notifier, tenantID, &approval)
		}(*a)
	}
	return a, nil
}

func notifyRequestedBestEffort(ctx context.Context, notifier Notifier, tenantID string, approval *Approval) {
	if notifier == nil || approval == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("approval notifier panic recovered",
				"tenant_id", tenantID,
				"approval_id", approval.ID,
				"panic", fmt.Sprint(rec))
		}
	}()
	if err := notifier.NotifyRequested(ctx, tenantID, approval); err != nil {
		slog.Warn("approval notifier failed",
			"tenant_id", tenantID,
			"approval_id", approval.ID,
			"err", err.Error())
	}
}

// insert dispatches to the unexported test-override hook when one is
// installed; otherwise to the real Repo.Insert. Centralising the
// resolution keeps Request's body readable and gives service_test.go a
// seam to bypass pgx without making Repo an interface (which would
// ripple into every Service.Repo.* caller in the package).
func (s *Service) insert(ctx context.Context, a *Approval) error {
	if s.insertFn != nil {
		return s.insertFn(ctx, a)
	}
	return s.Repo.Insert(ctx, a)
}

// Decide finalizes a pending approval. userID may be empty for the public
// one-click path (verified by HMAC instead).
//
// Audit (approvals HIGH F5): the two-person rule is enforced here —
// when a userID is supplied AND the row carries a RequestedByUserID
// AND the two match, Decide returns ErrSelfApproval *without*
// touching the row's status. Rows without a RequestedByUserID
// (agent-initiated, API-key-initiated, or pre-0173 back-compat) skip
// the check; there is no human requester to compare against.
func (s *Service) Decide(ctx context.Context, tenantID, approvalID string, decision Decision, userID, notes string) error {
	if decision != DecisionApprove && decision != DecisionReject {
		return ErrBadDecision
	}
	a, err := s.Repo.Get(ctx, tenantID, approvalID)
	if err != nil {
		return err
	}
	if a.Status != StatusPending {
		return ErrNotPending
	}
	if isSelfApproval(a, userID) {
		// Delegation override: when an active delegation row covers
		// (requester → decider), the decider IS authorised to act
		// on the requester's behalf. Settings UI is what writes
		// these rows.
		if s.Delegations != nil && a.RequestedByUserID != nil {
			active, lookupErr := s.Delegations.IsActive(ctx, tenantID, *a.RequestedByUserID, userID)
			if lookupErr == nil && active {
				// fall through to the decide
			} else {
				return ErrSelfApproval
			}
		} else {
			return ErrSelfApproval
		}
	}
	now := s.now()
	if now.After(a.ExpiresAt) {
		// Mark as expired so subsequent reads see the lifecycle correctly.
		_ = s.Repo.UpdateStatus(ctx, tenantID, approvalID, StatusExpired, "", "", now)
		return ErrExpired
	}
	target := StatusApproved
	if decision == DecisionReject {
		target = StatusRejected
	}
	if err := s.Repo.UpdateStatus(ctx, tenantID, approvalID, target, userID, notes, now); err != nil {
		return err
	}
	// On approve, snapshot the approved output into the golden set
	// (best-effort, off the critical path — same capture-then-goroutine
	// shape as the Notifier hook).
	if target == StatusApproved && s.GoldenCapture != nil {
		capturer := s.GoldenCapture
		go func(approval Approval) {
			ctx, cancel := context.WithTimeout(context.Background(), notificationTimeout)
			defer cancel()
			captureGoldenBestEffort(ctx, capturer, &approval)
		}(*a)
	}
	return nil
}

// captureGoldenBestEffort fires the GoldenCapturer hook with panic recovery;
// failures are logged and never propagate to the Decide caller.
func captureGoldenBestEffort(ctx context.Context, capturer GoldenCapturer, approval *Approval) {
	if capturer == nil || approval == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("approval golden capture panic recovered",
				"tenant_id", approval.TenantID,
				"approval_id", approval.ID,
				"panic", fmt.Sprint(rec))
		}
	}()
	if err := capturer.CaptureGolden(ctx, approval); err != nil {
		slog.Warn("approval golden capture failed",
			"tenant_id", approval.TenantID,
			"approval_id", approval.ID,
			"err", err.Error())
	}
}

// isSelfApproval returns true when the decider's userID matches the
// row's RequestedByUserID. Pure function so the two-person rule
// (audit HIGH F5) is unit-testable without a Repo. Empty userID
// (public one-click decide path) and nil RequestedByUserID
// (agent/API-key-initiated request) both bypass the check — there's
// no human requester identity to compare against.
func isSelfApproval(a *Approval, userID string) bool {
	if a == nil || userID == "" || a.RequestedByUserID == nil {
		return false
	}
	return *a.RequestedByUserID == userID
}

// SweepExpired flips pending rows past their expires_at to
// StatusExpired and emits one `approval.expired` event per row
// via the optional EventEmitter. Intended to be called from a
// periodic background goroutine.
//
// Audit (approvals HIGH F4): prior code returned only the count and emitted
// nothing, so realtime clients and downstream in-process automation never
// learned an approval had expired.
func (s *Service) SweepExpired(ctx context.Context) (count int, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("approvals sweep panic: %v", rec)
			count = 0
		}
	}()
	if s == nil || s.Repo == nil {
		return 0, errors.New("approvals: sweep repo not configured")
	}
	n, expired, err := s.Repo.SweepExpired(ctx, s.now())
	if err != nil {
		return 0, err
	}
	// Emit per-row events. Nil-safe — service may not have a
	// notifier wired (tests, deployments without the event bus).
	if s.EventEmitter != nil {
		for _, r := range expired {
			s.EventEmitter.Emit(r.TenantID, "approval.expired", map[string]any{
				"id":     r.ID,
				"source": "sweep",
			})
		}
	}
	return n, nil
}

// --- HMAC signed one-click links ---

// SignToken produces an opaque token that binds the intended recipient and
// decision on the public confirmation route. A matching authenticated browser
// session is still required before POST may change state. Format:
// `<approvalID>.<decision>.<expUnix>.<approverHash>.<sig>` where
// approverHash is the first 16 hex chars of sha256(lower(email)).
//
// Audit (approvals CRITICAL F1): the prior token format omitted the
// approver identity, so two admins receiving the same approval
// email got structurally identical tokens — admin A forwarding the
// email let admin B decide the approval. Binding the approver into
// the HMAC payload means the token is only valid for the one
// admin's email it was issued to.
//
// Empty approverEmail signs with a literal "anon" tag so VerifyToken can
// distinguish it from a named recipient. The POST handler fails that token
// closed because no authenticated identity can match it. Callers should always
// pass the recipient email.
func (s *Service) SignToken(approvalID string, decision Decision, expiresAt time.Time, approverEmail string) string {
	exp := strconv.FormatInt(expiresAt.Unix(), 10)
	approverHash := approverEmailHash(approverEmail)
	payload := approvalID + "." + string(decision) + "." + exp + "." + approverHash
	mac := hmac.New(sha256.New, s.HMACKey)
	_, _ = mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

// VerifyToken returns the approval id + decision + bound approver
// hash encoded in token, after checking signature and expiry. The
// caller MUST verify the bound approver hash matches the session
// user's email before processing the decision — that final check
// is what closes the forwarded-link attack.
func (s *Service) VerifyToken(token string) (approvalID string, decision Decision, approverHash string, err error) {
	parts := strings.Split(token, ".")
	// New 5-part format: id.decision.exp.approverHash.sig
	// Legacy 4-part format (id.decision.exp.sig) still verified
	// for tokens minted before the format change — they bound NO
	// approver and the caller treats approverHash="" as legacy.
	if len(parts) != 4 && len(parts) != 5 {
		return "", "", "", ErrBadToken
	}
	var decisionStr, expStr, sig string
	if len(parts) == 5 {
		approvalID, decisionStr, expStr, approverHash, sig = parts[0], parts[1], parts[2], parts[3], parts[4]
	} else {
		approvalID, decisionStr, expStr, sig = parts[0], parts[1], parts[2], parts[3]
		approverHash = ""
	}
	payload := approvalID + "." + decisionStr + "." + expStr
	if approverHash != "" {
		payload += "." + approverHash
	}
	mac := hmac.New(sha256.New, s.HMACKey)
	_, _ = mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return "", "", "", ErrBadToken
	}
	exp, perr := strconv.ParseInt(expStr, 10, 64)
	if perr != nil {
		return "", "", "", ErrBadToken
	}
	if s.now().Unix() > exp {
		return "", "", "", ErrExpired
	}
	d := Decision(decisionStr)
	if d != DecisionApprove && d != DecisionReject {
		return "", "", "", ErrBadToken
	}
	return approvalID, d, approverHash, nil
}

// approverEmailHash returns a short stable identifier for the
// approver email so the token-bound check works without leaking
// the address in the URL. Empty input → "anon".
func approverEmailHash(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return "anon"
	}
	sum := sha256.Sum256([]byte(email))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

// ApproverEmailHash is the exported helper for handlers that need
// to compute the same hash from a session email to compare against
// VerifyToken's returned hash.
func ApproverEmailHash(email string) string { return approverEmailHash(email) }
