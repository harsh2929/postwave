package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// allowedListmonkPaths whitelists which Listmonk endpoints we proxy.
// Per LICENSE-BOUNDARY.md, the only contact between Moosewave application code
// and the separate AGPL Listmonk process is HTTP, so every exposed path is
// intentional.
var allowedListmonkPaths = map[string]struct{}{
	"/api/health": {},
}

// safeUpstreamResponseHeaders is the allowlist of response headers we copy
// from Listmonk back to our caller. Everything else is dropped — Listmonk's
// Set-Cookie, Server, WWW-Authenticate, and X-Listmonk-* fingerprint
// headers never need to reach Moosewave clients, and forwarding any of them
// would either fix a session at our domain (Set-Cookie under our eTLD+1)
// or leak engine internals.
//
// To add a header here: confirm it's needed by an actual client AND
// doesn't carry server identity / session state.
var safeUpstreamResponseHeaders = map[string]struct{}{
	"content-type":     {},
	"etag":             {},
	"cache-control":    {},
	"last-modified":    {},
	"vary":             {},
	"content-language": {},
}

// ListmonkProxy returns an http.HandlerFunc that proxies a single whitelisted
// path to a running Listmonk instance at base. It is deliberately minimal:
// callers pass the configured Listmonk API credentials for endpoints that
// require them, while richer routing lives in dedicated services.
func ListmonkProxy(base, path, username, password string) http.HandlerFunc {
	if _, ok := allowedListmonkPaths[path]; !ok {
		// Programming error: surface immediately at startup-handler-construction.
		return func(w http.ResponseWriter, r *http.Request) {
			writeProxyJSONError(w, http.StatusInternalServerError, "path_not_allowed", "listmonk path not whitelisted")
		}
	}

	client := &http.Client{Timeout: 5 * time.Second}

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeProxyJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
			return
		}
		if err := validateListmonkProxyBase(base); err != nil {
			slog.Error("listmonk proxy: unsafe base", "err", err, "base", redactURLForLog(base))
			writeProxyJSONError(w, http.StatusInternalServerError, "bad_upstream_url", "bad upstream url")
			return
		}
		target, err := url.JoinPath(base, path)
		if err != nil {
			slog.Error("listmonk proxy: build url", "err", err, "base", redactURLForLog(base), "path", path)
			writeProxyJSONError(w, http.StatusInternalServerError, "bad_upstream_url", "bad upstream url")
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
		if err != nil {
			slog.Error("listmonk proxy: build request", "err", err)
			writeProxyJSONError(w, http.StatusInternalServerError, "bad_upstream_request", "bad upstream request")
			return
		}
		if username != "" || password != "" {
			req.SetBasicAuth(username, password)
		}

		resp, err := client.Do(req)
		if err != nil {
			slog.Warn("listmonk proxy: upstream unreachable", "err", err, "target", redactURLForLog(target))
			writeProxyJSONError(w, http.StatusBadGateway, "upstream_unreachable", "listmonk unreachable")
			return
		}
		defer func() { _ = resp.Body.Close() }()

		for k, vals := range resp.Header {
			if _, ok := safeUpstreamResponseHeaders[strings.ToLower(k)]; !ok {
				// Dropping by default catches any future Listmonk header
				// (Set-Cookie, Server, WWW-Authenticate, X-Listmonk-*
				// fingerprints, hop-by-hop) without an audit trail of
				// "what changed upstream".
				continue
			}
			for _, v := range vals {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			slog.Warn("listmonk proxy: copy body", "err", err)
		}
	}
}

func validateListmonkProxyBase(raw string) error {
	if strings.ContainsAny(raw, "\x00\r\n") {
		return url.InvalidHostError("unsafe base URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if !u.IsAbs() || u.Host == "" || u.User != nil {
		return url.InvalidHostError("unsafe base URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return url.InvalidHostError("unsafe base URL")
	}
	return nil
}

func writeProxyJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func redactURLForLog(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<invalid-url>"
	}
	u.User = nil
	q := u.Query()
	for _, key := range []string{"api_key", "apikey", "token", "password", "secret"} {
		if q.Has(key) {
			q.Set(key, "[redacted]")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}
