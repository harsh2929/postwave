// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP surface for retention offers.
//
// Production routes expose historical reporting only. Paid retention-offer
// mutations and portal acceptance remain unmounted until a real Stripe
// adapter and reconciliation are certified.
//
// Endpoint summary:
//
//	GET    /api/v1/retention-offers                       — admin list
//	GET    /api/v1/retention-offers/funnel                — admin funnel

package retention_offers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP layer to the Repo.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

const offersJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB

const (
	readSetTooLargeCode        = "result_set_too_large"
	readSetTooLargeMessage     = "the complete retention-offer result exceeds the 1000-row API limit; no partial data was returned"
	storedOfferInvalidCode     = "stored_offer_contract_invalid"
	storedOfferInvalidMessage  = "stored retention-offer data violates the bounded API contract; no partial data was returned"
	storedFunnelInvalidCode    = "stored_funnel_contract_invalid"
	storedFunnelInvalidMessage = "stored retention-offer funnel data violates the bounded API contract; no partial data was returned"
)

// MountRoutes registers read-only admin history/configuration GETs on the
// provided router. Caller decides which scope guards to apply by wrapping `r`
// first. The mutation and portal handlers below remain deliberately unmounted
// pending provider-adapter and reconciliation certification.
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/v1/retention-offers", d.List)
	r.Get("/api/v1/retention-offers/funnel", d.Funnel)
	r.Get("/api/v1/retention-offers/winback-settings", d.GetWinbackSettings)
}

// List GET /api/v1/retention-offers — admin all-rows.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListOffers(r.Context(), t.ID)
	if err != nil {
		if writeReadSetTooLarge(w, err) {
			return
		}
		if writeStoredOfferInvalid(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"offers": out, "count": len(out)})
}

// Upsert POST /api/v1/retention-offers — admin create/update.
func (d *Deps) Upsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in OfferInput
	if err := httpbody.DecodeJSON(w, r, offersJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpsertOffer(r.Context(), t.ID, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrTierRequired),
			errors.Is(err, ErrAmountInvalid),
			errors.Is(err, ErrDurationRange):
			httperror.WriteValidation(w, "validation_failed", err.Error())
		case errors.Is(err, ErrOfferFieldInvalid):
			httperror.WriteValidation(w, "retention_offer_field_invalid", err.Error())
		case errors.Is(err, ErrTierConflict):
			httperror.Write(w, http.StatusConflict, "tier_conflict", err.Error())
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Deactivate DELETE /api/v1/retention-offers/{id}.
func (d *Deps) Deactivate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	if err := d.Repo.DeactivateOffer(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "offer not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Funnel GET /api/v1/retention-offers/funnel — admin tile counts.
func (d *Deps) Funnel(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.LoadFunnel(r.Context(), t.ID)
	if err != nil {
		if writeReadSetTooLarge(w, err) {
			return
		}
		if writeStoredFunnelInvalid(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tiles": out, "count": len(out)})
}

// writeReadSetTooLarge maps the repository's typed completeness guard to a
// stable, retry-independent client response. A 409 reflects that the current
// catalog state cannot be represented by this non-paginated endpoint; it is
// not a transient server failure and must never fall through to a generic 5xx.
func writeReadSetTooLarge(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, ErrReadSetTooLarge) {
		return false
	}
	httperror.Write(w, http.StatusConflict, readSetTooLargeCode, readSetTooLargeMessage)
	return true
}

func writeStoredOfferInvalid(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, ErrOfferFieldInvalid) {
		return false
	}
	httperror.Write(w, http.StatusConflict, storedOfferInvalidCode, storedOfferInvalidMessage)
	return true
}

func writeStoredFunnelInvalid(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, ErrFunnelProjectionInvalid) {
		return false
	}
	httperror.Write(w, http.StatusConflict, storedFunnelInvalidCode, storedFunnelInvalidMessage)
	return true
}

// LogEvent POST /api/v1/retention-offers/{id}/events. Used by the
// portal to record shown / declined / expired (accepted goes through
// PortalAccept so the Stripe Apply call lands too).
func (d *Deps) LogEvent(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	var in EventInput
	if err := httpbody.DecodeJSON(w, r, offersJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.LogEvent(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidEvent):
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_event", err.Error())
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// PortalLookupResponse is the modal-render payload.
type PortalLookupResponse struct {
	Offer       *Offer `json:"offer,omitempty"`
	AmountLabel string `json:"amount_label,omitempty"`
	HasOffer    bool   `json:"has_offer"`
}

// PortalLookup GET /api/v1/portal/retention-offer?tier_id=... — cancel
// modal opens by calling this first. Returns has_offer=false when no
// active offer is configured so the portal skips the modal.
func (d *Deps) PortalLookup(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tierID := strings.TrimSpace(r.URL.Query().Get("tier_id"))
	if tierID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_tier_id", "tier_id query param required")
		return
	}
	offer, err := d.Repo.LookupByTier(r.Context(), t.ID, tierID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resp := PortalLookupResponse{}
	if offer != nil {
		resp.Offer = offer
		resp.AmountLabel = offer.FormatAmount()
		resp.HasOffer = true
	}
	writeJSON(w, http.StatusOK, resp)
}

// PortalAcceptInput body for accept.
type PortalAcceptInput struct {
	OfferID              string `json:"offer_id"`
	PaidSubID            string `json:"paid_sub_id,omitempty"`
	SubscriberEmail      string `json:"subscriber_email,omitempty"`
	StripeSubscriptionID string `json:"stripe_subscription_id,omitempty"`
}

// PortalAccept POST /api/v1/portal/retention-offer/accept — the
// cancel-flow happy path. Logs the accept + applies the Stripe coupon.
// Returns the logged event so the portal can render a confirmation
// receipt and short-circuit the in-flight cancel.
func (d *Deps) PortalAccept(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PortalAcceptInput
	if err := httpbody.DecodeJSON(w, r, offersJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.OfferID) == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_offer_id", "offer_id required")
		return
	}
	ev, err := d.Repo.AcceptOffer(r.Context(), t.ID, in.OfferID, in.StripeSubscriptionID, EventInput{
		PaidSubID:       in.PaidSubID,
		SubscriberEmail: in.SubscriberEmail,
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"event":   ev,
		"applied": ev.StripeApplicationID != "",
	})
}

// PortalDeclineInput body for decline.
type PortalDeclineInput struct {
	OfferID         string `json:"offer_id"`
	PaidSubID       string `json:"paid_sub_id,omitempty"`
	SubscriberEmail string `json:"subscriber_email,omitempty"`
}

// PortalDecline POST /api/v1/portal/retention-offer/decline — the
// "no thanks, cancel anyway" branch. Records the decline event so the
// funnel rollup is symmetrical, then 200s — the portal's existing
// cancel flow takes over and completes the cancellation.
func (d *Deps) PortalDecline(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PortalDeclineInput
	if err := httpbody.DecodeJSON(w, r, offersJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.OfferID) == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_offer_id", "offer_id required")
		return
	}
	ev, err := d.Repo.LogEvent(r.Context(), t.ID, in.OfferID, EventInput{
		PaidSubID:       in.PaidSubID,
		SubscriberEmail: in.SubscriberEmail,
		EventType:       EventDeclined,
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "event": ev})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
