// handlers.go owns the HTTP surface for voice_profile_labels.
//
// Endpoints (all under /v1/voice/labels, mounted by services/voice/main.go):
//
//	POST   /                  — operator records a label
//	GET    /                  — paginated list (?axis=&page=&size=)
//	DELETE /{id}              — admin-only removal of a single label
//	GET    /export.json       — admin-only bulk export for trainer feeds
//
// Tenant scoping piggybacks on the Handler.TenantFromRequest the
// existing voice handlers use (X-Tenant-ID by default). Admin-only
// routes additionally check the X-Postwave-Role header (owner|admin)
// or fall back to the internal-bearer-auth path so the calibration
// trainer's HTTP client can hit /export.json with the service token.
package labels

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/voice/internal/httpbody"
	"github.com/postwave/postwave/services/voice/internal/internalauth"
)

const labelJSONMaxBodyBytes int64 = 64 << 10

// LabelStore is the narrow surface handlers consume. Decoupled from
// *Store so unit tests can substitute an in-memory fake.
type LabelStore interface {
	Create(ctx context.Context, tenantID string, l Label) (string, error)
	List(ctx context.Context, tenantID, axis string, limit, offset int) ([]Label, int, error)
	Delete(ctx context.Context, tenantID, labelID string) error
	Export(ctx context.Context, tenantID string) ([]Label, error)
}

// Deps wires the handler dependencies. TenantFromRequest mirrors the
// voice.Handler shape so both packages extract tenant the same way.
type Deps struct {
	Store             LabelStore
	TenantFromRequest func(*http.Request) string
}

// NewDeps constructs Deps with the conventional X-Tenant-ID extractor.
// Callers may override TenantFromRequest before mounting.
func NewDeps(store LabelStore) *Deps {
	return &Deps{
		Store: store,
		TenantFromRequest: func(r *http.Request) string {
			return r.Header.Get("X-Tenant-ID")
		},
	}
}

// Routes returns a chi.Router with the four labels endpoints
// registered. Caller mounts at /v1/voice/labels.
func (d *Deps) Routes() chi.Router {
	r := chi.NewRouter()
	r.Post("/", d.create)
	r.Get("/", d.list)
	// /export.json is registered ahead of the {id} catch-all so chi
	// routes it explicitly (chi does not back-track from a param
	// match into a literal sibling).
	r.Get("/export.json", d.export)
	r.Delete("/{id}", d.delete)
	return r
}

// --- requests / responses ---

type createReq struct {
	SampleText string  `json:"sample_text"`
	Axis       string  `json:"axis"`
	Value      float64 `json:"value"`
	SampleID   string  `json:"sample_id,omitempty"`
	Notes      string  `json:"notes,omitempty"`
}

type createResp struct {
	ID string `json:"id"`
}

type labelJSON struct {
	ID         string    `json:"id"`
	TenantID   string    `json:"tenant_id"`
	SampleID   string    `json:"sample_id,omitempty"`
	SampleText string    `json:"sample_text"`
	Axis       string    `json:"axis"`
	Value      float64   `json:"value"`
	LabeledBy  string    `json:"labeled_by_user_id,omitempty"`
	Notes      string    `json:"notes,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

type listResp struct {
	Items []labelJSON `json:"items"`
	Total int         `json:"total"`
	Page  int         `json:"page"`
	Size  int         `json:"size"`
}

// --- handlers ---

func (d *Deps) create(w http.ResponseWriter, r *http.Request) {
	tenant := d.tenantOr401(w, r)
	if tenant == "" {
		return
	}
	var req createReq
	if err := httpbody.DecodeJSON(w, r, labelJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, httpbody.Message(err), httpbody.StatusCode(err))
		return
	}
	if err := ValidateLabel(req.Axis, req.Value, req.SampleText); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	labeledBy := strings.TrimSpace(r.Header.Get("X-User-ID"))
	id, err := d.Store.Create(r.Context(), tenant, Label{
		SampleText: req.SampleText,
		Axis:       req.Axis,
		Value:      req.Value,
		SampleID:   req.SampleID,
		Notes:      req.Notes,
		LabeledBy:  labeledBy,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidAxis), errors.Is(err, ErrInvalidValue), errors.Is(err, ErrEmptySampleText):
			http.Error(w, err.Error(), http.StatusBadRequest)
		default:
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusCreated, createResp{ID: id})
}

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	tenant := d.tenantOr401(w, r)
	if tenant == "" {
		return
	}
	axis := strings.TrimSpace(r.URL.Query().Get("axis"))
	page := atoiOr(r.URL.Query().Get("page"), 1)
	size := atoiOr(r.URL.Query().Get("size"), 50)
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 500 {
		size = 50
	}
	offset := (page - 1) * size

	items, total, err := d.Store.List(r.Context(), tenant, axis, size, offset)
	if err != nil {
		if errors.Is(err, ErrInvalidAxis) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]labelJSON, 0, len(items))
	for _, l := range items {
		out = append(out, toJSON(l))
	}
	writeJSON(w, http.StatusOK, listResp{Items: out, Total: total, Page: page, Size: size})
}

func (d *Deps) delete(w http.ResponseWriter, r *http.Request) {
	tenant := d.tenantOr401(w, r)
	if tenant == "" {
		return
	}
	if !isLabelsAdmin(r) {
		http.Error(w, "admin only", http.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	if err := d.Store.Delete(r.Context(), tenant, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) export(w http.ResponseWriter, r *http.Request) {
	tenant := d.tenantOr401(w, r)
	if tenant == "" {
		return
	}
	if !isLabelsAdmin(r) {
		http.Error(w, "admin only", http.StatusForbidden)
		return
	}
	items, err := d.Store.Export(r.Context(), tenant)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]labelJSON, 0, len(items))
	for _, l := range items {
		out = append(out, toJSON(l))
	}
	writeJSON(w, http.StatusOK, out)
}

// tenantOr401 extracts the tenant from the request or writes 401 and
// returns "" (in which case the caller must return immediately).
func (d *Deps) tenantOr401(w http.ResponseWriter, r *http.Request) string {
	if d.TenantFromRequest == nil {
		http.Error(w, "tenant resolver not wired", http.StatusInternalServerError)
		return ""
	}
	tenant := strings.TrimSpace(d.TenantFromRequest(r))
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return ""
	}
	return tenant
}

// isLabelsAdmin gates the admin-only routes. Matches the shape used
// by handlers/sequences.go's isTemplateAdmin so operators don't have
// to learn a second permission model.
func isLabelsAdmin(r *http.Request) bool {
	if internalauth.IsInternalBearerAuth(r.Context()) {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("X-Postwave-Role"))) {
	case "owner", "admin":
		return true
	default:
		return false
	}
}

func toJSON(l Label) labelJSON {
	return labelJSON{
		ID:         l.ID,
		TenantID:   l.TenantID,
		SampleID:   l.SampleID,
		SampleText: l.SampleText,
		Axis:       l.Axis,
		Value:      l.Value,
		LabeledBy:  l.LabeledBy,
		Notes:      l.Notes,
		CreatedAt:  l.CreatedAt,
	}
}

func atoiOr(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
