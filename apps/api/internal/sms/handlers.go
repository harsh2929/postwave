package sms

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"html"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

type Deps struct {
	Store           *Store
	Provider        Provider
	TwilioAuthToken string
	PublicBaseURL   string
	// InboxCursorKey encrypts and authenticates short-lived inbox keyset
	// cursors. Previous accepts the immediately prior key during a rotation;
	// all newly minted cursors use InboxCursorKey.
	InboxCursorKey         []byte
	InboxCursorPreviousKey []byte
	// InboxAuditFingerprintKey is the dedicated PII-fingerprint master used
	// to create tenant/domain-separated conversation subject identifiers in
	// fail-closed read audit rows. It is never used for auth or cursor crypto.
	InboxAuditFingerprintKey []byte
	// ReplyBudget is the durable credit/cost reservation boundary. Nil keeps
	// live inbox dispatch release-held; recipient caps and rate limits are not
	// a financial reservation.
	ReplyBudget ReplyBudgetReserver
	// BroadcastBudget is the durable worst-case segment/recipient credit
	// reservation boundary. Nil structurally holds scheduling/enqueueing.
	BroadcastBudget BroadcastBudgetReserver
	// Logger, when non-nil, is used by httperror.WriteInternal for bounded
	// internal diagnostics. Provider adapters and send boundaries must classify
	// upstream failures before they reach this logger; raw provider response
	// text can contain phone/body/account/credential data and is never log-safe.
	// Nil-safe at the call site; tests can leave it nil.
	Logger *slog.Logger
	// Mirror is retained only as a wiring-compatibility seam. Route40 does not
	// invoke it: copying raw SMS phone/body data into service_suite would bypass
	// the exact-admin/private SMS read boundary and has no atomic lifecycle,
	// retention, or subject-access contract. A future implementation must use a
	// durable minimized outbox and equivalent authorization before this hook can
	// be re-enabled.
	Mirror func(ctx context.Context, tenantID, fromPhone, body, providerMessageID string)
	// Notify, when set, announces a newly received inbound message to the
	// tenant's operators through the unified notification fanout
	// (COMMERCE#2). nil = no announcement. Fired off the request path;
	// best-effort. See inbound_notify.go for what is deliberately silent.
	Notify InboundNotifier
}

// operatorConsentRevocationInput is intentionally narrower than ConsentInput.
// The authenticated operator endpoint may record a conservative revocation;
// it cannot manufacture carrier provenance or positive consent.
type operatorConsentRevocationInput struct {
	ListID    string `json:"list_id"`
	PhoneE164 string `json:"phone_e164"`
	Action    string `json:"action"`
	Source    string `json:"source"`
	ProofText string `json:"proof_text"`
}

const (
	smsJSONMaxBodyBytes    int64 = 256 << 10 // 256 KiB
	smsWebhookMaxBodyBytes int64 = 128 << 10 // 128 KiB
	// Source-level release gate: no legacy send path may cross a provider until
	// durable budget reservation and provider-outcome reconciliation share one
	// proven intent/outbox lifecycle.
	smsLegacyDispatchReleaseReady = false
	// Reply and broadcast dispatch have the same unresolved provider-effect and
	// budget-settlement boundary. Existing reply intents remain recoverable, but
	// no new provider effect is permitted while this gate is false.
	smsDispatchSagaReleaseReady = false
	// Carrier/compliance auto-responses need their own durable, budgeted
	// evidence path; returning a TwiML <Message> is itself a provider effect.
	smsComplianceAutoReplyReleaseReady = false
	// A2P Brand/Campaign submissions create billable carrier-side resources.
	// They remain held until the provider request, local intent and bounded
	// receipt are one idempotent/reconcilable lifecycle. Polling is held with
	// submission because the current provider response contains an unbounded
	// raw payload which must never be persisted or returned as sender metadata.
	smsA2PRegistrationReleaseReady = false
	// Balance and top-up projections have no authoritative purchased-credit or
	// payment ledger yet. Keep billing claims unavailable independently of the
	// send-effect holds above.
	smsFinancialLedgerReleaseReady = false
	// The product currently supports outbound media URL plumbing only. It has
	// no bounded inbound MMS evidence model and no provider-authenticated smoke
	// ledger, so metadata flags cannot certify end-to-end MMS readiness.
	smsMMSReadinessReleaseReady = false
	// The legacy Twilio-only support mirror duplicated raw phone/body data into
	// a weaker read:reports plane in an unbounded best-effort goroutine. Keep it
	// source-held until a durable minimized outbox, exact SMS content authority,
	// retention, erasure and SAR coverage are deployed.
	smsSupportMirrorReleaseReady = false
	// Provider adapters/verifiers are process-global while sender profiles are
	// tenant-scoped. Canonical hosted deployment intentionally has no provider
	// secrets; accepting callbacks before a tenant-bound account/credential
	// resolver exists would make callback ownership unverifiable at the actual
	// multi-tenant authority boundary.
	smsProviderCallbackReleaseReady = false
	// Existing bearer click URLs remain mounted but inert until a dedicated
	// least-privilege resolver, token expiry/retention and edge-log governance
	// are deployed. A caller-settable RLS bypass must never be restored.
	smsClickResolverReleaseReady = false
)

// LegacySMSPIIEvidenceReadHeld is a structural release hold for older roster
// and campaign/consent evidence projections that silently cap pages, expose
// raw phone/email/provider fields, and cannot yet fail closed on audit/export
// completion. Keeping the old implementation callable behind a weaker scope
// would undermine the exact-admin private Inbox boundary.
func (d *Deps) LegacySMSPIIEvidenceReadHeld(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_evidence_read_release_held", "this SMS evidence projection is unavailable until its bounded private audit contract is deployed"))
}

func (d *Deps) MountRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/setup", d.Setup)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/compliance", d.Compliance)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/pilot-readiness", d.PilotReadiness)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/mms-readiness", d.MMSReadiness)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Post("/api/v1/sms/credits/preview", d.SMSCreditPreview)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/credits/balance", d.SMSCreditBalance)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/credits/usage", d.SMSCreditUsage)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Post("/api/v1/sms/credits/top-ups/quote", d.SMSCreditTopUpQuote)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/credits/top-ups/checkout", d.SMSCreditTopUpCheckout)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/regions", d.SMSProgramRegions)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/sms/templates", d.SMSTemplates)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/sms/discount-codes", d.SMSDiscountCodes)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/sms/lists", d.ListLists)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/sms/lists", d.CreateList)
	// SMS-004: edit/delete a list + view its member roster.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch("/api/v1/sms/lists/{id}", d.UpdateList)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/sms/lists/{id}", d.DeleteList)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Get("/api/v1/sms/lists/{id}/members", d.LegacySMSPIIEvidenceReadHeld)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/senders", d.ListSenders)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/senders", d.UpsertSender)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/senders/{id}/pause", d.PauseSender)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/senders/{id}/resume", d.ResumeSender)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/senders/{id}/pilot-certification", d.SenderPilotCertification)
	// Batch endpoint: returns pilot certifications for every sender in
	// one call. The dashboard SMS page previously fired N parallel
	// calls to /{id}/pilot-certification — fine at 1-2 senders, real
	// load at 10+. Audit perf finding FE-2.
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/senders/pilot-certifications", d.AllSenderPilotCertifications)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/senders/{id}/a2p/brand/submit", d.SubmitBrandRegistration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/senders/{id}/a2p/campaign/submit", d.SubmitCampaignRegistration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sms/senders/{id}/a2p/poll", d.PollA2PRegistration)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Post("/api/v1/sms/consent", d.RecordConsent)
	// SMS-006: read the consent roster/log + CSV export.
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Get("/api/v1/sms/consent", d.LegacySMSPIIEvidenceReadHeld)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Get("/api/v1/sms/consent/export", d.LegacySMSPIIEvidenceReadHeld)
	// Quiet hours (GAP-LS-145) + keyword auto-responses (GAP-LS-146/147).
	// These policy definitions expose private business schedules and custom
	// response content and change future compliance/provider effects. Keep
	// reads and writes on one exact effective tenant-admin boundary.
	policyAdmin := []func(http.Handler) http.Handler{protectSMSInboxResponse, apikeys.RequireExactTenantAdmin}
	r.With(policyAdmin...).Get("/api/v1/sms/quiet-hours", d.ListQuietHours)
	r.With(policyAdmin...).Post("/api/v1/sms/quiet-hours", d.CreateQuietHours)
	r.With(policyAdmin...).Patch("/api/v1/sms/quiet-hours/{id}", d.UpdateQuietHours)
	r.With(policyAdmin...).Delete("/api/v1/sms/quiet-hours/{id}", d.DeleteQuietHours)
	r.With(policyAdmin...).Get("/api/v1/sms/keyword-responses", d.ListKeywordResponses)
	r.With(policyAdmin...).Post("/api/v1/sms/keyword-responses", d.CreateKeywordResponse)
	r.With(policyAdmin...).Patch("/api/v1/sms/keyword-responses/{id}", d.UpdateKeywordResponse)
	r.With(policyAdmin...).Delete("/api/v1/sms/keyword-responses/{id}", d.DeleteKeywordResponse)
	// SMS suppressions (manual + system block-list). The desktop
	// smsSuppressionsApi shipped against these routes; the handlers landed
	// in suppressions.go.
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Get("/api/v1/sms/suppressions", d.ListSuppressions)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Post("/api/v1/sms/suppressions/query", d.QuerySuppressions)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Post("/api/v1/sms/suppressions", d.AddSuppression)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Delete("/api/v1/sms/suppressions/{id}", d.RemoveSuppression)
	// Broadcast definitions expose audience/message state. Keep the entire
	// family on the same exact effective owner/admin boundary as Inbox.
	broadcastAdmin := []func(http.Handler) http.Handler{protectSMSInboxResponse, apikeys.RequireExactTenantAdmin}
	r.With(broadcastAdmin...).Get("/api/v1/sms/broadcasts", d.ListBroadcasts)
	r.With(broadcastAdmin...).Post("/api/v1/sms/broadcasts", d.CreateBroadcast)
	r.With(broadcastAdmin...).Get("/api/v1/sms/broadcasts/{id}", d.GetBroadcast)
	r.With(broadcastAdmin...).Patch("/api/v1/sms/broadcasts/{id}", d.UpdateBroadcast)
	r.With(broadcastAdmin...).Delete("/api/v1/sms/broadcasts/{id}", d.DeleteBroadcast)
	r.With(broadcastAdmin...).Post("/api/v1/sms/broadcasts/{id}/cancel", d.CancelBroadcast)
	r.With(broadcastAdmin...).Get("/api/v1/sms/broadcasts/{id}/progress", d.BroadcastProgress)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/sms/campaigns", d.ListCampaigns)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns", d.CreateCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/sms/campaigns/{id}", d.GetCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch("/api/v1/sms/campaigns/{id}", d.UpdateCampaign)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Get("/api/v1/sms/campaigns/{id}/report", d.LegacySMSPIIEvidenceReadHeld)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sms/campaigns/{id}/variants", d.CampaignVariants)
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Get("/api/v1/sms/campaigns/{id}/report/export", d.LegacySMSPIIEvidenceReadHeld)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns/{id}/schedule", d.ScheduleCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns/{id}/pause", d.PauseCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns/{id}/resume", d.ResumeCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns/{id}/cancel", d.CancelCampaign)
}

// MountIdempotentRoutes wires the SMS routes that MUST be idempotent
// (send + test-send). Mounted from main.go inside the idempotency
// middleware group so an `Idempotency-Key` header replays the original
// response instead of double-sending outbound SMS — which would charge
// the operator twice per recipient.
//
// `extraMW` is the optional middleware chain main.go passes through —
// used to layer the per-tenant rate limit on test-send (audit finding
// H8: the budgets middleware bypasses cookie-session callers, so a
// dashboard user could spam unlimited real-SMS test sends).
//
// Kept separate from MountRoutes so the protected routes only run
// under the idempotency wrapper; everything else (CRUD, status flips,
// schedule, registration) stays on the normal mount path.
func (d *Deps) MountIdempotentRoutes(r chi.Router, extraMW ...func(http.Handler) http.Handler) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns/{id}/send", d.SendCampaign)
	// SMS-034: re-queue failed/undelivered recipients — idempotency-wrapped
	// since it re-triggers outbound.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/sms/campaigns/{id}/retry-failed", d.RetryFailedRecipients)
	// Broadcast send is doubly protected: the Idempotency-Key replay
	// from this mount group, plus the status-claim inside sendBroadcast
	// (draft|scheduled → sending flips exactly once) so even a keyless
	// double-POST cannot double-enqueue recipients.
	r.With(protectSMSInboxResponse, apikeys.RequireExactTenantAdmin).Post("/api/v1/sms/broadcasts/{id}/send", d.SendBroadcast)
	// Inbox replies cross the provider boundary synchronously. Require a
	// principal-scoped Idempotency-Key, the exact tenant-admin boundary, the
	// expensive-operation limiter, and private response headers.
	replyChain := make([]func(http.Handler) http.Handler, 0, len(extraMW)+2)
	replyChain = append(replyChain, extraMW...)
	replyChain = append(replyChain, protectSMSInboxResponse, apikeys.RequireExactTenantAdmin)
	r.With(replyChain...).Post("/api/v1/sms/conversations/{phone}/reply", d.ReplyConversation)
	// Stack: extra middlewares (e.g. per-tenant rate limit) then scope
	// gate, then the handler. r.With composes left-to-right.
	chain := make([]func(http.Handler) http.Handler, 0, len(extraMW)+1)
	chain = append(chain, extraMW...)
	chain = append(chain, apikeys.RequireScope(apikeys.ScopeWriteCampaigns))
	r.With(chain...).Post("/api/v1/sms/test-send", d.SendTest)
}

// LegacyDispatchReplayBypass prevents a pre-hold cached 2xx from being served
// for a source-held SMS effect. It is wired into the shared idempotency group
// before generic replay lookup/claim. Request bodies are irrelevant because
// all selected handlers are guaranteed to return the current 503 hold.
func LegacyDispatchReplayBypass(r *http.Request, _ []byte) bool {
	if r == nil || r.Method != http.MethodPost {
		return false
	}
	path := strings.Trim(r.URL.EscapedPath(), "/")
	if path == "api/v1/sms/test-send" {
		return !smsLegacyDispatchReleaseReady
	}
	parts := strings.Split(path, "/")
	if len(parts) != 6 || parts[0] != "api" || parts[1] != "v1" || parts[2] != "sms" || parts[4] == "" {
		return false
	}
	if parts[3] == "campaigns" && (parts[5] == "send" || parts[5] == "retry-failed") {
		return !smsLegacyDispatchReleaseReady
	}
	return parts[3] == "broadcasts" && parts[5] == "send" && !smsDispatchSagaReleaseReady
}

func (d *Deps) MountPublicRoutes(r chi.Router) {
	r.With(protectSMSPublicResponse).Handle("/api/public/sms/click/{token}", http.HandlerFunc(d.Click))
	r.With(protectSMSPublicResponse).Post("/api/public/sms/twilio/{tenant_id}", d.TwilioInbound)
	r.With(protectSMSPublicResponse).Post("/api/public/sms/twilio/{tenant_id}/status", d.TwilioStatus)
	r.With(protectSMSPublicResponse).Post("/api/public/sms/telnyx/{tenant_id}", d.TelnyxWebhook)
	r.With(protectSMSPublicResponse).Post("/api/public/sms/telnyx/{tenant_id}/status", d.TelnyxWebhook)
	r.With(protectSMSPublicResponse).Post("/api/public/sms/bandwidth/{tenant_id}", d.BandwidthWebhook)
	r.With(protectSMSPublicResponse).Post("/api/public/sms/bandwidth/{tenant_id}/status", d.BandwidthWebhook)
}

func protectSMSPublicResponse(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Del("ETag")
		next.ServeHTTP(w, r)
	})
}

func (d *Deps) Setup(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().Setup(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if out.CanSend && !d.anyApprovedSenderProviderConfigured(out.Senders) {
		out.CanSend = false
		out.BlockingReasons = append(out.BlockingReasons, "provider_credentials_not_configured")
	}
	if !smsLegacyDispatchReleaseReady || !smsDispatchSagaReleaseReady {
		out.CanSend = false
		out.BlockingReasons = append(out.BlockingReasons, "sms_dispatch_release_held")
	}
	if !smsComplianceAutoReplyReleaseReady {
		out.CanSend = false
		out.BlockingReasons = append(out.BlockingReasons, "sms_auto_reply_dispatch_release_held")
	}
	if !smsA2PRegistrationReleaseReady {
		out.CanSend = false
		out.BlockingReasons = append(out.BlockingReasons, "sms_a2p_registration_release_held")
	}
	if !smsProviderCallbackReleaseReady {
		out.CanSend = false
		out.BlockingReasons = append(out.BlockingReasons, "sms_provider_callback_release_held")
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Compliance(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().Compliance(r.Context(), tenant.ID, d.publicBaseURL(), d.webhookVerificationConfigured())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !smsLegacyDispatchReleaseReady || !smsDispatchSagaReleaseReady {
		out.CanSend = false
		out.Items = append(out.Items, ComplianceItem{
			Key: "dispatch_release", Label: "Durable SMS dispatch lifecycle", Complete: false,
			Detail: "Live sends remain held until budget settlement and provider reconciliation are deployed.",
		})
	}
	if !smsComplianceAutoReplyReleaseReady {
		out.CanSend = false
		out.Items = append(out.Items, ComplianceItem{
			Key: "auto_reply_dispatch_release", Label: "Durable HELP and custom auto-replies", Complete: false,
			Detail: "HELP and tenant keyword reply effects remain held until they have durable budget and provider evidence.",
		})
	}
	if !smsA2PRegistrationReleaseReady {
		out.CanSend = false
		out.Items = append(out.Items, ComplianceItem{
			Key: "a2p_registration_release", Label: "Durable A2P registration lifecycle", Complete: false,
			Detail: "A2P carrier registration remains held until idempotent provider reconciliation and a minimized receipt are deployed.",
		})
	}
	if !smsProviderCallbackReleaseReady {
		out.CanSend = false
		out.Items = append(out.Items, ComplianceItem{
			Key: "provider_callback_release", Label: "Tenant-bound provider callbacks", Complete: false,
			Detail: "Hosted callbacks remain held until provider credentials and account ownership resolve per tenant.",
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PilotReadiness(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().PilotReadiness(r.Context(), tenant.ID, d.publicBaseURL(), d.webhookVerificationConfigured())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListLists(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().ListLists(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateList(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SMSListInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out, err := d.store().CreateList(r.Context(), tenant.ID, in)
	if err != nil {
		if errors.Is(err, ErrInvalidSMSListInput) {
			httperror.WriteValidation(w, "invalid_sms_list", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// UpdateList PATCH /api/v1/sms/lists/{id} — edit a list's metadata (SMS-004).
func (d *Deps) UpdateList(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SMSListInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out, err := d.store().UpdateList(r.Context(), tenant.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if errors.Is(err, ErrInvalidSMSListInput) {
			httperror.WriteValidation(w, "invalid_sms_list", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteList DELETE /api/v1/sms/lists/{id} (SMS-004).
func (d *Deps) DeleteList(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	found, err := d.store().DeleteList(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrInvalidSMSListInput) {
			httperror.WriteValidation(w, "invalid_sms_list", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "list not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ListMembers GET /api/v1/sms/lists/{id}/members — the list's roster (SMS-004).
func (d *Deps) ListMembers(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().ListMembers(r.Context(), tenant.ID, chi.URLParam(r, "id"), 500)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": len(out)})
}

func (d *Deps) ListSenders(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().ListSenders(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenantId": tenant.ID, "items": out})
}

func (d *Deps) UpsertSender(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SenderInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	registrationStatus := strings.ToLower(strings.TrimSpace(in.RegistrationStatus))
	if strings.TrimSpace(in.BrandRegistrationSID) != "" ||
		strings.TrimSpace(in.CampaignRegistrationSID) != "" ||
		!oneOf(registrationStatus, "", RegistrationNotStarted, RegistrationDraft) {
		writeJSON(w, http.StatusConflict, errEnv("sms_registration_evidence_authority_required", "carrier registration identifiers and authoritative status require a durable provider-bound registration receipt"))
		return
	}
	if err := validateSenderInput(&in); err != nil {
		httperror.WriteValidation(w, "invalid_sms_sender", err.Error())
		return
	}
	out, err := d.store().UpsertSender(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) PauseSender(w http.ResponseWriter, r *http.Request) {
	d.setSenderPaused(w, r, true)
}

func (d *Deps) ResumeSender(w http.ResponseWriter, r *http.Request) {
	d.setSenderPaused(w, r, false)
}

func (d *Deps) setSenderPaused(w http.ResponseWriter, r *http.Request, paused bool) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SenderPauseInput
	if err := decodeOptionalSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out, err := d.store().SetSenderPaused(r.Context(), tenant.ID, chi.URLParam(r, "id"), paused, in.Reason)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SenderPilotCertification(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().SenderPilotCertification(
		r.Context(),
		tenant.ID,
		chi.URLParam(r, "id"),
		d.publicBaseURL(),
		d.webhookVerificationConfigured(),
		d.smsProviderConfiguredForSender(r.Context(), tenant.ID, chi.URLParam(r, "id")),
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AllSenderPilotCertifications returns the pilot-certification view
// for every sender belonging to the tenant in one call. Closes the
// dashboard SMS-page N+1 (audit perf FE-2). The per-sender route
// stays mounted for callers that want a single sender's cert
// (e.g., the sender-detail page).
func (d *Deps) AllSenderPilotCertifications(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	senders, err := d.store().ListSenders(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	base := d.publicBaseURL()
	webhookVerification := d.webhookVerificationConfigured()
	items := make([]SenderPilotCertification, 0, len(senders))
	for _, sender := range senders {
		out, err := d.store().SenderPilotCertification(
			r.Context(), tenant.ID, sender.ID, base, webhookVerification,
			d.providerConfiguredForSender(sender),
		)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		items = append(items, out)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) SubmitBrandRegistration(w http.ResponseWriter, r *http.Request) {
	if !smsA2PRegistrationReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_a2p_registration_release_held", "A2P carrier registration is unavailable until durable idempotency, reconciliation, and minimized provider receipts are deployed"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	sender, err := d.store().GetSender(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var in A2PBrandRegistrationInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	brand, providerName, err := d.submitProviderBrandRegistration(r.Context(), sender, in)
	if err != nil {
		d.writeProviderAutomationErr(w, r, providerName, "brand_registration", err)
		return
	}
	status := providerSenderRegistrationStatus(sender.Provider, brand, SmsRegistrationResource{})
	updated, err := d.store().UpdateSenderRegistration(r.Context(), tenant.ID, sender.ID, SenderRegistrationPatch{
		BrandRegistrationSID: brand.SID,
		RegistrationStatus:   status,
		Metadata: map[string]any{
			providerName + "_brand_registration": brand.Raw,
			providerName + "_registration_at":    time.Now().UTC().Format(time.RFC3339),
		},
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, A2PRegistrationResult{Sender: updated, Brand: brand})
}

func (d *Deps) SubmitCampaignRegistration(w http.ResponseWriter, r *http.Request) {
	if !smsA2PRegistrationReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_a2p_registration_release_held", "A2P carrier registration is unavailable until durable idempotency, reconciliation, and minimized provider receipts are deployed"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	sender, err := d.store().GetSender(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var in A2PCampaignRegistrationInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	in.BrandRegistrationSID = defaulted(in.BrandRegistrationSID, sender.BrandRegistrationSID)
	if strings.TrimSpace(in.BrandRegistrationSID) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("brand_registration_required", "submit or record the A2P Brand registration first"))
		return
	}
	campaign, providerName, err := d.submitProviderCampaignRegistration(r.Context(), sender, in)
	if err != nil {
		d.writeProviderAutomationErr(w, r, providerName, "campaign_registration", err)
		return
	}
	updated, err := d.store().UpdateSenderRegistration(r.Context(), tenant.ID, sender.ID, SenderRegistrationPatch{
		CampaignRegistrationSID: campaign.SID,
		RegistrationStatus:      providerSenderRegistrationStatus(sender.Provider, SmsRegistrationResource{SID: sender.BrandRegistrationSID, Status: RegistrationPending}, campaign),
		Metadata: map[string]any{
			providerName + "_campaign_registration": campaign.Raw,
			providerName + "_registration_at":       time.Now().UTC().Format(time.RFC3339),
		},
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, A2PRegistrationResult{Sender: updated, Campaign: campaign})
}

func (d *Deps) PollA2PRegistration(w http.ResponseWriter, r *http.Request) {
	if !smsA2PRegistrationReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_a2p_registration_release_held", "A2P carrier registration is unavailable until durable idempotency, reconciliation, and minimized provider receipts are deployed"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	sender, err := d.store().GetSender(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var brand SmsRegistrationResource
	var campaign SmsRegistrationResource
	providerName := defaulted(strings.ToLower(sender.Provider), ProviderTwilio)
	metadata := map[string]any{providerName + "_registration_polled_at": time.Now().UTC().Format(time.RFC3339)}
	if sender.BrandRegistrationSID != "" {
		brand, err = d.fetchProviderBrandRegistration(r.Context(), sender)
		if err != nil {
			d.writeProviderAutomationErr(w, r, providerName, "brand_poll", err)
			return
		}
		metadata[providerName+"_brand_registration"] = brand.Raw
	}
	if sender.CampaignRegistrationSID != "" {
		campaign, err = d.fetchProviderCampaignRegistration(r.Context(), sender)
		if err != nil {
			d.writeProviderAutomationErr(w, r, providerName, "campaign_poll", err)
			return
		}
		metadata[providerName+"_campaign_registration"] = campaign.Raw
	}
	updated, err := d.store().UpdateSenderRegistration(r.Context(), tenant.ID, sender.ID, SenderRegistrationPatch{
		RegistrationStatus: providerSenderRegistrationStatus(sender.Provider, brand, campaign),
		Metadata:           metadata,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, A2PRegistrationResult{Sender: updated, Brand: brand, Campaign: campaign})
}

func (d *Deps) RecordConsent(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var request operatorConsentRevocationInput
	if err := decodeSMSJSON(w, r, &request); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	if request.Source != "manual" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_consent_request", "operator SMS revocations require source=manual"))
		return
	}
	phone, err := NormalizePhoneUSCA(request.PhoneE164)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_phone", "phone_e164 must be a valid US/Canada number"))
		return
	}
	action := strings.ToLower(strings.TrimSpace(request.Action))
	if action == ConsentGranted {
		writeJSON(w, http.StatusConflict, errEnv("carrier_resubscribe_authority_required", "manual/API consent cannot clear carrier opt-out; a verified START or UNSTOP event is required"))
		return
	}
	if action != ConsentRevoked {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_consent_action", "the operator endpoint accepts only action=revoked"))
		return
	}
	proof := strings.TrimSpace(request.ProofText)
	if proof == "" || !validInboxText(proof, 500) {
		writeJSON(w, http.StatusBadRequest, errEnv("consent_reason_required", "proof_text must contain a safe operator revocation reason"))
		return
	}
	if request.ListID != "" && !validCanonicalUUIDV4(request.ListID) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_list_id", "list_id must be a canonical lowercase UUIDv4"))
		return
	}
	in := ConsentInput{
		ListID:    request.ListID,
		PhoneE164: phone,
		Action:    ConsentRevoked,
		Source:    "manual",
		ProofText: proof,
		Provider:  ConsentProviderProduct,
		Metadata:  map[string]any{"operator_reason": proof},
	}
	if err := d.store().RecordConsentWithAudit(r.Context(), tenant.ID, in, middleware.AuditMetaFromRequest(r)); err != nil {
		if errors.Is(err, ErrInvalidConsentInput) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_consent", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":        true,
		"tenantId":  tenant.ID,
		"phoneE164": phone,
		"action":    ConsentRevoked,
		"source":    "manual",
		"provider":  ConsentProviderProduct,
	})
}

func (d *Deps) ListCampaigns(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 100 so
	// omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 100, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.store().ListCampaigns(r.Context(), tenant.ID, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over the
	// prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[Campaign]{Items: out, NextCursor: next})
}

func (d *Deps) GetCampaign(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().GetCampaign(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CampaignReport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().CampaignReport(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CampaignVariants returns per-variant send outcomes for an A/B campaign
// (SMS-036).
func (d *Deps) CampaignVariants(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	items, err := d.store().CampaignVariantStats(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) CampaignReportExport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	status := r.URL.Query().Get("status")
	limit := intParam(r, "limit", 10000)
	rows, err := d.store().CampaignReportRows(r.Context(), tenant.ID, campaignID, status, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="sms-campaign-`+campaignID+`-report.csv"`)
	w.WriteHeader(http.StatusOK)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{
		"phone_e164",
		"recipient_status",
		"message_status",
		"attempts",
		"segments",
		"cost_micros",
		"provider_message_id",
		"error_code",
		"error_message",
		"queued_at",
		"updated_at",
		"sent_at",
		"delivered_at",
	})
	for _, row := range rows {
		_ = cw.Write([]string{
			csvCell(row.PhoneE164),
			csvCell(row.RecipientStatus),
			csvCell(row.MessageStatus),
			strconv.Itoa(row.Attempts),
			strconv.Itoa(row.Segments),
			strconv.FormatInt(row.CostMicros, 10),
			csvCell(row.ProviderMessageID),
			csvCell(row.ErrorCode),
			csvCell(row.ErrorMessage),
			row.QueuedAt.Format(time.RFC3339),
			row.UpdatedAt.Format(time.RFC3339),
			formatTimePtr(row.SentAt),
			formatTimePtr(row.DeliveredAt),
		})
	}
	cw.Flush()
}

func csvCell(value string) string {
	visible := strings.TrimLeft(value, " \t\r\n")
	if visible == "" {
		return value
	}
	switch visible[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}

func (d *Deps) CreateCampaign(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CampaignInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	if strings.EqualFold(strings.TrimSpace(in.Status), "scheduled") {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_campaign_schedule_release_held", "creating a scheduled SMS campaign is unavailable while durable dispatch is release-held"))
		return
	}
	out, err := d.store().CreateCampaign(r.Context(), tenant.ID, in)
	if err != nil {
		if errors.Is(err, ErrInvalidCampaignInput) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// UpdateCampaign PATCH /api/v1/sms/campaigns/{id} — edit a draft/scheduled/
// paused campaign in place so it can be reopened in the composer (SMS-008).
func (d *Deps) UpdateCampaign(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CampaignInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	if strings.EqualFold(strings.TrimSpace(in.Status), "scheduled") {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_campaign_schedule_release_held", "updating a campaign into scheduled state is unavailable while durable dispatch is release-held"))
		return
	}
	out, err := d.store().UpdateCampaign(r.Context(), tenant.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if errors.Is(err, ErrInvalidCampaignInput) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SendCampaign(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if !smsLegacyDispatchReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_campaign_dispatch_release_held", "SMS campaign dispatch is unavailable until durable budget and provider reconciliation are configured"))
		return
	}
	var in BroadcastInput
	if err := decodeOptionalSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	provider := d.Provider
	if provider == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_unconfigured", "configure an SMS provider before sending"))
		return
	}
	out, err := d.sendCampaign(r.Context(), tenant.ID, chi.URLParam(r, "id"), in, provider)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

// RetryFailedRecipients POST /api/v1/sms/campaigns/{id}/retry-failed — re-queue
// the campaign's failed/undelivered recipients for another delivery attempt
// (SMS-034). The drain worker picks them up; only non-delivered recipients are
// affected. Idempotency-wrapped since it triggers real outbound.
func (d *Deps) RetryFailedRecipients(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if !smsLegacyDispatchReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_campaign_retry_release_held", "SMS campaign retry dispatch is unavailable until durable budget and provider reconciliation are configured"))
		return
	}
	id := chi.URLParam(r, "id")
	n, err := d.store().RequeueFailedRecipients(r.Context(), tenant.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	report, err := d.store().CampaignReport(r.Context(), tenant.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"requeued": n, "report": report})
}

func (d *Deps) ScheduleCampaign(w http.ResponseWriter, r *http.Request) {
	if !smsLegacyDispatchReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_campaign_schedule_release_held", "SMS campaign scheduling is unavailable while durable dispatch is release-held"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CampaignStatusInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out, err := d.store().UpdateCampaignStatus(r.Context(), tenant.ID, chi.URLParam(r, "id"), "scheduled", in.ScheduledAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PauseCampaign(w http.ResponseWriter, r *http.Request) {
	d.setCampaignStatus(w, r, "paused")
}

func (d *Deps) ResumeCampaign(w http.ResponseWriter, r *http.Request) {
	if !smsLegacyDispatchReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_campaign_resume_release_held", "SMS campaign resume is unavailable while durable dispatch is release-held"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().ResumeCampaign(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CancelCampaign(w http.ResponseWriter, r *http.Request) {
	d.setCampaignStatus(w, r, "cancelled")
}

func (d *Deps) setCampaignStatus(w http.ResponseWriter, r *http.Request, status string) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().UpdateCampaignStatus(r.Context(), tenant.ID, chi.URLParam(r, "id"), status, nil)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SendTest(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if !smsLegacyDispatchReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_test_dispatch_release_held", "SMS test dispatch is unavailable until durable budget and provider reconciliation are configured"))
		return
	}
	var in SendInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	sender, err := d.store().GetSender(r.Context(), tenant.ID, in.SenderProfileID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	phone, decision, err := d.store().Gate(r.Context(), tenant.ID, sender, in.ListID, in.To, in.Body, -1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !decision.Allowed {
		writeJSON(w, http.StatusConflict, map[string]any{"gate": decision})
		return
	}
	provider := d.Provider
	if provider == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_unconfigured", "configure an SMS provider before sending"))
		return
	}
	result, err := safeProviderSend(r.Context(), provider, ProviderOutbound{
		Provider:            sender.Provider,
		To:                  phone,
		Body:                in.Body,
		MediaURL:            in.MediaURL,
		FromNumber:          sender.PhoneNumber,
		MessagingServiceSID: sender.MessagingServiceSID,
		StatusCallbackURL:   d.statusCallbackURL(sender.Provider, tenant.ID, sender.ID),
	})
	if err != nil {
		// Provider send errors echo raw Twilio/Telnyx/Bandwidth HTTP
		// response bodies (account SIDs, error message fragments,
		// rate-limit hints). Log server-side; return a generic 5xx
		// envelope. Phase 4 fix p4d.
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	msg, err := d.store().RecordOutbound(r.Context(), tenant.ID, in, phone, decision, result)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"gate": decision, "message": msg})
}

func (d *Deps) sendCampaign(ctx context.Context, tenantID, campaignID string, in BroadcastInput, provider Provider) (BroadcastResult, error) {
	if !smsLegacyDispatchReleaseReady {
		return BroadcastResult{}, errText("sms campaign dispatch release-held: durable budget/reconciliation unavailable")
	}
	campaign, err := d.store().GetCampaign(ctx, tenantID, campaignID)
	if err != nil {
		return BroadcastResult{}, err
	}
	if !oneOf(campaign.Status, "draft", "scheduled", "paused") {
		return BroadcastResult{}, errText("campaign is not sendable")
	}
	if strings.TrimSpace(campaign.Body) == "" {
		return BroadcastResult{}, errText("campaign body is required")
	}
	if campaign.SenderProfileID == "" {
		return BroadcastResult{}, errText("campaign sender is required")
	}
	if campaign.ListID == "" {
		return BroadcastResult{}, errText("campaign audience is required")
	}
	sender, err := d.store().GetSender(ctx, tenantID, campaign.SenderProfileID)
	if err != nil {
		return BroadcastResult{}, err
	}
	if SenderPaused(sender.Metadata) {
		return BroadcastResult{}, errText("sender is paused by kill switch")
	}
	probe := *d
	if provider != nil {
		probe.Provider = provider
	}
	if !probe.providerConfiguredForSender(sender) {
		return BroadcastResult{}, errText(defaulted(sender.Provider, ProviderTwilio) + " sms provider is not configured")
	}
	recipients, err := d.store().CampaignRecipients(ctx, tenantID, campaign.ListID, in.Limit)
	if err != nil {
		return BroadcastResult{}, err
	}
	if len(recipients) == 0 {
		return BroadcastResult{}, errText("no opted-in recipients found for sms list")
	}
	costPolicy := smsCostPolicyFor(sender, campaign)
	if err := d.store().MarkCampaignSending(ctx, tenantID, campaignID); err != nil {
		return BroadcastResult{}, err
	}

	linkTracking := linkTrackingEnabled(campaign.Metadata, in.LinkTracking)
	// SMS-037: per-recipient send-time optimization. Fixed mode keeps the
	// legacy immediate send (nextAttempt == now); recipient_tz / sto stamp a
	// future next_attempt_at per recipient so the worker releases each at its
	// own local/best time.
	sendMode := parseScheduleMode(campaign.Metadata)
	// SMS-036: A/B variants (metadata-carried). When present, each recipient
	// is bucketed deterministically to one variant body; nil means single-body.
	abVariants := parseABVariants(campaign.Metadata)
	sendNow := time.Now().UTC()
	result := BroadcastResult{Recipients: len(recipients), LinkTracking: linkTracking, CostCapMicros: costPolicy.CapMicros}
	blockCodes := map[string]bool{}
	for _, recipient := range recipients {
		body := campaign.Body
		variantLabel := ""
		phone, err := NormalizePhoneUSCA(recipient.Phone)
		if err != nil {
			result.Failed++
			continue
		}
		if len(abVariants) >= abMinVariants {
			v := pickVariant(abVariants, phone)
			body = v.Body
			variantLabel = v.Label
		}
		if linkTracking && d.publicBaseURL() != "" {
			replacements, err := d.store().CreateLinkTokens(ctx, tenantID, campaign.ID, phone, ExtractLinks(body), d.publicBaseURL())
			if err != nil {
				result.Failed++
				continue
			}
			body = RewriteLinks(body, replacements)
		}
		phone, decision, err := d.store().Gate(ctx, tenantID, sender, campaign.ListID, phone, body, -1)
		if err != nil {
			result.Failed++
			continue
		}
		result.Segments += decision.Segments
		if !decision.Allowed {
			result.Blocked++
			if decision.Reason != "" {
				blockCodes[decision.Reason] = true
			}
			continue
		}
		nextEstimatedCost := result.EstimatedCostMicros + costPolicy.estimate(decision.Segments)
		if costPolicy.CapMicros > 0 && nextEstimatedCost > costPolicy.CapMicros {
			result.Blocked++
			blockCodes["sms_cost_cap_reached"] = true
			continue
		}
		result.EstimatedCostMicros = nextEstimatedCost
		nextAttempt := sendNow
		meta := map[string]any{
			"broadcast":             true,
			"link_tracking":         linkTracking,
			"estimated_cost_micros": costPolicy.estimate(decision.Segments),
		}
		if variantLabel != "" {
			meta["variant"] = variantLabel
		}
		if sendMode.scheduled() {
			nextAttempt = computeSendAt(sendNow, sendMode, recipient.Timezone, recipient.BestSendHour)
			if nextAttempt.After(sendNow) {
				meta["schedule_mode"] = sendMode.Mode
				meta["scheduled_send_at"] = nextAttempt.Format(time.RFC3339)
				result.Scheduled++
			}
		}
		queued, err := d.store().EnqueueRecipient(ctx, tenantID, campaign, phone, body, decision.Segments, linkTracking, meta, nextAttempt)
		if err != nil {
			result.Failed++
			continue
		}
		if queued {
			result.Queued++
		}
	}
	for code := range blockCodes {
		result.BlockingCodes = append(result.BlockingCodes, code)
	}
	observeSMSCampaignRecipients(sender.Provider, "queued", result.Queued)
	observeSMSCampaignRecipients(sender.Provider, "blocked", result.Blocked)
	observeSMSCampaignRecipients(sender.Provider, "failed", result.Failed)
	observeSMSEstimatedCost(sender.Provider, result.EstimatedCostMicros)
	if result.Queued > 0 {
		updated, err := d.store().RefreshCampaignStats(ctx, tenantID, campaignID)
		if err != nil {
			return result, err
		}
		result.Campaign = updated
		return result, nil
	}
	updated, err := d.store().FinishCampaign(ctx, tenantID, campaignID, "failed", map[string]any{
		"recipients":            result.Recipients,
		"queued":                result.Queued,
		"blocked":               result.Blocked,
		"failed":                result.Failed,
		"segments":              result.Segments,
		"cost_micros":           result.CostMicros,
		"estimated_cost_micros": result.EstimatedCostMicros,
		"cost_cap_micros":       result.CostCapMicros,
		"link_tracking":         result.LinkTracking,
		"blocking_codes":        result.BlockingCodes,
	})
	if err != nil {
		return result, err
	}
	result.Campaign = updated
	return result, nil
}

func (d *Deps) TwilioInbound(w http.ResponseWriter, r *http.Request) {
	if !smsProviderCallbackReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_callback_release_held", "hosted SMS provider callbacks require a tenant-bound credential and provider-account ownership resolver"))
		return
	}
	tenantID := chi.URLParam(r, "tenant_id")
	if tenantID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_tenant", "tenant_id path parameter is required"))
		return
	}
	if !parseTwilioForm(w, r) {
		return
	}
	if !d.validTwilioRequest(r) {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "invalid Twilio signature"))
		return
	}
	body := r.FormValue("Body")
	from := r.FormValue("From")
	messageSID := r.FormValue("MessageSid")
	if strings.TrimSpace(messageSID) == "" {
		httperror.WriteValidation(w, "missing_provider_message_id", "Twilio MessageSid is required for replay protection")
		return
	}
	senderID, bindErr := d.store().ResolveProviderWebhookSender(r.Context(), tenantID, ProviderTwilio, r.FormValue("To"), r.FormValue("MessagingServiceSid"))
	if bindErr != nil {
		d.writeProviderBindingError(w, r, tenantID, bindErr)
		return
	}
	providerAction := ""
	switch strings.ToUpper(strings.TrimSpace(r.FormValue("OptOutType"))) {
	case "STOP":
		providerAction = ConsentRevoked
	case "START":
		providerAction = ConsentGranted
	case "HELP":
		providerAction = ConsentHelpRequested
	}
	msg, autoReply, duplicate, err := d.store().recordInboundProviderClassified(r.Context(), tenantID, senderID, ProviderTwilio, from, body, messageSID, twilioInboundEvidence(r), providerAction)
	if err != nil {
		if errors.Is(err, ErrSMSBodyOutsideContract) {
			httperror.WriteValidation(w, "sms_body_outside_contract", "SMS body must be non-empty valid UTF-8 within 16384 bytes and 4800 Unicode code points")
			return
		}
		if errors.Is(err, ErrProviderReplayConflict) {
			httperror.Write(w, http.StatusConflict, "provider_replay_conflict", "Twilio MessageSid was already used for different content")
			return
		}
		// Public webhook — DB error text would otherwise leak through
		// Twilio's debugger console. Log server-side; return generic
		// 5xx. Phase 4 fix p4d.
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	if duplicate {
		// The first delivery already ran the canonical consent/keyword/metric
		// effects. Acknowledge an exact provider retry with empty TwiML.
		writeTwimlReply(w, "")
		return
	}
	observeSMSInbound(ProviderTwilio, ClassifyInbound(body))
	if smsSupportMirrorReleaseReady && d.Mirror != nil {
		// The constant is intentionally false. Keep the call site explicit so a
		// future re-enable cannot happen without changing the release contract
		// and adding durable-outbox tests.
		d.Mirror(r.Context(), tenantID, from, body, messageSID)
	}
	// Announce the reply to the tenant's operators (COMMERCE#2). Only ever
	// reached for a message RecordInbound reported as new, so a provider
	// retry cannot re-ping.
	d.notifyInbound(tenantID, msg, body, autoReply)
	// A matched tenant-authored automatic reply (autoReply.Matched with a
	// non-empty Body) is deliberately NOT sent from here. Such replies are
	// dispatch effects, not webhook acknowledgements. They remain structurally
	// held until they share the live consent/suppression, financial reservation
	// and durable outbound evidence boundary used by operator sends. Never put
	// arbitrary tenant copy into TwiML here. The fixed HELP confirmation below
	// is the only current carrier-response exception.
	writeTwiml(w, ClassifyInbound(body))
}

func (d *Deps) TwilioStatus(w http.ResponseWriter, r *http.Request) {
	if !smsProviderCallbackReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_callback_release_held", "hosted SMS provider callbacks require a tenant-bound credential and provider-account ownership resolver"))
		return
	}
	tenantID := chi.URLParam(r, "tenant_id")
	if tenantID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_tenant", "tenant_id path parameter is required"))
		return
	}
	if !parseTwilioForm(w, r) {
		return
	}
	if !d.validTwilioRequest(r) {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "invalid Twilio signature"))
		return
	}
	senderProfileID, bindErr := d.store().ResolveProviderWebhookSender(r.Context(), tenantID, ProviderTwilio, r.FormValue("From"), r.FormValue("MessagingServiceSid"))
	if bindErr != nil {
		d.writeProviderBindingError(w, r, tenantID, bindErr)
		return
	}
	status := defaulted(r.FormValue("MessageStatus"), r.FormValue("SmsStatus"))
	_, err := d.store().UpdateDeliveryStatus(r.Context(), tenantID, senderProfileID, ProviderTwilio, r.FormValue("MessageSid"), status,
		r.FormValue("ErrorCode"), r.FormValue("ErrorMessage"), nil)
	if err != nil {
		// Public webhook — DB error text would otherwise leak through
		// Twilio's debugger console. Log server-side; return generic
		// 5xx. Phase 4 fix p4d.
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	observeSMSDelivery(ProviderTwilio, status)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) Click(w http.ResponseWriter, r *http.Request) {
	if !smsClickResolverReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_click_resolver_release_held", "tracked SMS links are temporarily unavailable"))
		return
	}
	token := chi.URLParam(r, "token")
	target, err := d.store().RecordClick(r.Context(), token, map[string]any{
		"user_agent": r.UserAgent(),
		"ip":         r.RemoteAddr,
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("click_not_found", "tracked link not found"))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target, http.StatusFound)
}

func (d *Deps) validTwilioRequest(r *http.Request) bool {
	token := strings.TrimSpace(d.TwilioAuthToken)
	if token == "" {
		token = strings.TrimSpace(os.Getenv("TWILIO_WEBHOOK_AUTH_TOKEN"))
	}
	if token == "" {
		return allowUnsignedProviderWebhooks()
	}
	return ValidateTwilioSignature(token, d.webhookURL(r), r.PostForm, r.Header.Get("X-Twilio-Signature"))
}

func parseTwilioForm(w http.ResponseWriter, r *http.Request) bool {
	if r.ContentLength > smsWebhookMaxBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "Twilio webhook payload exceeds 128 KiB"))
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, smsWebhookMaxBodyBytes)
	if err := r.ParseForm(); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "Twilio webhook payload exceeds 128 KiB"))
			return false
		}
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return false
	}
	return true
}

func (d *Deps) webhookURL(r *http.Request) string {
	base := d.publicBaseURL()
	if base != "" {
		return base + r.URL.RequestURI()
	}
	scheme := "https"
	if r.TLS == nil {
		scheme = "http"
	}
	return scheme + "://" + r.Host + r.URL.RequestURI()
}

func (d *Deps) publicBaseURL() string {
	return normalizePublicBaseURL(defaulted(d.PublicBaseURL, envPublicBaseURL()))
}

func (d *Deps) webhookVerificationConfigured() map[string]bool {
	return map[string]bool{
		ProviderTwilio: strings.TrimSpace(defaulted(d.TwilioAuthToken, os.Getenv("TWILIO_WEBHOOK_AUTH_TOKEN"))) != "",
		ProviderTelnyx: strings.TrimSpace(os.Getenv("TELNYX_PUBLIC_KEY")) != "",
		ProviderBandwidth: strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_TOKEN")) != "" ||
			(strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_USERNAME")) != "" &&
				strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_PASSWORD")) != ""),
	}
}

func (d *Deps) statusCallbackURL(provider, tenantID, _ string) string {
	base := d.publicBaseURL()
	if base == "" {
		return ""
	}
	provider = defaulted(strings.ToLower(strings.TrimSpace(provider)), ProviderTwilio)
	if !oneOf(provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		return ""
	}
	return base + "/api/public/sms/" + provider + "/" + tenantID + "/status"
}

func (d *Deps) store() *Store {
	if d.Store == nil {
		return &Store{}
	}
	return d.Store
}

func decodeSMSJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	return httpbody.DecodeJSON(w, r, smsJSONMaxBodyBytes, dst)
}

func decodeOptionalSMSJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	err := httpbody.DecodeJSON(w, r, smsJSONMaxBodyBytes, dst)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func writeSMSDecodeError(w http.ResponseWriter, err error) {
	// httpbody returns operator-safe codes ("bad_json", "payload_too_large")
	// + safe message text from its own validator, so echoing err.Error()
	// through httperror.Write is fine here — codes are in the safe-echo
	// set; status is determined by httpbody.StatusCode.
	httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
}

func (d *Deps) twilioProvider() (*TwilioProvider, error) {
	if provider, ok := d.Provider.(*TwilioProvider); ok && provider != nil && provider.AccountConfigured() {
		if provider.MessagingBaseURL == "" {
			provider.MessagingBaseURL = "https://messaging.twilio.com"
		}
		return provider, nil
	}
	if router, ok := d.Provider.(*ProviderRouter); ok && router != nil {
		if provider := router.Twilio(); provider != nil && provider.AccountConfigured() {
			if provider.MessagingBaseURL == "" {
				provider.MessagingBaseURL = "https://messaging.twilio.com"
			}
			return provider, nil
		}
	}
	provider := NewTwilioProviderFromEnv()
	if !provider.AccountConfigured() {
		return nil, errText("set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN before using A2P registration automation")
	}
	return provider, nil
}

func (d *Deps) telnyxProvider() (*TelnyxProvider, error) {
	if provider, ok := d.Provider.(*TelnyxProvider); ok && provider != nil && provider.Configured() {
		return provider, nil
	}
	if router, ok := d.Provider.(*ProviderRouter); ok && router != nil {
		if provider, _ := router.Providers[ProviderTelnyx].(*TelnyxProvider); provider != nil && provider.Configured() {
			return provider, nil
		}
	}
	provider := NewTelnyxProviderFromEnv()
	if !provider.Configured() {
		return nil, errText("set TELNYX_API_KEY before using Telnyx compliance automation")
	}
	return provider, nil
}

func (d *Deps) bandwidthProvider() (*BandwidthProvider, error) {
	if provider, ok := d.Provider.(*BandwidthProvider); ok && provider != nil && provider.Configured() {
		return provider, nil
	}
	if router, ok := d.Provider.(*ProviderRouter); ok && router != nil {
		if provider, _ := router.Providers[ProviderBandwidth].(*BandwidthProvider); provider != nil && provider.Configured() {
			return provider, nil
		}
	}
	provider := NewBandwidthProviderFromEnv()
	if !provider.Configured() {
		return nil, errText("set BANDWIDTH_ACCOUNT_ID, BANDWIDTH_API_USERNAME, and BANDWIDTH_API_PASSWORD before using Bandwidth compliance automation")
	}
	return provider, nil
}

func (d *Deps) smsProviderConfiguredForSender(ctx context.Context, tenantID, senderID string) bool {
	sender, err := d.store().GetSender(ctx, tenantID, senderID)
	if err != nil {
		return false
	}
	return d.providerConfiguredForSender(sender)
}

func (d *Deps) providerConfiguredForSender(sender SenderProfile) bool {
	switch defaulted(strings.ToLower(sender.Provider), ProviderTwilio) {
	case ProviderTwilio:
		provider, err := d.twilioProvider()
		return err == nil && provider != nil && provider.AccountConfigured()
	case ProviderTelnyx:
		provider, err := d.telnyxProvider()
		return err == nil && provider != nil && provider.Configured()
	case ProviderBandwidth:
		provider, err := d.bandwidthProvider()
		return err == nil && provider != nil && provider.Configured()
	default:
		return false
	}
}

func (d *Deps) anyApprovedSenderProviderConfigured(senders []SenderProfile) bool {
	for _, sender := range senders {
		if sender.RegistrationStatus == RegistrationApproved && !SenderPaused(sender.Metadata) && d.providerConfiguredForSender(sender) {
			return true
		}
	}
	return false
}

func (d *Deps) submitProviderBrandRegistration(ctx context.Context, sender SenderProfile, in A2PBrandRegistrationInput) (SmsRegistrationResource, string, error) {
	providerName := defaulted(strings.ToLower(sender.Provider), ProviderTwilio)
	switch providerName {
	case ProviderTwilio:
		provider, err := d.twilioProvider()
		if err != nil {
			return SmsRegistrationResource{}, providerName, err
		}
		out, err := provider.SubmitBrandRegistration(ctx, in.TwilioBrandRegistrationInput)
		return out, providerName, err
	case ProviderTelnyx:
		provider, err := d.telnyxProvider()
		if err != nil {
			return SmsRegistrationResource{}, providerName, err
		}
		out, err := provider.SubmitBrandRegistration(ctx, in)
		return out, providerName, err
	case ProviderBandwidth:
		provider, err := d.bandwidthProvider()
		if err != nil {
			return SmsRegistrationResource{}, providerName, err
		}
		out, err := provider.SubmitBrandRegistration(ctx, in)
		return out, providerName, err
	default:
		return SmsRegistrationResource{}, providerName, errText("unsupported sms provider")
	}
}

func (d *Deps) submitProviderCampaignRegistration(ctx context.Context, sender SenderProfile, in A2PCampaignRegistrationInput) (SmsRegistrationResource, string, error) {
	providerName := defaulted(strings.ToLower(sender.Provider), ProviderTwilio)
	switch providerName {
	case ProviderTwilio:
		provider, err := d.twilioProvider()
		if err != nil {
			return SmsRegistrationResource{}, providerName, err
		}
		out, err := provider.SubmitA2PCampaign(ctx, sender.MessagingServiceSID, in)
		return out, providerName, err
	case ProviderTelnyx:
		provider, err := d.telnyxProvider()
		if err != nil {
			return SmsRegistrationResource{}, providerName, err
		}
		out, err := provider.SubmitA2PCampaign(ctx, in)
		return out, providerName, err
	case ProviderBandwidth:
		provider, err := d.bandwidthProvider()
		if err != nil {
			return SmsRegistrationResource{}, providerName, err
		}
		out, err := provider.SubmitA2PCampaign(ctx, in)
		return out, providerName, err
	default:
		return SmsRegistrationResource{}, providerName, errText("unsupported sms provider")
	}
}

func (d *Deps) fetchProviderBrandRegistration(ctx context.Context, sender SenderProfile) (SmsRegistrationResource, error) {
	switch defaulted(strings.ToLower(sender.Provider), ProviderTwilio) {
	case ProviderTwilio:
		provider, err := d.twilioProvider()
		if err != nil {
			return SmsRegistrationResource{}, err
		}
		return provider.FetchBrandRegistration(ctx, sender.BrandRegistrationSID)
	case ProviderTelnyx:
		provider, err := d.telnyxProvider()
		if err != nil {
			return SmsRegistrationResource{}, err
		}
		return provider.FetchBrandRegistration(ctx, sender.BrandRegistrationSID)
	case ProviderBandwidth:
		provider, err := d.bandwidthProvider()
		if err != nil {
			return SmsRegistrationResource{}, err
		}
		return provider.FetchBrandRegistration(ctx, sender.BrandRegistrationSID)
	default:
		return SmsRegistrationResource{}, errText("unsupported sms provider")
	}
}

func (d *Deps) fetchProviderCampaignRegistration(ctx context.Context, sender SenderProfile) (SmsRegistrationResource, error) {
	switch defaulted(strings.ToLower(sender.Provider), ProviderTwilio) {
	case ProviderTwilio:
		if sender.MessagingServiceSID == "" {
			return SmsRegistrationResource{}, errText("twilio messaging service SID is required")
		}
		provider, err := d.twilioProvider()
		if err != nil {
			return SmsRegistrationResource{}, err
		}
		return provider.FetchA2PCampaign(ctx, sender.MessagingServiceSID, sender.CampaignRegistrationSID)
	case ProviderTelnyx:
		provider, err := d.telnyxProvider()
		if err != nil {
			return SmsRegistrationResource{}, err
		}
		return provider.FetchA2PCampaign(ctx, sender.CampaignRegistrationSID)
	case ProviderBandwidth:
		provider, err := d.bandwidthProvider()
		if err != nil {
			return SmsRegistrationResource{}, err
		}
		return provider.FetchA2PCampaign(ctx, sender.CampaignRegistrationSID)
	default:
		return SmsRegistrationResource{}, errText("unsupported sms provider")
	}
}

// writeProviderAutomationErr emits the right operator-facing response
// for a Twilio/Telnyx/Bandwidth A2P automation failure WITHOUT leaking
// the raw upstream error body (which can include account SIDs, brand
// IDs, hosted-numbers PII, and "your Bearer token …" hints). The two
// cases are deliberately differentiated:
//
//   - "set …" / "not configured" — operator-actionable config gap,
//     surfaced verbatim because the message is our own errText() and
//     contains zero provider data.
//   - everything else — upstream call failed (network, 4xx/5xx); we
//     keep the diagnostic trail server-side via httperror.WriteInternal
//     (request_id + tenant_id + err) and return the canonical generic
//     envelope. Phase 4 fix p4d.
func (d *Deps) writeProviderAutomationErr(w http.ResponseWriter, r *http.Request, providerName, op string, err error) {
	if err == nil {
		return
	}
	msg := err.Error()
	if strings.Contains(msg, "set ") || strings.Contains(msg, "not configured") {
		// Operator-authored text from errText() — safe to echo.
		httperror.Write(w, http.StatusServiceUnavailable, providerName+"_"+op+"_unconfigured", msg)
		return
	}
	tenantID := ""
	if t, ok := middleware.TenantFromContext(r.Context()); ok {
		tenantID = t.ID
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func providerSenderRegistrationStatus(provider string, brand, campaign SmsRegistrationResource) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderTelnyx, ProviderBandwidth:
		return carrierRegistrationStatus(brand, campaign)
	default:
		return senderRegistrationStatus(brand, campaign)
	}
}

func carrierRegistrationStatus(brand, campaign SmsRegistrationResource) string {
	brandStatus := strings.ToLower(strings.TrimSpace(brand.Status))
	campaignStatus := strings.ToLower(strings.TrimSpace(campaign.Status))
	switch {
	case containsAnyStatus(brandStatus, "failed", "rejected", "unverified", "declined") ||
		containsAnyStatus(campaignStatus, "failed", "rejected", "unverified", "declined"):
		return RegistrationRejected
	case containsAnyStatus(brandStatus, "suspended") ||
		containsAnyStatus(campaignStatus, "suspended", "expired"):
		return RegistrationSuspended
	case campaign.SID != "" && isApprovedRegistrationStatus(campaignStatus) &&
		(brand.SID == "" || isApprovedRegistrationStatus(brandStatus)) &&
		carrierCampaignAssignmentVerified(campaign.Raw):
		return RegistrationApproved
	case brand.SID != "" || campaign.SID != "":
		return RegistrationPending
	default:
		return RegistrationDraft
	}
}

func carrierCampaignAssignmentVerified(raw map[string]any) bool {
	for _, key := range []string{
		"postwave_assignment_verified",
		"assignment_verified",
		"phone_number_assignment_verified",
		"messaging_profile_assignment_verified",
		"tn_relationship_verified",
	} {
		if truthyAny(raw[key]) {
			return true
		}
	}
	return false
}

func senderRegistrationStatus(brand, campaign SmsRegistrationResource) string {
	brandStatus := strings.ToLower(strings.TrimSpace(brand.Status))
	campaignStatus := strings.ToLower(strings.TrimSpace(campaign.Status))
	switch {
	case containsAnyStatus(brandStatus, "failed", "rejected", "unverified") ||
		containsAnyStatus(campaignStatus, "failed", "rejected", "unverified"):
		return RegistrationRejected
	case containsAnyStatus(brandStatus, "suspended") || containsAnyStatus(campaignStatus, "suspended"):
		return RegistrationSuspended
	case campaign.SID != "" && isApprovedRegistrationStatus(campaignStatus) &&
		(brand.SID == "" || isApprovedRegistrationStatus(brandStatus)):
		return RegistrationApproved
	case brand.SID != "" || campaign.SID != "":
		return RegistrationPending
	default:
		return RegistrationDraft
	}
}

func isApprovedRegistrationStatus(status string) bool {
	return containsAnyStatus(status, "approved", "verified", "active")
}

func containsAnyStatus(status string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(status, needle) {
			return true
		}
	}
	return false
}

func twilioInboundEvidence(r *http.Request) map[string]any {
	return inboundProviderEvidence(ProviderTwilio, map[string]any{
		"provider_event_type":   "message.received",
		"provider_opt_out_type": r.FormValue("OptOutType"),
		"provider_media_count":  r.FormValue("NumMedia"),
	})
}

func writeTwiml(w http.ResponseWriter, action string) {
	message := ""
	if action == ConsentHelpRequested && smsComplianceAutoReplyReleaseReady {
		message = "Reply STOP to unsubscribe. Contact support if you need help."
	}
	writeTwimlReply(w, message)
}

// writeTwimlReply emits a TwiML response carrying message (or an empty
// <Response/> when there is nothing to say). Used by both the
// hardcoded HELP copy and tenant keyword auto-responses.
func writeTwimlReply(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if message == "" {
		_, _ = w.Write([]byte(`<Response></Response>`))
		return
	}
	_, _ = w.Write([]byte(`<Response><Message>` + html.EscapeString(message) + `</Message></Response>`))
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type errText string

func (e errText) Error() string { return string(e) }

func envPublicBaseURL() string {
	return defaulted(os.Getenv("POSTWAVE_PUBLIC_BASE_URL"), os.Getenv("PUBLIC_BASE_URL"))
}

func intParam(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func formatTimePtr(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
