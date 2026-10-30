// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — SCIM Users + Groups CRUD + JIT bridge.

package scim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// auditCtx attaches a middleware.Tenant to ctx so audit.Emit can resolve
// the tenant_id on the SCIM bearer-token paths (those run outside the
// normal TenantMiddleware chain and only stamp a local ctx key).
func auditCtx(ctx context.Context, tenantID string) context.Context {
	if tenantID == "" {
		return ctx
	}
	if _, ok := middleware.TenantFromContext(ctx); ok {
		return ctx
	}
	return middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
}

// SCIM resources are deliberately extensible (RFC 7643 extension schemas),
// so unknown top-level attributes are the one compatibility relaxation here.
// Size, media type, syntax, and the single-value rule remain strict.
func decodeSCIMJSON(r *http.Request, dst any) ([]byte, error) {
	return httpbody.DecodeJSONBytes(r, MaxBodyBytes, dst, httpbody.Options{
		AllowUnknownFields: true,
	})
}

func writeSCIMDecodeError(w http.ResponseWriter, err error) {
	writeError(w, httpbody.StatusCode(err), "invalidSyntax", httpbody.PublicMessage(err))
}

// --- Users ---

func (d *Deps) ListUsers(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	q := r.URL.Query()
	start := atoiOr(q.Get("startIndex"), 1)
	count := atoiOr(q.Get("count"), 100)
	if count > 500 {
		count = 500
	}
	filterAttr, filterVal, hasFilter := parseEqFilter(q.Get("filter"))

	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	whereSQL := ""
	args := []any{}
	if hasFilter {
		switch filterAttr {
		case "userName":
			whereSQL = " WHERE user_name = $1"
			args = append(args, filterVal)
		case "externalId":
			whereSQL = " WHERE external_id = $1"
			args = append(args, filterVal)
		case "active":
			whereSQL = " WHERE active = $1"
			args = append(args, filterVal == "true")
		}
	}

	// Count first so the response carries the canonical totalResults
	// even when start > 1.
	var total int
	if err := tx.QueryRow(r.Context(),
		"SELECT count(*) FROM scim_users"+whereSQL, args...).Scan(&total); err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	args = append(args, count, start-1)
	rows, err := tx.Query(r.Context(),
		"SELECT id::text, external_id, user_name, COALESCE(display_name,''), COALESCE(given_name,''), COALESCE(family_name,''), active, COALESCE(email_primary,''), created_at, updated_at FROM scim_users"+whereSQL+
			" ORDER BY created_at LIMIT $"+strconv.Itoa(len(args)-1)+" OFFSET $"+strconv.Itoa(len(args)),
		args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		var givenName, familyName, emailPrimary string
		if err := rows.Scan(&u.ID, &u.ExternalID, &u.UserName, &u.DisplayName,
			&givenName, &familyName, &u.Active, &emailPrimary,
			&u.Meta.Created, &u.Meta.LastModified); err != nil {
			writeError(w, http.StatusInternalServerError, "", fmtErr(err))
			return
		}
		u.Schemas = userSchemas()
		u.Meta.ResourceType = "User"
		if givenName != "" || familyName != "" {
			u.Name = &Name{GivenName: givenName, FamilyName: familyName}
		}
		if emailPrimary != "" {
			u.Emails = []Email{{Value: emailPrimary, Primary: true, Type: "work"}}
		}
		out = append(out, u)
	}
	writeSCIM(w, http.StatusOK, ListResponseFor(out, start, total))
}

func (d *Deps) GetUser(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	u, err := d.loadUser(r.Context(), tenantID, urlParam(r, "id"))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "", "user not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	writeSCIM(w, http.StatusOK, u)
}

func (d *Deps) CreateUser(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	var u User
	body, err := decodeSCIMJSON(r, &u)
	if err != nil {
		writeSCIMDecodeError(w, err)
		return
	}
	if u.UserName == "" {
		writeError(w, http.StatusBadRequest, "invalidValue", "userName is required")
		return
	}
	if u.Schemas == nil {
		u.Schemas = userSchemas()
	}
	// `active` defaults to true if absent (RFC 7643 §4.1.1).
	// Go bool zero value is false; SCIM clients omit `active` to mean
	// "use default". Re-derive from raw body to disambiguate.
	if !strings.Contains(string(body), `"active"`) {
		u.Active = true
	}
	saved, err := d.upsertUser(r.Context(), tenantID, &u, body, true /*createOnly*/)
	if err != nil {
		if errors.Is(err, errAlreadyExists) {
			writeError(w, http.StatusConflict, "uniqueness", "userName or externalId already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	d.maybeProvisionPostwaveUser(r.Context(), tenantID, saved)
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.user.create", "scim_user", saved.ID,
		nil, saved, map[string]any{
			"user_name":   saved.UserName,
			"external_id": saved.ExternalID,
			"active":      saved.Active,
		})
	writeSCIM(w, http.StatusCreated, saved)
}

func (d *Deps) ReplaceUser(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	var u User
	body, err := decodeSCIMJSON(r, &u)
	if err != nil {
		writeSCIMDecodeError(w, err)
		return
	}
	u.ID = urlParam(r, "id")
	if u.UserName == "" {
		writeError(w, http.StatusBadRequest, "invalidValue", "userName is required")
		return
	}
	if !strings.Contains(string(body), `"active"`) {
		u.Active = true
	}
	saved, err := d.updateAndSyncUser(r.Context(), tenantID, &u, body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.user.update", "scim_user", saved.ID,
		nil, saved, map[string]any{
			"user_name": saved.UserName,
			"active":    saved.Active,
			"op":        "replace",
		})
	writeSCIM(w, http.StatusOK, saved)
}

func (d *Deps) PatchUser(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	id := urlParam(r, "id")
	var patch PatchRequest
	_, err := decodeSCIMJSON(r, &patch)
	if err != nil {
		writeSCIMDecodeError(w, err)
		return
	}
	u, err := d.loadUser(r.Context(), tenantID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "", "user not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	// Apply each PATCH op. Supported paths: `active`, `userName`,
	// `name.givenName`, `name.familyName`, `displayName`.
	for _, op := range patch.Operations {
		switch strings.ToLower(strings.TrimSpace(op.Path)) {
		case "active":
			var b bool
			_ = json.Unmarshal(op.Value, &b)
			u.Active = b
		case "username":
			var s string
			_ = json.Unmarshal(op.Value, &s)
			if s != "" {
				u.UserName = s
			}
		case "displayname":
			var s string
			_ = json.Unmarshal(op.Value, &s)
			u.DisplayName = s
		case "name.givenname":
			var s string
			_ = json.Unmarshal(op.Value, &s)
			if u.Name == nil {
				u.Name = &Name{}
			}
			u.Name.GivenName = s
		case "name.familyname":
			var s string
			_ = json.Unmarshal(op.Value, &s)
			if u.Name == nil {
				u.Name = &Name{}
			}
			u.Name.FamilyName = s
		}
	}
	raw, _ := json.Marshal(u)
	saved, err := d.updateAndSyncUser(r.Context(), tenantID, u, raw)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.user.update", "scim_user", saved.ID,
		nil, saved, map[string]any{
			"user_name": saved.UserName,
			"active":    saved.Active,
			"op":        "patch",
			"ops_count": len(patch.Operations),
		})
	writeSCIM(w, http.StatusOK, saved)
}

func (d *Deps) DeleteUser(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	id := urlParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	if err := deactivateSCIMUserInTx(r.Context(), tx, tenantID, id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "", "user not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.user.delete", "scim_user", id,
		nil, nil, map[string]any{
			"semantics": "scim_deactivate",
		})
	w.WriteHeader(http.StatusNoContent)
}

// --- Groups ---

func (d *Deps) ListGroups(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	q := r.URL.Query()
	start := atoiOr(q.Get("startIndex"), 1)
	count := atoiOr(q.Get("count"), 100)
	if count > 500 {
		count = 500
	}
	filterAttr, filterVal, hasFilter := parseEqFilter(q.Get("filter"))

	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	whereSQL := ""
	args := []any{}
	if hasFilter {
		switch filterAttr {
		case "displayName":
			whereSQL = " WHERE display_name = $1"
			args = append(args, filterVal)
		case "externalId":
			whereSQL = " WHERE external_id = $1"
			args = append(args, filterVal)
		}
	}
	var total int
	if err := tx.QueryRow(r.Context(),
		"SELECT count(*) FROM scim_groups"+whereSQL, args...).Scan(&total); err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	args = append(args, count, start-1)
	rows, err := tx.Query(r.Context(),
		"SELECT id::text, external_id, display_name, created_at, updated_at FROM scim_groups"+whereSQL+
			" ORDER BY created_at LIMIT $"+strconv.Itoa(len(args)-1)+" OFFSET $"+strconv.Itoa(len(args)),
		args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	defer rows.Close()
	out := []Group{}
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.ExternalID, &g.DisplayName,
			&g.Meta.Created, &g.Meta.LastModified); err != nil {
			writeError(w, http.StatusInternalServerError, "", fmtErr(err))
			return
		}
		g.Schemas = groupSchemas()
		g.Meta.ResourceType = "Group"
		out = append(out, g)
	}
	writeSCIM(w, http.StatusOK, ListResponseFor(out, start, total))
}

func (d *Deps) GetGroup(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	g, err := d.loadGroup(r.Context(), tenantID, urlParam(r, "id"))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "", "group not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	writeSCIM(w, http.StatusOK, g)
}

func (d *Deps) CreateGroup(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	var g Group
	body, err := decodeSCIMJSON(r, &g)
	if err != nil {
		writeSCIMDecodeError(w, err)
		return
	}
	if g.DisplayName == "" {
		writeError(w, http.StatusBadRequest, "invalidValue", "displayName is required")
		return
	}
	saved, err := d.upsertGroup(r.Context(), tenantID, &g, body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	// Membership changes trigger role recomputation across all users.
	d.recomputeRolesAfterGroupChange(r.Context(), tenantID, saved.ID)
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.group.create", "scim_group", saved.ID,
		nil, saved, map[string]any{
			"display_name": saved.DisplayName,
			"external_id":  saved.ExternalID,
			"member_count": len(saved.Members),
		})
	writeSCIM(w, http.StatusCreated, saved)
}

func (d *Deps) ReplaceGroup(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	var g Group
	body, err := decodeSCIMJSON(r, &g)
	if err != nil {
		writeSCIMDecodeError(w, err)
		return
	}
	g.ID = urlParam(r, "id")
	saved, err := d.upsertGroup(r.Context(), tenantID, &g, body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	d.recomputeRolesAfterGroupChange(r.Context(), tenantID, saved.ID)
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.group.update", "scim_group", saved.ID,
		nil, saved, map[string]any{
			"display_name": saved.DisplayName,
			"member_count": len(saved.Members),
			"op":           "replace",
		})
	writeSCIM(w, http.StatusOK, saved)
}

func (d *Deps) PatchGroup(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	id := urlParam(r, "id")
	var patch PatchRequest
	_, err := decodeSCIMJSON(r, &patch)
	if err != nil {
		writeSCIMDecodeError(w, err)
		return
	}
	g, err := d.loadGroup(r.Context(), tenantID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "", "group not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	// PATCH semantics: { op: add|remove|replace, path: "members", value: [{value: <id>}] }
	for _, op := range patch.Operations {
		switch strings.ToLower(op.Path) {
		case "displayname":
			var s string
			_ = json.Unmarshal(op.Value, &s)
			if s != "" {
				g.DisplayName = s
			}
		case "members":
			var members []Member
			_ = json.Unmarshal(op.Value, &members)
			switch strings.ToLower(op.Op) {
			case "add":
				g.Members = append(g.Members, members...)
			case "remove":
				keep := g.Members[:0]
				dropIDs := map[string]bool{}
				for _, m := range members {
					dropIDs[m.Value] = true
				}
				for _, m := range g.Members {
					if !dropIDs[m.Value] {
						keep = append(keep, m)
					}
				}
				g.Members = keep
			case "replace":
				g.Members = members
			}
		}
	}
	raw, _ := json.Marshal(g)
	saved, err := d.upsertGroup(r.Context(), tenantID, g, raw)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	d.recomputeRolesAfterGroupChange(r.Context(), tenantID, saved.ID)
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.group.update", "scim_group", saved.ID,
		nil, saved, map[string]any{
			"display_name": saved.DisplayName,
			"member_count": len(saved.Members),
			"op":           "patch",
			"ops_count":    len(patch.Operations),
		})
	writeSCIM(w, http.StatusOK, saved)
}

func (d *Deps) DeleteGroup(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromContext(r.Context())
	if tenantID == "" {
		writeError(w, http.StatusUnauthorized, "", "missing tenant context")
		return
	}
	id := urlParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM scim_groups WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", fmtErr(err))
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "", "group not found")
		return
	}
	_ = tx.Commit(r.Context())
	d.recomputeRolesAfterGroupChange(r.Context(), tenantID, id)
	audit.EmitOrLog(auditCtx(r.Context(), tenantID), d.Pool,
		"scim.group.delete", "scim_group", id,
		nil, nil, nil)
	w.WriteHeader(http.StatusNoContent)
}

// --- internals ---

var errAlreadyExists = errors.New("scim: already exists")

// scimUserTx is the narrow transaction surface required by SCIM user
// lifecycle mutations. Keeping this smaller than pgx.Tx makes the atomic
// commit/rollback contract directly unit-testable without a database mock
// dependency; pgx.Tx remains the production implementation.
type scimUserTx interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type scimRoleQuery interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func (d *Deps) loadUser(ctx context.Context, tenantID, id string) (*User, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var u User
	var givenName, familyName, emailPrimary string
	row := tx.QueryRow(ctx, `
SELECT id::text, external_id, user_name, COALESCE(display_name,''),
       COALESCE(given_name,''), COALESCE(family_name,''), active,
       COALESCE(email_primary,''), created_at, updated_at
  FROM scim_users
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err := row.Scan(&u.ID, &u.ExternalID, &u.UserName, &u.DisplayName,
		&givenName, &familyName, &u.Active, &emailPrimary,
		&u.Meta.Created, &u.Meta.LastModified); err != nil {
		return nil, err
	}
	u.Schemas = userSchemas()
	u.Meta.ResourceType = "User"
	if givenName != "" || familyName != "" {
		u.Name = &Name{GivenName: givenName, FamilyName: familyName}
	}
	if emailPrimary != "" {
		u.Emails = []Email{{Value: emailPrimary, Primary: true, Type: "work"}}
	}
	return &u, nil
}

func (d *Deps) upsertUser(ctx context.Context, tenantID string, u *User, raw []byte, createOnly bool) (*User, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	return upsertUserTransaction(ctx, tx, tenantID, u, raw, createOnly)
}

func upsertUserTransaction(
	ctx context.Context,
	tx scimUserTx,
	tenantID string,
	u *User,
	raw []byte,
	createOnly bool,
) (*User, error) {
	defer func() { _ = tx.Rollback(ctx) }()
	saved, err := upsertUserInTx(ctx, tx, tenantID, u, raw, createOnly)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit SCIM user: %w", err)
	}
	return saved, nil
}

func upsertUserInTx(
	ctx context.Context,
	tx scimUserTx,
	tenantID string,
	u *User,
	raw []byte,
	createOnly bool,
) (*User, error) {
	var emailPrimary string
	for _, e := range u.Emails {
		if e.Primary {
			emailPrimary = e.Value
			break
		}
	}
	if emailPrimary == "" && len(u.Emails) > 0 {
		emailPrimary = u.Emails[0].Value
	}
	givenName, familyName := "", ""
	if u.Name != nil {
		givenName = u.Name.GivenName
		familyName = u.Name.FamilyName
	}
	rawJSON := string(raw)
	if createOnly {
		row := tx.QueryRow(ctx, `
INSERT INTO scim_users
    (tenant_id, external_id, user_name, display_name, given_name, family_name,
     active, email_primary, raw)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), $7,
        NULLIF($8,''), $9::jsonb)
RETURNING id::text, created_at, updated_at`,
			tenantID, u.ExternalID, u.UserName, u.DisplayName,
			givenName, familyName, u.Active, emailPrimary, rawJSON)
		if err := row.Scan(&u.ID, &u.Meta.Created, &u.Meta.LastModified); err != nil {
			// Unique-violation pgcode 23505.
			var pgErr interface{ SQLState() string }
			if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
				return nil, errAlreadyExists
			}
			return nil, err
		}
	} else {
		row := tx.QueryRow(ctx, `
UPDATE scim_users SET
    user_name = $3, display_name = NULLIF($4,''),
    given_name = NULLIF($5,''), family_name = NULLIF($6,''),
    active = $7, email_primary = NULLIF($8,''), raw = $9::jsonb,
    updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
 RETURNING created_at, updated_at`,
			tenantID, u.ID, u.UserName, u.DisplayName,
			givenName, familyName, u.Active, emailPrimary, rawJSON)
		if err := row.Scan(&u.Meta.Created, &u.Meta.LastModified); err != nil {
			return nil, err
		}
	}
	u.Schemas = userSchemas()
	u.Meta.ResourceType = "User"
	return u, nil
}

// updateAndSyncUser applies the SCIM resource mutation and its linked
// Moosewave users.status/role mutation in one transaction. Returning a 5xx
// after committing only the SCIM half would let the IdP and Moosewave disagree
// about whether the account is active.
func (d *Deps) updateAndSyncUser(
	ctx context.Context,
	tenantID string,
	u *User,
	raw []byte,
) (*User, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	return d.updateAndSyncUserInTx(ctx, tx, tenantID, u, raw)
}

func (d *Deps) updateAndSyncUserInTx(
	ctx context.Context,
	tx scimUserTx,
	tenantID string,
	u *User,
	raw []byte,
) (*User, error) {
	defer func() { _ = tx.Rollback(ctx) }()
	saved, err := upsertUserInTx(ctx, tx, tenantID, u, raw, false)
	if err != nil {
		return nil, err
	}
	if err := d.syncPostwaveUserActiveInTx(ctx, tx, tenantID, saved); err != nil {
		return nil, fmt.Errorf("sync linked Moosewave user: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit SCIM user lifecycle update: %w", err)
	}
	return saved, nil
}

func deactivateSCIMUserInTx(
	ctx context.Context,
	tx scimUserTx,
	tenantID string,
	id string,
) error {
	defer func() { _ = tx.Rollback(ctx) }()

	// SCIM DELETE means "deactivate" — flip active=false rather than drop
	// the row so the IdP can re-activate it via PATCH later.
	var linkedUserID *string
	row := tx.QueryRow(ctx, `
UPDATE scim_users SET active = false, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
 RETURNING user_id::text`, tenantID, id)
	if err := row.Scan(&linkedUserID); err != nil {
		return err
	}

	if linkedUserID != nil && *linkedUserID != "" {
		tag, err := tx.Exec(ctx, `
UPDATE users SET status = 'suspended'
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, *linkedUserID)
		if err != nil {
			return fmt.Errorf("deactivate linked Moosewave user: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("deactivate linked Moosewave user: expected one row, updated %d", tag.RowsAffected())
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit SCIM user deactivation: %w", err)
	}
	return nil
}

func (d *Deps) loadGroup(ctx context.Context, tenantID, id string) (*Group, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var g Group
	row := tx.QueryRow(ctx, `
SELECT id::text, external_id, display_name, created_at, updated_at
  FROM scim_groups
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err := row.Scan(&g.ID, &g.ExternalID, &g.DisplayName,
		&g.Meta.Created, &g.Meta.LastModified); err != nil {
		return nil, err
	}
	g.Schemas = groupSchemas()
	g.Meta.ResourceType = "Group"
	// Load members.
	rows, err := tx.Query(ctx, `
SELECT m.scim_user_id::text, u.user_name
  FROM scim_group_members m
  JOIN scim_users u ON u.id = m.scim_user_id
 WHERE m.group_id = $1::uuid`, g.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.Value, &m.Display); err != nil {
			return nil, err
		}
		m.Ref = "Users/" + m.Value
		g.Members = append(g.Members, m)
	}
	return &g, nil
}

func (d *Deps) upsertGroup(ctx context.Context, tenantID string, g *Group, raw []byte) (*Group, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if g.ID == "" {
		row := tx.QueryRow(ctx, `
INSERT INTO scim_groups (tenant_id, external_id, display_name, raw)
VALUES ($1::uuid, $2, $3, $4::jsonb)
RETURNING id::text, created_at, updated_at`,
			tenantID, g.ExternalID, g.DisplayName, string(raw))
		if err := row.Scan(&g.ID, &g.Meta.Created, &g.Meta.LastModified); err != nil {
			return nil, err
		}
	} else {
		row := tx.QueryRow(ctx, `
UPDATE scim_groups SET
    external_id = $3, display_name = $4, raw = $5::jsonb, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
 RETURNING created_at, updated_at`,
			tenantID, g.ID, g.ExternalID, g.DisplayName, string(raw))
		if err := row.Scan(&g.Meta.Created, &g.Meta.LastModified); err != nil {
			return nil, err
		}
	}
	// Replace membership set wholesale (PUT/POST semantics; PATCH
	// builds the final set in the caller).
	if _, err := tx.Exec(ctx,
		`DELETE FROM scim_group_members WHERE group_id = $1::uuid`, g.ID); err != nil {
		return nil, err
	}
	for _, m := range g.Members {
		if m.Value == "" {
			continue
		}
		_, err := tx.Exec(ctx, `
INSERT INTO scim_group_members (tenant_id, group_id, scim_user_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)
ON CONFLICT DO NOTHING`, tenantID, g.ID, m.Value)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	g.Schemas = groupSchemas()
	g.Meta.ResourceType = "Group"
	return g, nil
}

// --- JIT provisioning bridge ---

// maybeProvisionPostwaveUser creates a row in `users` for a newly-
// SCIM-created identity when none exists yet, and resolves the user's
// initial role from scim_role_mappings. Idempotent: if a Moosewave
// user with the same email already exists, link the scim_users.user_id
// pointer to it instead.
func (d *Deps) maybeProvisionPostwaveUser(ctx context.Context, tenantID string, u *User) {
	if !u.Active {
		return
	}
	emailPrimary := ""
	for _, e := range u.Emails {
		if e.Primary {
			emailPrimary = e.Value
			break
		}
	}
	if emailPrimary == "" {
		emailPrimary = u.UserName
	}
	if emailPrimary == "" {
		return
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	role := d.resolveRoleForUser(ctx, tx, tenantID, u.ID)
	var userID string
	// Try linking to an existing row first.
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM users WHERE tenant_id = $1::uuid AND email = $2`,
		tenantID, emailPrimary).Scan(&userID); err == nil {
		// Update SCIM pointer + role.
		_, _ = tx.Exec(ctx,
			`UPDATE scim_users SET user_id = $1::uuid WHERE id::text = $2`, userID, u.ID)
		_, _ = tx.Exec(ctx,
			`UPDATE users SET role = $1, status = 'active' WHERE id::text = $2`, role, userID)
		_ = tx.Commit(ctx)
		return
	}
	// Create a new Moosewave user.
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, status)
VALUES ($1::uuid, $2, $3, 'active')
RETURNING id::text`, tenantID, emailPrimary, role).Scan(&userID); err != nil {
		return
	}
	_, _ = tx.Exec(ctx,
		`UPDATE scim_users SET user_id = $1::uuid WHERE id::text = $2`, userID, u.ID)
	_ = tx.Commit(ctx)
}

// syncPostwaveUserActive flips the linked users.status to match
// scim_users.active and surfaces every database failure to its caller.
func (d *Deps) syncPostwaveUserActive(ctx context.Context, tenantID string, u *User) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := d.syncPostwaveUserActiveInTx(ctx, tx, tenantID, u); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit linked Moosewave user lifecycle: %w", err)
	}
	return nil
}

func (d *Deps) syncPostwaveUserActiveInTx(
	ctx context.Context,
	tx scimUserTx,
	tenantID string,
	u *User,
) error {
	status := "active"
	if !u.Active {
		status = "suspended"
	}
	if _, err := tx.Exec(ctx, `
UPDATE users SET status = $1
  FROM scim_users
 WHERE users.id = scim_users.user_id
   AND users.tenant_id = $3::uuid
   AND scim_users.tenant_id = $3::uuid
   AND scim_users.id::text = $2`, status, u.ID, tenantID); err != nil {
		return fmt.Errorf("update linked Moosewave user status: %w", err)
	}
	if u.Active {
		// Recompute role on activate.
		role, err := d.resolveRoleForUserStrict(ctx, tx, tenantID, u.ID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE users SET role = $1
  FROM scim_users
 WHERE users.id = scim_users.user_id
   AND users.tenant_id = $3::uuid
   AND scim_users.tenant_id = $3::uuid
   AND scim_users.id::text = $2`, role, u.ID, tenantID); err != nil {
			return fmt.Errorf("update linked Moosewave user role: %w", err)
		}
	}
	return nil
}

// resolveRoleForUser walks the scim_user's groups in precedence
// order and returns the first matching scim_role_mappings.role.
// Falls back to a '*' wildcard mapping, then to 'viewer'.
func (d *Deps) resolveRoleForUser(ctx context.Context, tx scimRoleQuery, tenantID, scimUserID string) string {
	role, err := d.resolveRoleForUserStrict(ctx, tx, tenantID, scimUserID)
	if err != nil {
		return "viewer"
	}
	return role
}

// resolveRoleForUserStrict preserves the best-effort resolver's legitimate
// "no mapping" fallback while distinguishing it from a database failure. A
// lifecycle activation must not silently downgrade a user to viewer because a
// role-mapping query failed.
func (d *Deps) resolveRoleForUserStrict(
	ctx context.Context,
	tx scimRoleQuery,
	tenantID string,
	scimUserID string,
) (string, error) {
	var role string
	err := tx.QueryRow(ctx, `
SELECT m.role
  FROM scim_role_mappings m
  JOIN scim_groups g ON g.tenant_id = m.tenant_id AND g.display_name = m.group_name
  JOIN scim_group_members gm ON gm.group_id = g.id AND gm.scim_user_id::text = $2
 WHERE m.tenant_id = $1::uuid
 ORDER BY m.precedence ASC
	LIMIT 1`, tenantID, scimUserID).Scan(&role)
	if err == nil && role != "" {
		return role, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("resolve SCIM group role: %w", err)
	}

	// Wildcard fallback.
	role = ""
	err = tx.QueryRow(ctx, `
SELECT role FROM scim_role_mappings
 WHERE tenant_id = $1::uuid AND group_name = '*'
 ORDER BY precedence ASC
	LIMIT 1`, tenantID).Scan(&role)
	if err == nil && role != "" {
		return role, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("resolve SCIM wildcard role: %w", err)
	}
	return "viewer", nil
}

// recomputeRolesAfterGroupChange re-resolves the role for every
// Moosewave user linked to the affected group. Best-effort.
func (d *Deps) recomputeRolesAfterGroupChange(ctx context.Context, tenantID, groupID string) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT scim_user_id::text
  FROM scim_group_members
 WHERE group_id::text = $1`, groupID)
	if err != nil {
		return
	}
	scimUserIDs := []string{}
	for rows.Next() {
		var s string
		if rows.Scan(&s) == nil {
			scimUserIDs = append(scimUserIDs, s)
		}
	}
	rows.Close()
	for _, sid := range scimUserIDs {
		role := d.resolveRoleForUser(ctx, tx, tenantID, sid)
		_, _ = tx.Exec(ctx, `
UPDATE users SET role = $1
  FROM scim_users
 WHERE users.id = scim_users.user_id
   AND scim_users.id::text = $2`, role, sid)
	}
	_ = tx.Commit(ctx)
}

func atoiOr(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

// keep time referenced for the meta struct
var _ = time.Now
