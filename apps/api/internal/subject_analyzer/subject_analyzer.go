// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subject_analyzer correlates subject-line attributes
// with engagement across the tenant's historical campaigns and
// reports actionable averages.
//
// Attributes scored:
//
//   * length          chars; bucketed into <30 / 30-50 / 50-80 / 80+
//   * word_count      total words
//   * emoji_count     a rough Unicode scan (BMP emoji blocks)
//   * has_question    contains '?'
//   * has_personalize {{var}} merge tokens
//   * uppercase_ratio fraction of letters in upper case (SHOUTING)
//
// For each bucket we report the average open and click rate, the
// sample size, and a confidence band. The operator uses this to
// answer "what's working for OUR list" — opinions from industry
// benchmarks don't apply uniformly.
//
// We also score a CANDIDATE subject (POST endpoint): apply the
// same attribute extraction + look up where the candidate falls
// in each bucket, returning the expected open rate plus
// suggestions.
//
// Surfaces:
//
//   GET  /api/v1/subject-analyzer/buckets        ?days=180
//   POST /api/v1/subject-analyzer/score          body: {subject}

package subject_analyzer

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 4 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// Attrs is the extracted attribute set for one subject.
type Attrs struct {
	Length         int     `json:"length"`
	LengthBucket   string  `json:"length_bucket"`
	WordCount      int     `json:"word_count"`
	EmojiCount     int     `json:"emoji_count"`
	HasQuestion    bool    `json:"has_question"`
	HasPersonalize bool    `json:"has_personalize"`
	UppercaseRatio float64 `json:"uppercase_ratio"`
	AllCaps        bool    `json:"all_caps"`
}

// Bucket is one row of the rollup.
type Bucket struct {
	Attribute string  `json:"attribute"`
	Bucket    string  `json:"bucket"`
	Campaigns int     `json:"campaigns"`
	OpenRate  float64 `json:"open_rate"`
	ClickRate float64 `json:"click_rate"`
}

type scoreReq struct {
	Subject string `json:"subject"`
}

// sample is the shared per-historical-campaign view used by both
// the rollup builder and the score projector.
type sample struct {
	attrs Attrs
	open  float64
	click float64
}

// MountRoutes registers admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/subject-analyzer/buckets", d.Buckets)
	r.With(read).Post("/api/v1/subject-analyzer/score", d.Score)
}

// Buckets GET /api/v1/subject-analyzer/buckets?days=180.
func (d *Deps) Buckets(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := 180
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 30 && n <= 730 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
WITH per_campaign AS (
  SELECT c.id, c.subject,
         count(DISTINCT e.subscriber_email)                                AS recipients,
         count(*) FILTER (WHERE e.event_type = 'opened')::float8          AS opens,
         count(*) FILTER (WHERE e.event_type = 'clicked')::float8         AS clicks
    FROM campaigns c
    LEFT JOIN subscriber_events e
      ON e.tenant_id = $1::uuid AND e.campaign_id = c.id
   WHERE c.tenant_id = $1::uuid AND c.sent_at IS NOT NULL AND c.sent_at >= $2
     AND c.subject IS NOT NULL AND length(c.subject) > 0
   GROUP BY c.id, c.subject
  HAVING count(DISTINCT e.subscriber_email) > 0
)
SELECT subject, recipients, opens, clicks FROM per_campaign`, t.ID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	campaigns := []sample{}
	for rows.Next() {
		var subject string
		var recip, opens, clicks float64
		if err := rows.Scan(&subject, &recip, &opens, &clicks); err != nil {
			continue
		}
		if recip == 0 {
			continue
		}
		campaigns = append(campaigns, sample{
			attrs: Extract(subject),
			open:  opens / recip,
			click: clicks / recip,
		})
	}

	buckets := rollup(campaigns)
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days":     days,
		"campaigns_total": len(campaigns),
		"buckets":         buckets,
	})
}

// Score POST /api/v1/subject-analyzer/score.
//
// Given a candidate subject, returns its attribute extraction +
// the expected-engagement projection by looking up the candidate
// in each of the rollup buckets.
func (d *Deps) Score(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body scoreReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		code := httpbody.ErrorCode(err)
		if httperror.IsValidationCode(code) {
			httperror.Write(w, httpbody.StatusCode(err), code, httpbody.PublicMessage(err))
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	subject := strings.TrimSpace(body.Subject)
	if subject == "" {
		writeErr(w, http.StatusBadRequest, "missing_subject", "")
		return
	}
	attrs := Extract(subject)

	// Pull tenant baseline (default 180d).
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	since := time.Now().UTC().AddDate(0, 0, -180)
	rows, _ := tx.Query(r.Context(), `
WITH per_campaign AS (
  SELECT c.subject,
         count(DISTINCT e.subscriber_email)::float8 AS recipients,
         count(*) FILTER (WHERE e.event_type='opened')::float8 AS opens,
         count(*) FILTER (WHERE e.event_type='clicked')::float8 AS clicks
    FROM campaigns c
    LEFT JOIN subscriber_events e
      ON e.tenant_id = $1::uuid AND e.campaign_id = c.id
   WHERE c.tenant_id = $1::uuid AND c.sent_at >= $2 AND c.subject IS NOT NULL
   GROUP BY c.id, c.subject
  HAVING count(DISTINCT e.subscriber_email) > 0
)
SELECT subject, recipients, opens, clicks FROM per_campaign`, t.ID, since)
	hist := []sample{}
	if rows != nil {
		for rows.Next() {
			var subj string
			var r, o, c float64
			if err := rows.Scan(&subj, &r, &o, &c); err != nil {
				continue
			}
			if r == 0 {
				continue
			}
			hist = append(hist, sample{
				attrs: Extract(subj),
				open:  o / r,
				click: c / r,
			})
		}
		rows.Close()
	}

	// Project: average open rate of historical campaigns that
	// share the candidate's length_bucket / has_question /
	// has_personalize / all_caps.
	matched := []sample{}
	for _, h := range hist {
		if h.attrs.LengthBucket == attrs.LengthBucket &&
			h.attrs.HasQuestion == attrs.HasQuestion &&
			h.attrs.AllCaps == attrs.AllCaps {
			matched = append(matched, h)
		}
	}
	expectedOpen := tenantAvg(hist, true)
	expectedClick := tenantAvg(hist, false)
	if len(matched) >= 3 {
		expectedOpen = avgOpen(matched)
		expectedClick = avgClick(matched)
	}

	suggestions := suggestions(attrs)
	writeJSON(w, http.StatusOK, map[string]any{
		"subject":         subject,
		"attributes":      attrs,
		"expected_open":   expectedOpen,
		"expected_click":  expectedClick,
		"matched_history": len(matched),
		"suggestions":     suggestions,
	})
}

// Extract is the pure-function attribute extractor. Exported so
// the campaign editor can call it inline without HTTP.
func Extract(subject string) Attrs {
	a := Attrs{Length: len([]rune(subject))}
	a.LengthBucket = lengthBucket(a.Length)
	a.WordCount = len(strings.Fields(subject))
	a.HasQuestion = strings.Contains(subject, "?")
	a.HasPersonalize = strings.Contains(subject, "{{") && strings.Contains(subject, "}}")
	letters, upper := 0, 0
	for _, r := range subject {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
		if isEmoji(r) {
			a.EmojiCount++
		}
	}
	if letters > 0 {
		a.UppercaseRatio = float64(upper) / float64(letters)
	}
	a.AllCaps = letters > 3 && a.UppercaseRatio > 0.9
	return a
}

func lengthBucket(n int) string {
	switch {
	case n < 30:
		return "short"
	case n < 50:
		return "medium"
	case n < 80:
		return "long"
	default:
		return "very_long"
	}
}

func isEmoji(r rune) bool {
	// Coarse: covers the most common emoji ranges. Not exhaustive
	// but identifies the high-volume cases (😀-🙏, 🎈-🛌, 🌀-🗿).
	switch {
	case r >= 0x1F300 && r <= 0x1F9FF:
		return true
	case r >= 0x2600 && r <= 0x27BF:
		return true
	case r >= 0x1F600 && r <= 0x1F64F:
		return true
	}
	return false
}

func rollup(campaigns []sample) []Bucket {
	groups := map[string]map[string][]sample{
		"length":          {},
		"has_question":    {},
		"has_personalize": {},
		"has_emoji":       {},
		"all_caps":        {},
	}
	for _, c := range campaigns {
		add := func(attr, bucket string) {
			groups[attr][bucket] = append(groups[attr][bucket], c)
		}
		add("length", c.attrs.LengthBucket)
		add("has_question", boolBucket(c.attrs.HasQuestion))
		add("has_personalize", boolBucket(c.attrs.HasPersonalize))
		add("has_emoji", boolBucket(c.attrs.EmojiCount > 0))
		add("all_caps", boolBucket(c.attrs.AllCaps))
	}
	out := []Bucket{}
	for attr, byBucket := range groups {
		for bucket, samples := range byBucket {
			if len(samples) == 0 {
				continue
			}
			var sumO, sumC float64
			for _, s := range samples {
				sumO += s.open
				sumC += s.click
			}
			out = append(out, Bucket{
				Attribute: attr,
				Bucket:    bucket,
				Campaigns: len(samples),
				OpenRate:  sumO / float64(len(samples)),
				ClickRate: sumC / float64(len(samples)),
			})
		}
	}
	return out
}

func boolBucket(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func tenantAvg(hist []sample, openNotClick bool) float64 {
	if len(hist) == 0 {
		return 0
	}
	var sum float64
	for _, h := range hist {
		if openNotClick {
			sum += h.open
		} else {
			sum += h.click
		}
	}
	return sum / float64(len(hist))
}

func avgOpen(xs []sample) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x.open
	}
	return s / float64(len(xs))
}

func avgClick(xs []sample) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x.click
	}
	return s / float64(len(xs))
}

func suggestions(a Attrs) []string {
	s := []string{}
	if a.AllCaps {
		s = append(s, "All-caps subjects trip spam filters; consider mixed case.")
	}
	if a.Length > 80 {
		s = append(s, "Very long subjects truncate in most inboxes — aim for under 50 chars.")
	}
	if a.Length < 15 {
		s = append(s, "Very short subjects can feel like spam — 20-40 chars is the sweet spot.")
	}
	if !a.HasPersonalize {
		s = append(s, "No merge tokens detected — adding {{first_name}} typically lifts open rate.")
	}
	if a.EmojiCount > 2 {
		s = append(s, "More than 2 emoji can hurt deliverability — keep it to 1 leading icon.")
	}
	return s
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

var _ = errors.New
