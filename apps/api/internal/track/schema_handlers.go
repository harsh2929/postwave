// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The authoring surface, without which the rest of this is a phantom.
//
// A validator with no way to declare a schema validates nothing: the table stays
// empty, `LoadActiveSchema` always returns ok=false, and every event passes
// while the code LOOKS like a contract is being enforced. That is the failure
// this whole subsystem was added to end, so the declaration endpoints ship in
// the same change as the check rather than after it.

// SchemaInput is the body for declaring a version.
type SchemaInput struct {
	EventName string `json:"event_name"`
	// Properties maps a property to its JSON type name — the same five words
	// the observed half records, so a declaration and an observation are
	// directly comparable.
	Properties map[string]string `json:"properties"`
	Required   []string          `json:"required,omitempty"`
}

var validJSONTypes = map[string]bool{
	TypeString: true, TypeNumber: true, TypeBoolean: true,
	TypeObject: true, TypeArray: true,
}

// MountSchemaRoutes registers the declaration surface.
func (d *Deps) MountSchemaRoutes(r chi.Router) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/event-schemas", d.ListSchemas)
	// Declaring what an event must contain is a governance action, not an
	// analytics one: a wrong declaration makes a healthy app look broken, so it
	// takes the write scope rather than the read one its GET uses.
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/api/v1/event-schemas", d.DeclareSchema)
}

type schemaRow struct {
	EventName           string            `json:"event_name"`
	Version             int               `json:"version"`
	Properties          map[string]string `json:"properties"`
	Required            []string          `json:"required"`
	Active              bool              `json:"active"`
	ViolationCount      int64             `json:"violation_count"`
	LastViolationAt     *string           `json:"last_violation_at,omitempty"`
	LastViolationDetail string            `json:"last_violation_detail,omitempty"`
}

func (d *Deps) ListSchemas(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Every version, not just the active one: the point of versioning is that
	// events collected under an old declaration can still be explained, and a
	// list that hides the old rows makes that impossible.
	rows, err := tx.Query(r.Context(), `
SELECT event_name, version, properties, required, active, violation_count,
       to_char(last_violation_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
       COALESCE(last_violation_detail, '')
  FROM product_event_schemas
 WHERE tenant_id = $1::uuid
 ORDER BY event_name, version DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	defer rows.Close()
	out := []schemaRow{}
	for rows.Next() {
		var s schemaRow
		if err := rows.Scan(&s.EventName, &s.Version, &s.Properties, &s.Required,
			&s.Active, &s.ViolationCount, &s.LastViolationAt, &s.LastViolationDetail); err != nil {
			httperror.WriteInternal(w, d.Slog, err, r.Context())
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	writeSchemaJSON(w, http.StatusOK, map[string]any{"items": out})
}

// DeclareSchema creates the next version and makes it active.
//
// A NEW VERSION rather than an edit, always. Editing a declaration in place
// rewrites the meaning of events already collected under it — the violation
// count on the row would then describe two different contracts added together,
// which is worse than no count.
func (d *Deps) DeclareSchema(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in SchemaInput
	if err := httpbody.DecodeJSON(w, r, 64<<10, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.EventName = strings.TrimSpace(in.EventName)
	if !ValidEventName(in.EventName) {
		httperror.WriteValidation(w, "invalid_event_name",
			"event_name must be a valid event name")
		return
	}
	// A declaration naming a type the observer never produces could never be
	// satisfied, and would report every event as violating forever.
	for prop, typ := range in.Properties {
		if !validJSONTypes[typ] {
			httperror.WriteValidation(w, "invalid_property_type",
				"property "+prop+": type must be one of string, number, boolean, object, array")
			return
		}
	}
	// Requiring a property nobody declared is a declaration that cannot be read:
	// the required list would demand a field whose type is unstated.
	for _, req := range in.Required {
		if _, ok := in.Properties[req]; !ok {
			httperror.WriteValidation(w, "undeclared_required_property",
				"required property "+req+" is not declared in properties")
			return
		}
	}

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Deactivate first, then insert active: the partial unique index permits one
	// active row per event, so the order is not cosmetic — the reverse fails.
	if _, err := tx.Exec(r.Context(), `
UPDATE product_event_schemas SET active = false, updated_at = now()
 WHERE tenant_id = $1::uuid AND event_name = $2 AND active`, t.ID, in.EventName); err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	props := in.Properties
	if props == nil {
		props = map[string]string{}
	}
	required := in.Required
	if required == nil {
		required = []string{}
	}
	var version int
	if err := tx.QueryRow(r.Context(), `
INSERT INTO product_event_schemas (tenant_id, event_name, version, properties, required, active)
SELECT $1::uuid, $2,
       COALESCE(MAX(version), 0) + 1,
       $3::jsonb, $4::text[], true
  FROM product_event_schemas
 WHERE tenant_id = $1::uuid AND event_name = $2
RETURNING version`, t.ID, in.EventName, jsonOrEmpty(props), required).Scan(&version); err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	writeSchemaJSON(w, http.StatusCreated, map[string]any{
		"event_name": in.EventName, "version": version, "active": true,
	})
}

func jsonOrEmpty(m map[string]string) []byte {
	b, err := json.Marshal(m)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func writeSchemaJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
