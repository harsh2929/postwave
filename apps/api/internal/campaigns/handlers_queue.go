package campaigns

// Guarded campaign dispatch: POST /api/v1/campaigns/{id}/queue.
//
// The queue handler materializes one campaign_recipients row per eligible
// address and flips the campaign to 'sending'. The send-loop guard in
// apps/api/internal/sending drains those rows under rate, quiet-hours, and
// final suppression checks. POST /campaigns/{id}/send is retained only as a
// compatibility alias bound directly to this same handler; there is no
// Listmonk audience-fan-out bypass.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/cost"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/holdout"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

// SuppressionLookup is the narrow contract QueueCampaign needs to filter
// the audience down before INSERTing recipient rows. The full Store in
// internal/suppressions implements it; tests can stub with a
// map-backed fake. Defined here so this package stays free of an import
// cycle on suppressions (which itself imports nothing from campaigns).
type SuppressionLookup interface {
	LookupBulk(ctx context.Context, tenantID string, emails []string) (map[string]bool, error)
}

// recipientsSuppressedAtQueueFill is a Prometheus counter incremented
// (by N) every time we filter N suppressed addresses out of an audience
// at queue-fill. The send-loop already has a per-row counter
// (postwave_sendloop_recipients_suppressed_total); this one is the
// "before they consumed any rate-limit slot" cousin so operators can
// see the two paths separately on the deliverability dashboard.
//
// Counter, not gauge: cumulative-total works correctly with the rate()
// query Prometheus dashboards use. No `reason` label on this one because
// at queue-fill time we just have the email's IS_SUPPRESSED bit; the
// per-reason breakdown is in the deliverability webhook receiver.
var recipientsSuppressedAtQueueFill = promauto.NewCounter(prometheus.CounterOpts{
	Name: "postwave_recipients_suppressed_at_queuefill_total",
	Help: "Total audience addresses filtered out at campaign queue-fill time because they are currently suppressed (active subscriber_suppressions row). Belt-and-suspenders to the per-row send-loop check.",
})

// MountQueue wires POST /api/v1/campaigns/{id}/queue. Mounted alongside the
// compatibility /send alias and protected by the same scope set.
func MountQueue(r chi.Router, d *Deps) {
	if d == nil {
		return
	}
	r.With(apikeys.RequireAllScopes(
		apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional,
	)).Post("/api/v1/campaigns/{id}/queue", d.QueueCampaign)
}

type queueResponse struct {
	CampaignID           string `json:"campaign_id"`
	ContentRevisionID    string `json:"content_revision_id,omitempty"`
	AssuranceRunID       string `json:"assurance_run_id,omitempty"`
	SendPlanID           string `json:"send_plan_id,omitempty"`
	AssuranceDecision    string `json:"assurance_decision,omitempty"`
	AssuranceRolloutMode string `json:"assurance_rollout_mode,omitempty"`
	AssuranceStatus      string `json:"assurance_status,omitempty"`
	AssuranceReasonCode  string `json:"assurance_reason_code,omitempty"`
	RecipientsQueued     int    `json:"recipients_queued"`
	Status               string `json:"status"`
	ApprovalID           string `json:"approval_id,omitempty"`
	ApprovalStatus       string `json:"approval_status,omitempty"`
	Message              string `json:"message,omitempty"`
	Sandbox              bool   `json:"sandbox,omitempty"`

	// G16 (campaigns 2026): frequency-cap filter outcome surfaced so
	// the operator can see how many recipients were skipped and which
	// rule was responsible. Zero / nil when no rules are configured.
	RecipientsSkippedFrequencyCap int                      `json:"recipients_skipped_frequency_cap,omitempty"`
	FrequencySkipBreakdown        []FrequencySkipBreakdown `json:"frequency_skip_breakdown,omitempty"`
	// RecipientsHeldOutControlGroup is how many audience members were withheld
	// because they belong to an active global control group.
	RecipientsHeldOutControlGroup int `json:"recipients_held_out_control_group,omitempty"`
	// RecipientsHeldOutCampaign is the immutable F02 control arm.  It is
	// separate from the tenant-wide control group because the two answer
	// different causal questions and have independent evidence ledgers.
	RecipientsHeldOutCampaign int `json:"recipients_held_out_campaign,omitempty"`
}

func (d *Deps) authorizeCampaignRevision(
	ctx context.Context,
	tenantID string,
	revision *campaignartifact.Revision,
	sandbox bool,
) (campaignassurancegate.Receipt, *queueError) {
	if sandbox || d == nil || d.campaignAssuranceRolloutMode() == campaignassurancegate.RolloutOff {
		return campaignassurancegate.Receipt{}, nil
	}
	if revision == nil || d.AssuranceGate == nil {
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusServiceUnavailable, Code: "campaign_assurance_unavailable",
			Message: "Campaign Assurance is required but not configured; queueing was not started",
		}
	}
	receipt, err := d.AssuranceGate.Authorize(ctx, campaignassurancegate.Request{
		TenantID: tenantID, CampaignID: revision.CampaignID,
		ContentRevisionID: revision.ID, SourceHash: revision.SourceHash,
	})
	if err == nil {
		if receipt.RolloutMode == "" {
			receipt.RolloutMode = d.campaignAssuranceRolloutMode()
		}
		return receipt, nil
	}
	switch {
	case errors.Is(err, campaignassurancegate.ErrNotAssured):
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusConflict, Code: "campaign_assurance_required",
			Message: "run Campaign Assurance for the current content revision before queueing",
		}
	case errors.Is(err, campaignassurancegate.ErrPending):
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusConflict, Code: "campaign_assurance_pending",
			Message: "Campaign Assurance is still running for the current content revision",
		}
	case errors.Is(err, campaignassurancegate.ErrStale):
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusConflict, Code: "campaign_assurance_stale",
			Message: "Campaign Assurance is stale; run it again for the current revision",
		}
	case errors.Is(err, campaignassurancegate.ErrBlocked):
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusUnprocessableEntity, Code: "campaign_assurance_blocked",
			Message: "deterministic Campaign Assurance findings block this send",
		}
	case errors.Is(err, campaignassurancegate.ErrUnavailable),
		errors.Is(err, campaignassurancegate.ErrIntegrityMismatch):
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusServiceUnavailable, Code: "campaign_assurance_unavailable",
			Message: "complete, integrity-verified Campaign Assurance evidence is unavailable",
			Err:     err,
		}
	default:
		return campaignassurancegate.Receipt{}, &queueError{
			Status: http.StatusInternalServerError, Err: err,
		}
	}
}

type campaignAssuranceRolloutReporter interface {
	RolloutMode() campaignassurancegate.RolloutMode
}

// campaignAssuranceRolloutMode keeps the historical boolean composition
// backward-compatible while allowing the staged rollout wrapper to be the
// single policy owner. A directly wired legacy Gate + enabled boolean means
// strict block, matching the pre-rollout behavior.
func (d *Deps) campaignAssuranceRolloutMode() campaignassurancegate.RolloutMode {
	if d == nil {
		return campaignassurancegate.RolloutOff
	}
	if reporter, ok := d.AssuranceGate.(campaignAssuranceRolloutReporter); ok {
		return reporter.RolloutMode()
	}
	if d.AssuranceGateEnabled {
		return campaignassurancegate.RolloutBlock
	}
	return campaignassurancegate.RolloutOff
}

// FrequencySkipBreakdown mirrors frequency.SkipBreakdown — duplicated
// here so the campaigns package doesn't gain a dependency on the
// frequency package's HTTP surface.
type FrequencySkipBreakdown struct {
	RuleID    string `json:"rule_id"`
	RuleLabel string `json:"rule_label"`
	Skipped   int    `json:"skipped"`
}

// FrequencyFilter, when non-nil on Deps, gates recipient enumeration
// at queue-fill against tenant frequency_cap_rules. Loosely-typed so
// the campaigns package doesn't import the frequency package directly.
// main.go wires this to frequency.FilterAudienceForChannel.
//
// SUB-133: the channel argument scopes the cap to the send's channel —
// only rules that apply to that channel are evaluated, and only
// subscriber_send_log rows on a channel in the rule's set count toward
// the shared cap. queueCampaignCore passes campaignChannel(c) (default
// "email").
type FrequencyFilter func(ctx context.Context, tenantID, channel string, candidates []string) (kept []string, skipped int, breakdown []FrequencySkipBreakdown, err error)

// ControlGroupFilter, when non-nil on Deps, drops the tenant's active
// control-group members from the audience before the send. Loosely typed so
// campaigns does not import control_group. main.go wires it to a closure over
// control_group.Repo.ActiveForTenant + PartitionControl. Returns the kept
// audience and the number held out.
type ControlGroupFilter func(ctx context.Context, tenantID string, candidates []string) (kept []string, excluded int, err error)

type queueCampaignOptions struct {
	SkipApproval bool
	Sandbox      bool
	Actor        ApprovalActor
}

type queueCampaignOutcome struct {
	Response queueResponse
	Approval *ApprovalState
}

type queueAssuranceBinding struct {
	ContentRevisionID string
	SendPlanID        string
	RunID             string
	RunAttempt        int
	ArtifactSetHash   string
	SourceHash        string
	PlanHash          string
	Decision          string
	OverrideIDs       []uuid.UUID
	BoundAt           *time.Time
}

func normalizeQueueAssuranceBinding(
	tenantID, campaignID string,
	receipt *campaignassurancegate.Receipt,
) (queueAssuranceBinding, error) {
	if receipt == nil {
		return queueAssuranceBinding{OverrideIDs: []uuid.UUID{}}, nil
	}
	canonical := func(value string) (string, bool) {
		parsed, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return "", false
		}
		canonicalValue := parsed.String()
		return canonicalValue, canonicalValue == strings.TrimSpace(value)
	}
	canonicalTenant, tenantOK := canonical(tenantID)
	canonicalCampaign, campaignOK := canonical(campaignID)
	contentRevisionID, revisionOK := canonical(receipt.ContentRevisionID)
	sendPlanID, planOK := canonical(receipt.SendPlanID)
	runID, runOK := canonical(receipt.RunID)
	if !tenantOK || !campaignOK || canonicalTenant != receipt.TenantID ||
		canonicalCampaign != receipt.CampaignID || !revisionOK || !planOK || !runOK ||
		receipt.PolicyVersion != campaignassurancegate.PolicyVersion || receipt.RunAttempt < 1 ||
		!validQueueSHA256(receipt.ArtifactSetHash) || !validQueueSHA256(receipt.SourceHash) ||
		!validQueueSHA256(receipt.PlanHash) || receipt.AuthorizedAt.IsZero() {
		return queueAssuranceBinding{}, errors.New("campaigns: invalid Campaign Assurance queue receipt")
	}
	overrideIDs := make([]uuid.UUID, len(receipt.OverrideIDs))
	previous := ""
	for index, raw := range receipt.OverrideIDs {
		canonicalID, ok := canonical(raw)
		if !ok || (previous != "" && canonicalID <= previous) {
			return queueAssuranceBinding{}, errors.New("campaigns: Campaign Assurance overrides must be sorted unique UUIDs")
		}
		overrideIDs[index] = uuid.MustParse(canonicalID)
		previous = canonicalID
	}
	switch receipt.Decision {
	case "pass", "warn":
		if len(overrideIDs) != 0 {
			return queueAssuranceBinding{}, errors.New("campaigns: non-blocked assurance receipt cannot carry overrides")
		}
	case "overridden":
		if len(overrideIDs) == 0 {
			return queueAssuranceBinding{}, errors.New("campaigns: overridden assurance receipt requires finding receipts")
		}
	default:
		return queueAssuranceBinding{}, errors.New("campaigns: invalid Campaign Assurance queue decision")
	}
	boundAt := receipt.AuthorizedAt.UTC()
	return queueAssuranceBinding{
		ContentRevisionID: contentRevisionID, SendPlanID: sendPlanID,
		RunID: runID, RunAttempt: receipt.RunAttempt,
		ArtifactSetHash: receipt.ArtifactSetHash, SourceHash: receipt.SourceHash,
		PlanHash: receipt.PlanHash, Decision: receipt.Decision,
		OverrideIDs: overrideIDs, BoundAt: &boundAt,
	}, nil
}

func validQueueSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, current := range value {
		if (current < '0' || current > '9') && (current < 'a' || current > 'f') {
			return false
		}
	}
	return true
}

func (d *Deps) freezeQueueContentRevision(
	ctx context.Context,
	tenantID, campaignID string,
	actor ApprovalActor,
) (*campaignartifact.Revision, *queueError) {
	// Transitional compatibility: tests and local compositions that have not
	// wired the artifact repository retain the legacy queue path. Production
	// main.go always wires it; the later assurance hard-gate rollout will make
	// this dependency mandatory everywhere.
	if d == nil || d.Artifacts == nil {
		return nil, nil
	}
	actorID := ""
	if _, err := uuid.Parse(actor.UserID); err == nil {
		actorID = actor.UserID
	}
	revision, err := d.Artifacts.FreezeCurrent(ctx, tenantID, campaignID, actorID)
	if err == nil {
		return revision, nil
	}
	var validation *campaignartifact.FactContractValidationError
	var references *campaignartifact.FactContractReferenceError
	switch {
	case errors.Is(err, campaignartifact.ErrNotFound):
		return nil, &queueError{Status: http.StatusNotFound, Code: "not_found", Message: "campaign not found"}
	case errors.Is(err, campaignartifact.ErrSourceIncomplete):
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "campaign_source_incomplete",
			Message: "campaign source must be complete before queueing"}
	case errors.As(err, &validation):
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "fact_contract_invalid",
			Message: "Fact Contract validation failed"}
	case errors.As(err, &references):
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "fact_contract_references_invalid",
			Message: "Fact Contract references semantic blocks that do not exist"}
	case errors.Is(err, campaignartifact.ErrInvalidInput):
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "campaign_semantics_invalid",
			Message: "campaign semantic source is invalid"}
	default:
		return nil, &queueError{Status: http.StatusInternalServerError, Err: err}
	}
}

type queueError struct {
	Status int
	// Code + Message describe the operator-authored {error:{code,message}}
	// envelope for non-5xx outcomes; the HTTP wrapper routes them through
	// httperror.Write so the canonical envelope (with request_id) is
	// emitted uniformly. Set Code="" to fall back to Body for non-trivial
	// envelopes (e.g. the compliance check, which carries extra fields).
	Code    string
	Message string
	Body    any
	// Err carries the underlying server-side error for 5xx cases so the
	// HTTP wrapper can route it through httperror.WriteInternal (which
	// logs err.Error() with tenant_id+request_id and writes a generic
	// envelope instead of echoing the raw text to the client). For non-5xx
	// (validation, conflict, locked, etc.) Err is nil and Code/Message or
	// Body carries the operator-authored envelope.
	Err error
}

func (e *queueError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("campaign queue failed with HTTP %d: %v", e.Status, e.Err)
	}
	return fmt.Sprintf("campaign queue failed with HTTP %d", e.Status)
}

// QueueCampaign POST /api/v1/campaigns/{id}/queue.
//
// Flow:
//  1. Load campaign; verify status sendable.
//  2. Resolve the one tenant-owned audience source (static freeze, list,
//     segment, or the legacy blank-source workspace audience) and enumerate
//     only activation-eligible email addresses.
//  3. INSERT one campaign_recipients row per email with status='pending'.
//  4. Flip campaign.status='sending' so the send-loop guard picks it up.
//  5. Return 202 + the recipient count.
//
// Returns 422 if the campaign has no body or no subject. Returns 409 if status
// isn't sendable.
func (d *Deps) QueueCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	sandboxFlag := sandbox.IsSandboxRequest(r)
	out, err := d.queueCampaignCore(r.Context(), t.ID, id, queueCampaignOptions{
		Sandbox: sandboxFlag,
		Actor:   approvalActorFromContext(r.Context()),
	})
	if err != nil {
		if qe := (*queueError)(nil); errors.As(err, &qe) {
			// 5xx queueError cases carry an underlying Err so we can
			// log it server-side without leaking err.Error() to the
			// client. Validation/conflict/locked cases route their
			// operator-authored {Code,Message} pair through
			// httperror.Write (canonical envelope + request_id), and
			// only fall back to writeJSON for non-trivial bodies
			// (e.g. the compliance check carries extra fields).
			if isPublicQueuePolicyError(qe.Code) {
				if qe.Err != nil && d != nil && d.Logger != nil {
					d.Logger.ErrorContext(r.Context(), "campaign queue policy persistence failed",
						"tenant_id", t.ID, "campaign_id", id, "err", qe.Err.Error())
				}
				writeJSON(w, qe.Status, errEnv(qe.Code, qe.Message))
				return
			}
			if qe.Status >= 500 && qe.Err != nil {
				httperror.WriteInternal(w, d.Logger, qe.Err, r.Context())
				return
			}
			if qe.Code != "" {
				httperror.Write(w, qe.Status, qe.Code, qe.Message)
				return
			}
			writeJSON(w, qe.Status, qe.Body)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if out.Approval != nil && !out.Approval.Approved {
		writeJSON(w, http.StatusAccepted, out.Response)
		return
	}
	writeJSON(w, http.StatusAccepted, out.Response)
}

func isPublicQueuePolicyError(code string) bool {
	switch code {
	case "campaign_live_dispatch_unavailable", "sandbox_unavailable", "sandbox_authority_unavailable", "frequency_cap_unavailable", "intelligent_retry_unavailable":
		return true
	default:
		return false
	}
}

// QueueScheduledCampaign is called by the campaign scheduler when a
// 'scheduled' campaign's scheduled_at falls due. It reuses the same
// validation / suppression / holdout / quota / queue-fill code as the
// HTTP queue endpoint — fixing D5 where the scheduler previously dispatched
// via Sender.CreateCampaign and BYPASSED
// the per-tenant rate limit and quiet-hours policy. Sandbox-ness is
// derived from the persisted campaigns.is_sandbox column (D6) so a
// scheduled sandbox campaign still simulates instead of sending.
// Approval enforcement IS active here so a scheduled campaign that
// requires approval doesn't fire un-reviewed at scheduled_at.
func (d *Deps) QueueScheduledCampaign(ctx context.Context, tenantID, campaignID string) (int, error) {
	sandboxFlag, err := d.loadCampaignSandboxAuthority(ctx, tenantID, campaignID)
	if err != nil {
		return 0, err
	}
	out, err := d.queueCampaignCore(ctx, tenantID, campaignID, queueCampaignOptions{
		Sandbox: sandboxFlag,
		Actor: ApprovalActor{
			Type:  "system",
			Label: "scheduler",
		},
	})
	if err != nil {
		return 0, err
	}
	return out.Response.RecipientsQueued, nil
}

// campaignChannel returns the channel a campaign dispatches on, used to scope
// the SUB-133 per-channel frequency cap at queue-fill. Campaigns are email by
// default (the audience query ANDs the email channel-consent gate), so an
// absent or blank delivery_settings.channel resolves to "email". A future
// SMS/push campaign type can set delivery_settings.channel to opt a send into a
// cross-channel cap that also counts its email sends.
func campaignChannel(c *Campaign) string {
	if c != nil && c.DeliverySettings != nil {
		if ch, ok := c.DeliverySettings["channel"].(string); ok {
			if ch = strings.TrimSpace(strings.ToLower(ch)); ch != "" {
				return ch
			}
		}
	}
	return "email"
}

// enqueueFrequencyRetryForChannel persists only email deferrals. The current
// intelligent-retry event identifies recipients by subscriber_email and its
// promotion transaction writes an email campaign recipient plus an "email"
// send-log row. SMS and push recipients are still withheld by the frequency
// filter, but must not enter that email-specific promotion path until the
// retry schema and worker become channel-aware.
func (d *Deps) enqueueFrequencyRetryForChannel(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID, channel string,
	emails []string,
	breakdown []FrequencySkipBreakdown,
	retryAfter time.Time,
) error {
	if channel != "email" || len(emails) == 0 {
		return nil
	}
	if d == nil || d.RetryQueue == nil {
		return errors.New("campaigns: intelligent-retry store is not configured")
	}
	if tx == nil {
		return errors.New("campaigns: intelligent-retry admission transaction is not configured")
	}
	return d.RetryQueue.EnqueueFrequencySkippedTx(
		ctx, tx, tenantID, campaignID, emails, breakdown, retryAfter,
	)
}

func frequencyCapAllDeferredError(channel string, kept, deferred []string) *queueError {
	if channel != "email" || len(kept) != 0 || len(deferred) == 0 {
		return nil
	}
	return &queueError{
		Status:  http.StatusUnprocessableEntity,
		Code:    "frequency_cap_all_deferred",
		Message: "all eligible email recipients are currently frequency-capped; no campaign queue admission or automatic retry event was created",
	}
}

func (d *Deps) filterFrequencyAudience(
	ctx context.Context,
	tenantID, channel string,
	emails []string,
) ([]string, int, []FrequencySkipBreakdown, *queueError) {
	if len(emails) == 0 {
		return emails, 0, nil, nil
	}
	if d == nil || d.Frequency == nil {
		return nil, 0, nil, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Frequency-cap enforcement is unavailable; queueing was not started.",
			Err:     errors.New("campaigns: frequency-cap filter is not configured"),
		}
	}
	kept, skipped, breakdown, err := d.Frequency(ctx, tenantID, channel, emails)
	if err != nil {
		return nil, 0, nil, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Frequency-cap enforcement is unavailable; queueing was not started.",
			Err:     err,
		}
	}
	if !validFrequencyFilterResult(emails, kept, skipped) {
		return nil, 0, nil, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Frequency-cap enforcement returned an invalid result; queueing was not started.",
			Err:     errors.New("campaigns: invalid frequency-cap filter result"),
		}
	}
	return kept, skipped, breakdown, nil
}

func (d *Deps) filterSubscriberPreferenceAudience(
	ctx context.Context,
	tenantID string,
	emails []string,
) ([]string, int, *queueError) {
	if len(emails) == 0 {
		return emails, 0, nil
	}
	if d == nil || d.SubscriberPreference == nil {
		return nil, 0, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Subscriber frequency-preference enforcement is unavailable; queueing was not started.",
			Err:     errors.New("campaigns: subscriber frequency-preference filter is not configured"),
		}
	}
	kept, skipped, err := d.SubscriberPreference(ctx, tenantID, emails)
	if err != nil {
		return nil, 0, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Subscriber frequency-preference enforcement is unavailable; queueing was not started.",
			Err:     err,
		}
	}
	if !validFrequencyFilterResult(emails, kept, skipped) {
		return nil, 0, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Subscriber frequency-preference enforcement returned an invalid result; queueing was not started.",
			Err:     errors.New("campaigns: invalid subscriber frequency-preference filter result"),
		}
	}
	return kept, skipped, nil
}

func (d *Deps) ensureCampaignEmailCompliance(ctx context.Context, tenantID string, c *Campaign) error {
	if d.Repo == nil {
		return nil
	}
	report, err := d.Repo.CheckEmailCompliance(ctx, tenantID, c)
	if err != nil {
		return &queueError{Status: http.StatusInternalServerError, Err: err}
	}
	if report != nil && !report.Ready {
		return &queueError{Status: http.StatusUnprocessableEntity, Body: map[string]any{
			"error": map[string]string{
				"code":    "email_compliance_blocked",
				"message": "Complete sender compliance requirements before queueing.",
			},
			"compliance": report,
		}}
	}
	return nil
}

func (d *Deps) filterControlGroup(ctx context.Context, tenantID string, emails []string) ([]string, int, *queueError) {
	if d.ControlGroups == nil || len(emails) == 0 {
		return emails, 0, nil
	}
	kept, excluded, err := d.ControlGroups(ctx, tenantID, emails)
	if err != nil {
		return nil, 0, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "control_group_unavailable",
			Message: "control-group membership could not be verified; no campaign was queued",
			Err:     err,
		}
	}
	if !validFrequencyFilterResult(emails, kept, excluded) {
		return nil, 0, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "control_group_unavailable",
			Message: "control-group filtering returned an inconsistent audience; no campaign was queued",
			Err:     errors.New("campaigns: invalid control-group filter result"),
		}
	}
	return kept, excluded, nil
}

func (d *Deps) recordQueueFinancials(ctx context.Context, tenantID, campaignID string, queued int) {
	// Cost telemetry is a queue projection, not allowance authority. The
	// provider-boundary reservation commits one recipient at a time and is the
	// only counter that may deny managed delivery.
	if d.CostSink != nil {
		_ = cost.RecordSends(ctx, d.CostSink, cost.DefaultPricing(), tenantID, queued, map[string]any{
			"campaign_id": campaignID,
		})
	}
}

func (d *Deps) queueCampaignCore(ctx context.Context, tenantID, id string, opts queueCampaignOptions) (*queueCampaignOutcome, error) {
	// Sandbox is a distinct, non-delivering lifecycle. It may bypass the live
	// interlock only when a real simulator is wired; a header alone is never
	// authority to turn a missing sandbox into a live send. Every non-sandbox
	// path fails closed before touching campaign state or audience data.
	if dispatchErr := d.authorizeQueueDispatch(ctx, tenantID, opts.Sandbox); dispatchErr != nil {
		return nil, dispatchErr
	}
	if d == nil || d.Repo == nil {
		return nil, &queueError{Status: http.StatusServiceUnavailable, Err: errors.New("campaign repository is not configured")}
	}
	c, campaignErr := d.Repo.Get(ctx, tenantID, id)
	if campaignErr != nil {
		if errors.Is(campaignErr, ErrNotFound) {
			return nil, &queueError{Status: http.StatusNotFound, Code: "not_found", Message: "campaign not found"}
		}
		return nil, &queueError{Status: http.StatusInternalServerError, Err: campaignErr}
	}
	if c.Status != StatusDraft && c.Status != StatusScheduled && c.Status != StatusPaused {
		return nil, &queueError{Status: http.StatusConflict, Code: "bad_status",
			Message: fmt.Sprintf("campaign in status %q cannot be queued", c.Status)}
	}
	// Persist the exact already-authorized decision before approval, audience
	// enumeration, simulation, or enqueue. A failed write is fatal: otherwise a
	// later background continuation could default an intended sandbox send to
	// live traffic. Persist false as well so a deliberate live re-queue cannot
	// inherit stale sandbox state from an earlier simulation.
	if err := d.persistCampaignSandboxAuthority(ctx, tenantID, id, opts.Sandbox); err != nil {
		return nil, &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "sandbox_authority_unavailable",
			Message: "campaign sandbox authority could not be persisted; queueing was not started",
			Err:     err,
		}
	}
	if c.Subject == "" || c.BodyHTML == "" {
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "incomplete",
			Message: "campaign needs a subject and body_html before queueing"}
	}
	if err := d.ensureEmailSendingAllowed(ctx, tenantID); err != nil {
		return nil, err
	}
	if err := d.ensureCampaignEmailCompliance(ctx, tenantID, c); err != nil {
		return nil, err
	}
	// Freeze before resolving or materializing recipients. The immutable source
	// ID is now shared by this queue attempt, later assurance, and the eventual
	// send plan; retries without edits reuse the same revision.
	revision, revisionErr := d.freezeQueueContentRevision(ctx, tenantID, id, opts.Actor)
	if revisionErr != nil {
		return nil, revisionErr
	}
	contentRevisionID := ""
	if revision != nil {
		contentRevisionID = revision.ID
	}
	// Authorize before audience resolution: a blocked/stale/unavailable run
	// must not reveal audience size, consume quota, or materialize recipients.
	// The gate binds the exact frozen source hash and returns the send-plan
	// identity that later raw delivery must also prove.
	assuranceReceipt, assuranceErr := d.authorizeCampaignRevision(
		ctx, tenantID, revision, opts.Sandbox,
	)
	if assuranceErr != nil {
		return nil, assuranceErr
	}
	// Resolve the audience through the same canonical path used by send-preview
	// and the production checklist. In particular, a named list is first
	// proven tenant-owned and then intersected with active list membership; a
	// failed list lookup is never reinterpreted as a blank segment / workspace
	// fan-out. Static snapshots remain authoritative.
	resolvedAudience, campaignErr := d.Repo.ResolveCampaignAudience(ctx, tenantID, c)
	if campaignErr != nil {
		return nil, queueAudienceError(campaignErr)
	}
	emails := resolvedAudience.Emails
	// These are queue candidates, not irrevocable send permission. The send
	// loop explicitly re-checks suppression and purpose consent at the last
	// safe boundary before transport, covering revocation after queue-fill.
	// A/B test split: if the campaign carries delivery_settings.ab_test
	// with a parent_id + total_variants > 1, narrow `emails` down to the
	// rows that hash into THIS variant's bucket. Same email + same
	// parent_id always lands in the same variant (deterministic), so a
	// re-queue after a pause/resume re-fans the same subset.
	if cfg, ok := ParseABTestVariantConfig(c.DeliverySettings); ok {
		emails = ApplyABTestSplit(cfg, emails)
	}
	// A/B winner rollout: when the campaign was created by the abtests
	// auto-rollout dispatcher (delivery_settings.ab_test_rollout set),
	// narrow `emails` down to the held-back audience — the subscribers
	// whose percent-bucket lies in [sample_pct, 100). Disjoint from the
	// original variant split by construction, so nobody receives both
	// the sample variant AND the rollout winner.
	if parentID, samplePct, ok := ParseABRolloutConfig(c.DeliverySettings); ok {
		emails = ApplyABRolloutHeldBack(parentID, samplePct, emails)
	}
	// The independent parent campaign_variants model owns its own sample_pct.
	// Resolve that sample exactly once before queue gates and holdout planning so
	// frequency retries, the holdout denominator, treatment, and repository
	// input all refer to the same sampled audience. QueueAndStartCampaign still
	// assigns variant IDs transactionally, but does not sample this set again.
	var sampleErr error
	emails, sampleErr = d.Repo.FilterQueueABSample(ctx, tenantID, id, emails)
	if sampleErr != nil {
		return nil, &queueError{Status: http.StatusInternalServerError, Err: sampleErr}
	}
	if len(emails) == 0 {
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "empty_audience",
			Message: "no subscribers are in the campaign's A/B sample"}
	}
	// Global control-group holdout. A tenant's active control group is a
	// deterministic slice of subscribers who must receive NO campaigns, so the
	// engagement gap between them and everyone else measures program lift.
	// control_group.IsInControl used to be called from nowhere, so control
	// members received every campaign and the lift was noise. Exclude them
	// here — before suppression/frequency, so a control member is never in the
	// sent cohort for any reason. The report partitions on the same identifier
	// (email), so the two agree.
	var controlHeldOut int
	var controlErr *queueError
	emails, controlHeldOut, controlErr = d.filterControlGroup(ctx, tenantID, emails)
	if controlErr != nil {
		return nil, controlErr
	}
	// Bulk-suppression filter at queue-fill. Without this, suppressed
	// addresses consume rate-limit slots in the send loop only to be
	// rejected per-row by the sendloop guard's check — wasted budget on
	// every campaign that targets a noisy segment. One round-trip filter
	// here cuts the queue down to deliverable rows. The send-loop check
	// remains as belt-and-suspenders so a race (suppression created
	// between our query and the send loop draining) still flags before
	// dispatch.
	emails = d.filterSuppressedAtQueueFill(ctx, tenantID, emails)
	// G16: frequency-cap filter. Runs AFTER suppression so suppressed
	// addresses don't pad the count of "rule-blocked" recipients
	// (they're already excluded for a different reason). This is the only
	// queue-admission enforcement point, so an unavailable or inconsistent
	// policy result must stop queueing rather than silently deliver.
	var freqSkipped int
	var freqBreakdown []FrequencySkipBreakdown
	var frequencyRetryEmails []string
	var frequencyRetryBreakdown []FrequencySkipBreakdown
	// SUB-133: scope the cap to the campaign's send channel (default
	// "email"). A send on any channel in a rule's set counts toward that
	// rule's shared cap.
	sendChannel := campaignChannel(c)
	if len(emails) > 0 {
		beforeFrequency := append([]string(nil), emails...)
		kept, skipped, breakdown, frequencyErr := d.filterFrequencyAudience(
			ctx, tenantID, sendChannel, emails,
		)
		if frequencyErr != nil {
			return nil, frequencyErr
		}
		emails = kept
		freqSkipped = skipped
		freqBreakdown = breakdown
		if skipped > 0 {
			frequencyRetryEmails = diffEmails(beforeFrequency, kept)
			frequencyRetryBreakdown = append([]FrequencySkipBreakdown(nil), breakdown...)
		}
	}
	// A campaign with no frequency-admitted email recipient has no durable
	// queue admission to continue. Keep it draft, create no retry event, and
	// return a stable release-hold response rather than manufacturing a
	// pre-approval or zero-recipient sending lifecycle.
	if allDeferredErr := frequencyCapAllDeferredError(sendChannel, emails, frequencyRetryEmails); allDeferredErr != nil {
		return nil, allDeferredErr
	}
	// SUB-132: subscriber-level frequency preference. Runs AFTER the tenant
	// cap filter so a recipient already skipped for a tenant rule doesn't pad
	// the per-subscriber count. Its skip is attributed to its own breakdown
	// entry (rule_id="subscriber_preference") so the operator can tell apart
	// per-subscriber pauses from tenant cap-rule skips. This is mandatory
	// activation authority: unavailable or inconsistent state stops queueing.
	keptByPreference, preferenceSkipped, preferenceErr := d.filterSubscriberPreferenceAudience(
		ctx, tenantID, emails,
	)
	if preferenceErr != nil {
		return nil, preferenceErr
	}
	emails = keptByPreference
	if preferenceSkipped > 0 {
		freqSkipped += preferenceSkipped
		freqBreakdown = append(freqBreakdown, FrequencySkipBreakdown{
			RuleID:    "subscriber_preference",
			RuleLabel: "Subscriber Frequency Preference",
			Skipped:   preferenceSkipped,
		})
	}
	emails, freqSkipped, freqBreakdown = d.applyQueuePrioritization(ctx, tenantID, id, emails, freqSkipped, freqBreakdown)
	if len(emails) == 0 {
		return nil, &queueError{Status: http.StatusUnprocessableEntity, Code: "empty_audience",
			Message: "no subscribers match the campaign's audience"}
	}

	if opts.Sandbox {
		return d.simulateSandboxQueue(ctx, tenantID, id, c, queueResponse{
			CampaignID:                    id,
			ContentRevisionID:             contentRevisionID,
			RecipientsQueued:              len(emails),
			Status:                        StatusSending,
			Sandbox:                       true,
			Message:                       "sandbox lifecycle scheduled",
			RecipientsSkippedFrequencyCap: freqSkipped,
			RecipientsHeldOutControlGroup: controlHeldOut,
			FrequencySkipBreakdown:        freqBreakdown,
		})
	}

	if !opts.SkipApproval && d.Approvals != nil {
		blocked, qerr := d.enforceSendApproval(ctx, tenantID, id, c, opts.Actor)
		if qerr != nil {
			return nil, qerr
		}
		if blocked != nil {
			blocked.Response.ContentRevisionID = contentRevisionID
			return blocked, nil
		}
	}

	// Campaign-level F02 holdout is the final audience partition.  Planning it
	// after consent, suppression, frequency, prioritisation, A/B, tenant-wide
	// control, and approval filters is load-bearing: assigning earlier would put
	// recipients who were never eligible to send into the treatment denominator
	// and dilute lift with a cohort the campaign did not actually target.
	//
	// The plan itself is still only in memory here. QueueAndStartCampaign writes
	// and freezes every treatment/control assignment in the SAME transaction as
	// campaign_recipients, so a failed queue cannot leave a phantom experiment.
	var holdoutPlan *holdout.AssignmentPlan
	var holdoutErr error
	holdoutPlan, emails, holdoutErr = d.planCampaignHoldout(ctx, tenantID, id, emails)
	if holdoutErr != nil {
		return nil, holdoutErr
	}
	// Queue admission does not consume or pre-spend managed allowance. The
	// shared provider-boundary gate reserves each immutable recipient row under
	// a locked tenant/month bucket, which is the only concurrency-safe point at
	// which all scheduled, approved and retried paths converge.

	// Atomically INSERT recipient rows + flip campaign status. We do this
	// in one tx so a partial enqueue + status flip can't leave the queue
	// drained by the guard before the campaign is fully populated.
	var assuranceBinding *campaignassurancegate.Receipt
	if assuranceReceipt.RunID != "" {
		copy := assuranceReceipt
		assuranceBinding = &copy
	}
	var retryAdmissionHook QueueAdmissionHook
	if sendChannel == "email" && len(frequencyRetryEmails) > 0 {
		retryAfter := time.Now().UTC().Add(time.Hour)
		retryAdmissionHook = func(hookCtx context.Context, tx pgx.Tx) error {
			return d.enqueueFrequencyRetryForChannel(
				hookCtx, tx, tenantID, id, sendChannel, frequencyRetryEmails,
				frequencyRetryBreakdown, retryAfter,
			)
		}
	}
	queued, campaignErr := d.Repo.QueueAndStartCampaign(
		ctx, tenantID, id, sendChannel, emails, holdoutPlan, assuranceBinding, retryAdmissionHook,
	)
	if campaignErr != nil {
		return nil, queueAdmissionError(campaignErr)
	}
	// Count the durable send against quota and the cost ledger.
	d.recordQueueFinancials(ctx, tenantID, id, queued)
	// QueueAndStartCampaign inserts the matching subscriber_send_log rows in
	// the same transaction as recipient admission and the status transition.
	// A successful queue receipt therefore cannot outrun its cap ledger.
	// Queue acceptance is not send completion. The repository emits the
	// canonical campaign.sent event transactionally only when status actually
	// transitions to sent; this realtime event solely communicates that work
	// entered the delivery queue.
	d.emit(tenantID, "campaign.queued", map[string]any{
		"id":                     id,
		"name":                   c.Name,
		"recipients":             queued,
		"kind":                   "queue",
		"content_revision_id":    contentRevisionID,
		"assurance_run_id":       assuranceReceipt.RunID,
		"send_plan_id":           assuranceReceipt.SendPlanID,
		"assurance_decision":     assuranceReceipt.Decision,
		"assurance_rollout_mode": assuranceReceipt.RolloutMode,
		"assurance_status":       assuranceReceipt.EvaluationStatus,
		"assurance_reason_code":  assuranceReceipt.EvaluationReasonCode,
	})
	return &queueCampaignOutcome{Response: queueResponse{
		CampaignID:                    id,
		ContentRevisionID:             contentRevisionID,
		AssuranceRunID:                assuranceReceipt.RunID,
		SendPlanID:                    assuranceReceipt.SendPlanID,
		AssuranceDecision:             assuranceReceipt.Decision,
		AssuranceRolloutMode:          string(assuranceReceipt.RolloutMode),
		AssuranceStatus:               string(assuranceReceipt.EvaluationStatus),
		AssuranceReasonCode:           assuranceReceipt.EvaluationReasonCode,
		RecipientsQueued:              queued,
		Status:                        StatusSending,
		RecipientsSkippedFrequencyCap: freqSkipped,
		RecipientsHeldOutControlGroup: controlHeldOut,
		RecipientsHeldOutCampaign:     holdoutPlan.ControlCount(),
		FrequencySkipBreakdown:        freqBreakdown,
	}}, nil
}

// filterSuppressedAtQueueFill drops bulk-suppressed addresses from the queue
// candidates. A lookup failure returns the candidates unchanged: the send loop
// re-checks suppression per row before transport.
func (d *Deps) filterSuppressedAtQueueFill(ctx context.Context, tenantID string, emails []string) []string {
	if d.Suppressions == nil || len(emails) == 0 {
		return emails
	}
	hits, err := d.Suppressions.LookupBulk(ctx, tenantID, emails)
	if err != nil {
		// Lookup failures aren't fatal — the per-row check in the
		// send loop will still catch suppressed rows. Log + proceed
		// so a transient DB hiccup doesn't break the queue path.
		//
		// (This package has no slog dep wired through Deps; the
		// failure is observable via the prometheus error counters
		// the suppressions package itself emits, plus the send-loop
		// per-row counter will go up if we let suppressed addresses
		// through.)
		return emails
	}
	if len(hits) > 0 {
		emails = filterOutSuppressed(emails, hits)
		recipientsSuppressedAtQueueFill.Add(float64(len(hits)))
	}
	return emails
}

// applyQueuePrioritization applies the optional message-prioritization filter
// and attributes its skips to their own breakdown entry. A filter error leaves
// the audience unchanged.
func (d *Deps) applyQueuePrioritization(ctx context.Context, tenantID, id string, emails []string, freqSkipped int, freqBreakdown []FrequencySkipBreakdown) ([]string, int, []FrequencySkipBreakdown) {
	if d.Prioritization == nil || len(emails) == 0 {
		return emails, freqSkipped, freqBreakdown
	}
	if kept, skipped, err := d.Prioritization(ctx, tenantID, id, emails); err == nil && skipped > 0 {
		emails = kept
		freqSkipped += skipped
		freqBreakdown = append(freqBreakdown, FrequencySkipBreakdown{
			RuleID:    "priority",
			RuleLabel: "Message Prioritization",
			Skipped:   skipped,
		})
	}
	return emails, freqSkipped, freqBreakdown
}

// simulateSandboxQueue runs the non-delivering sandbox lifecycle for an
// already-authorized sandbox queue and flips the campaign to sending.
// response.RecipientsQueued is the filtered audience size.
func (d *Deps) simulateSandboxQueue(ctx context.Context, tenantID, id string, c *Campaign, response queueResponse) (*queueCampaignOutcome, error) {
	if d.Sandbox == nil {
		return nil, &queueError{Status: http.StatusServiceUnavailable, Code: "sandbox_unavailable",
			Message: "sandbox lifecycle simulator is not configured"}
	}
	if err := d.Sandbox.SimulateCampaignLifecycle(ctx, tenantID, id, response.RecipientsQueued, time.Now().UTC()); err != nil {
		return nil, &queueError{Status: http.StatusInternalServerError, Err: err}
	}
	if _, err := d.Repo.Update(ctx, tenantID, c.ID, UpdateInput{Status: ptrString(StatusSending)}); err != nil {
		return nil, &queueError{Status: http.StatusInternalServerError, Err: err}
	}
	d.emit(tenantID, "campaign.simulated", map[string]any{
		"id":         id,
		"name":       c.Name,
		"recipients": response.RecipientsQueued,
		"kind":       "sandbox",
	})
	return &queueCampaignOutcome{Response: response}, nil
}

// planCampaignHoldout plans the campaign-level F02 holdout over the final
// eligible audience and returns the treatment arm as the audience to queue.
// Without a pool there is no plan and the audience passes through unchanged.
func (d *Deps) planCampaignHoldout(ctx context.Context, tenantID, id string, emails []string) (*holdout.AssignmentPlan, []string, error) {
	if d.Repo == nil || d.Repo.Pool == nil {
		return nil, emails, nil
	}
	holdoutPlan, planErr := holdout.PlanAudience(ctx, d.Repo.Pool, tenantID, id, emails)
	if planErr != nil {
		return nil, nil, &queueError{Status: http.StatusInternalServerError, Err: planErr}
	}
	if holdoutPlan == nil {
		return nil, emails, nil
	}
	if len(holdoutPlan.Treatment) == 0 {
		return nil, nil, &queueError{
			Status: http.StatusUnprocessableEntity,
			Code:   "empty_treatment_arm",
			Message: "the eligible audience produced no treatment recipients; " +
				"the holdout was not frozen and the campaign was not queued",
		}
	}
	return holdoutPlan, holdoutPlan.Treatment, nil
}

// enforceMonthlySendQuota checks the final deliverable recipient count against
// the monthly-send quota. nil means proceed (no limiter, under cap, or an
// opted-in overage).
func (d *Deps) enforceMonthlySendQuota(ctx context.Context, tenantID string, recipients int) error {
	if d.Limits == nil {
		return nil
	}
	if err := d.Limits.Check(ctx, tenantID, limits.ResourceMonthlySends, recipients); err != nil {
		// BILL-052: a cap breach becomes "allow + accrue" when the tenant
		// opted into overage; otherwise it stays the hard 402 (and a real
		// infra error stays a 500). nil = proceed past the cap.
		if qe := d.monthlySendQuotaError(ctx, tenantID, recipients, err); qe != nil {
			return qe
		}
	}
	return nil
}

// queueAdmissionError maps a transactional queue-admission failure onto the
// public refusal the caller returns. Authority drift and retry-evidence
// failures are 503s that invite a retry; anything else is a 500.
func queueAdmissionError(campaignErr error) *queueError {
	if errors.Is(campaignErr, errFrequencyCapAuthorityChanged) {
		return &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Frequency-cap authority changed during transactional admission; no recipients were queued. Retry to re-evaluate the audience.",
			Err:     campaignErr,
		}
	}
	if errors.Is(campaignErr, errSubscriberPreferenceAuthorityChanged) {
		return &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "frequency_cap_unavailable",
			Message: "Subscriber frequency-preference authority changed during queue admission; no recipients were queued. Retry to re-evaluate the audience.",
			Err:     campaignErr,
		}
	}
	if errors.Is(campaignErr, errIntelligentRetryAdmission) {
		return &queueError{
			Status:  http.StatusServiceUnavailable,
			Code:    "intelligent_retry_unavailable",
			Message: "deferred retry evidence could not be persisted; campaign queue admission was rolled back",
			Err:     campaignErr,
		}
	}
	return &queueError{Status: http.StatusInternalServerError, Err: campaignErr}
}

func queueAudienceError(err error) *queueError {
	switch {
	case errors.Is(err, ErrAudienceMixedSources):
		return &queueError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "ambiguous_audience",
			Message: mixedAudienceDetail,
		}
	case errors.Is(err, ErrAudienceListNotFound):
		return &queueError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "list_not_found",
			Message: audienceListNotFoundMessage,
		}
	case errors.Is(err, ErrSegmentNotFound):
		return &queueError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "segment_not_found",
			Message: audienceSegmentNotFoundMessage,
		}
	case errors.Is(err, ErrFrozenAudienceNotFound):
		return &queueError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "frozen_audience_not_found",
			Message: frozenAudienceMissingMessage,
		}
	default:
		return &queueError{Status: http.StatusInternalServerError, Err: err}
	}
}

// validFrequencyFilterResult prevents a broken adapter from injecting,
// reordering, or silently dropping recipients while claiming a different skip
// count. A valid result is an order-preserving subsequence of the candidates,
// and every removed position is accounted for by skipped.
func validFrequencyFilterResult(before, after []string, skipped int) bool {
	if skipped < 0 || skipped != len(before)-len(after) {
		return false
	}
	next := 0
	for _, candidate := range before {
		if next < len(after) && candidate == after[next] {
			next++
		}
	}
	return next == len(after)
}

func diffEmails(before, after []string) []string {
	if len(before) == 0 {
		return nil
	}
	kept := make(map[string]struct{}, len(after))
	for _, email := range after {
		kept[strings.ToLower(strings.TrimSpace(email))] = struct{}{}
	}
	out := make([]string, 0, len(before)-len(after))
	seen := map[string]struct{}{}
	for _, email := range before {
		key := strings.ToLower(strings.TrimSpace(email))
		if key == "" {
			continue
		}
		if _, ok := kept[key]; ok {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

func (d *Deps) ensureEmailSendingAllowed(ctx context.Context, tenantID string) error {
	if d == nil || d.EmailControls == nil {
		return nil
	}
	paused, reason, err := d.EmailControls.EmailSendingPaused(ctx, tenantID)
	if err != nil {
		return &queueError{Status: http.StatusInternalServerError, Err: err}
	}
	if paused {
		msg := "email sending is paused by tenant kill switch"
		if strings.TrimSpace(reason) != "" {
			msg += ": " + strings.TrimSpace(reason)
		}
		return &queueError{Status: http.StatusLocked, Code: "email_sending_paused", Message: msg}
	}
	return nil
}

// AudienceEmails returns the audience for a campaign.
//
// Filtering rules:
//
//   - segmentID == "" → no segment filter applied.
//   - segmentID != "" → the segment is loaded and evaluated through the
//     canonical resolver-aware email-activation population. Tenant isolation is enforced
//     both via RLS (db.WithTenant binds app.tenant_id) and via an
//     explicit tenant_id filter in the segment lookup.
//   - segment lookup miss → returns ErrSegmentNotFound + nil slice.
//
// Status='enabled' is always required (we never queue a disabled or
// blocklisted subscriber regardless of segment match).
//
// SUB-051: the email channel-consent gate is ALWAYS ANDed onto the
// recipient query (segment or no segment) so a profile whose
// consent_email_marketing_at is NULL — never granted, or revoked via a
// GPC / opt-out consent_events row the 0318 trigger projected to NULL —
// is excluded at activation time. Before this the consent-aware gate
// existed only in the segment-builder preview, so opted-out / GPC
// profiles still got selected at send time. The gate reuses the same
// definition the segment compiler uses (segments.ChannelConsentGate),
// so the previewed count and the delivered set stay byte-identical.
func (r *Repo) AudienceEmails(ctx context.Context, tenantID, segmentID string) ([]string, error) {
	tenantID = strings.TrimSpace(tenantID)
	segmentID = strings.TrimSpace(segmentID)
	if tenantID == "" {
		return nil, errors.New("audience: empty tenant id")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Build the WHERE clause (base predicate + compiled segment fragment +
	// email channel-consent gate). Extracted to buildAudienceWhere so the
	// G6 static-audience freeze resolves an identical audience.
	whereSQL, args, err := buildAudienceWhere(ctx, tx, tenantID, segmentID)
	if err != nil {
		return nil, err
	}

	// `subscribers.<col>` references appear in the compiled fragment
	// because compile.go fully qualifies its column references; that
	// matches our FROM table here.
	q := "SELECT email::text FROM subscribers WHERE " + whereSQL
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, 64)
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// filterOutSuppressed returns the subset of `emails` that does NOT
// appear in `hits`. `hits` is keyed lowercase per LookupBulk's contract;
// we lowercase each input before lookup so case differences don't slip
// suppressed rows through. Order is preserved (downstream INSERTs care
// about audience ordering for A/B determinism).
func filterOutSuppressed(emails []string, hits map[string]bool) []string {
	if len(emails) == 0 || len(hits) == 0 {
		return emails
	}
	out := make([]string, 0, len(emails))
	for _, e := range emails {
		k := strings.ToLower(strings.TrimSpace(e))
		if hits[k] {
			continue
		}
		out = append(out, e)
	}
	return out
}

// renumberPlaceholders rewrites $1, $2, … in a SQL fragment by adding
// `offset` to every placeholder index. Used to splice a compiled
// segment fragment (which starts placeholders at $1) into a query that
// already has `offset` args bound.
//
// Implementation: scan for `$<digits>`, parse the integer, emit
// `$<n+offset>`. Doesn't support `$$` (Postgres dollar-quoted strings);
// CompileAST never emits those.
func renumberPlaceholders(frag string, offset int) string {
	if offset == 0 {
		return frag
	}
	var b strings.Builder
	b.Grow(len(frag) + 4)
	i := 0
	for i < len(frag) {
		c := frag[i]
		if c != '$' {
			b.WriteByte(c)
			i++
			continue
		}
		// Read digits.
		j := i + 1
		for j < len(frag) && frag[j] >= '0' && frag[j] <= '9' {
			j++
		}
		if j == i+1 {
			// Lone '$' — write through unchanged.
			b.WriteByte(c)
			i++
			continue
		}
		// Parse the integer (bounded — placeholder count fits in int).
		n := 0
		for k := i + 1; k < j; k++ {
			n = n*10 + int(frag[k]-'0')
		}
		fmt.Fprintf(&b, "$%d", n+offset)
		i = j
	}
	return b.String()
}

var (
	errSubscriberPreferenceAuthorityChanged = errors.New("campaigns: subscriber frequency-preference authority changed during queue admission")
	errFrequencyCapAuthorityChanged         = errors.New("campaigns: frequency-cap authority changed during queue admission")
	errIntelligentRetryAdmission            = errors.New("campaigns: intelligent-retry admission failed")
)

// QueueAndStartCampaign inserts recipient rows and their frequency-ledger
// entries, flips the campaign to 'sending', and optionally locks the holdout
// decision in one transaction. Returns the number of new recipient rows.
func (r *Repo) QueueAndStartCampaign(
	ctx context.Context,
	tenantID, campaignID, channel string,
	emails []string,
	holdoutPlan *holdout.AssignmentPlan,
	assurance *campaignassurancegate.Receipt,
	beforeStatusFlip QueueAdmissionHook,
) (int, error) {
	if len(emails) == 0 {
		return 0, nil
	}
	channel = strings.ToLower(strings.TrimSpace(channel))
	if channel == "" {
		channel = "email"
	}
	switch channel {
	case "email", "sms", "push":
	default:
		return 0, fmt.Errorf("campaigns: unsupported frequency ledger channel %q", channel)
	}
	binding, err := normalizeQueueAssuranceBinding(tenantID, campaignID, assurance)
	if err != nil {
		return 0, err
	}
	tx, txErr := db.WithTenant(ctx, r.Pool, tenantID)
	if txErr != nil {
		return 0, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	frequencyAdmission, err := frequency.AdmitAndReserveTx(
		ctx, tx, tenantID, campaignID, channel, emails,
	)
	if err != nil {
		return 0, fmt.Errorf("campaigns: transactional frequency admission: %w", err)
	}
	if frequencyAdmission.Skipped != 0 {
		return 0, fmt.Errorf(
			"%w: %d candidate(s) became capped before materialization",
			errFrequencyCapAuthorityChanged,
			frequencyAdmission.Skipped,
		)
	}
	emails = frequencyAdmission.Kept
	if len(emails) == 0 {
		return 0, fmt.Errorf("%w: no candidates remain", errFrequencyCapAuthorityChanged)
	}

	// Recipients first. ON CONFLICT DO NOTHING relies on the unique
	// expression index introduced by migration 0158 — without it, a second /queue
	// call (network retry, operator double-click, paused→queue cycle,
	// approval-hook race) would insert duplicate rows that the send
	// loop processes independently → duplicate sends to the same
	// recipient. The unique key matches the index: campaign_id +
	// lower(subscriber_email).
	variants, _, txErr := loadQueueABVariants(ctx, tx, campaignID)
	if txErr != nil {
		return 0, txErr
	}
	variantIDs := make(map[string]string, len(variants))
	for _, variant := range variants {
		variantIDs[variant.VariantLabel] = variant.ID
	}
	// Child-campaign A/B tests split the audience before this method and carry
	// the corresponding canonical campaign_variants id in delivery_settings.
	// Stamp that id onto every child recipient so the parent results reader can
	// aggregate real sends/engagement across all child campaign rows.
	var childCanonicalVariantID string
	if len(variants) == 0 {
		var rawDeliverySettings []byte
		if err := tx.QueryRow(ctx, `
SELECT COALESCE(delivery_settings, '{}'::jsonb)
  FROM campaigns
	WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID).Scan(&rawDeliverySettings); err != nil {
			return 0, fmt.Errorf("load campaign delivery settings: %w", err)
		}
		var deliverySettings map[string]any
		if err := json.Unmarshal(rawDeliverySettings, &deliverySettings); err != nil {
			return 0, fmt.Errorf("decode campaign delivery settings: %w", err)
		}
		childCanonicalVariantID = canonicalABVariantID(deliverySettings)
	}

	// Resolve each recipient's A/B variant in-process first, then bulk-load.
	//
	// This used to be one INSERT round-trip PER RECIPIENT, inside this single
	// open transaction, inside the HTTP request. At ~0.3ms/RTT a 1M-recipient
	// campaign was ~5 minutes of serial round-trips holding one pooled
	// connection — the request timed out, the transaction rolled back, and
	// NOTHING was queued. That capped campaign size at low tens of thousands
	// regardless of how many replicas were running: an algorithm, not a
	// resource limit.
	//
	// CopyFrom cannot express ON CONFLICT, and the DO NOTHING is load-bearing
	// (re-queueing a paused campaign must not duplicate recipients). So we
	// COPY into a staging table and fold it in with a single INSERT ... SELECT
	// that keeps the exact same conflict semantics.
	type stagedRecipient struct {
		email     string
		variantID string
	}
	staged := make([]stagedRecipient, 0, len(emails))
	for _, e := range emails {
		variantID := childCanonicalVariantID
		if len(variants) > 0 {
			variantID = variantIDs[abtests.AssignVariant(e, campaignID, variants)]
			if variantID == "" {
				return 0, errors.New("campaigns: A/B variant assignment failed")
			}
		}
		staged = append(staged, stagedRecipient{email: e, variantID: variantID})
	}

	n := 0
	if len(staged) > 0 {
		// ON COMMIT DROP: the staging table lives and dies with this
		// transaction, so concurrent queues of different campaigns never see
		// each other's rows (each session gets its own temp namespace).
		if _, err := tx.Exec(ctx, `
CREATE TEMP TABLE _queue_stage (
    subscriber_email text,
    variant_id       text
) ON COMMIT DROP`); err != nil {
			return 0, fmt.Errorf("create recipient staging table: %w", err)
		}

		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"_queue_stage"},
			[]string{"subscriber_email", "variant_id"},
			pgx.CopyFromSlice(len(staged), func(i int) ([]any, error) {
				return []any{staged[i].email, staged[i].variantID}, nil
			}),
		); err != nil {
			return 0, fmt.Errorf("stage campaign recipients: %w", err)
		}

		// DISTINCT ON collapses duplicates WITHIN this batch on the same key
		// the unique index uses, so the batch can never conflict with itself;
		// ON CONFLICT then handles rows already queued by a previous call.
		var stagedCount, authorityCount, eligibleCount, recordedCount int64
		err := tx.QueryRow(ctx, `
WITH staged_recipients AS MATERIALIZED (
  SELECT DISTINCT ON (lower(s.subscriber_email))
         s.subscriber_email, s.variant_id
    FROM _queue_stage AS s
   ORDER BY lower(s.subscriber_email)
), subscriber_authority AS MATERIALIZED (
  -- This lock is the transaction-bound form of SUB-132. A pause update
  -- racing the earlier audience filter linearizes before this read (and makes
  -- the whole queue attempt roll back) or after recipient admission. It cannot
  -- commit inside an unchecked filter/INSERT gap.
  SELECT staged.subscriber_email, staged.variant_id,
         NOT (
                  subscriber.frequency_preference = 'paused'
              AND (subscriber.paused_until IS NULL OR subscriber.paused_until > now())
             ) AS preference_allows
    FROM staged_recipients AS staged
    JOIN subscribers AS subscriber
      ON subscriber.tenant_id = $2::uuid
     AND subscriber.email = staged.subscriber_email::citext
     FOR NO KEY UPDATE OF subscriber
), eligible_recipients AS MATERIALIZED (
  SELECT subscriber_email, variant_id
    FROM subscriber_authority
   WHERE preference_allows
), inserted_recipients AS (
  INSERT INTO campaign_recipients (
	    campaign_id, tenant_id, subscriber_email, status, variant_id,
    content_revision_id, send_plan_id, assurance_run_id,
    assurance_attempt_count, assurance_artifact_set_hash,
    assurance_source_hash, assurance_plan_hash, assurance_gate_decision,
    assurance_override_ids, assurance_bound_at
	  )
	  SELECT $1::uuid, $2::uuid, eligible.subscriber_email, 'pending', NULLIF(eligible.variant_id, '')::uuid,
       NULLIF($3, '')::uuid, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid,
       NULLIF($6, 0), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
       NULLIF($10, ''), $11::uuid[], $12
	    FROM eligible_recipients AS eligible
  ON CONFLICT (campaign_id, (lower(subscriber_email))) DO NOTHING
  RETURNING subscriber_email
)
SELECT (SELECT count(*) FROM staged_recipients),
       (SELECT count(*) FROM subscriber_authority),
       (SELECT count(*) FROM eligible_recipients),
       (SELECT count(*) FROM inserted_recipients)`,
			campaignID, tenantID, binding.ContentRevisionID, binding.SendPlanID,
			binding.RunID, binding.RunAttempt, binding.ArtifactSetHash,
			binding.SourceHash, binding.PlanHash, binding.Decision,
			binding.OverrideIDs, binding.BoundAt).Scan(
			&stagedCount, &authorityCount, &eligibleCount, &recordedCount,
		)
		if err != nil {
			return 0, fmt.Errorf("%w: queue campaign recipients and frequency ledger: %v", errSubscriberPreferenceAuthorityChanged, err)
		}
		if err := validateSubscriberPreferenceAuthorityCounts(stagedCount, authorityCount, eligibleCount); err != nil {
			return 0, err
		}
		n = int(recordedCount)
		if assurance != nil {
			var mismatch bool
			if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM campaign_recipients AS recipients
      JOIN _queue_stage AS staged
        ON lower(staged.subscriber_email) = lower(recipients.subscriber_email)
     WHERE recipients.tenant_id = $1::uuid
       AND recipients.campaign_id = $2::uuid
       AND ROW(
           recipients.content_revision_id::text,
           recipients.send_plan_id::text,
           recipients.assurance_run_id::text,
           recipients.assurance_attempt_count,
           recipients.assurance_artifact_set_hash,
           recipients.assurance_source_hash,
           recipients.assurance_plan_hash,
           recipients.assurance_gate_decision,
           recipients.assurance_override_ids
       ) IS DISTINCT FROM ROW(
           $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[]
       )
)`, tenantID, campaignID, binding.ContentRevisionID, binding.SendPlanID,
				binding.RunID, binding.RunAttempt, binding.ArtifactSetHash,
				binding.SourceHash, binding.PlanHash, binding.Decision,
				binding.OverrideIDs).Scan(&mismatch); err != nil {
				return 0, fmt.Errorf("verify queued assurance binding: %w", err)
			}
			if mismatch {
				return 0, errors.New("campaigns: queued recipient assurance binding differs from current authorization")
			}
		}
	}
	if err := materializePSTOScheduleTx(ctx, tx, tenantID, campaignID, emails); err != nil {
		return n, err
	}
	// Frequency-retry evidence belongs to this exact admission decision. Run
	// its insertion inside the same transaction and before the campaign flip;
	// a missing store or insertion error therefore rolls back recipients,
	// send-log rows, schedule materialization, and lifecycle state together.
	if beforeStatusFlip != nil {
		if err := beforeStatusFlip(ctx, tx); err != nil {
			return 0, fmt.Errorf("%w: %w", errIntelligentRetryAdmission, err)
		}
	}
	// Flip campaign status. Conditional on the current status being
	// non-terminal so we never reset a 'sent' campaign.
	const flip = `
UPDATE campaigns
SET status='sending', started_at=COALESCE(started_at, now()), updated_at=now()
WHERE id=$1::uuid AND tenant_id=$2::uuid
  AND status IN ('draft','scheduled','paused')`
	tag, txErr := tx.Exec(ctx, flip, campaignID, tenantID)
	if txErr != nil {
		return n, fmt.Errorf("flip campaign status: %w", txErr)
	}
	if tag.RowsAffected() == 0 {
		// Race: someone else moved the campaign out from under us.
		// Roll back the recipient inserts so we don't leak orphans.
		return 0, errors.New("campaigns: campaign no longer queueable")
	}
	if holdoutPlan != nil {
		if err := holdout.PersistAssignmentPlanTx(
			ctx, tx, tenantID, campaignID, holdoutPlan, n,
		); err != nil {
			return n, fmt.Errorf("freeze holdout assignment plan: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return n, err
	}
	return n, nil
}

func validateSubscriberPreferenceAuthorityCounts(staged, authority, eligible int64) error {
	if staged < 0 || authority < 0 || eligible < 0 || authority != staged || eligible != staged {
		return errSubscriberPreferenceAuthorityChanged
	}
	return nil
}

// FilterQueueABSample applies the independent parent campaign_variants
// sample_pct before campaign holdout planning. Variant assignment remains in
// QueueAndStartCampaign so the canonical IDs are stamped in its transaction.
func (r *Repo) FilterQueueABSample(ctx context.Context, tenantID, campaignID string, emails []string) ([]string, error) {
	if r == nil || r.Pool == nil || len(emails) == 0 {
		return emails, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	variants, samplePct, err := loadQueueABVariants(ctx, tx, campaignID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return filterQueueABSample(emails, campaignID, variants, samplePct), nil
}

func filterQueueABSample(emails []string, campaignID string, variants []abtests.Variant, samplePct float64) []string {
	if len(variants) == 0 {
		return emails
	}
	filtered := make([]string, 0, len(emails))
	for _, email := range emails {
		if abtests.IsInSample(email, campaignID, samplePct) {
			filtered = append(filtered, email)
		}
	}
	return filtered
}

// loadQueueABVariants reads the independent campaign_variants model used by
// the campaign A/B editor. Queue materialization uses it to stamp canonical
// variant IDs; FilterQueueABSample uses it earlier to establish the holdout
// denominator from the configured sample_pct.
func loadQueueABVariants(ctx context.Context, tx pgx.Tx, campaignID string) ([]abtests.Variant, float64, error) {
	rows, err := tx.Query(ctx, `
SELECT v.id::text, v.variant_label, v.weight::float8
  FROM campaign_variants v
 WHERE v.campaign_id = $1::uuid
 ORDER BY v.variant_label`, campaignID)
	if err != nil {
		return nil, 100, fmt.Errorf("load A/B variants: %w", err)
	}
	defer rows.Close()
	variants := []abtests.Variant{}
	for rows.Next() {
		var v abtests.Variant
		if err := rows.Scan(&v.ID, &v.VariantLabel, &v.Weight); err != nil {
			return nil, 100, fmt.Errorf("scan A/B variant: %w", err)
		}
		variants = append(variants, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 100, err
	}
	if len(variants) == 0 {
		return variants, 100, nil
	}
	var samplePct float64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(sample_pct, 100.0)::float8
  FROM campaign_ab_settings
 WHERE campaign_id = $1::uuid`, campaignID).Scan(&samplePct); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, 100, fmt.Errorf("load A/B sample settings: %w", err)
		}
		samplePct = 100
	}
	return variants, samplePct, nil
}
