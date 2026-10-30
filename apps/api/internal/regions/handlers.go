// SPDX-License-Identifier: AGPL-3.0-only
package regions

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// MountPublicRoutes adds the unauthenticated region-discovery endpoint.
// SDKs and the web app use it to learn which region they're talking to
// (display in the UI; advertise data-residency to the user).
//
//	GET /api/regions/current — returns the deployment region + endpoints
//	GET /api/regions         — returns every supported region
//
// We intentionally do NOT expose the full Allowed() list behind auth —
// the picker that lets the operator choose a region for a new tenant
// is public so the marketing site can render it without an API key.
func MountPublicRoutes(r chi.Router) {
	r.Get("/api/regions/current", GetCurrent)
	r.Get("/api/regions", GetList)
}

// GetCurrent serves GET /api/regions/current.
func GetCurrent(w http.ResponseWriter, _ *http.Request) {
	cur := Current()
	ep := EndpointsFor(cur)
	writeJSON(w, http.StatusOK, map[string]any{
		"region":        string(cur),
		"is_eu":         IsEURegion(cur),
		"is_us":         IsUSRegion(cur),
		"sdk_host":      HostFor(cur),
		"postmark_base": ep.PostmarkBaseURL,
		"mailgun_base":  ep.MailgunBaseURL,
		"ses_region":    ep.SESRegion,
	})
}

// GetList serves GET /api/regions.
func GetList(w http.ResponseWriter, _ *http.Request) {
	out := make([]map[string]any, 0, len(Allowed()))
	for _, r := range Allowed() {
		out = append(out, map[string]any{
			"region":   string(r),
			"sdk_host": HostFor(r),
			"is_eu":    IsEURegion(r),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"regions": out})
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
