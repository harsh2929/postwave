// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"net/http"
	"strings"
)

// ProtectCredentialResponses covers the two non-MCP paths that return
// reusable credential/key identity material. It is path-conditional so it can
// be mounted before authentication and protect early 401/403 responses too.
func ProtectCredentialResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isCredentialResponsePath(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &credentialResponseWriter{ResponseWriter: w}
		prepareCredentialResponse(protected)
		r.Header.Del("If-None-Match")
		r.Header.Del("If-Modified-Since")
		next.ServeHTTP(protected, r)
	})
}

func isCredentialResponsePath(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	return path == "/api/v1/streams/token" || path == "/api/v1/api-keys/me"
}

func prepareCredentialResponse(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Cache-Control", "private, no-store")
	header.Set("Pragma", "no-cache")
	header.Del("ETag")
	header.Del("Last-Modified")
	header.Del("Expires")
	addCredentialVary(header, "Authorization")
	addCredentialVary(header, "Cookie")
}

func addCredentialVary(header http.Header, dimension string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), dimension) {
				return
			}
		}
	}
	header.Add("Vary", dimension)
}

type credentialResponseWriter struct{ http.ResponseWriter }

func (w *credentialResponseWriter) WriteHeader(status int) {
	prepareCredentialResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *credentialResponseWriter) Write(body []byte) (int, error) {
	prepareCredentialResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

func (w *credentialResponseWriter) Flush() {
	prepareCredentialResponse(w.ResponseWriter)
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *credentialResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
