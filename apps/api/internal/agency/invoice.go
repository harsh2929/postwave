// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// InvoicePreview is deliberately release-held. The former implementation
// called a flat-rate event count an invoice preview, exposed no fixed temporal
// cutoff, had no pagination, and depended on a caller-controlled cross-tenant
// RLS bypass. There is no consolidated invoice processor consuming the stored
// billing mode. Returning no estimate is safer than manufacturing financial
// truth from an unqualified proxy.
func (d *Deps) InvoicePreview(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.requireAgencyTenant(r.Context(), tenant.ID); err != nil {
		if errors.Is(err, errNotAgency) {
			writeNotAgencyDenial(w)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if code, message := validateInvoiceQuery(r); code != "" {
		writeJSON(w, http.StatusBadRequest, errEnv(code, message))
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, errEnv(
		"agency_invoice_preview_release_hold",
		"invoice preview is unavailable until consolidated billing has a fixed rated ledger, temporal cutoff, and payer authority; no estimate was generated",
	))
}

func validateInvoiceQuery(r *http.Request) (string, string) {
	query := r.URL.Query()
	for key := range query {
		if key != "days" {
			return "unknown_query_parameter", "only days is supported"
		}
		if len(query[key]) != 1 {
			return "duplicate_query_parameter", key + " must be supplied at most once"
		}
	}
	if raw := strings.TrimSpace(query.Get("days")); raw != "" {
		days, err := strconv.Atoi(raw)
		if err != nil || days < 1 || days > 365 {
			return "invalid_days", "days must be an integer from 1 through 365"
		}
	}
	return "", ""
}
