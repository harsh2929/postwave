// SPDX-License-Identifier: AGPL-3.0-only
//
// reverse_etl.go — SUB-112 Reverse ETL.
//
// Warehouse-managed traits (columns from Snowflake/BigQuery/Redshift)
// sync BACK onto subscribers as queryable custom fields. This is the
// import direction's "profile traits" variant: each mapping links one
// warehouse column path to one subscriber custom-field key, with an
// optional type cast.
//
// The control plane reuses warehouse_connections + its credential
// machinery (credentials_ref). A mapping belongs to a connection. An
// execution ("sync traits now") matches incoming rows to subscribers by
// the mapping's profile_key_column (default email) and bulk-writes the
// mapped values into subscribers.custom_fields jsonb.
//
// v1 execution model: the remote-warehouse query is supplied INLINE in
// the sync request (rows: [...]) — the same staged-rows posture the
// existing import path uses for non-s3 providers (see validateRunInput).
// A credentialed warehouse driver attaches to fetchReverseETLRows in a
// follow-up; the mapping schema, the cast logic, and the bulk subscriber
// writeback all ship now and run end-to-end against staged rows.
package warehouse

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// ReverseETLMapping is one row from warehouse_reverse_etl_mappings.
type ReverseETLMapping struct {
	ID               string     `json:"id,omitempty"`
	TenantID         string     `json:"tenant_id,omitempty"`
	ConnectionID     string     `json:"connection_id,omitempty"`
	SourceTable      string     `json:"source_table"`
	ProfileKeyColumn string     `json:"profile_key_column"`
	ProfileKeyTarget string     `json:"profile_key_target"`
	SourceColumn     string     `json:"source_column"`
	TargetFieldKey   string     `json:"target_field_key"`
	CastType         string     `json:"cast_type"`
	Status           string     `json:"status"`
	Version          int64      `json:"version"`
	ExpectedVersion  int64      `json:"expected_version,omitempty"`
	LastSyncedAt     *time.Time `json:"last_synced_at,omitempty"`
	LastRowCount     int64      `json:"last_row_count"`
	CreatedAt        time.Time  `json:"created_at,omitempty"`
	UpdatedAt        time.Time  `json:"updated_at,omitempty"`
}

// ReverseETLSyncInput is the body of the sync trigger. Rows are the
// inline staged warehouse rows (v1); each row is a column→value map that
// must include every mapping's profile_key_column + source_column.
type ReverseETLSyncInput struct {
	SourceTable               string           `json:"source_table,omitempty"`
	Rows                      []map[string]any `json:"rows,omitempty"`
	ExpectedConnectionVersion int64            `json:"expected_connection_version"`
}

type ReverseETLDeleteInput struct {
	ExpectedVersion    int64  `json:"expected_version"`
	ConfirmationTarget string `json:"confirmation_target"`
}

// ReverseETLSyncResult summarizes a sync execution.
type ReverseETLSyncResult struct {
	ConnectionID     string `json:"connection_id"`
	MappingsApplied  int    `json:"mappings_applied"`
	RowsScanned      int    `json:"rows_scanned"`
	SubscribersFound int    `json:"subscribers_matched"`
	FieldsWritten    int    `json:"fields_written"`
}

const reverseETLMaxRows = 50_000

var validCastTypes = []string{"string", "number", "boolean", "date", "datetime", "json"}

// MountReverseETLRoutes registers the reverse-ETL surface (SUB-112).
//
//	GET    /api/v1/warehouse/connections/{id}/reverse-etl-mappings
//	POST   /api/v1/warehouse/connections/{id}/reverse-etl-mappings
//	DELETE /api/v1/warehouse/connections/{id}/reverse-etl-mappings/{mapping_id}
//	POST   /api/v1/warehouse/connections/{id}/reverse-etl-sync
func MountReverseETLRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/warehouse/connections/{id}/reverse-etl-mappings", d.ListReverseETLMappings)
	r.With(admin).Post("/api/v1/warehouse/connections/{id}/reverse-etl-mappings", d.CreateReverseETLMapping)
	r.With(admin).Delete("/api/v1/warehouse/connections/{id}/reverse-etl-mappings/{mapping_id}", d.DeleteReverseETLMapping)
	r.With(admin).Post("/api/v1/warehouse/connections/{id}/reverse-etl-sync", d.SyncReverseETL)
}

// ListReverseETLMappings GET .../reverse-etl-mappings.
func (d *Deps) ListReverseETLMappings(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	connectionID, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	out, err := d.Repo.ListReverseETLMappings(r.Context(), tenant, connectionID)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CreateReverseETLMapping POST .../reverse-etl-mappings.
func (d *Deps) CreateReverseETLMapping(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	connectionID, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in ReverseETLMapping
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.UpsertReverseETLMapping(r.Context(), tenant, connectionID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// DeleteReverseETLMapping DELETE .../reverse-etl-mappings/{mapping_id}.
func (d *Deps) DeleteReverseETLMapping(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	connectionID, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	mappingID, ok := warehouseUUIDParam(w, r, "mapping_id")
	if !ok {
		return
	}
	var in ReverseETLDeleteInput
	if err := httpbody.DecodeJSON(w, r, warehouseLifecycleJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := d.Repo.DeleteReverseETLMapping(r.Context(), tenant, connectionID, mappingID, in.ExpectedVersion, in.ConfirmationTarget); err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "id": mappingID, "previous_version": in.ExpectedVersion,
	})
}

// SyncReverseETL POST .../reverse-etl-sync — applies the connection's
// active mappings to the staged rows, writing mapped values onto matching
// subscribers' custom_fields.
func (d *Deps) SyncReverseETL(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	connectionID, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in ReverseETLSyncInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return

		}
	}
	out, err := d.Repo.SyncReverseETL(r.Context(), tenant, connectionID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// normalizeReverseETLMapping validates + defaults a mapping in place.
// Returns an error prefixed "validation:" on bad input.
func normalizeReverseETLMapping(in *ReverseETLMapping) error {
	in.SourceTable = strings.TrimSpace(in.SourceTable)
	in.SourceColumn = strings.TrimSpace(in.SourceColumn)
	in.TargetFieldKey = strings.TrimSpace(in.TargetFieldKey)
	in.ProfileKeyColumn = defaulted(strings.TrimSpace(in.ProfileKeyColumn), "email")
	in.ProfileKeyTarget = defaulted(strings.TrimSpace(in.ProfileKeyTarget), "email")
	in.CastType = defaulted(strings.ToLower(strings.TrimSpace(in.CastType)), "string")
	in.Status = defaulted(strings.TrimSpace(in.Status), "active")
	if in.SourceTable == "" {
		return fmt.Errorf("validation: source_table is required")
	}
	if in.SourceColumn == "" {
		return fmt.Errorf("validation: source_column is required")
	}
	if in.TargetFieldKey == "" {
		return fmt.Errorf("validation: target_field_key is required")
	}
	if in.ProfileKeyTarget != "email" {
		return fmt.Errorf("validation: profile_key_target must be email")
	}
	if !allowed(in.CastType, validCastTypes) {
		return fmt.Errorf("validation: cast_type must be one of string, number, boolean, date, datetime, json")
	}
	if !allowed(in.Status, []string{"draft", "active", "paused"}) {
		return fmt.Errorf("validation: status must be draft, active, or paused")
	}
	return nil
}

// castValue applies a mapping's cast_type to a raw warehouse value. The
// returned value is what lands in custom_fields. Unparseable values for a
// typed cast fall back to the string form so a single bad cell never
// drops the whole row.
func castValue(castType string, raw any) any {
	switch castType {
	case "number":
		switch v := raw.(type) {
		case float64:
			return v
		case int:
			return float64(v)
		case int64:
			return float64(v)
		case string:
			if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
				return f
			}
			return v
		}
		return raw
	case "boolean":
		switch v := raw.(type) {
		case bool:
			return v
		case string:
			s := strings.ToLower(strings.TrimSpace(v))
			if s == "true" || s == "1" || s == "yes" || s == "t" {
				return true
			}
			if s == "false" || s == "0" || s == "no" || s == "f" {
				return false
			}
			return v
		}
		return raw
	case "json":
		// Pass structured values through untouched; parse strings as JSON.
		if s, ok := raw.(string); ok {
			var parsed any
			if err := json.Unmarshal([]byte(s), &parsed); err == nil {
				return parsed
			}
			return s
		}
		return raw
	case "date", "datetime":
		// Stored as-is (string form) — downstream segment filters parse
		// ISO-8601 lazily; we only normalize to string here.
		return fmt.Sprintf("%v", raw)
	default: // string
		if raw == nil {
			return ""
		}
		if s, ok := raw.(string); ok {
			return s
		}
		return fmt.Sprintf("%v", raw)
	}
}
