// SPDX-License-Identifier: AGPL-3.0-only

// Package assurancelegalholdapi is the tenant-scoped HTTP surface for Campaign
// Assurance legal holds.
//
// The ledger and the SQL predicate shipped first (migration 1973), which left
// holds placeable only by direct SQL — a compliance control nobody could
// actually operate. This is the surface that makes it usable, and it is
// deliberately small: place, release, list. There is no edit. A hold's scope
// and reason are what an auditor reads later, so changing them in place would
// destroy the record rather than correct it; the correction is a release with a
// reason, followed by a new hold.
package assurancelegalholdapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/assurancelegalhold"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/rbac"
)

const (
	holdBodyMaxBytes int64 = 4 << 10
)

// HoldStore is the narrow persistence boundary. assurancelegalhold implements
// it; keeping it an interface means the HTTP decisions — status codes, actor
// binding, scope derivation — are provable without a database.
type HoldStore interface {
	Place(context.Context, assurancelegalhold.PlaceInput) (assurancelegalhold.Hold, error)
	Release(context.Context, assurancelegalhold.ReleaseInput) error
	List(context.Context, string) ([]assurancelegalhold.Hold, error)
}

type Deps struct {
	Store  HoldStore
	Logger *slog.Logger
}

// Mount registers the surface. Placing a hold suspends deletion of evidence
// across the tenant, so it carries the same permission as the rest of the
// retention controls rather than a campaign-editing one.
func Mount(r chi.Router, deps *Deps) {
	roleOf := func(req *http.Request) (string, bool) {
		user, ok := middleware.UserFromContext(req.Context())
		if !ok || user == nil {
			return "", false
		}
		return user.EffectiveRoleOrDurable(), true
	}
	// A legal hold is a human governance decision whose audit row names the
	// person who made it. API-key middleware can bind a key to a user id, but it
	// does not load that user's current/effective role. Treating the bound id as
	// an admin would therefore turn identity into authority. Keep this surface
	// session-only until an API-key path can prove both values from one current
	// authorization decision.
	sessionOnly := apikeys.RequireAuthMethod(apikeys.AuthMethodSession)
	gate := rbac.RequirePermission(rbac.PermAuditConfigure, roleOf)

	r.With(sessionOnly, gate).Post("/api/v1/assurance/legal-holds", deps.Place)
	r.With(sessionOnly, gate).Get("/api/v1/assurance/legal-holds", deps.List)
	r.With(sessionOnly, gate).Post("/api/v1/assurance/legal-holds/{holdID}/release", deps.Release)
}

type placeRequest struct {
	CampaignID string `json:"campaign_id"`
	Reason     string `json:"reason"`
}

type releaseRequest struct {
	Reason string `json:"reason"`
}

type holdResponse struct {
	ID         string `json:"id"`
	CampaignID string `json:"campaign_id"`
	// Scope is derived rather than left for the reader to infer from an empty
	// campaign_id. "this hold covers everything" is exactly the fact an
	// operator must not misread during an incident.
	Scope    string `json:"scope"`
	Reason   string `json:"reason"`
	PlacedAt string `json:"placed_at"`
}

func scopeOf(hold assurancelegalhold.Hold) string {
	if strings.TrimSpace(hold.CampaignID) == "" {
		return "tenant"
	}
	return "campaign"
}

func toResponse(hold assurancelegalhold.Hold) holdResponse {
	return holdResponse{
		ID: hold.ID, CampaignID: hold.CampaignID, Scope: scopeOf(hold),
		Reason: hold.Reason, PlacedAt: hold.PlacedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

func (d *Deps) requireStore(w http.ResponseWriter) bool {
	if d != nil && d.Store != nil {
		return true
	}
	// Refuse rather than report success. A 200 from an unwired surface would
	// tell an operator their hold is in place when nothing is preserved.
	httperror.Write(w, http.StatusServiceUnavailable, "legal_hold_unavailable",
		"Campaign Assurance legal holds are unavailable")
	return false
}

func identity(w http.ResponseWriter, r *http.Request) (tenantID, actorID string, ok bool) {
	tenant, found := middleware.TenantFromContext(r.Context())
	if !found || tenant == nil || strings.TrimSpace(tenant.ID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context is required")
		return "", "", false
	}
	user, found := middleware.UserFromContext(r.Context())
	if !found || user == nil || strings.TrimSpace(user.ID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_principal",
			"an authenticated tenant-bound actor is required")
		return "", "", false
	}
	if strings.TrimSpace(user.TenantID) != strings.TrimSpace(tenant.ID) {
		httperror.Write(w, http.StatusUnauthorized, "principal_tenant_mismatch",
			"authenticated actor is not bound to the active tenant")
		return "", "", false
	}
	return tenant.ID, user.ID, true
}

func (d *Deps) Place(w http.ResponseWriter, r *http.Request) {
	if !d.requireStore(w) {
		return
	}
	tenantID, actorID, ok := identity(w, r)
	if !ok {
		return
	}
	var input placeRequest
	if err := httpbody.DecodeJSON(w, r, holdBodyMaxBytes, &input); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "reason_required",
			"a legal hold requires a reason; it is the record of why evidence was preserved")
		return
	}
	if utf8.RuneCountInString(reason) > assurancelegalhold.MaxReasonCharacters {
		httperror.Write(w, http.StatusUnprocessableEntity, "reason_too_long",
			"legal hold reason exceeds the 2000-character limit")
		return
	}
	campaignID := strings.TrimSpace(input.CampaignID)
	if campaignID != "" {
		parsed, err := uuid.Parse(campaignID)
		if err != nil {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_campaign_id",
				"campaign_id must be a UUID when supplied")
			return
		}
		campaignID = parsed.String()
	}

	hold, err := d.Store.Place(r.Context(), assurancelegalhold.PlaceInput{
		TenantID:   tenantID,
		CampaignID: campaignID,
		Reason:     reason,
		// From the authenticated principal, never the body: a hold is an
		// accountability record, and a caller-supplied actor is not one.
		PlacedByUserID: actorID,
	})
	if err != nil {
		d.writeStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{"hold": toResponse(hold)})
}

func (d *Deps) Release(w http.ResponseWriter, r *http.Request) {
	if !d.requireStore(w) {
		return
	}
	tenantID, actorID, ok := identity(w, r)
	if !ok {
		return
	}
	var input releaseRequest
	if err := httpbody.DecodeJSON(w, r, holdBodyMaxBytes, &input); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "reason_required",
			"releasing a hold requires a reason; preservation stopping is itself an audit event")
		return
	}
	if utf8.RuneCountInString(reason) > assurancelegalhold.MaxReasonCharacters {
		httperror.Write(w, http.StatusUnprocessableEntity, "reason_too_long",
			"legal hold release reason exceeds the 2000-character limit")
		return
	}
	holdID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "holdID")))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_hold_id", "hold id must be a UUID")
		return
	}

	if err := d.Store.Release(r.Context(), assurancelegalhold.ReleaseInput{
		TenantID: tenantID, HoldID: holdID.String(),
		Reason: reason, ReleasedByUserID: actorID,
	}); err != nil {
		d.writeStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"released": true})
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	if !d.requireStore(w) {
		return
	}
	tenantID, _, ok := identity(w, r)
	if !ok {
		return
	}
	holds, err := d.Store.List(r.Context(), tenantID)
	if err != nil {
		d.writeStoreError(w, err)
		return
	}
	rows := make([]holdResponse, 0, len(holds))
	for _, hold := range holds {
		rows = append(rows, toResponse(hold))
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"holds": rows})
}

func (d *Deps) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, assurancelegalhold.ErrReasonRequired):
		httperror.Write(w, http.StatusUnprocessableEntity, "reason_required", err.Error())
	case errors.Is(err, assurancelegalhold.ErrAlreadyHeld):
		// A conflict, not a server error: "it is already held" is the
		// operator's own mental model of what happened.
		httperror.Write(w, http.StatusConflict, "already_held",
			"an active hold already covers this scope")
	case errors.Is(err, assurancelegalhold.ErrNotHeld):
		httperror.Write(w, http.StatusNotFound, "hold_not_found",
			"no active hold with that id")
	default:
		if d != nil && d.Logger != nil {
			d.Logger.Error("campaign assurance legal hold", "err", err)
		}
		httperror.Write(w, http.StatusInternalServerError, "legal_hold_failed",
			"the legal hold could not be recorded")
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
