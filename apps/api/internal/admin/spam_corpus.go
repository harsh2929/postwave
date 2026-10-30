// SPDX-License-Identifier: AGPL-3.0-only
//
// spam_corpus.go owns the operator-only HTTP endpoint that streams a
// labeled (text, isSpam) spam corpus extracted from
// email_events ⨝ seedlist_outcomes for the deliverability scanner's
// calibration trainer.
//
// The production data extraction lives in
// services/deliverability/internal/content/corpus.Exporter — the same
// package the deliverability service uses for its CLI corpus dump.
// apps/api can't import that package directly (different Go module),
// so this file declares a narrow Sample type + SpamCorpusExporter
// interface that main.go satisfies by either:
//
//  1. Proxying to the deliverability service's own
//     POST /api/internal/deliverability/spam-corpus/export route
//     (preferred — keeps the SQL with the package that owns it), or
//  2. Calling the corpus.Exporter directly via the workspace
//     (acceptable for a single-binary deploy where both services
//     share a database pool).
//
// Either way the HTTP shape stays the same and ops can pull labeled
// corpus on demand instead of shelling into a deliverability server.
//
// Auth: same Bearer-token pattern as the kms-rewrap endpoints
// (cfg.InternalAPIToken via Deps.authorize). Routes mount on the
// top-level router (no tenant middleware) next to /api/internal/admin/kms/*.
//
// Response shape: `?format=csv` returns text/csv with header
// `text,label,source,sample_at` streamed row-by-row; `?format=json`
// returns a JSON array. Default is csv (the trainer's expected input
// format).
package admin

import (
	"context"
	"encoding/csv"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Sample mirrors corpus.Sample's shape without the cross-module
// import. main.go's adapter is responsible for the projection so this
// package stays free of deliverability internals.
type Sample struct {
	Text     string    `json:"text"`
	Subject  string    `json:"subject,omitempty"`
	BodyHTML string    `json:"body_html,omitempty"`
	IsSpam   bool      `json:"is_spam"`
	Source   string    `json:"source"`
	SampleAt time.Time `json:"sample_at"`
}

// SpamCorpusExporter is the narrow surface the admin endpoint
// consumes. Implementations live in apps/api/main.go and either
// proxy to the deliverability service or call corpus.Exporter
// directly via the workspace.
type SpamCorpusExporter interface {
	// Export returns labeled (text, isSpam) samples whose
	// sample_at >= since. limit <= 0 means "no cap".
	Export(ctx context.Context, since time.Time, limit int) ([]Sample, error)
}

// SpamCorpusDeps wires the admin endpoint. InternalAPIToken /
// AllowDevToken / Logger are shared with the KMS rewrap surface.
type SpamCorpusDeps struct {
	Exporter         SpamCorpusExporter
	InternalAPIToken string
	AllowDevToken    bool
	Logger           *slog.Logger

	// Default since-window applied when the request has no
	// ?since query param. 30d is the spam-corpus CLI default.
	DefaultSince time.Duration
}

const spamCorpusExportJSONMaxBodyBytes int64 = 64 << 10

// MountRoutes registers POST /api/internal/admin/spam-corpus/export
// on r. Caller mounts on the top-level router (no tenant middleware)
// so the route sits next to /api/internal/admin/kms/*.
func (d *SpamCorpusDeps) MountRoutes(r chi.Router) {
	r.Method(http.MethodPost, "/api/internal/admin/spam-corpus/export",
		http.HandlerFunc(d.exportHandler))
}

// exportRequest is the JSON body shape. since/limit/format may also
// be supplied as query params; body wins when both are present so
// ops can curl with a single bearer-protected POST.
type exportRequest struct {
	Since  string `json:"since,omitempty"`  // YYYY-MM-DD or RFC3339
	Limit  int    `json:"limit,omitempty"`  // 0 = no cap
	Format string `json:"format,omitempty"` // csv | json (default csv)
}

func (d *SpamCorpusDeps) exportHandler(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "unauthorized"},
		})
		return
	}
	if d.Exporter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]any{"code": "exporter_not_configured", "message": "spam corpus exporter not wired"},
		})
		return
	}

	// Body is optional — empty body falls back to defaults.
	var req exportRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := httpbody.DecodeJSON(w, r, spamCorpusExportJSONMaxBodyBytes, &req); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	// Query-param fallback.
	q := r.URL.Query()
	if req.Since == "" {
		req.Since = q.Get("since")
	}
	if req.Limit == 0 {
		if v := q.Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				req.Limit = n
			}
		}
	}
	if req.Format == "" {
		req.Format = q.Get("format")
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "csv"
	}
	if format != "csv" && format != "json" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"code": "bad_format", "message": "format must be csv or json"},
		})
		return
	}

	since, err := parseSince(req.Since, d.defaultSince())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"code": "bad_since", "message": err.Error()},
		})
		return
	}

	samples, err := d.Exporter.Export(r.Context(), since, req.Limit)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("spam corpus export failed", "err", err.Error())
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "export_failed", "message": "an internal error occurred"},
		})
		return
	}
	if req.Limit > 0 && len(samples) > req.Limit {
		samples = samples[:req.Limit]
	}

	switch format {
	case "json":
		writeJSON(w, http.StatusOK, samples)
	default:
		writeCSV(w, samples)
	}
}

// authorize mirrors the KMS rewrap admin endpoint's bearer-token check.
func (d *SpamCorpusDeps) authorize(r *http.Request) bool {
	if d.AllowDevToken {
		return true
	}
	want := strings.TrimSpace(d.InternalAPIToken)
	if want == "" {
		return false
	}
	got := r.Header.Get("Authorization")
	if !strings.HasPrefix(got, "Bearer ") {
		return false
	}
	got = strings.TrimSpace(strings.TrimPrefix(got, "Bearer "))
	return got == want
}

func (d *SpamCorpusDeps) defaultSince() time.Duration {
	if d.DefaultSince > 0 {
		return d.DefaultSince
	}
	return 30 * 24 * time.Hour
}

// parseSince accepts either a YYYY-MM-DD date (UTC), a full RFC3339
// timestamp, or empty (which falls back to now - def). Returns the
// computed since timestamp in UTC.
func parseSince(raw string, def time.Duration) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Now().UTC().Add(-def), nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("since must be YYYY-MM-DD or RFC3339, got %q", raw)
}

// writeCSV streams the corpus as text/csv. Columns: text,label,source,sample_at.
// "label" is the trainer-friendly "spam" / "ham" string, not the bool —
// matches what the deliverability calibrator's CLI accepts as input.
func writeCSV(w http.ResponseWriter, samples []Sample) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="spam_corpus.csv"`)
	w.WriteHeader(http.StatusOK)

	c := csv.NewWriter(w)
	defer c.Flush()
	_ = c.Write([]string{"text", "label", "source", "sample_at"})
	for _, s := range samples {
		label := "ham"
		if s.IsSpam {
			label = "spam"
		}
		_ = c.Write([]string{
			csvCell(s.Text),
			label,
			csvCell(s.Source),
			s.SampleAt.UTC().Format(time.RFC3339),
		})
	}
}

func csvCell(value string) string {
	visible := strings.TrimLeft(value, " \t\r\n")
	if visible == "" {
		return value
	}
	switch visible[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}
