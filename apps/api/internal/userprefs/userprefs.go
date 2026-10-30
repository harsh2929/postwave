// Package userprefs persists per-user UI preferences scoped to a tenant.
//
// SUB-075: the Subscribers list lets each operator choose which columns
// to show, their widths, and the active sort. That state lives here so
// it survives reloads + follows the user across machines (vs. local-
// storage which is single-device).
//
// Surface:
//
//	GET /api/v1/me/prefs/subscribers_view   — returns {} on no row
//	PUT /api/v1/me/prefs/subscribers_view   — full replace
//
// Future view scopes (campaigns, lists, analytics) follow the same
// shape — add a new path + reuse the same table.
package userprefs

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const prefsJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

// ErrNotFound surfaces when a (tenant, user) has no stored row yet.
// Handlers translate this into an empty `{}` body so the desktop can
// no-op on first load.
var ErrNotFound = errors.New("userprefs: not found")

// SubscribersView is the column-customization payload the desktop
// writes for the Subscribers list. Stored as raw jsonb so the column
// catalog can grow without a Go struct churn.
type SubscribersView struct {
	Columns []string       `json:"columns"`
	Widths  map[string]int `json:"widths"`
	Sort    string         `json:"sort"`
	Order   string         `json:"order"`
}

// Repo is the Postgres-backed userprefs store.
type Repo struct {
	Pool *db.Pool
}

// Deps bundles the repo for handler wiring.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// failure details (tenant_id, request_id, err) without leaking err
	// text to callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers tenant-scoped routes.
func (d *Deps) MountRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/me/prefs/subscribers_view", d.GetSubscribersView)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/me/prefs/subscribers_view", d.PutSubscribersView)
}

// GetSubscribersView GET /api/v1/me/prefs/subscribers_view
func (d *Deps) GetSubscribersView(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	// Dev/API-key mode without a resolved user — return empty so the
	// client falls back to defaults instead of crashing.
	if !ok || u.ID == "" {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	raw, err := d.Repo.GetView(r.Context(), t.ID, u.ID, "subscribers_view")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Normalise on READ, not only on write. This handler serves the stored
	// bytes verbatim, so a null written before the write-side guard existed
	// would be replayed to every future reader forever -- fixing the writer
	// cannot heal a row that is already wrong.
	//
	// Decode-and-re-encode rather than string surgery: it also drops any field
	// the current struct no longer knows about, which is the same normalisation
	// the writer applies.
	var view SubscribersView
	if err := json.Unmarshal(raw, &view); err != nil {
		// Unreadable stored prefs are not worth a 500 -- the client falls back
		// to defaults, which is what an absent row already does.
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	if view.Columns == nil {
		view.Columns = []string{}
	}
	writeJSON(w, http.StatusOK, view)
}

// PutSubscribersView PUT /api/v1/me/prefs/subscribers_view
func (d *Deps) PutSubscribersView(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u.ID == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", "user identity required"))
		return
	}
	var in SubscribersView
	if err := httpbody.DecodeJSON(w, r, prefsJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in = sanitizeView(in)
	// Stored verbatim and served verbatim by GetSubscribersView, so a null here
	// is persisted and replayed to every future reader. Columns is typed as an
	// array on the client.
	if in.Columns == nil {
		in.Columns = []string{}
	}
	body, err := json.Marshal(in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.Repo.UpsertView(r.Context(), t.ID, u.ID, "subscribers_view", body); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, in)
}

// allowedColumns is the whitelist of column keys the desktop is
// permitted to persist. Adding a new sortable/visible column to the
// Subscribers list requires adding its key here so an attacker can't
// stuff arbitrary identifiers into the jsonb blob.
var allowedColumns = map[string]bool{
	"email":        true,
	"status":       true,
	"joined":       true,
	"engagement":   true,
	"tags":         true,
	"avatar":       true,
	"rating":       true,
	"churn_score":  true,
	"last_active":  true,
	"merge_fields": true,
	"source":       true,
	// SUB-075 — the first-class name columns (SUB-004) the desktop column
	// catalog exposes. They are backend-supported (subscriberColumns /
	// scanSubscriber) but were missing from this allow-list, so an operator
	// who showed/hid/resized them lost the choice on reload.
	"first_name":   true,
	"last_name":    true,
	"full_name":    true,
	"display_name": true,
	// SUB-075 — the archived marker (SUB-009) + account link (SUB-012)
	// columns the catalog also exposes.
	"archived_at": true,
	"account":     true,
}

// allowedSorts mirrors apps/api/internal/subscribers/repo.go::normalizeSort.
// Mismatches would surface as a server-side "unknown sort" 500 on next
// reload, so we keep the two in lockstep.
var allowedSorts = map[string]bool{
	"email":      true,
	"status":     true,
	"joined":     true,
	"engagement": true,
	"updated":    true,
	// SUB-075 — first/last name are server-sortable (subscribers.normalizeSort
	// maps both to the (tenant_id, first_name, last_name) index, mig 0413), so
	// a persisted name sort can actually be applied on next reload.
	"first_name": true,
	"last_name":  true,
}

func sanitizeView(in SubscribersView) SubscribersView {
	out := SubscribersView{Widths: map[string]int{}}
	seen := map[string]bool{}
	for _, c := range in.Columns {
		if !allowedColumns[c] || seen[c] {
			continue
		}
		seen[c] = true
		out.Columns = append(out.Columns, c)
	}
	for k, v := range in.Widths {
		if !allowedColumns[k] {
			continue
		}
		// Bound widths to sane CSS values; rejects negatives + runaway
		// values that would break the grid template.
		if v < 24 {
			v = 24
		}
		if v > 1200 {
			v = 1200
		}
		out.Widths[k] = v
	}
	if allowedSorts[in.Sort] {
		out.Sort = in.Sort
	}
	if in.Order == "asc" || in.Order == "desc" {
		out.Order = in.Order
	}
	return out
}

/* ------- repo methods (subscriber_view_prefs) --------------------- */

// GetView returns the raw jsonb blob for the (tenant, user, scope) row.
// The handler streams the bytes through so we don't double-decode the
// stored shape.
func (r *Repo) GetView(ctx context.Context, tenantID, userID, scope string) ([]byte, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	err = tx.QueryRow(ctx, `
SELECT prefs->$3
  FROM subscriber_view_prefs
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantID, userID, scope).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return []byte("{}"), nil
	}
	return raw, nil
}

// UpsertView writes the scope key inside the prefs jsonb, leaving any
// sibling scopes untouched. One row per (tenant, user); columns/sort/
// widths nest under the named scope key.
func (r *Repo) UpsertView(ctx context.Context, tenantID, userID, scope string, body []byte) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_view_prefs (tenant_id, user_id, prefs)
VALUES ($1::uuid, $2::uuid, jsonb_build_object($3::text, $4::jsonb))
ON CONFLICT (tenant_id, user_id) DO UPDATE
   SET prefs      = subscriber_view_prefs.prefs || jsonb_build_object($3::text, $4::jsonb),
       updated_at = now()`, tenantID, userID, scope, body)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
