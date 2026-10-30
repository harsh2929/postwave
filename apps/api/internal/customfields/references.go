// SPDX-License-Identifier: AGPL-3.0-only
//
// Where-used lookup for a custom field (SETC-032). Deleting a field never
// removes the subscriber values keyed under it, but it CAN silently break a
// segment, flow, or form that references the key — so the delete dialog shows
// the downstream objects first.
//
// Reference detection is a text-substring scan, deliberately conservative:
//   - Segments + flows reference a custom field as the quoted AST token
//     `"custom.<key>"` (see segments/compile.go, flowbuilder.go), so we match
//     that exact quoted token.
//   - Forms map a submission field via its `"<key>"` entry in structure/steps.
//
// We use strpos (literal, case-sensitive) rather than ILIKE so an underscore
// in the key is NOT treated as a LIKE single-char wildcard, and the trailing
// quote is a boundary so `loyalty` does not match `loyalty_tier`.
package customfields

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// FieldReference is one object that mentions the field.
type FieldReference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// FieldReferences groups where-used hits by subsystem. Each slice is non-nil
// (possibly empty) so the JSON is always `{"segments":[],...}`.
type FieldReferences struct {
	Segments []FieldReference `json:"segments"`
	Flows    []FieldReference `json:"flows"`
	Forms    []FieldReference `json:"forms"`
}

// References returns the segments, flows, and forms that reference the field
// identified by id. Returns ErrNotFound if the id is unknown to the tenant.
func (r *Repo) References(ctx context.Context, tenantID, id string) (*FieldReferences, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var key string
	err = tx.QueryRow(ctx,
		`SELECT key FROM tenant_custom_fields WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, tenantID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	out := &FieldReferences{
		Segments: []FieldReference{},
		Flows:    []FieldReference{},
		Forms:    []FieldReference{},
	}

	// Segments + flows use the quoted predicate token `"custom.<key>"`.
	predicateToken := `"custom.` + key + `"`
	if out.Segments, err = scanRefs(ctx, tx,
		`SELECT id::text, COALESCE(name, '') FROM saved_segments
		  WHERE tenant_id = $2::uuid AND strpos(predicate_json::text, $1) > 0
		  ORDER BY name`, predicateToken, tenantID); err != nil {
		return nil, err
	}
	if out.Flows, err = scanRefs(ctx, tx,
		`SELECT id::text, COALESCE(name, '') FROM automation_journeys
		  WHERE tenant_id = $2::uuid AND strpos(nodes::text, $1) > 0
		  ORDER BY name`, predicateToken, tenantID); err != nil {
		return nil, err
	}

	// Forms map a field by its quoted key `"<key>"` in structure or steps.
	formToken := `"` + key + `"`
	if out.Forms, err = scanRefs(ctx, tx,
		`SELECT id::text, COALESCE(name, '') FROM forms
		  WHERE tenant_id = $2::uuid
		    AND (strpos(structure::text, $1) > 0 OR strpos(steps::text, $1) > 0)
		  ORDER BY name`, formToken, tenantID); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// scanRefs runs a (token, tenantID) query returning (id, name) rows.
func scanRefs(ctx context.Context, tx pgx.Tx, sql, token, tenantID string) ([]FieldReference, error) {
	rows, err := tx.Query(ctx, sql, token, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	refs := []FieldReference{}
	for rows.Next() {
		var ref FieldReference
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}
