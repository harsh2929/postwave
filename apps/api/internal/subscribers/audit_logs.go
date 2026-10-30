// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-123 — Audit Logs API scoped to a single subscriber.
//
// A SIEM-friendly, paginated read of the subscriber-mutating audit trail for
// one profile. Subscriber mutations already emit audit_log rows
// (subscriber.create via Identify, subscriber.merged, subscriber.deleted,
// subscriber.bulk_deleted) carrying action='subscriber.*' and
// resource_id={subscriber_id}. This endpoint filters the existing,
// RLS-protected audit_log table (migration 0002) down to one subscriber so a
// security team can ingest "what changed for this contact" without scanning
// the global /api/v1/audit feed.
//
//	GET /api/v1/subscribers/{id}/audit?action=&since=&cursor=&limit=
//
// The audit_log_tenant_action_at_idx index already serves the
// (tenant_id, action LIKE 'subscriber.%') predicate efficiently; the
// resource_id filter narrows to the single profile. No schema changes needed.

package subscribers

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// auditLogDefaultLimit / auditLogMaxLimit bound the page size so a misclicked
// "export all" cannot try to materialize an unbounded slice. Mirrors the
// global audit endpoint's 50/500 defaults.
const (
	auditLogDefaultLimit = 50
	auditLogMaxLimit     = 500
)

// AuditLogEntry is one row of the subscriber-scoped audit trail. It is a thin
// projection of audit_log that mirrors the field set the global
// GET /api/v1/audit endpoint returns, so SIEM ingest can reuse one parser.
type AuditLogEntry struct {
	ID           int64          `json:"id"`
	Action       string         `json:"action"`
	ResourceType string         `json:"resource_type,omitempty"`
	ResourceID   string         `json:"resource_id,omitempty"`
	ActorType    string         `json:"actor_type"`
	ActorLabel   string         `json:"actor_label,omitempty"`
	UserID       string         `json:"user_id,omitempty"`
	IP           string         `json:"ip,omitempty"`
	UserAgent    string         `json:"user_agent,omitempty"`
	Metadata     map[string]any `json:"metadata"`
	At           time.Time      `json:"at"`
}

// AuditLogResponse is the cursor-paginated body. NextCursor is non-empty only
// when a further page exists; clients pass it back as ?cursor=.
type AuditLogResponse struct {
	Items      []AuditLogEntry `json:"items"`
	NextCursor string          `json:"next_cursor,omitempty"`
}

// auditLogOptions captures the parsed query params for ListAuditLogs.
type auditLogOptions struct {
	Action string     // optional prefix-anchored action filter; ANDed with subscriber.% scope
	Since  *time.Time // optional lower bound on at (inclusive)
	Cursor int64      // keyset cursor: return rows with id < Cursor; 0 = first page
	Limit  int
}

// MountAuditLogRoutes wires the SUB-123 scoped audit endpoint. Read-only, so
// it requires the read:subscribers scope (the same gate the rest of the
// subscriber read surface uses).
func MountAuditLogRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/audit",
			observability.RecordSurfaceFunc("subscribers", "audit_list", d.AuditLogs))
}

// AuditLogs GET /api/v1/subscribers/{id}/audit
//
// Returns the subscriber-mutating audit history for one profile, newest
// first, with cursor-based pagination. {id} may be the subscriber's Moosewave
// id (the resource_id audit rows carry) or its email — when an email is
// supplied it is first resolved to the row id so the resource_id filter still
// matches.
func (d *Deps) AuditLogs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "subscriber id or email required"))
		return
	}
	opts, err := parseAuditLogOptions(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_request", err.Error()))
		return
	}
	out, err := d.Repo.ListAuditLogs(r.Context(), t.ID, id, opts)
	if err != nil {
		if err == ErrNotFound {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// parseAuditLogOptions reads the action / since / cursor / limit query params,
// applying the same bounds as the global audit endpoint. A malformed `since`
// is a 400 so a caller does not silently get an unfiltered page.
func parseAuditLogOptions(r *http.Request) (auditLogOptions, error) {
	q := r.URL.Query()
	opts := auditLogOptions{
		Action: strings.TrimSpace(q.Get("action")),
		Limit:  auditLogDefaultLimit,
	}
	if v := strings.TrimSpace(q.Get("limit")); v != "" {
		if n, perr := strconv.Atoi(v); perr == nil && n > 0 {
			opts.Limit = n
		}
	}
	if opts.Limit > auditLogMaxLimit {
		opts.Limit = auditLogMaxLimit
	}
	if v := strings.TrimSpace(q.Get("cursor")); v != "" {
		n, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil || n < 0 {
			return opts, errAuditBadCursor
		}
		opts.Cursor = n
	}
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		parsed, perr := time.Parse(time.RFC3339, raw)
		if perr != nil {
			parsed, perr = time.Parse(time.RFC3339Nano, raw)
		}
		if perr != nil {
			return opts, errBadSince
		}
		opts.Since = &parsed
	}
	return opts, nil
}

// errAuditBadCursor / errBadSince are sentinel parse errors surfaced as 400s.
// (Named distinctly from list_cursor.go's errInvalidCursor to avoid a
// package-level redeclaration.)
var (
	errAuditBadCursor = parseError("cursor must be a non-negative integer")
	errBadSince       = parseError("since must be an RFC3339 timestamp")
)

type parseError string

func (e parseError) Error() string { return string(e) }

// escapeLikePattern neutralizes the LIKE metacharacters (\, %, _) in a
// caller-supplied term so it is matched literally inside a LIKE pattern (used
// with ESCAPE '\'). Without this a caller passing action=foo% would otherwise
// widen the prefix match beyond the documented dotted-namespace anchoring.
func escapeLikePattern(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// ListAuditLogs resolves the subscriber (by id or email) then queries the
// existing audit_log table for the subscriber-mutating events that carry that
// resource_id. The query is scoped to action LIKE 'subscriber.%' so a future
// non-subscriber row sharing the id (resource_id is free-text across resource
// types) cannot leak in. Cursor is a keyset on id DESC.
func (r *Repo) ListAuditLogs(ctx context.Context, tenantID, id string, opts auditLogOptions) (*AuditLogResponse, error) {
	if opts.Limit <= 0 {
		opts.Limit = auditLogDefaultLimit
	}
	if opts.Limit > auditLogMaxLimit {
		opts.Limit = auditLogMaxLimit
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve the subscriber so an email identifier still matches the
	// resource_id audit rows carry (always the row id). This also 404s for
	// an unknown subscriber rather than returning an empty page that could be
	// confused with "no audit history".
	sub, err := getInTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}

	// Prefix-anchored action match: an explicit ?action= must match either the
	// exact action term or a dotted-namespace descendant of it (e.g.
	// action=subscriber matches subscriber.updated; action=subscriber.updated
	// matches only that exact action). It is NOT an unanchored substring, so
	// action=foo can never match 'subscriber.unfoo'. LIKE metacharacters in the
	// caller-supplied term are escaped so a literal % / _ cannot widen the match.
	actionPrefix := escapeLikePattern(opts.Action) + ".%"
	const sql = `
SELECT id, action, resource_type, resource_id,
       actor_type, actor_label, user_id::text,
       host(ip), user_agent, metadata, at
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action LIKE 'subscriber.%'
   AND resource_id = $2
   AND ($3 = '' OR action = $3 OR action LIKE $4 ESCAPE '\')
   AND ($5 = 0  OR id < $5)
   AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
 ORDER BY id DESC
 LIMIT $7`
	rows, err := tx.Query(ctx, sql,
		tenantID, sub.ID, opts.Action, actionPrefix, opts.Cursor, opts.Since, opts.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := &AuditLogResponse{Items: []AuditLogEntry{}}
	for rows.Next() {
		var (
			e            AuditLogEntry
			resourceType *string
			resourceID   *string
			actorLabel   *string
			userID       *string
			ip           *string
			userAgent    *string
			meta         map[string]any
		)
		if err := rows.Scan(&e.ID, &e.Action, &resourceType, &resourceID,
			&e.ActorType, &actorLabel, &userID,
			&ip, &userAgent, &meta, &e.At); err != nil {
			return nil, err
		}
		if resourceType != nil {
			e.ResourceType = *resourceType
		}
		if resourceID != nil {
			e.ResourceID = *resourceID
		}
		if actorLabel != nil {
			e.ActorLabel = *actorLabel
		}
		if userID != nil {
			e.UserID = *userID
		}
		if ip != nil {
			e.IP = *ip
		}
		if userAgent != nil {
			e.UserAgent = *userAgent
		}
		if meta == nil {
			meta = map[string]any{}
		}
		e.Metadata = meta
		out.Items = append(out.Items, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(out.Items) == opts.Limit {
		out.NextCursor = strconv.FormatInt(out.Items[len(out.Items)-1].ID, 10)
	}
	return out, nil
}
