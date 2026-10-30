// SPDX-License-Identifier: AGPL-3.0-only
//
// Package notification_feed is the server-backed per-user in-app notification
// inbox (the "bell") with seen/read state — migration 1630. Distinct from
// notification_preferences (gates outbound email) and from web/desktop push:
// this is the operator's own in-product activity feed.
//
// Producers call Repo.Notify / Repo.Fanout to drop a row for one or many
// users; the session-scoped HTTP handlers let the acting user list their feed
// and mark items seen/read. RLS guards the tenant boundary; the handlers
// always pin user_id to the acting session user, so a user can only ever read
// or mutate their own rows.

package notification_feed

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// Item is the wire shape of one feed row.
type Item struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	EventType string         `json:"event_type,omitempty"`
	Title     string         `json:"title"`
	Body      string         `json:"body,omitempty"`
	DeepLink  string         `json:"deep_link,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	SeenAt    *time.Time     `json:"seen_at,omitempty"`
	ReadAt    *time.Time     `json:"read_at,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	// Actions are what the person can DO about this, decided by the server at
	// write time. Always present, possibly empty: a client that had to treat
	// absent and empty differently would be re-deriving the rule this field
	// exists to remove.
	Actions []notifications.Action `json:"actions"`
}

// NewNotification is what a producer pushes.
type NewNotification struct {
	Kind     string
	Title    string
	Body     string
	DeepLink string
	Payload  map[string]any
	// Suppressed writes the row as a dedup/identity anchor only, hidden from the
	// in-app feed reads (List + unread count). Set by the fanout when a user has
	// the in-app channel OFF but another durable-anchored channel (webhook) ON.
	Suppressed bool
}

// Repo is the data layer.
type Repo struct{ Pool *db.Pool }

const selectCols = `id::text, kind, event_type, title, body, deep_link, payload, seen_at, read_at, created_at, actions`

// Notify inserts one feed row for a single user. Returns the new id. Producer
// API; tenant-scoped via db.WithTenant so RLS fires.
func (r *Repo) Notify(ctx context.Context, tenantID, userID string, n NewNotification) (string, error) {
	ids, err := r.Fanout(ctx, tenantID, []string{userID}, n)
	if err != nil || len(ids) == 0 {
		return "", err
	}
	return ids[0], nil
}

// NotifyDeduped inserts one feed row for a single user with a cross-channel
// identity: the returned id is THE notification_id every delivery channel
// (feed, mobile push, web push, SSE) carries, and dedupeKey makes the logical
// notification insert-once per (tenant, user). created=false means an earlier
// dispatch already created this notification — the caller must SUPPRESS its
// channel fanout, which is what makes "reaches every device, once" true
// across replicas and retries. An empty dedupeKey degrades to a plain insert.
func (r *Repo) NotifyDeduped(
	ctx context.Context,
	tenantID, userID string,
	n NewNotification,
	eventType, dedupeKey string,
) (id string, created bool, err error) {
	if userID == "" {
		return "", false, nil
	}
	payload, _ := json.Marshal(nonNil(n.Payload))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Derived HERE, from the event type, rather than passed in by each caller.
	//
	// The actions a notification offers are a property of what happened, not of
	// who is writing the row — and there are several writers. A parameter would
	// be one more thing every producer must remember, and the one that forgot
	// would produce a notification that is silently less actionable than the
	// same event from somewhere else.
	actions, marshalErr := json.Marshal(notifications.ActionsForEvent(eventType))
	if marshalErr != nil {
		return "", false, marshalErr
	}

	if dedupeKey == "" {
		if err := tx.QueryRow(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, payload, event_type, suppressed, actions)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
RETURNING id::text`,
			tenantID, userID, n.Kind, n.Title, n.Body, n.DeepLink, string(payload), eventType, n.Suppressed, string(actions)).Scan(&id); err != nil {
			return "", false, err
		}
		return id, true, tx.Commit(ctx)
	}
	err = tx.QueryRow(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, payload, event_type, dedupe_key, suppressed, actions)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key <> '' DO NOTHING
RETURNING id::text`,
		tenantID, userID, n.Kind, n.Title, n.Body, n.DeepLink, string(payload), eventType, dedupeKey, n.Suppressed, string(actions)).Scan(&id)
	switch {
	case err == nil:
		return id, true, tx.Commit(ctx)
	case errors.Is(err, pgx.ErrNoRows):
		// Duplicate — surface the existing identity so the caller can still
		// reference it (read-sync), but signal that fanout must be suppressed.
		if err := tx.QueryRow(ctx, `
SELECT id::text FROM notification_feed
WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND dedupe_key = $3`,
			tenantID, userID, dedupeKey).Scan(&id); err != nil {
			return "", false, err
		}
		return id, false, tx.Commit(ctx)
	default:
		return "", false, err
	}
}

// Fanout inserts the same notification for many users in one transaction and
// returns the created row ids. Skips empty user ids.
func (r *Repo) Fanout(ctx context.Context, tenantID string, userIDs []string, n NewNotification) ([]string, error) {
	payload, _ := json.Marshal(nonNil(n.Payload))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := []string{}
	for _, uid := range userIDs {
		if uid == "" {
			continue
		}
		var id string
		if err := tx.QueryRow(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, payload)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)
RETURNING id::text`,
			tenantID, uid, n.Kind, n.Title, n.Body, n.DeepLink, string(payload)).Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Pagination bounds. maxListLimit is the largest page a caller may ask for;
// an out-of-range limit is CLAMPED (not reset to the default) so a client that
// asks for more than the ceiling still gets the ceiling instead of silently
// dropping back to 50.
const (
	defaultListLimit = 50
	maxListLimit     = 200
)

// ErrInvalidCursor is returned when a caller supplies a cursor that this
// server did not mint. Callers surface it as a 422, never a 500.
var ErrInvalidCursor = errors.New("notification_feed: invalid cursor")

// ListOptions bounds one page of the feed.
//
// Cursor is an opaque, server-minted keyset token over (created_at, id) — the
// exact ORDER BY of the query — so paging is stable while new notifications
// arrive at the head of the feed. Offsets were never an option here: the feed
// is append-at-the-front, so LIMIT/OFFSET would duplicate and skip rows.
type ListOptions struct {
	UnreadOnly bool
	Limit      int
	Cursor     string
}

// Page is one page of the feed plus the user's total unread count. NextCursor
// is empty when the page just returned is the last one.
type Page struct {
	Items       []Item
	UnreadCount int
	NextCursor  string
}

// EncodeCursor mints the opaque keyset token for a row. Exported for tests and
// for producers that want to resume from a known position.
func EncodeCursor(createdAt time.Time, id string) string {
	if id == "" {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(
		[]byte(strconv.FormatInt(createdAt.UTC().UnixMicro(), 10) + "." + id))
}

// decodeCursor parses a token minted by EncodeCursor. It never trusts the
// input: a malformed token is a client error, not a server error, and the id
// half is handed to Postgres as a uuid so a non-uuid is rejected here rather
// than becoming a 500 from a failed cast.
func decodeCursor(raw string) (time.Time, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, "", nil
	}
	if len(raw) > 256 {
		return time.Time{}, "", ErrInvalidCursor
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, "", ErrInvalidCursor
	}
	micros, id, found := strings.Cut(string(decoded), ".")
	if !found {
		return time.Time{}, "", ErrInvalidCursor
	}
	epoch, err := strconv.ParseInt(micros, 10, 64)
	if err != nil {
		return time.Time{}, "", ErrInvalidCursor
	}
	if !validUUID(id) {
		return time.Time{}, "", ErrInvalidCursor
	}
	return time.UnixMicro(epoch).UTC(), id, nil
}

// validUUID accepts the canonical 8-4-4-4-12 hex form only.
func validUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, c := range id {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// List returns one page of the user's feed (newest first) plus their unread
// count. When UnreadOnly is set, only rows with read_at IS NULL are returned.
// A page is fetched with limit+1 rows so "is there more" is answered without a
// second count query; the extra row is trimmed before returning.
func (r *Repo) List(ctx context.Context, tenantID, userID string, opts ListOptions) (Page, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	cursorAt, cursorID, err := decodeCursor(opts.Cursor)
	if err != nil {
		return Page{}, err
	}
	var cursorTime any
	var cursorRow any
	if cursorID != "" {
		cursorTime = cursorAt
		cursorRow = cursorID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Page{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+selectCols+`
  FROM notification_feed
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND NOT suppressed
   AND ($3 = false OR read_at IS NULL)
   AND ($4::timestamptz IS NULL
        OR (created_at, id) < ($4::timestamptz, $5::uuid))
 ORDER BY created_at DESC, id DESC
 LIMIT $6`, tenantID, userID, opts.UnreadOnly, cursorTime, cursorRow, limit+1)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var it Item
		var raw []byte
		var rawActions []byte
		if err := rows.Scan(&it.ID, &it.Kind, &it.EventType, &it.Title, &it.Body, &it.DeepLink,
			&raw, &it.SeenAt, &it.ReadAt, &it.CreatedAt, &rawActions); err != nil {
			return Page{}, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &it.Payload)
		}
		it.Actions = []notifications.Action{}
		if len(rawActions) > 0 {
			_ = json.Unmarshal(rawActions, &it.Actions)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	page := Page{}
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		page.NextCursor = EncodeCursor(last.CreatedAt, last.ID)
	}
	page.Items = out
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM notification_feed
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND read_at IS NULL AND NOT suppressed`,
		tenantID, userID).Scan(&page.UnreadCount); err != nil {
		return Page{}, err
	}
	return page, tx.Commit(ctx)
}

// MarkSeenAll stamps seen_at on every unseen row (clears the bell badge).
func (r *Repo) MarkSeenAll(ctx context.Context, tenantID, userID string) (int, error) {
	return r.bulkStamp(ctx, tenantID, userID, "seen_at")
}

// MarkReadAll stamps read_at (and seen_at) on every unread row.
func (r *Repo) MarkReadAll(ctx context.Context, tenantID, userID string) (int, error) {
	return r.bulkStamp(ctx, tenantID, userID, "read_at")
}

func (r *Repo) bulkStamp(ctx context.Context, tenantID, userID, col string) (int, error) {
	// col is a fixed internal literal ('seen_at'|'read_at'), never user input.
	guard := "seen_at"
	if col == "read_at" {
		guard = "read_at"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// read implies seen, so MarkReadAll also stamps seen_at where missing.
	set := col + " = now()"
	if col == "read_at" {
		set = "read_at = now(), seen_at = COALESCE(seen_at, now())"
	}
	tag, err := tx.Exec(ctx, `
UPDATE notification_feed SET `+set+`
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND `+guard+` IS NULL`,
		tenantID, userID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), tx.Commit(ctx)
}

// MarkRead stamps one row read (and seen). Reports whether a row was updated
// (false = not found / not this user's).
func (r *Repo) MarkRead(ctx context.Context, tenantID, userID, id string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE notification_feed
   SET read_at = COALESCE(read_at, now()), seen_at = COALESCE(seen_at, now())
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid`,
		tenantID, userID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}

func nonNil(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// ---------------------------------------------------------------------
// Handlers (session-required; every handler pins user_id to the session user)
// ---------------------------------------------------------------------

// Deps wires the handlers.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the per-user feed endpoints. Mount inside the
// session-required group (the handlers 401 without a session user).
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/notifications", d.List)
	r.Post("/api/v1/notifications/seen", d.MarkSeen)
	r.Post("/api/v1/notifications/read-all", d.MarkReadAll)
	r.Post("/api/v1/notifications/{id}/read", d.MarkRead)
	// ECO-05: the delivery ledgers' read path (deliveries.go). Mounted here, in
	// the same function as the feed itself, because the two answer halves of one
	// question — the feed says what arrived, these say what happened to
	// everything else — and a separate mount is a mount a later edit can forget.
	r.Get("/api/v1/notifications/deliveries", d.ListDeliveries)
	r.Get("/api/v1/notifications/{id}/deliveries", d.NotificationDeliveries)
}

// actor returns the tenant + acting user, or writes 401 and returns ok=false.
func (d *Deps) actor(w http.ResponseWriter, r *http.Request) (tenantID, userID string, ok bool) {
	t, tok := middleware.TenantFromContext(r.Context())
	u, uok := middleware.UserFromContext(r.Context())
	if !tok || !uok || u.ID == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_session", "sign in to view notifications")
		return "", "", false
	}
	return t.ID, u.ID, true
}

// List serves GET /api/v1/notifications.
//
//	?unread=true   only rows the user has not read
//	?limit=N       page size, 1..200 (default 50; larger values clamp to 200)
//	?cursor=TOKEN  next_cursor from a previous page (keyset, not offset)
//
// The response carries next_cursor + has_more so a client can page the whole
// feed. Both are omitted-as-false/empty on the last page.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	page, err := d.Repo.List(r.Context(), tenantID, userID, ListOptions{
		UnreadOnly: query.Get("unread") == "true",
		Limit:      limit,
		Cursor:     query.Get("cursor"),
	})
	if errors.Is(err, ErrInvalidCursor) {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_cursor",
			"cursor must be a next_cursor value returned by this endpoint")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	body := map[string]any{
		"items":        page.Items,
		"unread_count": page.UnreadCount,
		"has_more":     page.NextCursor != "",
	}
	if page.NextCursor != "" {
		body["next_cursor"] = page.NextCursor
	}
	writeJSON(w, http.StatusOK, body)
}

func (d *Deps) MarkSeen(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	n, err := d.Repo.MarkSeenAll(r.Context(), tenantID, userID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "seen": n})
}

func (d *Deps) MarkReadAll(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	n, err := d.Repo.MarkReadAll(r.Context(), tenantID, userID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "read": n})
}

func (d *Deps) MarkRead(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	updated, err := d.Repo.MarkRead(r.Context(), tenantID, userID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	if !updated {
		httperror.Write(w, http.StatusNotFound, "not_found", "notification not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
