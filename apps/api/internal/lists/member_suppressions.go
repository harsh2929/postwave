package lists

// AUDIT-DESKTOP-2026-06-10 §A2 (GAP-LS-143): per-list suppressions.
//
//	GET /api/v1/lists/{id}/suppressions?page=&per_page=
//
// Returns suppressed addresses scoped to the ACTIVE members of one
// list. The desktop SuppressionTab previously showed the tenant-wide
// recent-50 slice with a disclaimer; this endpoint is the real
// list-scoped read.
//
// Which suppression source: the gateway has three coexisting
// suppression tables (`suppressions` 0060, `email_suppressions` 0030,
// `subscriber_suppressions` 0081). The converged read path — the one
// the send loop's SuppressionConverger consults — is the
// v_suppressions_unified VIEW (migration 0244, security_invoker, RLS
// inherited from the base tables). We join list memberships against
// that view so a member suppressed through ANY write path (legacy
// admin add, Mailchimp-parity API, X1 webhook receivers) shows up.
//
// Row shape: mirrors the tenant-wide GET /api/v1/suppressions rows
// (subscribers.Suppression JSON keys: email, reason, source,
// provider_event_id, metadata, suppressed_at, expires_at, created_at)
// with two honest divergences, both forced by the unified view:
//   - NO `id` field. The view is a UNION ALL over three tables and
//     exposes no stable row id; inventing one would be fake. Clients
//     should key rows on `email`.
//   - extra `source_table` field so operators can see which of the
//     three tables the row came from (same field the converger
//     surfaces on its entries).
//
// Predicate decisions (documented contract):
//   - membership: removed_at IS NULL (active members only — same
//     predicate as the Members tab read in members.go).
//   - suppression: active only (expires_at IS NULL OR > now()) — the
//     question this tab answers is "which of my members can't be
//     mailed", which is the converger's active predicate, not the
//     tenant-wide admin list's everything-including-expired view.
//   - dedup: one row per address (DISTINCT ON lower(email), newest
//     suppression wins). The view is row-per-source-table; an
//     audit-grade multi-row view belongs to the suppression timeline
//     endpoint, not this list.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MemberSuppression is one suppressed list member. Field set mirrors
// subscribers.Suppression (the tenant-wide list row) minus `id`, plus
// `source_table` — see the file header for why.
type MemberSuppression struct {
	Email           string         `json:"email"`
	Reason          string         `json:"reason"`
	Source          string         `json:"source"`
	ProviderEventID string         `json:"provider_event_id,omitempty"`
	Metadata        map[string]any `json:"metadata"`
	SuppressedAt    time.Time      `json:"suppressed_at"`
	ExpiresAt       *time.Time     `json:"expires_at,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	SourceTable     string         `json:"source_table,omitempty"`
}

// MemberSuppressionsPage is the response envelope for
// GET /api/v1/lists/{id}/suppressions. Matches the tenant-wide
// SuppressionPage envelope (items/total/page/per_page).
type MemberSuppressionsPage struct {
	Items   []MemberSuppression `json:"items"`
	Total   int                 `json:"total"`
	Page    int                 `json:"page"`
	PerPage int                 `json:"per_page"`
}

// GetSuppressions handles GET /api/v1/lists/{id}/suppressions.
//
// Query params: page (1-indexed, default 1), per_page (default 25,
// capped at 200 — same bounds as the members read). {id} accepts the
// Moosewave uuid or the Listmonk bigint, resolved exactly like
// GetSubscribers.
func (d *Deps) GetSuppressions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}

	rawID := strings.TrimSpace(chi.URLParam(r, "id"))
	if rawID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id required"))
		return
	}
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, rawID)
	if err != nil {
		d.writeListIdentityError(w, r, err)
		return
	}

	page := parsePositiveInt(r.URL.Query().Get("page"), 1)
	perPage := parsePositiveInt(r.URL.Query().Get("per_page"), membersDefaultPerPage)
	if perPage > membersMaxPerPage {
		perPage = membersMaxPerPage
	}

	items, total, err := d.Repo.ListMemberSuppressions(r.Context(), t.ID, listUUID, page, perPage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, MemberSuppressionsPage{
		Items:   items,
		Total:   total,
		Page:    page,
		PerPage: perPage,
	})
}

// memberSuppressionsFromSQL is the shared join: active memberships of
// the list, through subscribers for the canonical email, against the
// unified suppressions view (active rows only). lower() on both sides
// because the view casts citext to text, losing citext's native
// case-insensitive compare.
const memberSuppressionsFromSQL = `
  FROM list_subscribers ls
  JOIN subscribers s ON s.id = ls.subscriber_id
  JOIN v_suppressions_unified v
    ON v.tenant_id = ls.tenant_id
   AND lower(v.email) = lower(s.email::text)
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id = $2::uuid
   AND ls.removed_at IS NULL
   AND (v.expires_at IS NULL OR v.expires_at > now())`

// ListMemberSuppressions runs the paginated join. Count + page slice
// in one tx so total stays consistent with the slice (same pattern as
// ListMembers).
func (r *Repo) ListMemberSuppressions(ctx context.Context, tenantID, listUUID string, page, perPage int) ([]MemberSuppression, int, error) {
	if r == nil || r.Pool == nil {
		return nil, 0, fmt.Errorf("lists: repo not configured")
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = membersDefaultPerPage
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(DISTINCT lower(v.email))`+memberSuppressionsFromSQL,
		tenantID, listUUID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count member suppressions: %w", err)
	}

	offset := (page - 1) * perPage
	rows, err := tx.Query(ctx, `
SELECT email, reason, source, provider_event_id, metadata, created_at, expires_at, source_table
  FROM (
    SELECT DISTINCT ON (lower(v.email))
           v.email::text                    AS email,
           v.reason,
           COALESCE(v.source, '')           AS source,
           COALESCE(v.source_event_id, '')  AS provider_event_id,
           v.metadata,
           v.created_at,
           v.expires_at,
           v.source_table`+memberSuppressionsFromSQL+`
     ORDER BY lower(v.email), v.created_at DESC
  ) dedup
 ORDER BY created_at DESC, email ASC
 LIMIT $3 OFFSET $4`, tenantID, listUUID, perPage, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("select member suppressions: %w", err)
	}
	defer rows.Close()

	out := make([]MemberSuppression, 0, perPage)
	for rows.Next() {
		var m MemberSuppression
		var meta []byte
		if err := rows.Scan(&m.Email, &m.Reason, &m.Source, &m.ProviderEventID,
			&meta, &m.CreatedAt, &m.ExpiresAt, &m.SourceTable); err != nil {
			return nil, 0, fmt.Errorf("scan member suppression: %w", err)
		}
		// The view maps each base table's "when it was suppressed"
		// column into created_at; surface it under both keys so the
		// shape stays drop-in with the tenant-wide rows.
		m.SuppressedAt = m.CreatedAt
		m.Metadata = decodeMetadataJSON(meta)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// decodeMetadataJSON is a forgiving jsonb-bytes -> map decoder.
// Malformed metadata degrades to an empty map rather than failing the
// page — same absorb-and-continue behaviour the suppressions package
// uses for its metadata bags.
func decodeMetadataJSON(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return out
}
