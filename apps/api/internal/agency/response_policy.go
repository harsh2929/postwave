// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"net/http"
	"strings"
)

// ProtectResponses is mounted both at the process root and on the agency
// routes. That ordering makes tenant, credential, CSRF, step-up,
// idempotency, 404, and method refusals just as private as handler responses.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAgencyPath(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &protectedResponseWriter{ResponseWriter: w}
		preparePrivateResponse(protected.Header())
		next.ServeHTTP(protected, r)
	})
}

func isAgencyPath(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	return path == "/api/v1/agency" || strings.HasPrefix(path, "/api/v1/agency/")
}

func preparePrivateResponse(header http.Header) {
	header.Set("Cache-Control", "private, no-store")
	header.Set("Pragma", "no-cache")
	header.Set("Expires", "0")
	header.Set("X-Content-Type-Options", "nosniff")
	addVary(header, "Authorization")
	addVary(header, "Cookie")
}

func addVary(header http.Header, dimension string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), dimension) {
				return
			}
		}
	}
	header.Add("Vary", dimension)
}

type protectedResponseWriter struct{ http.ResponseWriter }

func (w *protectedResponseWriter) WriteHeader(status int) {
	preparePrivateResponse(w.Header())
	w.ResponseWriter.WriteHeader(status)
}

func (w *protectedResponseWriter) Write(body []byte) (int, error) {
	preparePrivateResponse(w.Header())
	return w.ResponseWriter.Write(body)
}

func (w *protectedResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func setMutationOutcome(w http.ResponseWriter, outcome string) {
	w.Header().Set(MutationOutcomeHeader, outcome)
}

// MutationGlobalReplayBypass keeps release-held agency effects out of the
// generalized idempotency ledger. It is path/method-only and body-independent
// so even a malformed/duplicate legacy Idempotency-Key reaches the stable hold
// instead of replaying an historical response or creating a ledger record.
func MutationGlobalReplayBypass(r *http.Request, _ []byte) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := r.URL.EscapedPath()
	switch {
	case r.Method == http.MethodPost && path == "/api/v1/agency/children":
		return true
	case r.Method == http.MethodPost && path == "/api/v1/agency/billing-mode":
		return true
	case r.Method == http.MethodPatch && path == "/api/v1/agency/branding":
		return true
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/api/v1/agency/children/"):
		child := strings.TrimPrefix(path, "/api/v1/agency/children/")
		return child != "" && !strings.Contains(child, "/")
	default:
		return false
	}
}

func writeNotCommitted(w http.ResponseWriter, status int, code, message string) {
	setMutationOutcome(w, mutationOutcomeNotCommitted)
	writeJSON(w, status, errEnv(code, message))
}
