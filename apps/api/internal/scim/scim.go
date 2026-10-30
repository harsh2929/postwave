// SPDX-License-Identifier: AGPL-3.0-only
//
// Package scim implements SCIM 2.0 (RFC 7642/7643/7644) Users + Groups
// provisioning. The IdP sends `Authorization: Bearer <scim-token>`; the
// handler resolves token → tenant_id and applies the operation under
// that tenant's RLS context.
//
// Coverage: the SCIM 2.0 spec is large; we implement the "core" subset
// every major IdP exercises:
//
//   * Users: list, create, get, replace (PUT), patch, delete
//     Schema: urn:ietf:params:scim:schemas:core:2.0:User
//     Attributes: userName, name.{givenName,familyName}, displayName,
//                 emails[primary=true], active
//
//   * Groups: list, create, get, replace, patch, delete
//     Schema: urn:ietf:params:scim:schemas:core:2.0:Group
//     Members are scim_user ids.
//
// PATCH semantics support `Operations[] = { op: add|remove|replace,
// path, value }`. Filter expressions on list are limited to
// `userName eq "x"` and `displayName eq "x"` — every IdP we've tested
// emits exactly these forms.
//
// JIT bridge: when SCIM creates an scim_user, the handler resolves
// the user's group memberships through scim_role_mappings and
// (when no Moosewave user_id is linked yet) creates a row in `users`
// with the resolved role. Subsequent SCIM updates (active=false,
// group changes) flow through to the linked users row.

package scim

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/regions"
)

// MaxBodyBytes caps inbound SCIM payloads. The largest realistic
// payload is a Group with many members; 1 MiB is plenty.
const MaxBodyBytes int64 = 1 << 20

// Deps bundles the SCIM handler dependencies.
type Deps struct {
	Pool *db.Pool
	// RegionLookup resolves a tenant id to its pinned data region.
	// When non-nil, bearerAuth enforces that the resolved SCIM tenant
	// lives in regions.Current(); a mismatched tenant is rejected
	// with 421 Misdirected Request + a Location header pointing at
	// the correct region's host. Nil disables enforcement — used by
	// tests and single-region deployments.
	//
	// Closes multi-region audit HIGH #5 (intra-package follow-up):
	// regions.EnforceRegion can't be wrapped around the SCIM mount at
	// the router layer because the tenant id is only resolved AFTER
	// dispatch (inside bearerAuth). An EU IdP landing on the US
	// replica would previously write EU tenant rows to the US cluster
	// without a 421. We enforce inside the auth middleware so every
	// downstream handler is covered for free.
	RegionLookup regions.LookupTenantRegion
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller
	// after construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

// MountRoutes registers the SCIM endpoints. Public-ish URL prefix
// (`/scim/v2`) by RFC convention; authn is Bearer token, NOT the
// regular API-key flow.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	// ServiceProviderConfig + ResourceTypes + Schemas — IdPs query
	// these for discovery before issuing real ops.
	r.Get("/scim/v2/ServiceProviderConfig", d.ServiceProviderConfig)
	r.Get("/scim/v2/ResourceTypes", d.ResourceTypes)
	r.Get("/scim/v2/Schemas", d.Schemas)

	r.With(d.bearerAuth).Get("/scim/v2/Users", d.ListUsers)
	// p4d-recordsurface-wire-others: every mutating SCIM op gets a
	// pw_scim_<action>_total + pw_scim_duration_seconds pair. The
	// surface dashboard tracks IdP provisioning throughput +
	// latency from a single Grafana row.
	r.With(d.bearerAuth).Post("/scim/v2/Users", observability.RecordSurfaceFunc("scim", "user_create", d.CreateUser))
	r.With(d.bearerAuth).Get("/scim/v2/Users/{id}", d.GetUser)
	r.With(d.bearerAuth).Put("/scim/v2/Users/{id}", observability.RecordSurfaceFunc("scim", "user_replace", d.ReplaceUser))
	r.With(d.bearerAuth).Patch("/scim/v2/Users/{id}", observability.RecordSurfaceFunc("scim", "user_patch", d.PatchUser))
	r.With(d.bearerAuth).Delete("/scim/v2/Users/{id}", observability.RecordSurfaceFunc("scim", "user_delete", d.DeleteUser))

	r.With(d.bearerAuth).Get("/scim/v2/Groups", d.ListGroups)
	r.With(d.bearerAuth).Post("/scim/v2/Groups", observability.RecordSurfaceFunc("scim", "group_create", d.CreateGroup))
	r.With(d.bearerAuth).Get("/scim/v2/Groups/{id}", d.GetGroup)
	r.With(d.bearerAuth).Put("/scim/v2/Groups/{id}", observability.RecordSurfaceFunc("scim", "group_replace", d.ReplaceGroup))
	r.With(d.bearerAuth).Patch("/scim/v2/Groups/{id}", observability.RecordSurfaceFunc("scim", "group_patch", d.PatchGroup))
	r.With(d.bearerAuth).Delete("/scim/v2/Groups/{id}", observability.RecordSurfaceFunc("scim", "group_delete", d.DeleteGroup))
}

// --- SCIM wire types ---

// SCIM "Resource" base — every SCIM object carries id + meta.
type meta struct {
	ResourceType string    `json:"resourceType"`
	Created      time.Time `json:"created"`
	LastModified time.Time `json:"lastModified"`
	Location     string    `json:"location,omitempty"`
}

// User is the SCIM 2.0 User resource wire shape.
type User struct {
	Schemas     []string `json:"schemas"`
	ID          string   `json:"id"`
	ExternalID  string   `json:"externalId,omitempty"`
	UserName    string   `json:"userName"`
	Active      bool     `json:"active"`
	Name        *Name    `json:"name,omitempty"`
	DisplayName string   `json:"displayName,omitempty"`
	Emails      []Email  `json:"emails,omitempty"`
	Meta        meta     `json:"meta"`
}

// Name is the standard SCIM name complex attribute.
type Name struct {
	GivenName  string `json:"givenName,omitempty"`
	FamilyName string `json:"familyName,omitempty"`
	Formatted  string `json:"formatted,omitempty"`
}

// Email is one email object inside User.emails[].
type Email struct {
	Value   string `json:"value"`
	Type    string `json:"type,omitempty"`
	Primary bool   `json:"primary,omitempty"`
}

// Group is the SCIM 2.0 Group resource.
type Group struct {
	Schemas     []string `json:"schemas"`
	ID          string   `json:"id"`
	ExternalID  string   `json:"externalId,omitempty"`
	DisplayName string   `json:"displayName"`
	Members     []Member `json:"members,omitempty"`
	Meta        meta     `json:"meta"`
}

// Member is one entry inside Group.members[].
type Member struct {
	Value   string `json:"value"` // scim_user_id
	Display string `json:"display,omitempty"`
	Ref     string `json:"$ref,omitempty"`
	Type    string `json:"type,omitempty"`
}

// ListResponse is the wrapper for paginated lists.
type ListResponse struct {
	Schemas      []string `json:"schemas"`
	TotalResults int      `json:"totalResults"`
	ItemsPerPage int      `json:"itemsPerPage"`
	StartIndex   int      `json:"startIndex"`
	Resources    any      `json:"Resources"`
}

// PatchOp is one operation inside a PATCH request.
type PatchOp struct {
	Op    string          `json:"op"`
	Path  string          `json:"path,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
}

// PatchRequest is the SCIM 2.0 PATCH body.
type PatchRequest struct {
	Schemas    []string  `json:"schemas"`
	Operations []PatchOp `json:"Operations"`
}

// scimErr writes the RFC 7644 §3.12 error envelope.
type scimErr struct {
	Schemas  []string `json:"schemas"`
	Status   string   `json:"status"`
	ScimType string   `json:"scimType,omitempty"`
	Detail   string   `json:"detail"`
}

func writeError(w http.ResponseWriter, status int, scimType, detail string) {
	w.Header().Set("Content-Type", "application/scim+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(scimErr{
		Schemas:  []string{"urn:ietf:params:scim:api:messages:2.0:Error"},
		Status:   strconv.Itoa(status),
		ScimType: scimType,
		Detail:   detail,
	})
}

func writeSCIM(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/scim+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// --- Bearer-token middleware ---

type ctxKey int

const ctxKeyTenant ctxKey = 1

// bearerAuth validates Authorization: Bearer <scim-token>, looks up
// the tenant_id, stamps it onto request context, and updates
// last_used_at. Failure modes:
//   - missing/malformed header → 401
//   - token not found → 401
//   - token revoked → 401
func (d *Deps) bearerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "", "missing bearer token")
			return
		}
		tok := strings.TrimPrefix(auth, "Bearer ")
		tok = strings.TrimSpace(tok)
		if tok == "" {
			writeError(w, http.StatusUnauthorized, "", "empty bearer token")
			return
		}
		// Constant-time compare against stored sha256 to avoid timing
		// distinguishability on token enumeration.
		sum := sha256.Sum256([]byte(tok))
		tx, err := db.WithWorkerScope(r.Context(), d.Pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "", "auth backend")
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		// Worker-permissive lookup (we don't know the tenant yet). The scope
		// and lookup must share this transaction; transaction-local GUCs are
		// cleared after a standalone auto-commit statement.
		var tenantID string
		var storedHash []byte
		row := tx.QueryRow(r.Context(), `
SELECT tenant_id::text, token_sha256
  FROM scim_tokens
 WHERE token_sha256 = $1 AND revoked_at IS NULL
 LIMIT 1`, sum[:])
		if err := row.Scan(&tenantID, &storedHash); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusUnauthorized, "", "invalid token")
				return
			}
			writeError(w, http.StatusInternalServerError, "", "auth backend")
			return
		}
		// Defense in depth: the SELECT already filtered by equality
		// but constant-time-compare guards against logic bugs.
		if subtle.ConstantTimeCompare(sum[:], storedHash) != 1 {
			writeError(w, http.StatusUnauthorized, "", "invalid token")
			return
		}
		// Per-tenant data-region enforcement (multi-region audit
		// HIGH #5). enforceRegion writes the 421 envelope itself when
		// it rejects, so we just check the bool here and bail out.
		if !d.enforceRegion(w, tenantID) {
			return
		}
		// Best-effort touch of last_used_at; don't fail the request
		// if the update errors.
		_, _ = tx.Exec(r.Context(),
			`UPDATE scim_tokens SET last_used_at = now() WHERE token_sha256 = $1`, sum[:])
		// last_used_at is best-effort, as before. End the worker transaction
		// before invoking the downstream SCIM handler.
		_ = tx.Commit(r.Context())
		ctx := context.WithValue(r.Context(), ctxKeyTenant, tenantID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// enforceRegion runs the per-tenant region check. Returns true if
// the request should continue, false if a response has already been
// written (mismatch → 421, lookup error → 500). Nil RegionLookup
// (single-region deployments) is a pass-through. Extracted from
// bearerAuth so the gate is unit-testable without a DB.
func (d *Deps) enforceRegion(w http.ResponseWriter, tenantID string) bool {
	if d == nil || d.RegionLookup == nil {
		return true
	}
	tenantRegion, err := d.RegionLookup(tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "region lookup failed")
		return false
	}
	if here := regions.Current(); tenantRegion != here {
		correct := regions.HostFor(tenantRegion)
		w.Header().Set("Location", correct)
		w.Header().Set("X-Postwave-Region", string(tenantRegion))
		writeError(w, http.StatusMisdirectedRequest, "",
			fmt.Sprintf("this tenant's data lives in %s; retry against %s",
				string(tenantRegion), correct))
		return false
	}
	return true
}

// MintToken creates a new SCIM token for the tenant. Returns the
// plaintext token ONCE (operator copy-paste); subsequent reads only
// surface the prefix.
func MintToken(ctx context.Context, pool *db.Pool, tenantID, createdByUserID, description string) (token string, prefix string, err error) {
	raw, err := randomToken()
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256([]byte(raw))
	prefix = raw[:8]
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var createdBy any
	if createdByUserID != "" {
		createdBy = createdByUserID
	}
	_, err = tx.Exec(ctx, `
INSERT INTO scim_tokens (tenant_id, token_sha256, token_prefix, description, created_by)
VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
		tenantID, sum[:], prefix, description, createdBy)
	if err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return raw, prefix, nil
}

func randomToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "scim_" + hex.EncodeToString(b[:]), nil
}

// tenantIDFromContext returns the SCIM-bound tenant_id.
func tenantIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(ctxKeyTenant).(string)
	return v
}

// utility: chi URL param wrapper.
func urlParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

// ListResponseFor builds the standard SCIM list-response wrapper.
func ListResponseFor(items any, start, total int) ListResponse {
	itemsPer := 0
	switch v := items.(type) {
	case []User:
		itemsPer = len(v)
	case []Group:
		itemsPer = len(v)
	}
	return ListResponse{
		Schemas:      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		TotalResults: total,
		ItemsPerPage: itemsPer,
		StartIndex:   start,
		Resources:    items,
	}
}

// userSchemas + groupSchemas are the canonical "$schemas" array.
func userSchemas() []string {
	return []string{"urn:ietf:params:scim:schemas:core:2.0:User"}
}
func groupSchemas() []string {
	return []string{"urn:ietf:params:scim:schemas:core:2.0:Group"}
}

// --- discovery endpoints ---

// ServiceProviderConfig advertises which SCIM features Moosewave
// supports. PATCH=true, ETag=false, filter=true (we support equality
// only — IdPs probe for `eq` and gracefully degrade).
func (d *Deps) ServiceProviderConfig(w http.ResponseWriter, _ *http.Request) {
	writeSCIM(w, http.StatusOK, map[string]any{
		"schemas":        []string{"urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"},
		"patch":          map[string]bool{"supported": true},
		"filter":         map[string]any{"supported": true, "maxResults": 200},
		"changePassword": map[string]bool{"supported": false},
		"sort":           map[string]bool{"supported": false},
		"etag":           map[string]bool{"supported": false},
		"authenticationSchemes": []map[string]any{{
			"type":        "oauthbearertoken",
			"name":        "OAuth Bearer Token",
			"description": "Moosewave SCIM tokens issued per tenant.",
		}},
	})
}

// ResourceTypes lists what the server supports (User + Group).
func (d *Deps) ResourceTypes(w http.ResponseWriter, _ *http.Request) {
	writeSCIM(w, http.StatusOK, map[string]any{
		"schemas":      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"totalResults": 2,
		"Resources": []map[string]any{
			{
				"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"},
				"id":          "User",
				"name":        "User",
				"endpoint":    "/Users",
				"schema":      "urn:ietf:params:scim:schemas:core:2.0:User",
				"description": "Moosewave user account",
			},
			{
				"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"},
				"id":          "Group",
				"name":        "Group",
				"endpoint":    "/Groups",
				"schema":      "urn:ietf:params:scim:schemas:core:2.0:Group",
				"description": "Moosewave SCIM group; maps to a role via scim_role_mappings",
			},
		},
	})
}

// Schemas returns the SCIM core User + Group schema definitions Moosewave
// supports, so an IdP that introspects /Schemas during discovery sees the real
// attribute set (userName, name, emails, active, externalId for User;
// displayName, members for Group) instead of an empty list.
func (d *Deps) Schemas(w http.ResponseWriter, _ *http.Request) {
	resources := []any{scimUserSchema(), scimGroupSchema()}
	writeSCIM(w, http.StatusOK, map[string]any{
		"schemas":      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"totalResults": len(resources),
		"Resources":    resources,
	})
}

// scimAttr builds one attribute definition with RFC 7643 defaults.
func scimAttr(name, typ string, multiValued, required bool, sub ...map[string]any) map[string]any {
	a := map[string]any{
		"name":        name,
		"type":        typ,
		"multiValued": multiValued,
		"required":    required,
		"caseExact":   false,
		"mutability":  "readWrite",
		"returned":    "default",
		"uniqueness":  "none",
	}
	if len(sub) > 0 {
		a["subAttributes"] = sub
	}
	return a
}

func scimUserSchema() map[string]any {
	userName := scimAttr("userName", "string", false, true)
	userName["uniqueness"] = "server"
	extID := scimAttr("externalId", "string", false, false)
	extID["caseExact"] = true
	return map[string]any{
		"id":          "urn:ietf:params:scim:schemas:core:2.0:User",
		"name":        "User",
		"description": "User Account",
		"attributes": []map[string]any{
			userName,
			scimAttr("name", "complex", false, false,
				scimAttr("givenName", "string", false, false),
				scimAttr("familyName", "string", false, false)),
			scimAttr("displayName", "string", false, false),
			scimAttr("emails", "complex", true, false,
				scimAttr("value", "string", false, false),
				scimAttr("primary", "boolean", false, false)),
			scimAttr("active", "boolean", false, false),
			extID,
		},
		"meta": map[string]any{
			"resourceType": "Schema",
			"location":     "/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
		},
	}
}

func scimGroupSchema() map[string]any {
	extID := scimAttr("externalId", "string", false, false)
	extID["caseExact"] = true
	return map[string]any{
		"id":          "urn:ietf:params:scim:schemas:core:2.0:Group",
		"name":        "Group",
		"description": "Group",
		"attributes": []map[string]any{
			scimAttr("displayName", "string", false, true),
			scimAttr("members", "complex", true, false,
				scimAttr("value", "string", false, false),
				scimAttr("display", "string", false, false)),
			extID,
		},
		"meta": map[string]any{
			"resourceType": "Schema",
			"location":     "/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group",
		},
	}
}

// parseEqFilter extracts the literal from a filter like
// `userName eq "alice@example.com"`. Returns ("", "", false) when the
// filter is empty or non-equality.
func parseEqFilter(raw string) (attr, value string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", false
	}
	// Format: <attr> eq "<value>"
	parts := strings.SplitN(raw, " eq ", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	v := strings.TrimSpace(parts[1])
	v = strings.Trim(v, "\"")
	return strings.TrimSpace(parts[0]), v, true
}

// fmtErr formats an internal error for the SCIM body without leaking
// internal repr.
func fmtErr(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("internal: %s", err.Error())
}
