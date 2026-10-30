// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The redemption webhook (PRD F04).
//
// "Redemption webhook at /v1/codes/redeem so the customer's commerce system
// reports use."
//
// The caller is the CUSTOMER'S system, not a browser, so this is authenticated
// like any other server-to-server write rather than by a token in a link. It is
// also the endpoint whose whole purpose is to attribute revenue to a campaign
// nobody clicked — so the response states explicitly whether the attribution was
// made without a preceding click, because that is the fact the feature exists to
// establish and a caller should be able to assert on it rather than infer it.

// Deps carries the redemption HTTP surface.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// MountRoutes registers the redemption webhook.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.With(
		apikeys.RequireAuthMethod(apikeys.AuthMethodAPIKey),
		apikeys.RequireScope(apikeys.ScopeAdmin),
	).Post("/api/v1/codes/redeem", d.Redeem)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/campaigns/{campaign}/direct-attribution-evidence", d.ListCampaignEvidence)
}

type redeemRequest struct {
	Code         string     `json:"code"`
	AssignmentID string     `json:"assignment_id,omitempty"`
	AmountCents  *int64     `json:"amount_cents,omitempty"`
	Currency     string     `json:"currency,omitempty"`
	OccurredAt   *time.Time `json:"occurred_at,omitempty"`
}

const maxRedeemCodeBytes = 512

// ReplayBodyLimit keeps the global replay middleware from buffering its 40 MiB
// attachment ceiling for this narrow commerce JSON mutation before the handler
// can apply its own 8 KiB decoder cap.
func ReplayBodyLimit(r *http.Request) int64 {
	if r != nil && r.Method == http.MethodPost && r.URL.EscapedPath() == "/api/v1/codes/redeem" {
		return 8 << 10
	}
	return 0
}

func validRedeemCode(value string) bool {
	if value == "" || len(value) > maxRedeemCodeBytes || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func requireRedemptionIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values(idempotency.HeaderName)
	if len(values) == 0 {
		httperror.Write(w, http.StatusBadRequest, "idempotency_key_required",
			"Exactly one Idempotency-Key is required so a transport retry cannot record the outcome twice.")
		return false
	}
	if len(values) != 1 || !idempotency.ValidKey(values[0]) {
		httperror.Write(w, http.StatusBadRequest, "invalid_idempotency_key",
			"Idempotency-Key must be supplied exactly once as 1-255 valid UTF-8 bytes without whitespace padding or controls.")
		return false
	}
	return true
}

// Redeem records a redemption reported by the customer's commerce system.
func (d *Deps) Redeem(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	if !requireRedemptionIdempotencyKey(w, r) {
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	if _, ok := idempotency.StorageKeyFromContext(r.Context()); !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "idempotency_boundary_unavailable",
			"redemption ingestion is unavailable because its durable replay boundary is not active")
		return
	}
	if _, ok := idempotency.RequestHashFromContext(r.Context()); !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "idempotency_boundary_unavailable",
			"redemption ingestion is unavailable because its request identity was not established")
		return
	}

	var in redeemRequest
	if err := httpbody.DecodeJSONWith(w, r, 8<<10, &in, httpbody.Options{
		AllowMissingContentType: true,
		AllowUnknownFields:      false,
	}); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_request", "request body must be one strict JSON object")
		return
	}
	code := strings.TrimSpace(in.Code)
	if !validRedeemCode(code) {
		httperror.Write(w, http.StatusBadRequest, "invalid_code", "code must contain 1-512 valid UTF-8 bytes without control characters")
		return
	}
	assignmentID := strings.TrimSpace(in.AssignmentID)
	if assignmentID != "" {
		if parsed, err := uuid.Parse(assignmentID); err != nil || parsed.Version() == 0 {
			httperror.Write(w, http.StatusBadRequest, "invalid_assignment_id", "assignment_id must be an opaque UUID returned by allocation")
			return
		}
	}
	currency := strings.ToUpper(strings.TrimSpace(in.Currency))
	if in.AmountCents == nil && currency != "" {
		httperror.Write(w, http.StatusBadRequest, "currency_without_amount", "currency is allowed only when amount_cents is supplied")
		return
	}
	if in.AmountCents != nil {
		if *in.AmountCents < 0 {
			httperror.Write(w, http.StatusBadRequest, "invalid_amount", "amount_cents must be zero or greater for a redemption")
			return
		}
		if len(currency) != 3 || currency[0] < 'A' || currency[0] > 'Z' ||
			currency[1] < 'A' || currency[1] > 'Z' || currency[2] < 'A' || currency[2] > 'Z' {
			httperror.Write(w, http.StatusBadRequest, "invalid_currency", "currency must be a three-letter uppercase ISO 4217 code")
			return
		}
	}

	redemption := Redemption{
		Code:         code,
		AssignmentID: assignmentID,
		Currency:     currency,
		Source:       "commerce_webhook",
	}
	if in.AmountCents != nil {
		redemption.AmountCents = in.AmountCents
	}
	if in.OccurredAt != nil {
		// Caller-supplied time is honoured: a commerce system reporting yesterday's
		// redemption today must not have it dated today, or the conversion lands
		// outside the window it belongs to.
		redemption.OccurredAt = in.OccurredAt.UTC()
		if redemption.OccurredAt.After(time.Now().UTC().Add(5 * time.Minute)) {
			httperror.Write(w, http.StatusBadRequest, "occurred_at_in_future", "occurred_at cannot be more than five minutes in the future")
			return
		}
	}

	result, err := d.Repo.Record(r.Context(), t.ID, redemption)
	if err != nil {
		d.writeError(w, r, err)
		return
	}

	var conversionID any
	if result.ConversionID != 0 {
		conversionID = result.ConversionID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recorded":          true,
		"campaign_id":       result.CampaignID,
		"assignment_id":     result.AssignmentID,
		"attributed_via":    AttributedViaCodeRedemption,
		"attribution_scope": result.AttributionScope,
		"linked_without_recorded_assignment_click": result.LinkedWithoutRecordedAssignmentClick,
		"readership_proven":                        false,
		"conversion_id":                            conversionID,
	})
}

func (d *Deps) writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrUnknownCode):
		// 404 rather than 400: an unknown code and a malformed one are different
		// facts to the caller's retry logic — one is permanent, the other is a bug
		// in their request.
		httperror.Write(w, http.StatusNotFound, "unknown_code", "code or assignment was not recognised")
	case errors.Is(err, ErrCodeExpired):
		httperror.Write(w, http.StatusGone, "code_expired", "code has expired")
	case errors.Is(err, ErrAlreadyRedeemed):
		// 409, and the code is named: a single-use code redeemed twice is the
		// commerce system's own duplicate, and it needs to tell those apart from a
		// transport retry it should repeat.
		httperror.Write(w, http.StatusConflict, "already_redeemed", "code assignment has already been redeemed; replay the original Idempotency-Key for its receipt")
	case errors.Is(err, ErrAmbiguousCode):
		httperror.Write(w, http.StatusConflict, "ambiguous_code", "code matches multiple assignments; retry with the opaque assignment_id returned by allocation")
	case errors.Is(err, ErrCodeUnavailable):
		httperror.Write(w, http.StatusConflict, "code_unavailable", "code assignment is not in a redeemable state")
	case errors.Is(err, ErrAttributionUnavailable):
		httperror.Write(w, http.StatusUnprocessableEntity, "attribution_linkage_unavailable", "code assignment does not have one verifiable campaign and discount linkage")
	default:
		httperror.WriteInternal(w, d.log(), err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
