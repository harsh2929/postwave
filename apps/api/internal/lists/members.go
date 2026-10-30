package lists

// GAP-LS-042: paginated list-members endpoint. Today the lists package
// only proxies CRUD to Listmonk; the desktop UI fakes member counts
// from a tag substring search capped at 10 rows. This file owns the
// real query against list_subscribers + subscribers so the slideover
// Members tab can show actual membership with search + status filter.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MemberSubscriber is the projection the Members tab renders. We keep
// the field set narrow on purpose: the join is hot and the slideover
// only needs identity + status + when they were added. Callers that
// need the rest of the subscriber record can drill into
// /api/v1/subscribers/{id}.
type MemberSubscriber struct {
	ID      string    `json:"id"`
	Email   string    `json:"email"`
	Status  string    `json:"status"`
	Source  string    `json:"source,omitempty"`
	AddedAt time.Time `json:"added_at"`
}

// MembersPage is the response shape for GET /api/v1/lists/{id}/subscribers.
// Matches subscribers.Page exactly so the desktop client can share the
// same Subscriber-list rendering code.
type MembersPage struct {
	ListID  string             `json:"list_id"`
	Items   []MemberSubscriber `json:"items"`
	Total   int                `json:"total"`
	Page    int                `json:"page"`
	PerPage int                `json:"per_page"`
}

const (
	membersDefaultPerPage = 25
	membersMaxPerPage     = 200
)

// activeMembersFrom and activeMemberPredicate are the one definition of "a
// member of this list" every membership count in this package reports: a
// membership row that has not been removed, joined to the subscriber it names.
//
// The Lists page used to show Listmonk's own subscriber_lists count while the
// Members tab counted these rows, and nothing kept the two stores in step — a
// list with members read "0 subscribers" on its card. The Members tab, the
// catalogue's subscriber_count and the campaign checklist's audience count now
// all read through these two fragments, so they cannot disagree again.
const (
	activeMembersFrom     = `list_subscribers ls JOIN subscribers s ON s.id = ls.subscriber_id AND s.tenant_id = ls.tenant_id`
	activeMemberPredicate = `ls.removed_at IS NULL`
)

// SubscriberListRef is one row in the "lists a subscriber belongs to"
// response (D04#10).
type SubscriberListRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// EngineID is Listmonk's bigint for this list. It is how Name gets
	// resolved -- see GetListsForSubscriber -- and is not part of the wire
	// contract.
	EngineID int64 `json:"-"`
}

// GetListsForSubscriber handles GET /api/v1/lists/for-subscriber/{sub_id}
// — the lists a subscriber currently belongs to, for the subscriber
// slideover's Lists section (D04#10).
func (d *Deps) GetListsForSubscriber(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	subID := strings.TrimSpace(chi.URLParam(r, "sub_id"))
	if subID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "subscriber id required"))
		return
	}
	if _, err := uuid.Parse(subID); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "subscriber id must be a UUID"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	out, err := d.Repo.ListsForSubscriber(r.Context(), t.ID, subID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Names come from the engine because that is the only place they exist. A
	// failed hop is reported rather than papered over: WriteInternal classifies
	// an unreachable upstream as 502, so "the engine is down" and "we broke" stay
	// distinguishable. Membership without names would look like a rendered,
	// empty answer.
	if len(out) > 0 {
		names, nameErr := d.engineListNames(r.Context())
		if nameErr != nil {
			httperror.WriteInternal(w, d.Logger, nameErr, r.Context())
			return
		}
		for i := range out {
			out[i].Name = names[out[i].EngineID]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"subscriber_id": subID,
		"items":         out,
		"count":         len(out),
	})
}

// ListsForSubscriber returns the (non-removed) list memberships for a
// subscriber under RLS.
func (r *Repo) ListsForSubscriber(ctx context.Context, tenantID, subscriberID string) ([]SubscriberListRef, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// There is no `lists` table in this database and no migration has ever
	// created one -- list NAMES live in the Listmonk engine, which is why
	// /api/v1/lists is a proxy. Joining it made every call to this route fail
	// with 42P01, so the subscriber slideover's Lists section has never once
	// rendered.
	//
	// Read what this database actually holds: the membership rows and the
	// engine id of each list. The caller resolves names over the engine's HTTP
	// API, which is the only place they exist.
	//
	// The engine id comes from the list's identity when the membership row
	// does not carry it. The denormalised listmonk_list_id is optional — the
	// bulk add-to-list verb used to write NULL there — and resolving only
	// through it named every such list "" in the subscriber's Lists panel.
	rows, err := tx.Query(ctx, `
SELECT ls.list_id::text, COALESCE(ls.listmonk_list_id, m.listmonk_bigint_id, 0)
  FROM list_subscribers ls
  LEFT JOIN list_id_map m
    ON m.tenant_id = ls.tenant_id
   AND m.postwave_uuid = ls.list_id
 WHERE ls.tenant_id = $1::uuid AND ls.subscriber_id = $2::uuid AND ls.removed_at IS NULL
 ORDER BY ls.added_at DESC`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriberListRef{}
	for rows.Next() {
		var s SubscriberListRef
		if err := rows.Scan(&s.ID, &s.EngineID); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GetSubscribers handles GET /api/v1/lists/{id}/subscribers.
//
// Query params:
//   - query: substring match on subscribers.email (case-insensitive)
//   - status: one of enabled / disabled / blocklisted / unconfirmed
//   - page: 1-indexed, default 1
//   - per_page: default 25, capped at 200
//
// Membership lookups accept either the Moosewave uuid or the Listmonk
// bigint via list_id_map (GAP-LS-045 resolution path). The query joins
// list_subscribers -> subscribers under RLS so cross-tenant rows are
// silently filtered by the tenant_isolation policy.
func (d *Deps) GetSubscribers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	rawID := chi.URLParam(r, "id")
	if rawID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id required"))
		return
	}
	if rawID != strings.TrimSpace(rawID) {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id must be a positive integer or UUID"))
		return
	}
	if _, err := normalizeListUUID(rawID); err != nil {
		if _, ok := parseInt64Strict(rawID); !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id must be a positive integer or UUID"))
			return
		}
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, rawID)
	if err != nil {
		d.writeListIdentityError(w, r, err)
		return
	}

	q := strings.TrimSpace(listsearch.ReadQuery(r.URL.Query()))
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if status != "" && !validMemberStatus(status) {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_status", "status must be one of enabled, disabled, blocklisted, unconfirmed"))
		return
	}
	page := parsePositiveInt(r.URL.Query().Get("page"), 1)
	perPage := parsePositiveInt(r.URL.Query().Get("per_page"), membersDefaultPerPage)
	if perPage > membersMaxPerPage {
		perPage = membersMaxPerPage
	}

	out, total, err := d.Repo.ListMembers(r.Context(), t.ID, listUUID, q, status, page, perPage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, MembersPage{
		ListID:  listUUID,
		Items:   out,
		Total:   total,
		Page:    page,
		PerPage: perPage,
	})
}

// resolveListUUID resolves a public list id — Listmonk bigint or Moosewave
// uuid — to the canonical uuid of a live list of this tenant. Every
// list-scoped route resolves through here.
//
// A uuid used to be returned as-is once it parsed, so any made-up or deleted
// list's uuid was accepted: the members routes listed and wrote memberships of
// lists that did not exist, and CSV import filled them. Both forms now have to
// name a list the tenant has a live identity for; anything else is
// ErrListIDNotMapped (a 404) and a malformed id is ErrInvalidListID (a 400).
//
// The resolution commits before this returns, so it answers a request early;
// it does not hold the list. Every writer re-verifies the list with
// ResolveListIdentityTx in its own writing transaction.
func (r *Repo) resolveListUUID(ctx context.Context, tenantID, raw string) (string, error) {
	if _, _, err := ParseListID(raw); err != nil {
		return "", err
	}
	if r == nil || r.Pool == nil {
		return "", ErrListsRepoUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	identity, err := ResolveListIdentityTx(ctx, tx, tenantID, raw)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return identity.UUID, nil
}

// normalizeListUUID accepts only the canonical hyphenated UUID shape and
// normalises hexadecimal case. google/uuid intentionally accepts several
// convenience encodings (URNs, braces, raw hex); public list routes do not,
// because those aliases make identity echoes and cache keys ambiguous.
func normalizeListUUID(raw string) (string, error) {
	if len(raw) != 36 || raw[8] != '-' || raw[13] != '-' || raw[18] != '-' || raw[23] != '-' {
		return "", ErrInvalidListID
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		return "", ErrInvalidListID
	}
	return parsed.String(), nil
}

// ListMembers runs the paginated join. Total + items in one tx to keep
// the count consistent with the page slice.
func (r *Repo) ListMembers(ctx context.Context, tenantID, listUUID, query, status string, page, perPage int) ([]MemberSubscriber, int, error) {
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

	// Build the WHERE fragment + args incrementally so we don't risk
	// shifting positional placeholders.
	args := []any{tenantID, listUUID}
	where := "ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid AND " + activeMemberPredicate
	if query != "" {
		args = append(args, "%"+strings.ToLower(query)+"%")
		where += fmt.Sprintf(" AND lower(s.email::text) LIKE $%d", len(args))
	}
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND s.status = $%d", len(args))
	}

	var total int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM `+activeMembersFrom+` WHERE `+where,
		args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count members: %w", err)
	}

	offset := (page - 1) * perPage
	args = append(args, perPage, offset)
	rows, err := tx.Query(ctx,
		`SELECT s.id::text, s.email::text, s.status, COALESCE(ls.source, ''), ls.added_at
		   FROM `+activeMembersFrom+`
		  WHERE `+where+`
		  ORDER BY ls.added_at DESC, s.email ASC
		  LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)),
		args...)
	if err != nil {
		return nil, 0, fmt.Errorf("select members: %w", err)
	}
	defer rows.Close()

	out := make([]MemberSubscriber, 0, perPage)
	for rows.Next() {
		var m MemberSubscriber
		if err := rows.Scan(&m.ID, &m.Email, &m.Status, &m.Source, &m.AddedAt); err != nil {
			return nil, 0, fmt.Errorf("scan member: %w", err)
		}
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

func validMemberStatus(s string) bool {
	switch s {
	case "enabled", "disabled", "blocklisted", "unconfirmed":
		return true
	}
	return false
}

func parsePositiveInt(raw string, fallback int) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallback
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

// engineListNames resolves Listmonk list ids to names in one hop.
//
// Listmonk answers {"data":{"results":[{"id":1,"name":"..."}]}}. Only the two
// fields needed are decoded, so an unrelated change to the engine's list
// payload cannot break this.
func (d *Deps) engineListNames(ctx context.Context) (map[int64]string, error) {
	body, status, err := d.proxyCtx(ctx, http.MethodGet, "/api/lists?per_page=all", nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, fmt.Errorf("lists: engine returned %d resolving list names", status)
	}
	var envelope struct {
		Data struct {
			Results []struct {
				ID   int64  `json:"id"`
				Name string `json:"name"`
			} `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("lists: decoding engine list names: %w", err)
	}
	names := make(map[int64]string, len(envelope.Data.Results))
	for _, l := range envelope.Data.Results {
		names[l.ID] = l.Name
	}
	return names, nil
}
