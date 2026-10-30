package email_template

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Deps holds nothing today; kept as a struct so the wiring matches the
// other packages and so future settings (e.g. a max-size limit) can land
// without touching main.go.
type Deps struct{}

const previewJSONMaxBodyBytes int64 = 1 << 20 // 1 MiB

// PreviewInput is the body of POST /api/v1/templates/preview.
type PreviewInput struct {
	Template string         `json:"template"`
	Vars     map[string]any `json:"vars"`
}

// PreviewResponse is the rendered output.
type PreviewResponse struct {
	Rendered string `json:"rendered"`
}

// MountRoutes wires the preview endpoint onto the supplied chi router. The
// caller decides which middleware group (tenant-scoped vs public) it
// belongs in; this package does not assume.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Post("/api/v1/templates/preview", d.Preview)
}

// Preview renders the supplied template against the supplied vars.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	var in PreviewInput
	if err := httpbody.DecodeJSON(w, r, previewJSONMaxBodyBytes, &in); err != nil {
		writeJSON(w, httpbody.StatusCode(err), map[string]any{"error": map[string]string{"code": httpbody.ErrorCode(err), "message": httpbody.PublicMessage(err)}})
		return
	}
	out, err := Render(in.Template, in.Vars)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "render_failed", "message": err.Error()}})
		return
	}
	writeJSON(w, http.StatusOK, PreviewResponse{Rendered: out})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
