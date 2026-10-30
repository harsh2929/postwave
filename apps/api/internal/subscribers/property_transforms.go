// SPDX-License-Identifier: AGPL-3.0-only
//
// property_transforms.go — applies tenant-defined
// profile_property_transform_rules (migration 0201) during subscriber
// ingest, plus minimal CRUD to manage the rules.
//
// A rule maps a source_path (a key in custom_fields/merge_fields, or a
// dotted json_path for nested reads) to a target_key under custom_fields,
// applying a named transform (copy/lowercase/uppercase/trim/date/number/
// boolean/json_path). The applier runs at the same Create/Update chokepoint
// as applyTenantIdentifierTransforms and is strictly best-effort: a load
// failure logs and leaves the payload untouched (fail-open ingest).

package subscribers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var validTransforms = map[string]bool{
	"copy": true, "lowercase": true, "uppercase": true, "trim": true,
	"date": true, "number": true, "boolean": true, "json_path": true,
}
var validRuleStatuses = map[string]bool{"active": true, "paused": true, "archived": true}

// PropertyTransformRule mirrors a profile_property_transform_rules row.
type PropertyTransformRule struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	SourcePath string `json:"source_path"`
	TargetKey  string `json:"target_key"`
	Transform  string `json:"transform"`
	Status     string `json:"status"`
}

// PropertyTransformRuleInput is the writable rule contract. IDs are generated
// by the service and are deliberately not accepted on the name-keyed upsert
// route, keeping request and response schemas unambiguous.
type PropertyTransformRuleInput struct {
	Name       string `json:"name"`
	SourcePath string `json:"source_path"`
	TargetKey  string `json:"target_key"`
	Transform  string `json:"transform"`
	Status     string `json:"status"`
}

// LoadPropertyTransformRules returns the tenant's ACTIVE rules for the ingest
// applier. Tenant-scoped via db.WithTenant so RLS fires.
func (r *Repo) LoadPropertyTransformRules(ctx context.Context, tenantID string) ([]PropertyTransformRule, error) {
	return r.queryTransformRules(ctx, tenantID, true)
}

// ListTransformRules returns ALL of the tenant's rules (any status) for CRUD.
func (r *Repo) ListTransformRules(ctx context.Context, tenantID string) ([]PropertyTransformRule, error) {
	return r.queryTransformRules(ctx, tenantID, false)
}

func (r *Repo) queryTransformRules(ctx context.Context, tenantID string, activeOnly bool) ([]PropertyTransformRule, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, source_path, target_key, transform, status
  FROM profile_property_transform_rules
 WHERE tenant_id = $1::uuid AND ($2 = false OR status = 'active')
 ORDER BY name ASC`, tenantID, activeOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PropertyTransformRule{}
	for rows.Next() {
		var rule PropertyTransformRule
		if err := rows.Scan(&rule.ID, &rule.Name, &rule.SourcePath, &rule.TargetKey,
			&rule.Transform, &rule.Status); err != nil {
			return nil, err
		}
		out = append(out, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UpsertTransformRule creates or updates a rule by (tenant_id, name).
func (r *Repo) UpsertTransformRule(ctx context.Context, tenantID string, in PropertyTransformRule) (PropertyTransformRule, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return PropertyTransformRule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out PropertyTransformRule
	if err := tx.QueryRow(ctx, `
INSERT INTO profile_property_transform_rules
	(tenant_id, name, source_path, target_key, transform, status)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, name) DO UPDATE SET
	source_path = EXCLUDED.source_path,
	target_key  = EXCLUDED.target_key,
	transform   = EXCLUDED.transform,
	status      = EXCLUDED.status,
	updated_at  = now()
RETURNING id::text, name, source_path, target_key, transform, status`,
		tenantID, in.Name, in.SourcePath, in.TargetKey, in.Transform, in.Status).Scan(
		&out.ID, &out.Name, &out.SourcePath, &out.TargetKey, &out.Transform, &out.Status); err != nil {
		return PropertyTransformRule{}, err
	}
	return out, tx.Commit(ctx)
}

// DeleteTransformRule removes a rule by id; reports whether a row was deleted.
func (r *Repo) DeleteTransformRule(ctx context.Context, tenantID, id string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM profile_property_transform_rules
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Ingest applier
// ---------------------------------------------------------------------

// applyPropertyTransformRules loads the tenant's active rules and applies them
// to the ingest payload. Best-effort: a load error logs and returns without
// mutating the payload (fail-open).
//
// allocateIfNil MUST be true ONLY on Create. On the Update (PATCH) path a nil
// customFields means "leave custom_fields untouched", and Repo.Update treats a
// non-nil customFields as a FULL REPLACEMENT — so allocating a nil map there to
// hold a single derived key would wipe every existing custom field. On Update
// we therefore pass false: a rule that would target an untouched custom_fields
// set is skipped rather than fabricating a destructive replacement map. When
// the PATCH already carries custom_fields (non-nil), derived keys are added to
// that set normally.
func (d *Deps) applyPropertyTransformRules(ctx context.Context, tenantID string, mergeFields map[string]any, customFields *map[string]any, allocateIfNil bool) {
	if d == nil || d.Repo == nil || customFields == nil {
		return
	}
	rules, err := d.Repo.LoadPropertyTransformRules(ctx, tenantID)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("load property transform rules failed; skipping",
				"tenant_id", tenantID, "err", err.Error())
		}
		return
	}
	if len(rules) == 0 {
		return
	}
	applyPropertyTransforms(rules, mergeFields, customFields, allocateIfNil)
}

// applyPropertyTransforms is the pure core (unit-tested). For each rule it
// reads the source value, applies the transform, and writes the result under
// target_key in customFields. When customFields is nil it is allocated ONLY if
// allocateIfNil is set (Create) — on Update a nil map is "don't touch" and a
// rule is skipped rather than turned into a full-replacement wipe.
func applyPropertyTransforms(rules []PropertyTransformRule, mergeFields map[string]any, customFields *map[string]any, allocateIfNil bool) {
	for _, rule := range rules {
		raw, ok := lookupSource(rule.SourcePath, rule.Transform, mergeFields, *customFields)
		if !ok {
			continue
		}
		out, ok := transformValue(rule.Transform, raw)
		if !ok {
			continue
		}
		if *customFields == nil {
			if !allocateIfNil {
				// Update path: don't fabricate a replacement map.
				continue
			}
			*customFields = map[string]any{}
		}
		(*customFields)[rule.TargetKey] = out
	}
}

// lookupSource reads the source value from custom_fields (preferred) or
// merge_fields. For json_path with a dotted path it traverses nested objects.
func lookupSource(source, transform string, mergeFields, customFields map[string]any) (any, bool) {
	if transform == "json_path" && strings.Contains(source, ".") {
		parts := strings.Split(source, ".")
		if v, ok := traversePath(customFields, parts); ok {
			return v, true
		}
		return traversePath(mergeFields, parts)
	}
	if customFields != nil {
		if v, ok := customFields[source]; ok {
			return v, true
		}
	}
	if mergeFields != nil {
		if v, ok := mergeFields[source]; ok {
			return v, true
		}
	}
	return nil, false
}

func traversePath(m map[string]any, parts []string) (any, bool) {
	if m == nil {
		return nil, false
	}
	var cur any = m
	for _, p := range parts {
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		nv, ok := obj[p]
		if !ok {
			return nil, false
		}
		cur = nv
	}
	return cur, true
}

// transformValue applies a single named transform. Returns ok=false when the
// value can't be coerced (the rule is then skipped, leaving the payload as-is).
func transformValue(transform string, v any) (any, bool) {
	switch transform {
	case "copy", "json_path":
		return v, true
	case "lowercase":
		return strings.ToLower(toStringLoose(v)), true
	case "uppercase":
		return strings.ToUpper(toStringLoose(v)), true
	case "trim":
		return strings.TrimSpace(toStringLoose(v)), true
	case "number":
		return toNumber(v)
	case "boolean":
		return toBoolean(v)
	case "date":
		return toDate(v)
	}
	return nil, false
}

func toStringLoose(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

func toNumber(v any) (any, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return nil, false
		}
		return f, true
	}
	return nil, false
}

func toBoolean(v any) (any, bool) {
	switch b := v.(type) {
	case bool:
		return b, true
	case float64:
		return b != 0, true
	case string:
		switch strings.ToLower(strings.TrimSpace(b)) {
		case "true", "1", "yes", "on", "y":
			return true, true
		case "false", "0", "no", "off", "n", "":
			return false, true
		}
	}
	return nil, false
}

// toDate normalizes a date-ish value to an RFC3339 string. Accepts a handful
// of common input layouts; unrecognized input is skipped.
func toDate(v any) (any, bool) {
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format(time.RFC3339), true
	}
	s := strings.TrimSpace(toStringLoose(v))
	if s == "" {
		return nil, false
	}
	layouts := []string{
		time.RFC3339, "2006-01-02", "2006-01-02 15:04:05",
		"01/02/2006", "02/01/2006", "2006/01/02", time.RFC1123Z,
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC().Format(time.RFC3339), true
		}
	}
	return nil, false
}

// ---------------------------------------------------------------------
// CRUD handlers
// ---------------------------------------------------------------------

// MountTransformRuleRoutes registers the rule-management CRUD.
func MountTransformRuleRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/profile-transform-rules", d.ListTransformRules)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/profile-transform-rules", d.UpsertTransformRule)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/profile-transform-rules/{id}", d.DeleteTransformRule)
}

func (d *Deps) ListTransformRules(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListTransformRules(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": len(out)})
}

func (d *Deps) UpsertTransformRule(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var input PropertyTransformRuleInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &input); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in := PropertyTransformRule{
		Name:       input.Name,
		SourcePath: input.SourcePath,
		TargetKey:  input.TargetKey,
		Transform:  input.Transform,
		Status:     input.Status,
	}
	in.Name = strings.TrimSpace(in.Name)
	in.SourcePath = strings.TrimSpace(in.SourcePath)
	in.TargetKey = strings.TrimSpace(in.TargetKey)
	in.Transform = strings.TrimSpace(in.Transform)
	in.Status = strings.TrimSpace(in.Status)
	if in.Transform == "" {
		in.Transform = "copy"
	}
	if in.Status == "" {
		in.Status = "active"
	}
	if in.Name == "" || in.SourcePath == "" || in.TargetKey == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed",
			"name, source_path and target_key are required")
		return
	}
	if !validTransforms[in.Transform] {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed",
			"transform must be one of copy, lowercase, uppercase, trim, date, number, boolean, json_path")
		return
	}
	if !validRuleStatuses[in.Status] {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed",
			"status must be one of active, paused, archived")
		return
	}
	out, err := d.Repo.UpsertTransformRule(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteTransformRule(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "transform rule id must be a UUID")
		return
	}
	deleted, err := d.Repo.DeleteTransformRule(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if !deleted {
		httperror.Write(w, http.StatusNotFound, "not_found", "transform rule not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
