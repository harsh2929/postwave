// SPDX-License-Identifier: AGPL-3.0-only
//
// Workstream 4 (Mailchimp parity polish) — template-language region
// editing.
//
// Templates can declare named editable regions inline via Mailchimp-style
// region syntax:
//
//   {{region:hero}}
//     <h1>Default headline</h1>
//   {{/region}}
//
//   {{region:footer}}
//     <p>© 2026 Acme</p>
//   {{/region}}
//
// The endpoint GET /api/v1/campaign-templates/{id}/regions enumerates
// each region with its default content + the byte offset where it starts
// in the template body (so the desktop editor can scroll the right
// region into view when the operator clicks "Edit default").
//
// The parser is intentionally simple — it doesn't understand nested
// regions; a region tag inside another region is treated as content,
// matching the way Mailchimp itself behaves in their composer.

package campaigntemplates

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Region is one parsed editable zone from a template body.
type Region struct {
	Name        string `json:"name"`
	DefaultHTML string `json:"default_html"`
	// Position is the byte offset of the opening tag in the source. The
	// desktop editor uses this to scroll the source view to the region
	// without re-parsing client-side.
	Position int `json:"position"`
	// Length is the byte span of the entire region (opening tag through
	// closing tag, inclusive).
	Length int `json:"length"`
}

// regionRE matches `{{region:NAME}} ... {{/region}}` (non-greedy body).
// Names are alnum + dash/underscore, 1-48 chars — enough to cover
// "hero", "footer", "promo-banner-2026" without allowing pathological
// inputs through.
var regionRE = regexp.MustCompile(`(?s)\{\{\s*region:([A-Za-z0-9_\-]{1,48})\s*\}\}(.*?)\{\{\s*/\s*region\s*\}\}`)

// ParseRegions extracts every region from the given template body.
//
// Returns regions in document order. Each region's Position is the byte
// offset of `{{region:…}}` (matching Mailchimp's "Edit default" UI which
// scrolls to the literal source). DefaultHTML is the trimmed content
// between the open + close tags.
//
// Bodies with no regions return an empty slice (not nil) so callers can
// JSON-encode a stable shape.
func ParseRegions(body string) []Region {
	out := []Region{}
	if body == "" {
		return out
	}
	matches := regionRE.FindAllStringSubmatchIndex(body, -1)
	for _, m := range matches {
		// m = [matchStart, matchEnd, nameStart, nameEnd, bodyStart, bodyEnd]
		if len(m) < 6 {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(body[m[2]:m[3]]))
		if name == "" {
			continue
		}
		inner := body[m[4]:m[5]]
		out = append(out, Region{
			Name:        name,
			DefaultHTML: strings.TrimSpace(inner),
			Position:    m[0],
			Length:      m[1] - m[0],
		})
	}
	return out
}

// CountRegions returns just the count, used by the templates list
// surface to badge templates that ship region zones.
func CountRegions(body string) int {
	return len(regionRE.FindAllStringSubmatchIndex(body, -1))
}

// ---------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------

// MountRegionRoutes registers GET /api/v1/campaign-templates/{id}/regions.
// Caller wires the same auth middleware as the rest of the surface.
func (d *Deps) MountRegionRoutes(r chi.Router) {
	r.Get("/api/v1/campaign-templates/{id}/regions", d.Regions)
}

// Regions GET /api/v1/campaign-templates/{id}/regions — returns the
// parsed region list. The desktop "Regions" panel renders this beside
// the template preview.
func (d *Deps) Regions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tpl, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	regions := ParseRegions(regionSource(tpl))
	writeJSON(w, http.StatusOK, map[string]any{
		"regions": regions,
		"count":   len(regions),
	})
}

// Parse the same source the campaign draft will compile, not stale HTML.
func regionSource(template *Template) string {
	if template.BodyMJML != "" {
		return template.BodyMJML
	}
	return template.BodyHTML
}
