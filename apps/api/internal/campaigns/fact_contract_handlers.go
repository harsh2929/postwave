// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// factContractJSONMaxBodyBytes bounds both the handler decoder and the global
// replay middleware. Fact Contract v1 is structured authoring metadata, not an
// attachment surface; 256 KiB leaves ample room for a large fact inventory
// without allowing a keyed request to allocate the global 40 MiB ceiling.
const factContractJSONMaxBodyBytes int64 = 256 << 10

// FactContractReplayBodyLimit selects the exact normative authoring route for
// the global Idempotency-Key middleware's pre-hash body cap.
func FactContractReplayBodyLimit(r *http.Request) int64 {
	if r == nil || r.Method != http.MethodPut {
		return 0
	}
	path := r.URL.EscapedPath()
	if strings.HasPrefix(path, "/api/v1/campaigns/") && strings.HasSuffix(path, "/fact-contract") {
		return factContractJSONMaxBodyBytes
	}
	return 0
}

// requireFactContractIdempotencyKey rejects an absent, repeated, padded, or
// control-bearing key. The shared replay middleware treats the key as optional
// for legacy writes, so the normative Fact Contract endpoint must enforce its
// stronger route contract itself.
func requireFactContractIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values(idempotency.HeaderName)
	if len(values) == 0 {
		httperror.Write(w, http.StatusBadRequest, "idempotency_key_required",
			"Exactly one Idempotency-Key is required so retries cannot overwrite a newer Fact Contract.")
		return false
	}
	if len(values) != 1 || !idempotency.ValidKey(values[0]) {
		httperror.Write(w, http.StatusBadRequest, "invalid_idempotency_key",
			"Idempotency-Key must be supplied exactly once as 1-255 valid UTF-8 bytes without whitespace padding or controls.")
		return false
	}
	return true
}

// requireFactContractIfMatch accepts exactly one strong ETag. Missing and
// wildcard validators cannot protect an edit and return 428; weak, malformed,
// or list validators can never satisfy strong If-Match comparison and return
// 412. Keeping this strict avoids inheriting ParseIfMatch's documented legacy
// leniency on a new normative concurrency boundary.
func requireFactContractIfMatch(w http.ResponseWriter, r *http.Request) (string, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	raw := strings.TrimSpace(values[0])
	if raw == "" || raw == "*" {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	if len(values) != 1 || raw != values[0] || strings.HasPrefix(raw, "W/") ||
		strings.Contains(raw, ",") || len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		httpcache.WritePreconditionFailed(w)
		return "", false
	}
	return raw, true
}

// SetFactContract is the dedicated §13.1 authoring boundary. Its request body
// is the Fact Contract object itself (or {} to explicitly clear it), and its
// response is the updated campaign plus the new strong campaign ETag.
func (d *Deps) SetFactContract(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	if !requireFactContractIdempotencyKey(w, r) {
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	if _, ok := idempotency.StorageKeyFromContext(r.Context()); !ok {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("idempotency_boundary_unavailable",
			"Fact Contract authoring is unavailable because its durable replay boundary is not active"))
		return
	}
	if _, ok := idempotency.RequestHashFromContext(r.Context()); !ok {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("idempotency_boundary_unavailable",
			"Fact Contract authoring is unavailable because its request identity was not established"))
		return
	}
	campaignID := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(campaignID); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_campaign_id", "campaign id must be a UUID")
		return
	}
	ifMatch, ok := requireFactContractIfMatch(w, r)
	if !ok {
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("campaign_repository_unavailable", "campaign repository unavailable"))
		return
	}
	if d.refuseIfLeaseHeld(w, r, t.ID, campaignID) {
		return
	}

	var contract json.RawMessage
	if err := httpbody.DecodeJSONWith(w, r, factContractJSONMaxBodyBytes, &contract, httpbody.Options{
		AllowMissingContentType: true,
		AllowUnknownFields:      false,
	}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(contract) == 0 {
		httperror.Write(w, http.StatusBadRequest, "invalid_json", "request body must be one Fact Contract JSON object")
		return
	}

	campaign, err := d.Repo.Update(r.Context(), t.ID, campaignID, UpdateInput{
		IfMatchToken: ifMatch,
		FactContract: append(json.RawMessage(nil), contract...),
	})
	if err != nil {
		if writeCampaignSemanticError(w, err) {
			return
		}
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "campaign not found")
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
		case errors.Is(err, ErrCampaignDispatching):
			httperror.Write(w, http.StatusConflict, "campaign_dispatching",
				"this campaign has started sending; its Fact Contract can no longer be changed")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}

	w.Header().Set("ETag", httpcache.ConcurrencyToken("campaign", campaign.ID, campaign.UpdatedAt))
	d.emit(t.ID, "campaign.fact_contract.updated", map[string]any{
		"id": campaign.ID,
	})
	writeJSON(w, http.StatusOK, campaign)
}
