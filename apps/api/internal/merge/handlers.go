// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — POST /api/v1/merge/preview lets the editor render
// a draft against a sample subscriber in real time. The editor
// debounces this on keystroke + shows the rendered output side-by-
// side.

package merge

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Deps wires the merge endpoints. The template-preview engine is
// stateless; Pool/Logger are only needed by the subscriber-merge
// apply path (apply.go) — when Pool is nil the apply route is not
// registered, preserving the historical stateless mount.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers POST /api/v1/merge/preview and (when a pool
// is wired) POST /api/v1/merge/apply.
func MountRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Post("/api/v1/merge/preview", d.Preview)
	if d != nil && d.Pool != nil {
		// Subscriber merge is a destructive subscriber write — same
		// scope as POST /api/v1/subscribers/merge.
		r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
			Post("/api/v1/merge/apply", d.Apply)
	}
}

// previewRequest is the editor body.
type previewRequest struct {
	// Template is the raw HTML/text/subject with {{ }} expressions.
	Template string `json:"template"`
	// Vars is the sample subscriber context. Top-level keys like
	// "first_name", "last_name", "company"; nested object lookups
	// via dot in the template ({{ subscriber.email }}).
	Vars map[string]any `json:"vars"`
	// HTML selects the same value-escaping path used by HTML email sends.
	HTML bool `json:"html,omitempty"`
}

// previewResponse is the rendered output + any expansion errors.
type previewResponse struct {
	Rendered string `json:"rendered"`
	Error    string `json:"error,omitempty"`
}

// Preview renders the template against the supplied sample vars.
// Errors render the empty string + return the error in the
// response envelope so the editor can show a red "syntax issue" hint.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	var in previewRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	render := Render
	if in.HTML {
		render = RenderHTML
	}
	rendered, err := render(in.Template, Context{Vars: in.Vars})
	resp := previewResponse{Rendered: rendered}
	if err != nil {
		resp.Error = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
