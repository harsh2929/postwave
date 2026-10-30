// SPDX-License-Identifier: AGPL-3.0-only
package approvals

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// Deps wires HTTP handlers to a Service. Mounted in main.go via Mount.
type Deps struct {
	Service *Service
	// PublicSessionResolver resolves an optional browser session on the public
	// signed-link route. GET remains public so recipients can inspect the
	// confirmation page, but POST requires the resolved session to match the
	// approver identity bound into the token. The public router deliberately
	// has no tenant middleware, so leaving this nil fails every decision closed.
	PublicSessionResolver func(*http.Request) (*middleware.Tenant, *middleware.User, error)
	// PublicBaseURL is used to construct one-click decide URLs in notifier
	// previews. Empty disables URL generation.
	PublicBaseURL string
	// Bus, when non-nil, receives best-effort approval.* realtime events at
	// the end of state-changing HTTP handlers. It serves UI refresh only;
	// customer webhooks are persisted transactionally by Repo.
	Bus *events.Bus
	// SlackPoster, when non-nil, is invoked at the end of
	// RequestApprovalHandler so the Slack approval bot can post a
	// Block-Kit message into the tenant's connected channel. The
	// adapter is best-effort: failures log but never fail the request.
	SlackPoster SlackPoster
	// NotifDispatcher is retained on Deps for backward-compatibility
	// with callers that still wire it through main.go, but per-recipient
	// gating now lives inside the Notifier itself (see notifier.go +
	// notify.go). The handler no longer consults this field. Keeping the
	// field non-removed lets the existing main.go wiring keep compiling;
	// when the field is non-nil the handler does nothing with it. A
	// future cleanup can drop the field entirely once main.go is moved
	// to plumbing the dispatcher into the PostmarkNotifier instead.
	NotifDispatcher notifications.Dispatcher
	// OnApproved is invoked after an approval transitions to approved.
	// It lets resource owners bind the human decision to the originally
	// requested side effect, such as queueing a campaign send. Hook
	// failures are reported as warnings in the HTTP response but do not
	// roll back the approval row, which has already been decided.
	OnApproved ApprovedHook
	// Logger is used by httperror.WriteInternal to record server-side
	// log lines on 5xx paths without echoing err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
	// publicDecisionFn is the package-local test seam for the complete
	// repository mutation below. Production always leaves it nil. Keeping the
	// seam at the effect boundary lets security tests prove rejected identities
	// make zero mutation attempts without replacing the concrete pgx Repo.
	publicDecisionFn func(context.Context, string, string, string, string, Decision) (*Approval, error)
}

var errPublicApprovalTenantMismatch = errors.New("approvals: public session tenant does not own approval")

const approvalJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// ApprovedHook runs the side effect unlocked by an approval decision.
// resourceType/resourceID are copied from the approval row.
type ApprovedHook func(ctx context.Context, tenantID string, resourceType ResourceType, resourceID string) error

// emit publishes a presentation-only approval.* realtime event when the bus
// is configured. nil-safe so tests don't have to thread the broker through.
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

// Mount registers tenant-scoped admin routes on the provided router. Caller
// is expected to have TenantMiddleware in front. Admin gate is enforced in
// the handler bodies because not every request reaches it via the same
// middleware chain.
func (d *Deps) Mount(r chi.Router) {
	r.Get("/api/v1/approvals", d.list)
	r.Get("/api/v1/approvals/{id}", d.get)
	r.Post("/api/v1/approvals/{id}/approve", d.approve)
	r.Post("/api/v1/approvals/{id}/reject", d.reject)
	r.Post("/api/v1/approvals/{id}/decision", d.decision)

	// Delegation + escalation policy CRUD (migration 0179).
	r.Get("/api/v1/approvals/delegations", d.listDelegations)
	r.Post("/api/v1/approvals/delegations", d.createDelegation)
	r.Delete("/api/v1/approvals/delegations/{id}", d.revokeDelegation)
	r.Get("/api/v1/approvals/escalation-policy", d.getEscalationPolicy)
	r.Put("/api/v1/approvals/escalation-policy", d.upsertEscalationPolicy)
}

// --- delegation handlers ---

func (d *Deps) listDelegations(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	list, err := d.Service.Repo.ListDelegations(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delegations": list})
}

func (d *Deps) createDelegation(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	var in Delegation
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		// httpbody returns typed sentinels (ErrTooLarge / ErrMultipleJSONValues)
		// whose .Error() text is operator-safe; codes are in
		// httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.TenantID = tenant.ID
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		in.CreatedByUser = u.ID
	}
	out, err := d.Service.Repo.CreateDelegation(r.Context(), in)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) revokeDelegation(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Service.Repo.RevokeDelegation(r.Context(), tenant.ID, id); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) getEscalationPolicy(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	p, err := d.Service.Repo.GetEscalationPolicy(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (d *Deps) upsertEscalationPolicy(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	var p EscalationPolicy
	if err := httpbody.DecodeJSON(w, r, 4<<10, &p); err != nil {
		// httpbody returns typed sentinels (ErrTooLarge / ErrMultipleJSONValues)
		// whose .Error() text is operator-safe; codes are in
		// httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	p.TenantID = tenant.ID
	var updatedBy string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		updatedBy = u.ID
	}
	if err := d.Service.Repo.UpsertEscalationPolicy(r.Context(), p, updatedBy); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// MountPublic registers the public signed-link route on the provided router.
// GET is an unauthenticated, read-only confirmation page. POST additionally
// requires a current browser session whose identity matches the token-bound
// approver. Caller mounts this on the public+rate-limited group.
func (d *Deps) MountPublic(r chi.Router) {
	// GET renders an HTML Confirm interstitial; POST commits the
	// decision. Two-step prevents link-prefetcher auto-clicks (Outlook
	// Safelinks, Gmail link-warming, etc.) from accidentally
	// approving/rejecting on link-mouseover.
	r.Get("/api/public/approvals/{id}/decide", d.publicDecide)
	r.Post("/api/public/approvals/{id}/decide", d.publicDecide)
}

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	statusFilter := r.URL.Query().Get("status")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rows, err := d.Service.Repo.List(r.Context(), tenant.ID, statusFilter, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": rows, "items": rows})
}

func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	a, err := d.Service.Repo.Get(r.Context(), tenant.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "approval not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (d *Deps) approve(w http.ResponseWriter, r *http.Request) {
	d.decide(w, r, DecisionApprove)
}

func (d *Deps) reject(w http.ResponseWriter, r *http.Request) {
	d.decide(w, r, DecisionReject)
}

func (d *Deps) decision(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Decision Decision `json:"decision"`
		Notes    string   `json:"notes"`
	}
	if err := httpbody.DecodeJSON(w, r, approvalJSONMaxBodyBytes, &body); err != nil {
		// httpbody returns typed sentinels (ErrTooLarge / ErrMultipleJSONValues)
		// whose .Error() text is operator-safe; codes are in
		// httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	switch body.Decision {
	case DecisionApprove:
		d.decideReturningApproval(w, r, DecisionApprove, body.Notes)
	case DecisionReject:
		d.decideReturningApproval(w, r, DecisionReject, body.Notes)
	default:
		writeErr(w, http.StatusBadRequest, "bad_decision", "decision must be approve|reject")
	}
}

func (d *Deps) decide(w http.ResponseWriter, r *http.Request, decision Decision) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Notes string `json:"notes"`
	}
	if err := httpbody.DecodeJSONWith(w, r, approvalJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		// httpbody returns typed sentinels (ErrTooLarge / ErrMultipleJSONValues)
		// whose .Error() text is operator-safe; codes are in
		// httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	userID := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		userID = u.ID
	}
	if err := d.Service.Decide(r.Context(), tenant.ID, id, decision, userID, body.Notes); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not_found", "approval not found")
		case errors.Is(err, ErrNotPending):
			writeErr(w, http.StatusConflict, "not_pending", "approval already decided")
		case errors.Is(err, ErrExpired):
			writeErr(w, http.StatusGone, "expired", "approval has expired")
		case errors.Is(err, ErrBadDecision):
			writeErr(w, http.StatusBadRequest, "bad_decision", "decision must be approve|reject")
		case errors.Is(err, ErrSelfApproval):
			writeSelfApprovalDenial(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	d.emit(tenant.ID, "approval.decided", map[string]any{
		"id":       id,
		"decision": string(decision),
		"user_id":  userID,
	})
	resp := map[string]any{"ok": true}
	if hookErr := d.runApprovedHookForID(r.Context(), tenant.ID, id, decision); hookErr != nil {
		resp["followup_error"] = hookErr.Error()
		slog.Warn("approval approved hook failed",
			"approval_id", id, "tenant_id", tenant.ID, "err", hookErr.Error())
	}
	writeJSON(w, http.StatusOK, resp)
}

func (d *Deps) decideReturningApproval(w http.ResponseWriter, r *http.Request, decision Decision, notes string) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	userID := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		userID = u.ID
	}
	if err := d.Service.Decide(r.Context(), tenant.ID, id, decision, userID, notes); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not_found", "approval not found")
		case errors.Is(err, ErrNotPending):
			writeErr(w, http.StatusConflict, "not_pending", "approval already decided")
		case errors.Is(err, ErrExpired):
			writeErr(w, http.StatusGone, "expired", "approval has expired")
		case errors.Is(err, ErrBadDecision):
			writeErr(w, http.StatusBadRequest, "bad_decision", "decision must be approve|reject")
		case errors.Is(err, ErrSelfApproval):
			writeSelfApprovalDenial(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	a, err := d.Service.Repo.Get(r.Context(), tenant.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emit(tenant.ID, "approval.decided", map[string]any{
		"id":       id,
		"decision": string(decision),
		"user_id":  userID,
		"status":   a.Status,
	})
	if hookErr := d.runApprovedHook(r.Context(), a, decision); hookErr != nil {
		slog.Warn("approval approved hook failed",
			"approval_id", id, "tenant_id", tenant.ID, "err", hookErr.Error())
	}
	writeJSON(w, http.StatusOK, a)
}

func (d *Deps) publicDecide(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	token := r.URL.Query().Get("token")
	q := r.URL.Query().Get("decision")
	if token == "" {
		writeErr(w, http.StatusBadRequest, "missing_token", "token query param required")
		return
	}
	signedID, signedDecision, approverHash, err := d.Service.VerifyToken(token)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "bad_token", "token invalid or expired")
		return
	}
	if signedID != id {
		writeErr(w, http.StatusUnauthorized, "bad_token", "token does not match this approval")
		return
	}
	if q != "" && Decision(q) != signedDecision {
		writeErr(w, http.StatusBadRequest, "decision_mismatch", "decision query does not match signed decision")
		return
	}
	// Two-step confirm to avoid link-prefetcher / safelink auto-clicks:
	// a GET renders an HTML interstitial; a POST (with the same signed
	// token) executes the decision. Outlook Safelinks, Gmail link
	// warming, etc. only follow GETs, so they no longer trigger an
	// accidental decide.
	if r.Method == http.MethodGet {
		d.renderPublicDecideInterstitial(w, r, id, token, signedDecision)
		return
	}

	// Possession of a signed link identifies the intended approval and
	// decision, but it is not proof that the presenter is the named recipient.
	// Legacy four-part tokens and old anonymous-recipient tokens cannot meet
	// that identity requirement and therefore never reach a repository call.
	if approverHash == "" || approverHash == ApproverEmailHash("") {
		writeErr(w, http.StatusUnauthorized, "approver_identity_unbound",
			"this approval link is not bound to a recipient; request a new approval link")
		return
	}
	tenant, user, resolveErr := d.resolvePublicDecisionSession(r)
	if resolveErr != nil {
		httperror.WriteInternal(w, d.Logger, resolveErr, r.Context())
		return
	}
	if tenant == nil || user == nil || strings.TrimSpace(tenant.ID) == "" ||
		strings.TrimSpace(user.ID) == "" || strings.TrimSpace(user.SessionID) == "" ||
		strings.TrimSpace(user.Email) == "" || user.TenantID != tenant.ID {
		writeErr(w, http.StatusUnauthorized, "authentication_required",
			"sign in as the recipient of this approval link to continue")
		return
	}
	if ApproverEmailHash(user.Email) != approverHash {
		writeApproverMismatchDenial(w)
		return
	}
	role := strings.ToLower(strings.TrimSpace(user.EffectiveRoleOrDurable()))
	if role != "owner" && role != "admin" {
		writeApprovalsRoleDenial(w, "a current owner or admin session is required to decide approvals")
		return
	}
	ctx := middleware.WithTenant(r.Context(), tenant)
	ctx = middleware.WithUser(ctx, user)
	r = r.WithContext(ctx)

	decidedApproval, err := d.applyPublicDecision(
		r.Context(), id, token, tenant.ID, user.ID, signedDecision,
	)
	if err != nil {
		switch {
		case errors.Is(err, errPublicApprovalTenantMismatch):
			writeApproverMismatchDenial(w)
		case errors.Is(err, ErrTokenAlreadyUsed):
			writeErr(w, http.StatusConflict, "token_already_used",
				"this approval link has already been used")
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not_found", "approval not found")
		case errors.Is(err, ErrNotPending):
			writeErr(w, http.StatusConflict, "not_pending", "approval already decided")
		case errors.Is(err, ErrExpired):
			writeErr(w, http.StatusGone, "expired", "approval has expired")
		case errors.Is(err, ErrSelfApproval):
			writeSelfApprovalDenial(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	d.emit(decidedApproval.TenantID, "approval.decided", map[string]any{
		"id":       id,
		"decision": string(signedDecision),
		"source":   "public_link",
	})
	resp := map[string]any{"ok": true, "decision": string(signedDecision)}
	if hookErr := d.runApprovedHook(r.Context(), decidedApproval, signedDecision); hookErr != nil {
		resp["followup_error"] = hookErr.Error()
		slog.Warn("approval approved hook failed",
			"approval_id", id, "tenant_id", decidedApproval.TenantID, "err", hookErr.Error())
	}
	writeJSON(w, http.StatusOK, resp)
}

// applyPublicDecision is the only mutation boundary for a public signed-link
// POST. Identity and current-role checks happen before this method. It then
// verifies tenant ownership before consuming the single-use token or changing
// approval state, and routes the transition through Service.Decide so the
// ordinary expiry and two-person rules still apply.
func (d *Deps) applyPublicDecision(
	ctx context.Context,
	id, rawToken, sessionTenantID, userID string,
	decision Decision,
) (*Approval, error) {
	if d.publicDecisionFn != nil {
		return d.publicDecisionFn(ctx, id, rawToken, sessionTenantID, userID, decision)
	}
	a, err := d.Service.Repo.GetUnscoped(ctx, id)
	if err != nil {
		return nil, err
	}
	if a.TenantID != sessionTenantID {
		return nil, errPublicApprovalTenantMismatch
	}
	// Insert the token's SHA-256 into approval_token_consumption before the
	// decision. The unique key closes concurrent replay; identity and tenant
	// checks above ensure an attacker cannot burn somebody else's token first.
	if err := d.Service.Repo.MarkTokenConsumed(ctx, id, rawToken); err != nil {
		return nil, err
	}
	if err := d.Service.Decide(ctx, a.TenantID, id, decision, userID, "decided via signed link"); err != nil {
		return nil, err
	}
	a.Status = decisionToStatus(decision)
	decidedAt := d.Service.now()
	a.DecidedAt = &decidedAt
	a.DecidedByUserID = &userID
	return a, nil
}

// resolvePublicDecisionSession returns only a browser-session principal. API
// keys and context users without a concrete session id cannot stand in for the
// human recipient named by a signed approval link.
func (d *Deps) resolvePublicDecisionSession(r *http.Request) (*middleware.Tenant, *middleware.User, error) {
	if r == nil || middleware.IsAPIKeyAuth(r.Context()) {
		return nil, nil, nil
	}
	if user, ok := middleware.UserFromContext(r.Context()); ok && user != nil && strings.TrimSpace(user.SessionID) != "" {
		tenant, _ := middleware.TenantFromContext(r.Context())
		return tenant, user, nil
	}
	if d == nil || d.PublicSessionResolver == nil {
		return nil, nil, nil
	}
	return d.PublicSessionResolver(r)
}

// renderPublicDecideInterstitial returns a small HTML page with a
// Confirm/Cancel form that POSTs back to the same URL. Token is
// echoed in a hidden field. The page sets `Cache-Control: no-store`
// so a misbehaving link prefetcher can't even cache the interstitial.
func (d *Deps) renderPublicDecideInterstitial(w http.ResponseWriter, r *http.Request, id, token string, decision Decision) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.WriteHeader(http.StatusOK)
	verb := "approve"
	if decision == DecisionReject {
		verb = "reject"
	}
	// Build the form URL preserving the existing query string so the
	// POST carries the same signed token + optional ?decision param. Both the
	// URL and id are untrusted HTTP input even though the token later binds the
	// id, so escape them before placing either in HTML.
	formURL := html.EscapeString(r.URL.Path + "?" + r.URL.RawQuery)
	escapedID := html.EscapeString(id)
	html := `<!doctype html>
<html><head><meta charset="utf-8"><title>Confirm approval decision</title>
<meta name="robots" content="noindex,nofollow">
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:560px;margin:48px auto;padding:24px;color:#0a0a0a;line-height:1.55}
 h1{font-size:20px;margin:0 0 12px}
 p{font-size:15px;color:#444}
 .row{margin-top:24px;display:flex;gap:12px}
	 button,.cancel{font:inherit;padding:10px 18px;border-radius:6px;cursor:pointer;border:1px solid #ccc;background:#fff;text-decoration:none;color:inherit}
 button.primary{background:#0055d4;color:#fff;border-color:#0055d4}
 button.danger{background:#c0392b;color:#fff;border-color:#c0392b}
 .meta{color:#888;font-size:13px;margin-top:32px}
</style></head>
<body>
<h1>Confirm: ` + verb + ` this approval?</h1>
<p>You're about to <strong>` + verb + `</strong> the pending approval.
This action is final. The link was valid; click <em>Confirm</em> to
record the decision.</p>
<form method="POST" action="` + formURL + `">
  <div class="row">
    <button type="submit" class="` + map[Decision]string{DecisionApprove: "primary", DecisionReject: "danger"}[decision] + `">Confirm ` + verb + `</button>
	    <a class="cancel" href="/">Cancel</a>
  </div>
</form>
	<p class="meta">Approval id: ` + escapedID + `</p>
</body></html>`
	_, _ = w.Write([]byte(html))
	_ = token // token stays in the URL via formURL; not echoed in body
}

func (d *Deps) runApprovedHookForID(ctx context.Context, tenantID, id string, decision Decision) error {
	if d == nil || d.Service == nil || d.Service.Repo == nil || decision != DecisionApprove {
		return nil
	}
	a, err := d.Service.Repo.Get(ctx, tenantID, id)
	if err != nil {
		return err
	}
	return d.runApprovedHook(ctx, a, decision)
}

func (d *Deps) runApprovedHook(ctx context.Context, a *Approval, decision Decision) error {
	if d == nil || d.OnApproved == nil || a == nil || decision != DecisionApprove {
		return nil
	}
	if a.Status != StatusApproved {
		return nil
	}
	return d.OnApproved(ctx, a.TenantID, ResourceType(a.ResourceType), a.ResourceID)
}

func decisionToStatus(d Decision) Status {
	if d == DecisionReject {
		return StatusRejected
	}
	return StatusApproved
}

// requireAdmin returns false (and writes 403) when the request is not made
// by an admin/owner user.
//
// PRE-FIX behaviour: when UserFromContext returned no user, this admitted
// the request — defensible during local dev where the slug-only path has
// no user attached, but a fail-open in any real deployment that suppressed
// the user-context middleware. The PRODUCTION_READINESS audit flagged it
// as MED. New behaviour:
//
//   - User present + role owner/admin → allow
//   - User present + role not in admin set → 403 forbidden
//   - User absent BUT API-key auth (with scopes already enforced upstream
//     by apikeys.RequireScope) → allow
//   - User absent + no API-key auth → 403 forbidden (fail closed). This
//     covers the rare configuration where the request reached the handler
//     without TenantMiddleware attaching a user.
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if middleware.IsAPIKeyAuth(r.Context()) {
		// API-key path: scope check already ran in middleware. The
		// route mounts already require ScopeAdmin / ScopeWriteCampaigns
		// where appropriate. Trust the upstream gate.
		return true
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok {
		writeApprovalsRoleDenial(w, "approvals require an authenticated owner/admin user")
		return false
	}
	if u.Role == "owner" || u.Role == "admin" {
		return true
	}
	writeApprovalsRoleDenial(w, "admin role required")
	return false
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": errCode, "message": msg},
	})
}

// ---------------------------------------------------------------------------
// Slack approval-bot integration glue.
// ---------------------------------------------------------------------------
//
// The Slack approval bot needs a hook fired when a new approval is
// created so it can post a Block-Kit message into the tenant's
// connected channel. We expose that hook here (rather than touching
// approvals.go's Service.Request, which is out-of-scope for this
// feature) by:
//
//   1. Defining a narrow SlackPoster interface that slackint.ApprovalDeps
//      satisfies. It stays narrow to avoid forcing the approvals
//      package to import slackint and the resulting circular import.
//   2. Adding RequestApprovalHandler that mirrors the existing
//      handlers' shape: tenant context required, admin gate,
//      JSON body, calls Service.Request, then — at the end — posts
//      to Slack. Slack failure is logged via slog and never fails
//      the request.
//
// Existing send/sequence/automation entry points already call
// Service.Request directly; this handler is the new HTTP-callable
// surface the desktop "Send" + Slack slash-command flows hit so both
// get the new Slack bot post for free.

// SlackPoster is the narrow surface the Slack approval bot exposes for
// "send this approval to Slack." nil = no-op.
type SlackPoster interface {
	PostApprovalRequest(ctx context.Context, a *Approval) error
}

// RequestApprovalInput is the body of POST /api/v1/approvals.
type RequestApprovalInput struct {
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	ActorType    string `json:"actor_type,omitempty"`
	ActorLabel   string `json:"actor_label,omitempty"`
}

// RequestApprovalHandler creates a pending approval row, fires the
// existing email Notifier, and best-effort posts a Block-Kit approval
// message to the tenant's connected Slack workspace if any.
func (d *Deps) RequestApprovalHandler(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	if !requireAdmin(w, r) {
		return
	}
	var in RequestApprovalInput
	if err := httpbody.DecodeJSON(w, r, approvalJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns typed sentinels (ErrTooLarge / ErrMultipleJSONValues)
		// whose .Error() text is operator-safe; codes are in
		// httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.ResourceType == "" || in.ResourceID == "" {
		writeErr(w, http.StatusBadRequest, "missing_fields", "resource_type and resource_id required")
		return
	}
	res := Resource{Type: ResourceType(in.ResourceType), ID: in.ResourceID}
	actor := Actor{Type: in.ActorType, Label: in.ActorLabel}
	// Capture the requesting user's id so Service.Decide can later
	// enforce the two-person rule (audit HIGH F5). Nil for API-key /
	// agent flows — the rule degenerates trivially when no human
	// requester exists to match against.
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && u.ID != "" {
		uid := u.ID
		actor.UserID = &uid
		// Default the actor label to the user's email so the
		// approvals dashboard surfaces a human-readable requester
		// even when callers don't pass actor_label.
		if actor.Label == "" && u.Email != "" {
			actor.Label = u.Email
		}
		if actor.Type == "" {
			actor.Type = "user"
		}
	}
	// Per-recipient pref gating now lives inside the Notifier (see
	// notifier.go + notify.go). The handler no longer fetches the
	// requester's user pref and passes WithSilencedNotifier(); doing
	// that historically silenced the email for ALL admin recipients
	// when the requester opted out, which is wrong. The notifier's
	// per-recipient loop consults the dispatcher for each admin
	// independently — see PostmarkNotifier.NotifyRequested.
	a, err := d.Service.Request(r.Context(), tenant.ID, res, actor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emit(tenant.ID, "approval.requested", map[string]any{
		"id":            a.ID,
		"resource_type": a.ResourceType,
		"resource_id":   a.ResourceID,
	})

	// Slack post is fire-and-forget — never fail the HTTP request on
	// a Slack outage. Dispatch in a goroutine so a slow Slack API
	// call does not extend the response latency, mirroring the
	// goroutine-based Notifier dispatch in Service.Request.
	if d.SlackPoster != nil {
		approvalCopy := *a
		go func() {
			defer func() {
				if rec := recover(); rec != nil {
					slog.Error("slack post approval panic recovered",
						"approval_id", approvalCopy.ID,
						"tenant_id", approvalCopy.TenantID,
						"panic", fmt.Sprint(rec))
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := d.SlackPoster.PostApprovalRequest(ctx, &approvalCopy); err != nil {
				slog.Warn("slack post approval failed",
					"approval_id", approvalCopy.ID,
					"tenant_id", approvalCopy.TenantID,
					"err", err.Error())
			}
		}()
	}

	writeJSON(w, http.StatusCreated, a)
}
