// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ListCampaignEvidence returns the identity-minimized F04 operator register.
// It is deliberately mounted independently of CouponAllocationAvailable: this
// route can observe receipts and cannot mint, release, redeem or mutate one.
func (d *Deps) ListCampaignEvidence(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}

	input, err := parseCampaignEvidenceQuery(r)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	page, err := d.Repo.ListCampaignEvidence(
		r.Context(), tenant.ID, strings.TrimSpace(chi.URLParam(r, "campaign")), input,
	)
	if err != nil {
		if errors.Is(err, ErrInvalidEvidenceInput) {
			httperror.Write(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		if errors.Is(err, ErrEvidenceNotFound) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "campaign was not found")
			return
		}
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func parseCampaignEvidenceQuery(r *http.Request) (CampaignEvidenceInput, error) {
	var out CampaignEvidenceInput
	query := r.URL.Query()
	for _, name := range []string{"limit", "offset"} {
		values, present := query[name]
		if !present {
			continue
		}
		if len(values) != 1 || strings.TrimSpace(values[0]) != values[0] || values[0] == "" {
			return out, errors.New(name + " must be specified exactly once without surrounding whitespace")
		}
		value, err := strconv.Atoi(values[0])
		if err != nil {
			return out, errors.New(name + " must be a base-10 integer")
		}
		if name == "limit" {
			// Zero is the in-process sentinel for an omitted limit. An explicit
			// ?limit=0 must not be silently reinterpreted as the default page.
			if value == 0 {
				return out, errors.New("limit must be between 1 and " + strconv.Itoa(MaxCampaignEvidenceLimit))
			}
			out.Limit = value
		} else {
			out.Offset = value
		}
	}
	return normalizeCampaignEvidenceInput(out)
}
