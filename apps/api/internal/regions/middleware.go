// SPDX-License-Identifier: AGPL-3.0-only

package regions

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// LookupTenantRegion is the function signature EnforceRegion takes for
// resolving the tenant's pinned region from its id. We accept a
// callback (rather than a *db.Pool) so this package stays free of the
// db import and so tests can plug in a trivial map-backed lookup.
type LookupTenantRegion func(tenantID string) (Region, error)

// EnforceRegion is the chi middleware that fronts every tenant-scoped
// route. It runs AFTER middleware.TenantMiddleware (so a Tenant is on
// ctx) and refuses requests whose tenant.data_region != Current()
// with 421 Misdirected Request. The 421 body carries a Location-style
// pointer in the JSON envelope so SDKs can autodiscover the right
// host without re-parsing headers — but we also set Location and
// X-Postwave-Region so curl, wget, and proxies behave too.
//
//	r.Use(regions.EnforceRegion(func(id string) (regions.Region, error) {
//	    var s string
//	    err := pool.QueryRow(ctx,
//	        `SELECT data_region FROM tenants WHERE id = $1::uuid`, id,
//	    ).Scan(&s)
//	    return regions.Region(s), err
//	}))
//
// Pass-through cases:
//   - No tenant on ctx (a public endpoint accidentally inside the
//     group): we don't have anything to enforce, so we let it through.
//     middleware.TenantMiddleware would already have 401'd before us
//     in normal layering; this is just a belt-and-braces guard.
//   - Lookup error: we fail closed with 500 rather than serving data
//     from a tenant whose region we couldn't confirm.
func EnforceRegion(getTenantRegion LookupTenantRegion) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t, ok := middleware.TenantFromContext(r.Context())
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			tenantRegion, err := getTenantRegion(t.ID)
			if err != nil {
				writeRegionErr(w, http.StatusInternalServerError,
					"region_lookup_failed",
					"could not resolve tenant data region",
					"")
				return
			}
			here := Current()
			if tenantRegion != here {
				correct := HostFor(tenantRegion)
				w.Header().Set("Location", correct)
				w.Header().Set("X-Postwave-Region", string(tenantRegion))
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusMisdirectedRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code": "wrong_region",
						"message": fmt.Sprintf(
							"this tenant's data lives in %s; retry against %s",
							string(tenantRegion), correct,
						),
						"correct_endpoint": correct,
					},
				})
				return
			}
			ctx := WithRegion(r.Context(), tenantRegion)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// writeRegionErr is a thin local helper so we don't drag the handlers
// package's writeJSON/writeJSONErr (which is unexported) into this
// file. Keeping the envelope shape identical is a manual contract;
// see handlers/audit.go writeJSONErr for the canonical version.
func writeRegionErr(w http.ResponseWriter, status int, code, message, correct string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	body := map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	}
	if correct != "" {
		body["error"].(map[string]any)["correct_endpoint"] = correct
	}
	_ = json.NewEncoder(w).Encode(body)
}
