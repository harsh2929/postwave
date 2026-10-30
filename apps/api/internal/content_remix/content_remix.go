// SPDX-License-Identifier: AGPL-3.0-only
//
// Package content_remix creates deterministic multi-asset derivatives from a
// campaign issue. It is intentionally provider-free: an LLM can replace the
// renderer later without changing the route contract or saved campaign shape.
package content_remix

import (
	"encoding/json"
	"html"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const remixJSONMaxBodyBytes int64 = 128 << 10

type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

type Input struct {
	Channels []string `json:"channels,omitempty"`
	Tone     string   `json:"tone,omitempty"`
}

type RemixAsset struct {
	Channel   string    `json:"channel"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

type Response struct {
	CampaignID  string       `json:"campaign_id"`
	Assets      []RemixAsset `json:"assets"`
	GeneratedAt time.Time    `json:"generated_at"`
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns, apikeys.ScopeAdmin)
	r.With(write).Post("/api/v1/campaigns/{id}/remix", d.remix)
}

func (d *Deps) remix(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in Input
	if err := httpbody.DecodeJSON(w, r, remixJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and the error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var subject, preview, bodyHTML, plainText string
	err = tx.QueryRow(r.Context(), `
SELECT COALESCE(subject, ''), COALESCE(preview_text, ''),
       COALESCE(body_html, ''), COALESCE(plain_text, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`, t.ID, chi.URLParam(r, "id")).
		Scan(&subject, &preview, &bodyHTML, &plainText)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	assets := renderAssets(chi.URLParam(r, "id"), subject, preview, firstNonEmpty(plainText, stripHTML(bodyHTML)), in)
	writeJSON(w, http.StatusOK, Response{
		CampaignID:  chi.URLParam(r, "id"),
		Assets:      assets,
		GeneratedAt: time.Now().UTC(),
	})
}

func renderAssets(campaignID, subject, preview, body string, in Input) []RemixAsset {
	channels := normalizeChannels(in.Channels)
	tone := strings.TrimSpace(in.Tone)
	if tone == "" {
		tone = "default"
	}
	summary := firstNonEmpty(preview, firstSentence(body), subject)
	now := time.Now().UTC()
	out := make([]RemixAsset, 0, len(channels))
	for _, ch := range channels {
		switch ch {
		case "sms":
			out = append(out, RemixAsset{
				Channel:   ch,
				Title:     "SMS teaser",
				Body:      truncate(subject+": "+summary, 280),
				Source:    sourceLabel(campaignID, tone),
				CreatedAt: now,
			})
		case "social":
			out = append(out, RemixAsset{
				Channel:   ch,
				Title:     "Social post",
				Body:      truncate(subject+"\n\n"+summary+"\n\nRead the full issue in the archive.", 700),
				Source:    sourceLabel(campaignID, tone),
				CreatedAt: now,
			})
		case "podcast_outline":
			out = append(out, RemixAsset{
				Channel: ch,
				Title:   "Podcast outline",
				Body: strings.Join([]string{
					"Intro: " + subject,
					"Key point: " + summary,
					"Discussion: what changed and why it matters",
					"Close: invite listeners to read the archive issue",
				}, "\n"),
				Source:    sourceLabel(campaignID, tone),
				CreatedAt: now,
			})
		default:
			out = append(out, RemixAsset{
				Channel:   "web_teaser",
				Title:     subject,
				Body:      truncate(summary, 420),
				Source:    sourceLabel(campaignID, tone),
				CreatedAt: now,
			})
		}
	}
	return out
}

func normalizeChannels(in []string) []string {
	if len(in) == 0 {
		return []string{"web_teaser", "sms", "social", "podcast_outline"}
	}
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range in {
		ch := strings.ToLower(strings.TrimSpace(raw))
		if ch == "" || seen[ch] {
			continue
		}
		seen[ch] = true
		out = append(out, ch)
	}
	return out
}

var tagRE = regexp.MustCompile(`<[^>]+>`)
var whitespaceRE = regexp.MustCompile(`\s+`)

func stripHTML(v string) string {
	v = tagRE.ReplaceAllString(v, " ")
	v = html.UnescapeString(v)
	return strings.TrimSpace(whitespaceRE.ReplaceAllString(v, " "))
}

func firstSentence(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	for _, sep := range []string{". ", "! ", "? ", "\n"} {
		if idx := strings.Index(v, sep); idx > 0 {
			return strings.TrimSpace(v[:idx+1])
		}
	}
	return truncate(v, 220)
}

func truncate(v string, max int) string {
	v = strings.TrimSpace(v)
	if len(v) <= max {
		return v
	}
	if max <= 3 {
		return v[:max]
	}
	return strings.TrimSpace(v[:max-3]) + "..."
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func sourceLabel(campaignID, tone string) string {
	return "campaign:" + campaignID + ";tone:" + tone + ";renderer:deterministic"
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
