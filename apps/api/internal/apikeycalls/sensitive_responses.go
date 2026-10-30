// SPDX-License-Identifier: AGPL-3.0-only
package apikeycalls

import (
	"net/http"
	"strings"
)

// ProtectMCPResponses applies the privacy boundary for every /api/v1/mcp
// response before authentication can short-circuit. It reasserts at commit
// time so shared error/cache writers cannot replace the policy.
func ProtectMCPResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isMCPRoute(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &mcpResponseWriter{ResponseWriter: w}
		prepareMCPResponse(protected)
		// Conditional requests can turn a credential-sensitive response into a
		// shared 304. MCP responses are intentionally never revalidated.
		r.Header.Del("If-None-Match")
		r.Header.Del("If-Modified-Since")
		next.ServeHTTP(protected, r)
	})
}

func prepareMCPResponse(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Cache-Control", "private, no-store")
	header.Set("Pragma", "no-cache")
	header.Del("ETag")
	header.Del("Last-Modified")
	header.Del("Expires")
	addMCPVary(header, "Authorization")
	addMCPVary(header, "Cookie")
}

func addMCPVary(header http.Header, dimension string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), dimension) {
				return
			}
		}
	}
	header.Add("Vary", dimension)
}

func isMCPRoute(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	return path == "/api/v1/mcp" || strings.HasPrefix(path, "/api/v1/mcp/")
}

type mcpResponseWriter struct {
	http.ResponseWriter
}

func (w *mcpResponseWriter) WriteHeader(status int) {
	prepareMCPResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *mcpResponseWriter) Write(body []byte) (int, error) {
	prepareMCPResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

func (w *mcpResponseWriter) Flush() {
	prepareMCPResponse(w.ResponseWriter)
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *mcpResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
