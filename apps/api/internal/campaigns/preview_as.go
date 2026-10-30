// SPDX-License-Identifier: AGPL-3.0-only
//
// G22 (campaigns 2026): "Preview as subscriber". Renders a campaign body
// exactly as ONE specific subscriber would receive it — merge tags
// ({{ first_name }}), Jinja-ish conditionals ({% if key %}), AND the
// dynamic-content regions ({{#if KEY}}…{{else}}…{{/if}}) all resolved
// against that subscriber's real fields.
//
// Two conditional syntaxes coexist in Moosewave bodies: merge.Render
// handles {% if %} + {{ var }}, while dynamic regions use the
// handlebars-style {{#if KEY}}. merge.RenderHTML does NOT understand the
// region syntax, so this endpoint resolves regions FIRST (collapsing
// each to the subscriber's branch) and then runs the merge renderer.

package campaigns

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/merge"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// PreviewAsInput selects the subscriber to render as — by id or email.
type PreviewAsInput struct {
	SubscriberID    string `json:"subscriber_id,omitempty"`
	SubscriberEmail string `json:"subscriber_email,omitempty"`
}

// PreviewAsOutput is the rendered body + the subscriber it resolved to.
type PreviewAsOutput struct {
	SubscriberEmail string `json:"subscriber_email"`
	BodyHTML        string `json:"body_html"`
	// UnresolvedRegions lists region KEYs that couldn't be evaluated from
	// the subscriber's fields (e.g. segment membership) and fell back to
	// the default branch — so the operator knows the preview approximates
	// those.
	UnresolvedRegions []string `json:"unresolved_regions,omitempty"`
}

// MountPreviewAs wires POST /api/v1/campaigns/{id}/preview-as. Read-scope
// because it renders existing content; it mutates nothing.
func MountPreviewAs(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Post("/api/v1/campaigns/{id}/preview-as", d.previewAs)
}

func (d *Deps) previewAs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	var in PreviewAsInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	selector := strings.TrimSpace(in.SubscriberID)
	if selector == "" {
		selector = strings.TrimSpace(in.SubscriberEmail)
	}
	if selector == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_subscriber",
			"subscriber_id or subscriber_email is required"))
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Campaign body.
	var body string
	err = tx.QueryRow(r.Context(),
		`SELECT COALESCE(body_html, '') FROM campaigns WHERE id = $1::uuid`, campaignID,
	).Scan(&body)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Subscriber fields. Match by id (uuid) OR email (citext). custom_fields
	// carries first_name/last_name/etc. for Klaviyo-style tenants.
	var email string
	var customRaw []byte
	err = tx.QueryRow(r.Context(), `
SELECT email, COALESCE(custom_fields, '{}')::jsonb
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (($2 <> '' AND id::text = $2) OR email = $3)
 LIMIT 1`,
		t.ID, idOrEmpty(in.SubscriberID), selector,
	).Scan(&email, &customRaw)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSON(w, http.StatusNotFound, errEnv("subscriber_not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	vars := map[string]any{}
	_ = json.Unmarshal(customRaw, &vars)
	vars["email"] = email
	ctx := merge.Context{Vars: vars}

	// 1. Resolve dynamic regions to this subscriber's branch.
	rendered, unresolved := resolveRegionsFor(body, func(key string) bool {
		v, ok := ctx.Resolve(key)
		return ok && isTruthyValue(v)
	})
	// 2. Run the merge renderer for {{ var }} + {% if %}.
	out, err := merge.RenderHTML(rendered, ctx)
	if err != nil {
		// A malformed {% %} block shouldn't 500 the preview — fall back to
		// the region-resolved body so the operator still sees something.
		out = rendered
	}

	writeJSON(w, http.StatusOK, PreviewAsOutput{
		SubscriberEmail:   email,
		BodyHTML:          out,
		UnresolvedRegions: unresolved,
	})
}

func idOrEmpty(id string) string { return strings.TrimSpace(id) }

// resolveRegionsFor collapses every {{#if KEY}}…{{else}}…{{/if}} region
// to the branch selected by truthy(KEY). It re-parses after each pass so
// nested regions inside the chosen branch are resolved too (bounded to
// avoid pathological loops). Returns the collapsed body + the distinct
// region KEYs that resolved falsey because the subscriber had no value
// for them (best-effort signal that the preview approximates those).
func resolveRegionsFor(body string, truthy func(key string) bool) (string, []string) {
	unresolved := map[string]struct{}{}
	for pass := 0; pass < 12; pass++ {
		regions, err := ParseRegions(body)
		if err != nil || len(regions) == 0 {
			break
		}
		// Collapse top-level regions back-to-front so earlier byte offsets
		// stay valid as we splice later ones.
		ordered := make([]Region, len(regions))
		copy(ordered, regions)
		for i := 0; i < len(ordered)-1; i++ {
			for j := i + 1; j < len(ordered); j++ {
				if ordered[j].Start > ordered[i].Start {
					ordered[i], ordered[j] = ordered[j], ordered[i]
				}
			}
		}
		for _, reg := range ordered {
			on := truthy(reg.Key)
			if !on {
				unresolved[reg.Key] = struct{}{}
			}
			var replacement string
			if on {
				replacement = reg.TrueBranch
			} else if reg.HasElse {
				replacement = reg.FalseBranch
			}
			if reg.Start >= 0 && reg.End <= len(body) && reg.Start <= reg.End {
				body = body[:reg.Start] + replacement + body[reg.End:]
			}
		}
	}
	if len(unresolved) == 0 {
		return body, nil
	}
	keys := make([]string, 0, len(unresolved))
	for k := range unresolved {
		keys = append(keys, k)
	}
	return body, keys
}

// isTruthyValue treats non-empty strings, true, and non-zero numbers as
// truthy; everything else (nil, false, 0, "") is falsey.
func isTruthyValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		s := strings.TrimSpace(strings.ToLower(t))
		return s != "" && s != "false" && s != "0" && s != "no"
	case float64:
		return t != 0
	case int:
		return t != 0
	default:
		return true
	}
}
