// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The HTTP surface for editing leases.
//
// Without this the lease layer is a tested mechanism nobody takes — which is
// the "described in the past tense" failure this ledger keeps catching, and
// which two migrations earlier in this same session already committed. A guard
// nothing invokes protects nothing.

// leaseHolderFromRequest identifies who is asking.
//
// A lease keyed on a USER, not a session or a key: the same person editing from
// two tabs is one editor and must not lock themselves out, while two colleagues
// sharing an API key are indistinguishable and correctly treated as one holder —
// the lease cannot tell them apart, and pretending otherwise would refuse a
// person their own campaign.
func leaseHolderFromRequest(r *http.Request) (id, label string) {
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && u.ID != "" {
		return u.ID, u.Email
	}
	// A key with a BOUND USER never reaches here: `apikeys` middleware sets
	// WithUser whenever `key.UserID != ""`, so such a key resolves to the same
	// holder as that person's browser session — a scripted write inherits its
	// owner's dashboard lease, which is correct (it IS them) and was previously
	// described here as impossible.
	//
	// This branch is only for USER-LESS keys. The key id is a stable internal
	// ownership identity (so only that key can renew/release); HTTP projections
	// never serialize it. The separately configured actor label is the only
	// coordination copy a conflicting editor may see.
	if keyID := middleware.APIKeyIDFromContext(r.Context()); keyID != "" {
		_, actorLabel := middleware.ActorFromContext(r.Context())
		if actorLabel == "" {
			actorLabel = "an API key"
		}
		return "api-key:" + keyID, actorLabel
	}
	return "", ""
}

func (d *Deps) leaseRequestContext(w http.ResponseWriter, r *http.Request) (tenantID, campaignID, holderID, holderLabel string, ok bool) {
	t, found := middleware.TenantFromContext(r.Context())
	if !found {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return "", "", "", "", false
	}
	rawID := strings.TrimSpace(chi.URLParam(r, "id"))
	if rawID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "campaign id required"))
		return "", "", "", "", false
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign_id", "campaign id must be a UUID"))
		return "", "", "", "", false
	}
	hid, hlabel := leaseHolderFromRequest(r)
	if hid == "" {
		// An anonymous holder would be indistinguishable from every other
		// anonymous holder, so the lease would read as simultaneously held and
		// renewable by everyone.
		writeJSON(w, http.StatusForbidden, errEnv("no_identity",
			"an editing lease needs an identified caller"))
		return "", "", "", "", false
	}
	if d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("unavailable", "repository unavailable"))
		return "", "", "", "", false
	}
	return t.ID, id.String(), hid, hlabel, true
}

// AcquireEditLease POST /api/v1/campaigns/{id}/edit-lease
//
// Acquire AND renew, one endpoint. A client that must choose between two will
// eventually choose wrong, and the wrong choice here is a lease that silently
// lapses mid-edit.
func (d *Deps) AcquireEditLeaseHandler(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, holderID, holderLabel, ok := d.leaseRequestContext(w, r)
	if !ok {
		return
	}
	lease, err := d.Repo.AcquireEditLease(r.Context(), tenantID, campaignID, holderID, holderLabel, 0)
	if errors.Is(err, ErrCampaignNotFound) {
		// 404 for both "not yours" and "does not exist". Telling them apart is
		// the cross-tenant oracle this check closes.
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
		return
	}
	var held *ErrEditLeaseHeld
	if errors.As(err, &held) {
		// 409, not 403: the caller is permitted to edit this campaign, just not
		// right now. A 403 would send them to an administrator about a
		// permission they already have.
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{
				"code":    "edit_lease_held",
				"message": held.Error(),
				"holder":  editLeaseConflictHolder(held.Holder),
			},
		})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errEnv("lease_failed", "could not acquire the editing lease"))
		return
	}
	// The caller already knows the campaign and their own identity. Return the
	// useful timing state without reflecting either durable authorization id or
	// their email-address label.
	owned := viewerEditLease(lease)
	owned.HolderLabel = "you"
	writeJSON(w, http.StatusOK, owned)
}

// ReleaseEditLease DELETE /api/v1/campaigns/{id}/edit-lease
func (d *Deps) ReleaseEditLeaseHandler(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, holderID, _, ok := d.leaseRequestContext(w, r)
	if !ok {
		return
	}
	if err := d.Repo.ReleaseEditLease(r.Context(), tenantID, campaignID, holderID); err != nil {
		writeJSON(w, http.StatusInternalServerError, errEnv("lease_failed", "could not release the editing lease"))
		return
	}
	// 200 with the resulting state rather than 204: releasing a lease you do
	// not hold is a no-op, and a bare 204 would let a caller believe they had
	// taken something away from someone else.
	writeJSON(w, http.StatusOK, map[string]any{"released": true})
}

// GetEditLease GET /api/v1/campaigns/{id}/edit-lease
//
// Answers "is anyone editing this, and who" without taking anything — the read
// a list view needs before it offers an Edit button.
func (d *Deps) GetEditLeaseHandler(w http.ResponseWriter, r *http.Request) {
	// Lease state is short-lived workspace metadata and can contain a holder
	// label. Never let a browser or shared proxy retain it after the lease ends.
	w.Header().Set("Cache-Control", "no-store")
	t, found := middleware.TenantFromContext(r.Context())
	if !found {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	rawID := strings.TrimSpace(chi.URLParam(r, "id"))
	if rawID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "campaign id required"))
		return
	}
	id, parseErr := uuid.Parse(rawID)
	if parseErr != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign_id", "campaign id must be a UUID"))
		return
	}
	if d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("unavailable", "repository unavailable"))
		return
	}
	lease, err := d.Repo.EditLeaseHolder(r.Context(), t.ID, id.String())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errEnv("lease_failed", "could not read the editing lease"))
		return
	}
	if lease == nil {
		writeJSON(w, http.StatusOK, map[string]any{"held": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"held":  true,
		"lease": viewerEditLease(lease),
	})
}

// viewerEditLease is the read-scope representation of a lease. The durable
// holder id is an authorization primitive, not coordination copy, and user
// leases currently store an email address as their label. A campaign viewer
// needs to know that editing is occupied and for how long; they do not need
// either identifier. Non-email service labels remain useful for coordination.
type viewerEditLeaseResponse struct {
	HolderLabel string    `json:"holder_label"`
	AcquiredAt  time.Time `json:"acquired_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func viewerEditLease(lease *EditLease) viewerEditLeaseResponse {
	return viewerEditLeaseResponse{
		HolderLabel: editLeaseCoordinationLabel(lease.HolderLabel),
		AcquiredAt:  lease.AcquiredAt,
		ExpiresAt:   lease.ExpiresAt,
	}
}

type editLeaseConflictHolderResponse struct {
	Label     string    `json:"label"`
	Since     time.Time `json:"since"`
	ExpiresAt time.Time `json:"expires_at"`
}

func editLeaseConflictHolder(lease EditLease) editLeaseConflictHolderResponse {
	return editLeaseConflictHolderResponse{
		Label:     editLeaseCoordinationLabel(lease.HolderLabel),
		Since:     lease.AcquiredAt,
		ExpiresAt: lease.ExpiresAt,
	}
}

// AssertRequestEditable is the lease check other packages call.
//
// Takes the REQUEST rather than a holder id so `leaseHolderFromRequest` stays
// the single definition of who is asking. A second package deriving its own
// holder identity is how the same person ends up locked out of their own
// campaign on one route and not another — the drift this whole layer exists to
// remove, reintroduced one level down.
//
// Returns nil when nothing is held, when the lease has expired, or when the
// caller is the holder. A READ failure also returns nil: the lease is advisory,
// and failing closed would let an unrelated outage look like a permanent lock.
func (d *Deps) AssertRequestEditable(r *http.Request, tenantID, campaignID string) error {
	if d == nil || d.Repo == nil {
		return nil
	}
	holderID, _ := leaseHolderFromRequest(r)
	err := d.Repo.AssertEditableBy(r.Context(), tenantID, campaignID, holderID)
	var held *ErrEditLeaseHeld
	if errors.As(err, &held) {
		return held
	}
	return nil
}

// refuseIfLeaseHeld writes a 409 and reports true when another editor holds the
// campaign.
//
// One line per guarded handler. The alternative — repeating the errors.As, the
// status choice and the envelope at every site — is how the same refusal ends up
// worded three ways and returned with two different statuses, which a client
// then has to special-case per route.
func (d *Deps) refuseIfLeaseHeld(w http.ResponseWriter, r *http.Request, tenantID, campaignID string) bool {
	err := d.AssertRequestEditable(r, tenantID, campaignID)
	if err == nil {
		return false
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": map[string]any{"code": "edit_lease_held", "message": err.Error()},
	})
	return true
}
