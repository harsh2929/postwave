// SPDX-License-Identifier: AGPL-3.0-only
//
// metered_paywall_handlers.go — admin GET / PUT endpoints for the
// per-tenant metered paywall config + the integration point with
// PublicGet that fires the meter check on the public archive read
// path. Lives in a separate file from metered_paywall.go so the data
// model + business logic stays unit-testable without the chi/http
// boilerplate.
//
// Routes (all admin-scoped — see MountMeteredPaywallAdminRoutes):
//
//	GET /api/v1/admin/archive/metered-paywall
//	PUT /api/v1/admin/archive/metered-paywall
//
// The public archive read path (PublicGet in archive.go) invokes
// applyMeteredPaywallToIssue via the Deps reference — see
// archive.go's call into ApplyMeteredPaywall for the wiring.

package archive

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountMeteredPaywallAdminRoutes wires the admin config endpoints
// behind `apikeys.ScopeAdmin`. Called from MountAdminRoutes (in
// archive.go) so it inherits the same tenant-context + RBAC wrap as
// the rest of the archive admin surface.
func (d *Deps) MountMeteredPaywallAdminRoutes(r chi.Router) {
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Get("/api/v1/admin/archive/metered-paywall", d.AdminGetMeteredPaywall)
	admin.Put("/api/v1/admin/archive/metered-paywall", d.AdminPutMeteredPaywall)
}

// AdminGetMeteredPaywall GET /api/v1/admin/archive/metered-paywall
//
// Returns the per-tenant config row. First-read of a never-configured
// tenant returns the zero-value envelope (quota=0, reset_cadence=
// "monthly") so the desktop can render the form without a "not
// configured" branch.
func (d *Deps) AdminGetMeteredPaywall(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	cfg, err := d.Repo.GetMeteredPaywallConfig(r.Context(), t.ID)
	if err != nil {
		// Repo may return raw pgx/db errors (tx setup, scan, commit) —
		// route through WriteInternal so we never leak driver text.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// AdminPutMeteredPaywall PUT /api/v1/admin/archive/metered-paywall
//
// PATCH-style: pointer fields on MeteredPaywallInput let the caller
// update a single column without stomping the rest. Validation errors
// map to 400 with stable codes the desktop can use for inline-error
// rendering.
func (d *Deps) AdminPutMeteredPaywall(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in MeteredPaywallInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		writeJSON(w, httpbody.StatusCode(err), errEnv(httpbody.ErrorCode(err), httpbody.PublicMessage(err)))
		return
	}
	if err := d.Repo.UpsertMeteredPaywallConfig(r.Context(), t.ID, in); err != nil {
		// Typed sentinel errors are operator-safe validation strings
		// (defined in metered_paywall.go) — safe to echo for inline
		// desktop rendering.
		if errors.Is(err, ErrInvalidMeteredCadence) {
			httperror.WriteValidation(w, "invalid_cadence", err.Error())
			return
		}
		if errors.Is(err, ErrInvalidMeteredQuota) {
			httperror.WriteValidation(w, "invalid_quota", err.Error())
			return
		}
		// Anything else from the repo is a db / pgx / tx error — route
		// through WriteInternal so we never leak driver text.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// applyMeteredPaywallToIssue is the public-path integration hook
// PublicGet calls AFTER the existing subscribe-wall pass. Decoupled
// here (rather than inlined in archive.go) so the meter logic stays
// testable in isolation and so a future audit can grep "metered" in
// one place.
//
// Returns the (possibly rewritten) body + decision so the handler can
// hydrate the JSON response fields `meteredActive`, `meteredLocked`,
// `meteredReadCount`, etc.
func (d *Deps) applyMeteredPaywallToIssue(r *http.Request, tenantID, campaignID, body, paidTier string) (string, MeteredDecision) {
	if d == nil || d.Repo == nil {
		return body, MeteredDecision{Allowed: true}
	}
	in := MeteredAllowInput{
		TenantID:       tenantID,
		CampaignID:     campaignID,
		VisitorID:      ExtractVisitorID(r, d.TrustForwardedIPHeaders),
		PaidMemberTier: paidTier,
		UserAgent:      r.UserAgent(),
		Now:            time.Now().UTC(),
	}
	dec := d.Repo.MeteredAllow(r.Context(), in)
	if !dec.MeteredActive {
		return body, dec
	}
	cfg, err := d.Repo.GetMeteredPaywallConfig(r.Context(), tenantID)
	if err != nil {
		// Fail-open: if we can't reload the config (we just used it,
		// so this should be impossible in practice), don't gate.
		return body, MeteredDecision{Allowed: true}
	}
	return ApplyMeteredPaywall(body, cfg, dec), dec
}
