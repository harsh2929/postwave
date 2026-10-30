package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"log/slog"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/cost"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/emailpreview"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/safety"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

type TransactionalSender interface {
	SendTransactional(context.Context, listmonk.SendTransactionalReq) error
}

type Deps struct {
	Repo *Repo
	// Artifacts snapshots mutable campaign drafts into tenant-safe immutable
	// revisions. Assurance and dispatch bind to these identities instead of
	// re-reading editor state.
	Artifacts CampaignArtifactStore
	// AssuranceGate authorizes the exact immutable content revision before a
	// live audience is enumerated. AssuranceGateEnabled is the staged rollout
	// switch; once enabled, a missing gate or revision fails closed. Sandbox
	// simulations remain non-delivering and do not require authorization.
	AssuranceGate        CampaignAssuranceGate
	AssuranceGateEnabled bool
	// ABRepo bridges child-campaign A/B creation into the canonical
	// campaign_variants/results subsystem consumed by results readers.
	ABRepo *abtests.Repo
	Sender TransactionalSender
	Safety *safety.Service
	Limits *limits.Enforcer
	// Allowance is the same managed-send authority used by the background
	// campaign drain. Test sends cross their provider boundary in this handler.
	Allowance        sendallowance.Gate
	RequireAllowance bool
	// CostSink, when non-nil, records KindSend to the cost ledger once per
	// queued batch (priced in microcents). nil disables cost recording.
	CostSink cost.Recorder
	// ControlGroups, when non-nil, holds the tenant's active control-group
	// members out of the audience so program-lift measurement is real. nil
	// disables the holdout.
	ControlGroups ControlGroupFilter
	// EmailControls is the tenant-level production email kill switch.
	// When paused, all campaign enqueue/dispatch paths must refuse to send.
	EmailControls EmailSendControls
	// LiveDispatch is the process/tenant operational interlock for every
	// campaign action that can enter a real delivery lifecycle. nil is closed.
	// Authenticated sandbox queueing bypasses it only when Sandbox is wired.
	LiveDispatch dispatchcontrol.Gate
	// ScheduledMaterializationEnabled is runtime operator intent for workers
	// that create status=scheduled state. Shared compile-time qualification is
	// also required, so this field alone can never arm an unsafe scheduler.
	ScheduledMaterializationEnabled bool
	// Bus, when non-nil, receives campaign.* domain events at the end
	// of mutating handlers. Optional — nil disables emission so tests
	// don't have to thread a broker through.
	Bus *events.Bus
	// Suppressions, when non-nil, is consulted by QueueCampaign before
	// INSERTing recipient rows. Suppressed audience members get filtered
	// out at queue-fill so they don't consume rate-limit slots in the
	// send loop only to be rejected per-row. nil disables the bulk
	// filter (per-row check in the send loop is the safety net).
	Suppressions SuppressionLookup
	// Approvals gates high-risk live sends. nil disables the gate for
	// local/dev test wiring; production wires it from main.go.
	Approvals ApprovalGate
	// Sandbox simulates production-like lifecycle events when a request is
	// marked sandbox. nil means sandbox sends are unavailable.
	Sandbox SandboxLifecycle
	// SandboxAuthority persists the exact queue-time sandbox decision for
	// background continuations. Production falls back to Repo; this narrow seam
	// exists so policy persistence can be tested independently of PostgreSQL.
	// A read or write failure is always fatal: unknown authority must never be
	// reinterpreted as permission to send real traffic.
	SandboxAuthority SandboxAuthorityStore
	// Frequency evaluates tenant-level frequency cap
	// rules against the audience at queue-fill time. Skipped recipients
	// are surfaced in queueResponse.RecipientsSkippedFrequencyCap +
	// FrequencySkipBreakdown. A missing filter fails queueing closed. G16.
	Frequency FrequencyFilter
	// SubscriberPreference enforces the mandatory SUB-132 subscriber-level
	// frequency preference at queue-fill: it drops recipients whose
	// frequency_preference='paused' and whose pause is still in effect
	// (paused_until NULL or in the future). It runs AFTER the tenant-level
	// Frequency filter, and its skip count is surfaced under its own
	// FrequencySkipBreakdown entry (rule_id="subscriber_preference") so the
	// operator sees per-subscriber preference skips distinctly from
	// tenant cap-rule skips. Missing wiring is unavailable policy authority,
	// so queueing fails closed while candidates remain.
	SubscriberPreference SubscriberPreferenceFilter
	// Prioritization, when non-nil, drops recipients who already
	// received a higher-priority campaign inside the active collision
	// window. It runs at queue-fill so lower-priority overlap never
	// reaches the send loop.
	Prioritization PrioritizationFilter
	// RetryQueue receives email recipients deferred by queue-fill gates. The
	// current durable event and promotion worker are email-specific, so queue
	// admission must not send SMS or push skips through this interface.
	RetryQueue RetryQueue
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

type CampaignAssuranceGate interface {
	Authorize(context.Context, campaignassurancegate.Request) (campaignassurancegate.Receipt, error)
}

type EmailSendControls interface {
	EmailSendingPaused(ctx context.Context, tenantID string) (paused bool, reason string, err error)
}

const campaignJSONMaxBodyBytes int64 = 2 << 20 // 2 MiB

// ApprovalGate is implemented by the approvals service adapter in main.go.
// The campaigns package intentionally depends only on this tiny contract so
// approvals can stay a reusable subsystem.
//
// fingerprint is a stable hash of the campaign's approval-relevant
// content (subject + body_html + segment_id, computed in
// queueCampaignCore). When a prior Approved row exists for this
// campaign, the gate compares the stored fingerprint against this
// argument and rejects re-use on mismatch — preventing the
// "approve-then-edit" bypass. Empty string disables the check (for
// callers that don't have the content handy, e.g. legacy paths).
type ApprovalGate interface {
	EnsureCampaignSendApproved(ctx context.Context, tenantID, campaignID, fingerprint string, actor ApprovalActor) (*ApprovalState, error)
	// MarkApprovalConsumed flips the approval row's consumed_at to
	// now() after the side-effect (queue-fill) has landed. Callers
	// MUST invoke this once per approval; a second queue attempt
	// finds consumed_at non-null and re-requests approval. Best-
	// effort: errors are logged but do not roll back the queue.
	MarkApprovalConsumed(ctx context.Context, tenantID, approvalID string) error
	// VerifyApprovedFingerprint reports whether the CURRENT content still
	// matches what was approved, for the path that sends WITHOUT re-running
	// the gate.
	//
	// This exists because the gate above has one caller, behind
	// `!opts.SkipApproval` — and the approval hook, which is what actually
	// sends in the default wiring, passes SkipApproval: true. So the
	// approve→edit→send sequence the fingerprint was built to stop was never
	// compared on the only path it travels. An adversarial review found this
	// after the fingerprint work had already been called done.
	//
	// Returns false when the stored hash differs. An EMPTY stored hash returns
	// true: rows predating the fingerprint carry none, and refusing them would
	// brick every in-flight approval across a deploy.
	VerifyApprovedFingerprint(ctx context.Context, tenantID, campaignID, fingerprint string) (bool, error)
}

// ApprovalActor mirrors the request-scoped actor metadata attached by auth.
type ApprovalActor struct {
	Type     string
	Label    string
	APIKeyID string
	// UserID is the canonical id of the human who initiated the
	// campaign send. Threaded through into approvals.Actor.UserID so
	// the two-person rule can block self-approval (audit HIGH F5).
	// Empty for API-key / agent send flows — the no-self-approval
	// rule degenerates trivially when no human requester exists.
	UserID string
}

// ApprovalState tells a send path whether it may continue or must wait for
// human approval.
type ApprovalState struct {
	Approved  bool
	ID        string
	Status    string
	ExpiresAt *time.Time
}

// SandboxLifecycle is implemented by the sandbox simulator adapter in main.go.
type SandboxLifecycle interface {
	SimulateCampaignLifecycle(ctx context.Context, tenantID, campaignID string, recipientCount int, now time.Time) error
}

// SandboxAuthorityStore is the durable authority used by schedulers, approval
// hooks, and agent continuations after the initiating HTTP request is gone.
type SandboxAuthorityStore interface {
	SetSandboxFlag(ctx context.Context, tenantID, campaignID string, sandbox bool) error
	GetSandboxFlag(ctx context.Context, tenantID, campaignID string) (bool, error)
}

type PrioritizationFilter func(ctx context.Context, tenantID, campaignID string, candidates []string) (kept []string, skipped int, err error)

// SubscriberPreferenceFilter is the mandatory SUB-132 queue-fill hook. main.go wires it
// to frequency.FilterBySubscriberPreference. Loosely-typed (no breakdown
// return) because the single per-subscriber-preference skip count maps to one
// synthetic FrequencySkipBreakdown entry that queueCampaignCore appends itself.
type SubscriberPreferenceFilter func(ctx context.Context, tenantID string, candidates []string) (kept []string, skipped int, err error)

type RetryQueue interface {
	EnqueueFrequencySkippedTx(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, emails []string, breakdown []FrequencySkipBreakdown, retryAfter time.Time) error
}

// QueueAdmissionHook runs inside QueueAndStartCampaign's tenant transaction
// after recipient materialization and before the campaign status flip. Any
// error rolls back the complete queue admission.
type QueueAdmissionHook func(context.Context, pgx.Tx) error

// emit publishes a campaign.* event when the bus is configured. Safe
// against a nil receiver / nil bus so test wiring stays minimal.
func (d *Deps) emit(tenantID, topic string, payload map[string]any) {
	if d == nil || d.Bus == nil || tenantID == "" {
		return
	}
	d.Bus.Publish(events.Event{
		Topic:    topic,
		TenantID: tenantID,
		Payload:  payload,
	})
}

func MountRead(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns", d.List)
	// /count is registered BEFORE /{id} so the chi router matches the
	// literal path before falling through to the parameterised route.
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/count", d.Count)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/content-revisions", d.ListContentRevisions)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/content-revisions/{revisionID}", d.GetContentRevision)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}", d.Get)
}

func MountWrite(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/campaigns", d.Create)
	r.With(apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)).Post("/api/v1/campaigns/test-send", d.TestSend)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch("/api/v1/campaigns/{id}", d.Update)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put("/api/v1/campaigns/{id}/fact-contract", d.SetFactContract)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/campaigns/{id}/content-revisions", d.FreezeContentRevision)
	// Editing leases. Read is a plain campaign read — a list view asks "is
	// anyone editing this" before offering an Edit button — while taking or
	// releasing one is a write, because it changes who may edit.
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/edit-lease", d.GetEditLeaseHandler)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/campaigns/{id}/edit-lease", d.AcquireEditLeaseHandler)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete("/api/v1/campaigns/{id}/edit-lease", d.ReleaseEditLeaseHandler)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete("/api/v1/campaigns/{id}", d.Delete)
	r.With(apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)).Post("/api/v1/campaigns/{id}/test-send", d.TestSend)
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Accept both `?query=` (desktop UI canonical name) and the legacy
	// `?q=` (compat for older clients + tests). listsearch.ReadQuery
	// prefers `query` and falls back to `q`.
	q := listsearch.ReadQuery(r.URL.Query())
	// Optional ?limit=N caps the result-set per request. Dashboard
	// overview uses limit=10; full list page omits to get the
	// CampaignListMaxRows ceiling. Negative / non-numeric values
	// fall through to the default.
	limit := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			page = n
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("per_page")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit <= 0 {
		limit = CampaignListMaxRows
	}
	if limit > CampaignListMaxRows {
		limit = CampaignListMaxRows
	}
	// Optional ?source_template_id=UUID filter (TMPL-026): list only the
	// campaigns built from a given template. Validate here so a malformed
	// value is a 400, not a 500 from the ::uuid cast.
	sourceTemplateID := strings.TrimSpace(r.URL.Query().Get("source_template_id"))
	if sourceTemplateID != "" {
		if _, err := uuid.Parse(sourceTemplateID); err != nil {
			writeJSON(w, http.StatusBadRequest,
				errEnv("invalid_source_template_id", "source_template_id must be a UUID"))
			return
		}
	}
	rows, err := d.Repo.ListPageFilter(r.Context(), t.ID, q, sourceTemplateID, limit, (page-1)*limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// Count returns per-status campaign counts via a single COUNT(*)
// GROUP BY query — cheap even at thousands of campaigns. Lets the
// dashboard render accurate all-time stats without pulling the
// full row set. Audit perf FE-1 follow-through (the prior fix
// bounded the list at 500 + relabelled the stat to "recent"; this
// gives back the real count without the cost).
func (d *Deps) Count(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.CountFiltered(r.Context(), t.ID, listsearch.ReadQuery(r.URL.Query()))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	c, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		if errors.Is(err, ErrDeleteRequiresDraft) {
			writeJSON(w, http.StatusConflict, errEnv("campaign_not_draft", "only draft campaigns can be deleted"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Emit the optimistic-concurrency token so clients can echo it back in
	// If-Match on the next PATCH.
	w.Header().Set("ETag", httpcache.ConcurrencyToken("campaign", c.ID, c.UpdatedAt))
	writeJSON(w, http.StatusOK, c)
}

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var authoring createAuthoringInput
	if err := httpbody.DecodeJSON(w, r, campaignJSONMaxBodyBytes, &authoring); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if authoring.hasDispatchState() {
		httperror.Write(w, http.StatusUnprocessableEntity, "campaign_dispatch_state_owned",
			"status and scheduled_at are controlled by campaign lifecycle endpoints")
		return
	}
	in := authoring.repositoryInput()
	if err := normalizeCreate(&in); err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if in.EditorMode == "mjml" && strings.TrimSpace(in.BodyMJML) != "" {
		rendered, _, rerr := emailpreview.RenderMJML(r.Context(), in.BodyMJML, nil)
		if rerr != nil {
			httperror.Write(w, http.StatusUnprocessableEntity, "mjml_not_rendered", httperror.MessageForStatus(http.StatusUnprocessableEntity))
			return
		}
		in.BodyHTML = rendered
	} else if in.EditorMode == "plain_text" && strings.TrimSpace(in.PlainText) != "" {
		in.BodyHTML = plainTextBodyHTML(in.PlainText)
	}
	if d.Limits != nil {
		if err := d.Limits.Check(r.Context(), t.ID, limits.ResourceCampaigns, 1); err != nil {
			if limits.WriteExceeded(w, err) {
				return
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	c, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if writeCampaignSemanticError(w, err) || writeCampaignAudienceError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emit(t.ID, "campaign.created", map[string]any{
		"id":     c.ID,
		"name":   c.Name,
		"status": c.Status,
	})
	writeJSON(w, http.StatusCreated, c)
}

func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Refuse a write while someone ELSE holds the editing lease.
	//
	// Checked before the body is even parsed: the point of a lease is that the
	// second editor learns immediately, not after composing a change that is
	// going to be rejected. An UNHELD campaign is unaffected, which is what
	// keeps every existing client working — only a genuine concurrent editor is
	// stopped, and `If-Match` plus the approval fingerprint still cover what
	// slips past the lease's TTL.
	if d.Repo != nil {
		holderID, _ := leaseHolderFromRequest(r)
		if err := d.Repo.AssertEditableBy(r.Context(), t.ID, chi.URLParam(r, "id"), holderID); err != nil {
			var held *ErrEditLeaseHeld
			if errors.As(err, &held) {
				// 409, not 403: they ARE allowed to edit this campaign, just not
				// while someone else is. A 403 sends them to an administrator
				// about a permission they already have.
				writeJSON(w, http.StatusConflict, map[string]any{
					"error": map[string]any{
						"code":    "edit_lease_held",
						"message": held.Error(),
						"holder":  editLeaseConflictHolder(held.Holder),
					},
				})
				return
			}
			// A lease READ failure must not block editing: the lease is an
			// advisory convenience, and failing closed here would make an
			// unrelated outage look like a permanent lock.
			d.Logger.WarnContext(r.Context(), "edit lease check failed", "error", err)
		}
	}

	var authoring updateAuthoringInput
	if err := httpbody.DecodeJSON(w, r, campaignJSONMaxBodyBytes, &authoring); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if authoring.hasDispatchState() {
		httperror.Write(w, http.StatusUnprocessableEntity, "campaign_dispatch_state_owned",
			"status and scheduled_at are controlled by campaign lifecycle endpoints")
		return
	}
	in := authoring.repositoryInput()
	if err := normalizeUpdate(&in); err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	// Authoring modes must always refresh the canonical body_html.  Checking
	// only whether body_html was empty left stale HTML behind whenever an MJML
	// or plain-text draft was edited after its first save.
	mode := ""
	if in.EditorMode != nil {
		mode = *in.EditorMode
	}
	if in.BodyMJML != nil && strings.TrimSpace(*in.BodyMJML) != "" &&
		(mode == "mjml" || in.BodyHTML == nil || strings.TrimSpace(*in.BodyHTML) == "") {
		rendered, _, rerr := emailpreview.RenderMJML(r.Context(), *in.BodyMJML, nil)
		if rerr != nil {
			httperror.Write(w, http.StatusUnprocessableEntity, "mjml_not_rendered", httperror.MessageForStatus(http.StatusUnprocessableEntity))
			return
		}
		in.BodyHTML = &rendered
	} else if mode == "plain_text" && in.PlainText != nil {
		rendered := plainTextBodyHTML(*in.PlainText)
		in.BodyHTML = &rendered
	}
	// Optimistic concurrency: a caller that sends If-Match opts into a 412 on
	// stale writes. Absent the header, the write proceeds unconditionally.
	// `If-Match: *` means "only if this resource exists" — an explicitly
	// CONDITIONAL request. Discarding the wildcard bool made it an
	// unconditional write returning 200: the caller believes it sent a
	// precondition and got last-writer-wins. Refused instead, because silently
	// weakening a caller's stated intent is worse than rejecting a header shape
	// this resource does not support.
	if tok, present, wildcard := httpcache.ParseIfMatch(r); present {
		if wildcard {
			httpcache.WritePreconditionFailed(w)
			return
		}
		in.IfMatchToken = tok
	}
	c, err := d.Repo.Update(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if writeCampaignSemanticError(w, err) {
			return
		}
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		if errors.Is(err, ErrCampaignDispatching) {
			// 409, not 422: the request is well-formed and would be valid at
			// any other point in this campaign's life. What is wrong is the
			// state it arrived in, and the remedy is a different resource
			// (a duplicate), not a corrected field.
			writeJSON(w, http.StatusConflict, errEnv("campaign_dispatching",
				"this campaign has started sending; its content can no longer be changed — duplicate it to send a revised version"))
			return
		}
		if writeCampaignAudienceError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("campaign", c.ID, c.UpdatedAt))
	d.emit(t.ID, "campaign.updated", map[string]any{
		"id":     c.ID,
		"name":   c.Name,
		"status": c.Status,
	})
	writeJSON(w, http.StatusOK, c)
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Deleting a campaign someone else is editing is the most destructive
	// version of the collision this lease exists to stop: the other editor's
	// work does not conflict, it ceases to exist.
	if d.refuseIfLeaseHeld(w, r, t.ID, chi.URLParam(r, "id")) {
		return
	}
	if err := d.Repo.Delete(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) TestSend(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Test sends use the real transactional transport. Unlike campaign queueing,
	// this endpoint has no authoritative sandbox simulator, so a sandbox-only
	// key or opt-in header must fail closed instead of leaking a real message.
	if sandbox.IsSandboxRequest(r) {
		// This fixed 503 is a public policy contract, not an infrastructure error;
		// write it directly so the generic 5xx sanitizer does not collapse the
		// stable code to internal_error.
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sandbox_unavailable",
			"campaign test sends are unavailable in sandbox mode"))
		return
	}
	if err := d.checkLiveDispatch(r.Context(), t.ID); err != nil {
		writeLiveDispatchError(w, err)
		return
	}
	var in TestSendInput
	if err := httpbody.DecodeJSON(w, r, campaignJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if pathID := chi.URLParam(r, "id"); pathID != "" {
		in.CampaignID = pathID
	}
	if in.CampaignID != "" {
		c, err := d.Repo.Get(r.Context(), t.ID, in.CampaignID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
				return
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if in.Subject == "" {
			in.Subject = c.Subject
		}
		if in.BodyHTML == "" {
			in.BodyHTML = c.BodyHTML
		}
		if in.BodyMJML == "" {
			in.BodyMJML = c.BodyMJML
		}
		if in.PlainText == "" {
			in.PlainText = c.PlainText
		}
	}
	to, err := normalizeEmail(in.ToEmail)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	in.ToEmail = to
	in.Subject = strings.TrimSpace(in.Subject)
	if in.Subject == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "subject is required"))
		return
	}
	if paused, reason, err := d.emailSendingPaused(r.Context(), t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	} else if paused {
		msg := "email sending is paused by tenant kill switch"
		if reason != "" {
			msg += ": " + reason
		}
		writeJSON(w, http.StatusLocked, errEnv("email_sending_paused", msg))
		return
	}
	if strings.TrimSpace(in.BodyHTML) == "" && strings.TrimSpace(in.BodyMJML) != "" {
		rendered, _, err := emailpreview.RenderMJML(r.Context(), in.BodyMJML, nil)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("mjml_not_rendered", httperror.MessageForStatus(http.StatusUnprocessableEntity)))
			return
		}
		in.BodyHTML = rendered
	}
	if strings.TrimSpace(in.BodyHTML) == "" && strings.TrimSpace(in.PlainText) != "" {
		in.BodyHTML = plainTextBodyHTML(in.PlainText)
	}
	if strings.TrimSpace(in.BodyHTML) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("mjml_not_rendered", "body_html is required for test sends"))
		return
	}
	if d.Safety != nil {
		verdict, err := d.Safety.Check(r.Context(), safety.DraftToCheck{
			Subject:                in.Subject,
			BodyHTML:               in.BodyHTML,
			HasListUnsubscribePost: true,
		})
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if verdict != nil && verdict.Verdict == safety.VerdictFail {
			writeJSON(w, http.StatusUnprocessableEntity, verdict)
			return
		}
	}
	if d.Sender == nil {
		writeJSON(w, http.StatusBadGateway, errEnv("sender_unavailable", "transactional sender not configured"))
		return
	}
	allowanceKey := "campaign-test:" + uuid.NewString()
	if requestKey := strings.TrimSpace(r.Header.Get("Idempotency-Key")); requestKey != "" {
		allowanceKey = "campaign-test:" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(t.ID+"\x00"+requestKey)).String()
	}
	if d.Allowance == nil && d.RequireAllowance {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("managed_send_allowance_unavailable", "managed send allowance is unavailable"))
		return
	}
	var allowanceReservation sendallowance.Reservation
	if d.Allowance != nil {
		var err error
		allowanceReservation, err = d.Allowance.Reserve(r.Context(), sendallowance.Request{
			TenantID: t.ID, Key: allowanceKey, Source: "campaign_test",
			SourceRef: in.CampaignID, RecipientIDs: []string{in.ToEmail},
		})
		if err != nil {
			if errors.Is(err, sendallowance.ErrExhausted) {
				var exhausted *sendallowance.ExhaustedError
				if errors.As(err, &exhausted) {
					limit, current := int64(exhausted.Limit), int64(exhausted.Current)
					entitlement.Write(w, entitlement.Denial{
						Subject: "campaign.test_send", Reason: entitlement.ReasonPlan,
						Code:     "managed_send_allowance_exhausted",
						Message:  "The workspace has reached its monthly accepted-recipient allowance.",
						Resource: string(limits.ResourceMonthlySends), Limit: &limit, Current: &current,
					})
					return
				}
			}
			writeJSON(w, http.StatusServiceUnavailable, errEnv("managed_send_allowance_unavailable", "managed send allowance is unavailable"))
			return
		}
		if err := d.Allowance.Commit(r.Context(), allowanceReservation); err != nil {
			_ = d.Allowance.Release(context.WithoutCancel(r.Context()), allowanceReservation, "commit_failed")
			writeJSON(w, http.StatusServiceUnavailable, errEnv("managed_send_allowance_unavailable", "managed send allowance is unavailable"))
			return
		}
	}
	// Match the 10s bound the batch sendloop uses (D13 in
	// PRODUCTION_READINESS.md). Without this, the test-send path
	// would hang for the bare listmonk.Client's 15s default any
	// time Listmonk's /api/tx stalls, so an operator probing
	// "does my mailer work?" sees a 15s timeout instead of a 10s
	// SLO violation.
	sendCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := d.Sender.SendTransactional(sendCtx, listmonk.SendTransactionalReq{
		SubscriberEmail: in.ToEmail,
		Subject:         in.Subject,
		Body:            in.BodyHTML,
		ContentType:     "html",
		IdempotencyKey:  allowanceKey,
	}); err != nil {
		if d.Allowance != nil && listmonk.DefinitelyRejected(err) {
			_ = d.Allowance.Release(context.WithoutCancel(r.Context()), allowanceReservation, "provider_definitely_rejected")
		}
		// Translate upstream-Listmonk failure modes into clean, stable
		// error codes the SDK can branch on. Without this, the bare
		// `err.Error()` leaks implementation strings like
		// "listmonk: POST /api/tx: 400 Subscriber not found" — useful
		// for debugging, useless for a public API contract.
		code := "send_failed"
		msg := "transactional send failed"
		raw := err.Error()
		switch {
		case strings.Contains(raw, "Subscriber") && strings.Contains(raw, "not found"):
			code = "recipient_unknown"
			msg = "the recipient address is not registered as a subscriber yet; add them first"
		case strings.Contains(raw, "template") && strings.Contains(raw, "not found"):
			code = "template_misconfigured"
			msg = "the default transactional template id is invalid; check POSTWAVE_LISTMONK_DEFAULT_TEMPLATE_ID"
		case strings.Contains(raw, "Authentication Credentials Invalid"):
			code = "smtp_auth_failed"
			msg = "upstream SMTP rejected the credentials; rotate Listmonk's SMTP password"
		}
		writeJSON(w, http.StatusBadGateway, errEnv(code, msg))
		return
	}
	// A successful test message is not a completed campaign send. Keep the
	// realtime signal truthful so notification and outbound-webhook consumers
	// never mistake a one-recipient probe for production completion.
	d.emit(t.ID, "campaign.test_sent", map[string]any{
		"id":      in.CampaignID,
		"to":      in.ToEmail,
		"subject": in.Subject,
		"kind":    "test",
	})
	writeJSON(w, http.StatusAccepted, TestSendResponse{
		MessageID:  "listmonk_tx_accepted",
		To:         in.ToEmail,
		AcceptedAt: time.Now().UTC(),
	})
}

func normalizeCreate(in *CreateInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Subject = strings.TrimSpace(in.Subject)
	in.SegmentID = strings.TrimSpace(in.SegmentID)
	in.ListID = strings.TrimSpace(in.ListID)
	if in.ListID != "" && in.SegmentID != "" {
		return ErrAudienceMixedSources
	}
	in.CampaignType = normalizeCampaignType(in.CampaignType)
	if !validCampaignType(in.CampaignType) {
		return errors.New("invalid campaign_type")
	}
	in.EditorMode = normalizeEditorMode(in.EditorMode)
	if !validEditorMode(in.EditorMode) {
		return errors.New("invalid editor_mode")
	}
	in.PreviewText = strings.TrimSpace(in.PreviewText)
	in.FromName = strings.TrimSpace(in.FromName)
	in.ReplyTo = strings.TrimSpace(strings.ToLower(in.ReplyTo))
	if in.ReplyTo != "" {
		email, err := normalizeEmail(in.ReplyTo)
		if err != nil {
			return errors.New("reply_to must be valid")
		}
		in.ReplyTo = email
	}
	in.ReusableSectionIDs = normalizeIDs(in.ReusableSectionIDs)
	in.TrackingSettings = nonNilMap(in.TrackingSettings)
	in.DeliverySettings = nonNilMap(in.DeliverySettings)
	if in.Name == "" {
		return errors.New("name is required")
	}
	if in.Subject == "" {
		return errors.New("subject is required")
	}
	return nil
}

func normalizeUpdate(in *UpdateInput) error {
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" {
			return errors.New("name cannot be empty")
		}
		in.Name = &name
	}
	if in.Subject != nil {
		subject := strings.TrimSpace(*in.Subject)
		if subject == "" {
			return errors.New("subject cannot be empty")
		}
		in.Subject = &subject
	}
	if in.Status != nil {
		status := strings.TrimSpace(*in.Status)
		if !validStatus(status) {
			return errors.New("invalid status")
		}
		in.Status = &status
	}
	if in.CampaignType != nil {
		campaignType := normalizeCampaignType(*in.CampaignType)
		if !validCampaignType(campaignType) {
			return errors.New("invalid campaign_type")
		}
		in.CampaignType = &campaignType
	}
	if in.EditorMode != nil {
		editorMode := normalizeEditorMode(*in.EditorMode)
		if !validEditorMode(editorMode) {
			return errors.New("invalid editor_mode")
		}
		in.EditorMode = &editorMode
	}
	if in.PreviewText != nil {
		preview := strings.TrimSpace(*in.PreviewText)
		in.PreviewText = &preview
	}
	if in.FromName != nil {
		from := strings.TrimSpace(*in.FromName)
		in.FromName = &from
	}
	if in.ReplyTo != nil {
		replyTo := strings.TrimSpace(strings.ToLower(*in.ReplyTo))
		if replyTo != "" {
			email, err := normalizeEmail(replyTo)
			if err != nil {
				return errors.New("reply_to must be valid")
			}
			replyTo = email
		}
		in.ReplyTo = &replyTo
	}
	if in.SegmentID != nil {
		segmentID := strings.TrimSpace(*in.SegmentID)
		in.SegmentID = &segmentID
	}
	if in.ListID != nil {
		listID := strings.TrimSpace(*in.ListID)
		in.ListID = &listID
	}
	if in.ReusableSectionIDs != nil {
		in.ReusableSectionIDs = normalizeIDs(in.ReusableSectionIDs)
	}
	return nil
}

func validStatus(status string) bool {
	switch status {
	case StatusDraft, StatusScheduled, StatusSending, StatusSent, StatusPaused,
		StatusCancelled, StatusFailed:
		return true
	default:
		return false
	}
}

func normalizeCampaignType(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "regular"
	}
	return value
}

func validCampaignType(value string) bool {
	switch value {
	case "regular", "plain_text", "ab_test", "rss", "automated", "transactional":
		return true
	default:
		return false
	}
}

func normalizeEditorMode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "blocks"
	}
	return value
}

func validEditorMode(value string) bool {
	switch value {
	case "blocks", "html", "plain_text", "mjml":
		return true
	default:
		return false
	}
}

func plainTextBodyHTML(text string) string {
	escaped := html.EscapeString(strings.TrimSpace(text))
	escaped = strings.ReplaceAll(escaped, "\r\n", "\n")
	escaped = strings.ReplaceAll(escaped, "\r", "\n")
	return "<div>" + strings.ReplaceAll(escaped, "\n", "<br>\n") + "</div>"
}

func normalizeEmail(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("to_email is required")
	}
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return "", errors.New("to_email must be valid")
	}
	return strings.ToLower(addr.Address), nil
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

// writeCampaignSemanticError maps author-correctable semantic source failures
// at the repository boundary. Keeping this mapping beside the campaign handlers
// ensures both POST and PATCH expose the same stable contract while the
// repository remains authoritative for every non-HTTP caller.
//
// It intentionally does not return err.Error() for the generic sentinel. That
// sentinel is also used by immutable-artifact plumbing and may wrap storage or
// implementation detail. Typed Fact Contract errors carry the bounded,
// operator-safe detail that an editor needs to annotate the affected fields.
func writeCampaignSemanticError(w http.ResponseWriter, err error) bool {
	var semanticTree *campaignartifact.SemanticTreeValidationError
	if errors.As(err, &semanticTree) && semanticTree != nil {
		diagnostics := append([]semanticemail.Diagnostic(nil), semanticTree.Diagnostics...)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": map[string]any{
				"code":    "semantic_content_invalid",
				"message": "Semantic email content validation failed",
				"details": map[string]any{
					"diagnostics": diagnostics,
				},
			},
		})
		return true
	}

	var validation *campaignartifact.FactContractValidationError
	if errors.As(err, &validation) && validation != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": map[string]any{
				"code":    "fact_contract_invalid",
				"message": "Fact Contract validation failed",
				"details": map[string]any{
					"validation_errors": validation.Errors,
				},
			},
		})
		return true
	}

	var references *campaignartifact.FactContractReferenceError
	if errors.As(err, &references) && references != nil {
		// Copy so response encoding cannot race with or expose mutation of the
		// source error slice held by another caller.
		missing := append([]string(nil), references.MissingBlockIDs...)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": map[string]any{
				"code":    "fact_contract_references_invalid",
				"message": "Fact Contract references semantic blocks that do not exist",
				"details": map[string]any{
					"missing_block_ids": missing,
				},
			},
		})
		return true
	}

	if errors.Is(err, campaignartifact.ErrInvalidInput) {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"campaign_semantics_invalid",
			"source_mode, content_schema_version, semantic content, or fact_contract is invalid",
		))
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
