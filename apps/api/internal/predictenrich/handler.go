// SPDX-License-Identifier: AGPL-3.0-only
//
// Package predictenrich is a thin in-process handler that fronts the
// deliverability service's /v1/predict endpoint. Its sole job is to
// SERVER-SIDE inject the tenant's rolling-30-day EQ-Score average
// into the request body before forwarding upstream.
//
// Why this is not a serviceproxy.Director hook:
//
//   * serviceproxy uses httputil.ReverseProxy which streams the
//     request body — it doesn't expose a "read body, modify JSON,
//     re-encode" hook without significantly complicating the shared
//     utility (which 12 other routes also use).
//
//   * The enrichment is one route only. Inlining the JSON
//     read/modify/write here keeps the shared proxy stupid and the
//     enrichment isolated.
//
// Why we don't trust the client-supplied avg_eq_score_last_30d:
//
//   * The placement-predictor's engagement risk has a 25-point swing
//     between the worst (D/F grade pattern, +0.15 risk) and best
//     (A grade pattern, -0.10 risk) EQ bands. A client could lie and
//     game its prediction. We strip whatever the client sent and
//     authoritatively inject the value from the eq_score_history
//     table under the request's resolved tenant.

package predictenrich

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/eqscore"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// Deps wires the handler.
type Deps struct {
	Pool            *db.Pool
	UpstreamBaseURL string // e.g. "http://deliverability:8080"
	UpstreamPath    string // e.g. "/v1/predict"
	InternalToken   string // bearer for upstream
	// HTTPClient is exposed for testing; falls back to a 10s-timeout
	// client when nil.
	HTTPClient *http.Client
	// Logger is used by httperror.WriteInternal to record server-side
	// failure detail without leaking err.Error() to API callers.
	// Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MaxBodyBytes caps the request body to prevent a malicious client
// from exhausting memory during the JSON round-trip. 1 MiB is plenty
// for a placement predict body (HTML drafts cap well below this in
// the editor).
const MaxBodyBytes = 1 << 20 // 1 MiB

// Handler returns an http.HandlerFunc that:
//
//  1. Reads the request body (capped).
//  2. Parses as JSON; if a `history` object exists, ensures the
//     `avg_eq_score_last_30d` field is replaced with the tenant's
//     real rolling average (computed via eqscore.AvgScoreLast30d).
//     When `history` is absent we synthesise one carrying just the
//     EQ field, since the predictor accepts a zero-value
//     HistoricalEngagement as "no engagement data."
//  3. Re-encodes and forwards to the upstream deliverability
//     service with the InternalAPIToken header.
//  4. Streams the upstream response back unchanged.
func (d *Deps) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
			return
		}
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", r.Method)
			return
		}
		body, err := httpbody.ReadJSONAtMost(r, MaxBodyBytes, httpbody.Options{})
		if err != nil {
			httpbody.WriteError(w, err)
			return
		}
		var document map[string]any
		if err := httpbody.DecodeJSONValue(body, &document, httpbody.Options{AllowUnknownFields: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
		// An environment that does not run the deliverability service loads
		// its URL as empty (config.ServiceNotDeployed). That is a fact about
		// the deployment, answered the way the proxied sidecar routes answer
		// it, not an internal error to log and alert on for every call.
		if strings.TrimSpace(d.UpstreamBaseURL) == "" {
			httperror.WriteUnavailable(w, "service_not_deployed",
				"This feature isn't available in this environment.", false)
			return
		}
		enriched, err := d.injectEQHistory(r.Context(), t.ID, body)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if err := d.forward(w, r, enriched); err != nil {
			// Upstream error text (deliverability service URL / pgx
			// failures bubbled up) is not safe to echo; log it server
			// side and return the generic envelope.
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
}

// injectEQHistory parses the body, replaces history.avg_eq_score_last_30d
// with the tenant's authoritative average, and returns the
// re-encoded JSON. Handler validates the bounded JSON document before this
// method runs, so malformed requests never consume an upstream request slot.
func (d *Deps) injectEQHistory(ctx context.Context, tenantID string, body []byte) ([]byte, error) {
	avg, has, err := eqscore.AvgScoreLast30d(ctx, d.Pool, tenantID)
	if err != nil {
		// A lookup failure is non-fatal — the predictor downgrades to
		// the "no EQ history" branch gracefully. Forward without
		// injection rather than fail the whole request.
		observability.EQScoreAvgInjectedTotal.WithLabelValues("lookup_failed").Inc()
		return body, nil
	}
	if !has {
		// No grading history → leave the body alone so the
		// "AvgEQScoreLast30d == 0" path in the predictor fires.
		observability.EQScoreAvgInjectedTotal.WithLabelValues("no_history").Inc()
		return body, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("decode validated prediction body: %w", err)
	}
	hist, ok := doc["history"].(map[string]any)
	if !ok {
		hist = map[string]any{}
	}
	// Always overwrite — a client-supplied value cannot game the
	// engagement-risk component.
	hist["avg_eq_score_last_30d"] = avg
	doc["history"] = hist
	observability.EQScoreAvgInjectedTotal.WithLabelValues("injected").Inc()
	return json.Marshal(doc)
}

// forward proxies the request to the upstream deliverability service.
func (d *Deps) forward(w http.ResponseWriter, r *http.Request, body []byte) error {
	if d.UpstreamBaseURL == "" {
		return errors.New("upstream base url not configured")
	}
	url := strings.TrimRight(d.UpstreamBaseURL, "/") + d.UpstreamPath
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if d.InternalToken != "" {
		req.Header.Set("Authorization", "Bearer "+d.InternalToken)
	}
	// Propagate the trace context if present. The serviceproxy does
	// more here (strips sensitive headers, adds tenant/user headers)
	// but for placement predict the upstream only needs the body +
	// internal token.
	for _, h := range []string{"X-Request-Id", "Traceparent", "Tracestate"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	// Copy headers + status + body verbatim.
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
	return nil
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
