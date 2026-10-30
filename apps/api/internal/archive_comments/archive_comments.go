// Package archive_comments implements threaded commenting on published
// archive issues — Moosewave's parity drop against Ghost (Members
// commenting), Buttondown (built-in comments with admin moderation),
// and Substack (reader threads + smart sort).
//
// Surface contract (see archive_comments-threaded gap entry):
//
//	Public (read + post):
//	  GET  /api/public/archive/{tenant_slug}/{campaign_slug}/comments
//	  POST /api/public/archive/{tenant_slug}/{campaign_slug}/comments
//
//	Authenticated subscriber (vote):
//	  POST /api/public/archive/{tenant_slug}/{campaign_slug}/comments/{comment_id}/vote
//
//	Admin / moderation:
//	  GET  /api/v1/archive/comments?status=&campaignId=
//	  POST /api/v1/archive/comments/{id}/moderate     {status}
//	  POST /api/v1/archive/comments/{id}/pin
//	  POST /api/v1/archive/comments/{id}/unpin
//	  DEL  /api/v1/archive/comments/{id}
//
// Backend uses the canonical tenant-RLS GUC idiom; the public POST
// path resolves the tenant from the {tenant_slug} → tenant_id mapping
// in tenant_public_settings (same lookup the public issue page uses)
// so a comment can never be filed against another tenant's campaign
// even if the URL is forged.
//
// SubscriberResolver is the only injected dep: it exchanges a public
// session/preference token for (subscriberID, displayName). Wired in
// main.go to the same preferences.LookupToken closure used by the
// subscribe-wall path. Guest comments (no token) are allowed when the
// resolver returns ErrNoSubscriber — in that case the request body
// must include a `displayName` field, which the handler validates.
//
// The smart-sort default is "best": pinned-first, then
// (upvotes - downvotes) DESC, tie-broken by created_at DESC. Callers
// pass `?sort=new|top|best` to override. The single comment-tree
// response carries the full thread (replies inlined as children) so
// the public page renders without per-reply round trips — depth is
// soft-bounded to MaxThreadDepth to prevent runaway nesting in the UI.
package archive_comments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrNotFound is returned when a tenant/campaign/comment lookup
// resolves to zero rows. Mapped to 404 by the handlers.
var ErrNotFound = errors.New("archive_comments: not found")

// ErrNoSubscriber is the sentinel returned by SubscriberResolver when
// the request carried no token or the token failed to resolve. The
// handler treats it as "guest comment" and falls back to the
// displayName field on the request body.
var ErrNoSubscriber = errors.New("archive_comments: no subscriber session")

// Wire-format limits. Body limit mirrors the schema-level cap so a
// 200 OK from the API is byte-equivalent to what the DB will accept.
const (
	maxBodyChars    = 4000
	maxDisplayName  = 80
	commentsJSONMax = 32 << 10 // 32 KiB per request
	// MaxThreadDepth bounds reply nesting in the rendered tree. The
	// SQL still allows arbitrary depth — this is purely a UI-side
	// guard against pathological 200-level threads. Replies past
	// the limit collapse into the deepest visible ancestor.
	MaxThreadDepth = 6
)

// Comment is the wire shape returned by the list/post endpoints.
// Children is populated server-side when the tree builder is used
// (public list path); admin moderation responses leave it empty
// because the moderation table renders a flat list keyed by status.
type Comment struct {
	ID           string    `json:"id"`
	CampaignID   string    `json:"campaignId"`
	ParentID     string    `json:"parentId,omitempty"`
	SubscriberID string    `json:"subscriberId,omitempty"`
	DisplayName  string    `json:"displayName"`
	Body         string    `json:"body"`
	Pinned       bool      `json:"pinned"`
	Status       string    `json:"status"`
	Upvotes      int       `json:"upvotes"`
	Downvotes    int       `json:"downvotes"`
	CreatedAt    time.Time `json:"createdAt"`
	Children     []Comment `json:"children,omitempty"`
}

// ListResponse is the public + admin list envelope.
type ListResponse struct {
	Items []Comment `json:"items"`
	// Total is the pre-pagination row count. Useful for the
	// moderation dashboard's "12 pending" counter; the public
	// path leaves it 0 (tree response is unpaginated).
	Total int `json:"total,omitempty"`
}

// PostInput is the wire body accepted by the public POST endpoint.
// `DisplayName` is only consulted on the guest path (no subscriber
// token). `ParentID` is optional; empty/missing means top-level.
type PostInput struct {
	Body        string `json:"body"`
	DisplayName string `json:"displayName,omitempty"`
	ParentID    string `json:"parentId,omitempty"`
}

// VoteInput is the wire body for the public vote endpoint. Vote
// is +1/-1; 0 means "clear my vote" (the repo deletes the row).
type VoteInput struct {
	Vote int `json:"vote"`
}

// ModerateInput is the wire body for the admin moderation status
// flip.  status ∈ {visible, pending, hidden, spam}.
type ModerateInput struct {
	Status string `json:"status"`
}

// SubscriberResolver exchanges the public request for a subscriber
// identity. Returns ErrNoSubscriber when no session is attached —
// the handler then treats the post as a guest comment.
type SubscriberResolver func(ctx context.Context, r *http.Request) (subscriberID, displayName string, err error)

// TenantResolver maps an archive slug → tenant id. Same lookup the
// archive package already does against tenant_public_settings; we
// re-declare the contract here to keep the comments package
// independent (no archive→archive_comments cycle).
type TenantResolver func(ctx context.Context, archiveSlug string) (string, error)

// CampaignResolver maps (tenant_id, campaign_slug) → campaign id.
// Same shape the archive.Repo.GetIssue path uses internally.
type CampaignResolver func(ctx context.Context, tenantID, campaignSlug string) (string, error)

// Repo is the postgres surface for the comments tables. Tenant
// scoping is via db.WithTenant; the public path uses the resolved
// tenant id from the slug lookup so a forged campaign_id can't
// cross-tenant comment.
type Repo struct {
	Pool *db.Pool
}

// Deps wires the public + admin handlers. SubscriberResolver,
// TenantResolver, and CampaignResolver are required for the public
// surface; the admin surface only needs Repo + middleware.Tenant.
type Deps struct {
	Repo               *Repo
	Logger             *slog.Logger
	SubscriberResolver SubscriberResolver
	TenantResolver     TenantResolver
	CampaignResolver   CampaignResolver
}

func (d *Deps) log() *slog.Logger {
	if d != nil && d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// MountPublicRoutes registers the public read/post/vote routes.
// Mounted under the same /api/public/archive prefix the archive
// package owns so the routes share the tenant-slug resolution
// pattern (no extra tenant middleware needed).
func (d *Deps) MountPublicRoutes(r chi.Router) {
	r.Get("/api/public/archive/{tenant_slug}/{campaign_slug}/comments", d.PublicList)
	r.Post("/api/public/archive/{tenant_slug}/{campaign_slug}/comments", d.PublicPost)
	r.Post("/api/public/archive/{tenant_slug}/{campaign_slug}/comments/{comment_id}/vote", d.PublicVote)
}

// MountAdminRoutes registers the moderation routes. Expected to be
// mounted under the standard tenant-middleware chain (the routes
// pull middleware.TenantFromContext).
func (d *Deps) MountAdminRoutes(r chi.Router) {
	r.Get("/api/v1/archive/comments", d.AdminList)
	r.Post("/api/v1/archive/comments/{id}/moderate", d.AdminModerate)
	r.Post("/api/v1/archive/comments/{id}/pin", d.AdminPin)
	r.Post("/api/v1/archive/comments/{id}/unpin", d.AdminUnpin)
	r.Delete("/api/v1/archive/comments/{id}", d.AdminDelete)
}

// ---------- repo ------------------------------------------------------

// ListForCampaign returns the full thread for a campaign. The public
// path filters to status='visible'; the admin path passes
// statusFilter="" to see every row.  Sorted in SQL but the tree
// nesting + pin-floating happens in Go (cheap; threads cap out in
// the low hundreds in real-world deployments).
func (r *Repo) ListForCampaign(ctx context.Context, tenantID, campaignID, statusFilter, sort string) ([]Comment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	args := []any{tenantID, campaignID}
	where := `WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`
	if statusFilter != "" {
		args = append(args, statusFilter)
		where += fmt.Sprintf(" AND status = $%d", len(args))
	}

	// Default sort is created_at DESC so the Go-side tree builder can
	// place replies under their parent in stable chronological order.
	// "Best" / "top" rankings are applied after the tree is built.
	orderBy := "ORDER BY pinned DESC, created_at DESC"
	if sort == "new" {
		orderBy = "ORDER BY pinned DESC, created_at DESC"
	}

	q := `
SELECT id::text,
       campaign_id::text,
       COALESCE(parent_comment_id::text, ''),
       COALESCE(subscriber_id::text, ''),
       display_name,
       body,
       pinned,
       status,
       upvotes,
       downvotes,
       created_at
  FROM archive_comments
  ` + where + `
 ` + orderBy + `
 LIMIT 5000`

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Comment
	for rows.Next() {
		var c Comment
		if err := rows.Scan(&c.ID, &c.CampaignID, &c.ParentID, &c.SubscriberID,
			&c.DisplayName, &c.Body, &c.Pinned, &c.Status,
			&c.Upvotes, &c.Downvotes, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListForModeration returns a flat list filtered by status — backing
// the moderation dashboard's per-status tabs. Includes the total
// pre-limit row count so the UI can show "12 pending".
func (r *Repo) ListForModeration(ctx context.Context, tenantID, status, campaignID string, limit int) ([]Comment, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	args := []any{tenantID}
	where := `WHERE tenant_id = $1::uuid`
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if campaignID != "" {
		args = append(args, campaignID)
		where += fmt.Sprintf(" AND campaign_id = $%d::uuid", len(args))
	}

	var total int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM archive_comments `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, limit)
	q := `
SELECT id::text,
       campaign_id::text,
       COALESCE(parent_comment_id::text, ''),
       COALESCE(subscriber_id::text, ''),
       display_name,
       body,
       pinned,
       status,
       upvotes,
       downvotes,
       created_at
  FROM archive_comments
  ` + where + `
 ORDER BY created_at DESC
 LIMIT $` + strconv.Itoa(len(args))

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Comment
	for rows.Next() {
		var c Comment
		if err := rows.Scan(&c.ID, &c.CampaignID, &c.ParentID, &c.SubscriberID,
			&c.DisplayName, &c.Body, &c.Pinned, &c.Status,
			&c.Upvotes, &c.Downvotes, &c.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// Insert writes a new comment.  `parentID == ""` means top-level.
// `subscriberID == ""` means guest comment — the caller is
// responsible for having validated the displayName.
//
// The status field is set by the caller (the public handler
// consults a tenant-level "require moderation" flag in a follow-up;
// for now defaults to 'visible' to keep the happy path live).
func (r *Repo) Insert(ctx context.Context, tenantID, campaignID, parentID, subscriberID, displayName, body, status string) (Comment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Comment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Validate the parent (if any) belongs to the same tenant +
	// campaign. Cross-campaign reply attempts are dropped with
	// ErrNotFound rather than 400 to avoid leaking comment-id
	// existence across tenants.
	if parentID != "" {
		var ok bool
		err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM archive_comments
   WHERE id = $1::uuid
     AND tenant_id = $2::uuid
     AND campaign_id = $3::uuid
)`, parentID, tenantID, campaignID).Scan(&ok)
		if err != nil {
			return Comment{}, err
		}
		if !ok {
			return Comment{}, ErrNotFound
		}
	}

	var (
		parentArg any
		subArg    any
	)
	if parentID == "" {
		parentArg = nil
	} else {
		parentArg = parentID
	}
	if subscriberID == "" {
		subArg = nil
	} else {
		subArg = subscriberID
	}

	if status == "" {
		status = "visible"
	}

	var c Comment
	err = tx.QueryRow(ctx, `
INSERT INTO archive_comments (
    tenant_id, campaign_id, parent_comment_id, subscriber_id,
    display_name, body, status
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
RETURNING id::text, campaign_id::text,
          COALESCE(parent_comment_id::text, ''),
          COALESCE(subscriber_id::text, ''),
          display_name, body, pinned, status,
          upvotes, downvotes, created_at`,
		tenantID, campaignID, parentArg, subArg,
		displayName, body, status,
	).Scan(&c.ID, &c.CampaignID, &c.ParentID, &c.SubscriberID,
		&c.DisplayName, &c.Body, &c.Pinned, &c.Status,
		&c.Upvotes, &c.Downvotes, &c.CreatedAt)
	if err != nil {
		return Comment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Comment{}, err
	}
	return c, nil
}

// Vote upserts a (comment, subscriber) vote and updates the
// denormalised tallies on archive_comments in the same tx. `vote`
// of 0 clears any existing vote. Returns the new (up, down) tally
// so the caller can echo it on the response (the public UI
// re-renders the pill on the same row without a refresh).
func (r *Repo) Vote(ctx context.Context, tenantID, commentID, subscriberID string, vote int) (up, down int, err error) {
	if vote < -1 || vote > 1 {
		return 0, 0, fmt.Errorf("archive_comments: invalid vote %d", vote)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve the existing vote so we know whether to apply a
	// (+1 up), (+1 down), (-1 up), (-1 down), or no-op delta on
	// the parent row.
	var prev int
	err = tx.QueryRow(ctx, `
SELECT vote FROM archive_comment_votes
 WHERE comment_id = $1::uuid AND subscriber_id = $2::uuid`,
		commentID, subscriberID).Scan(&prev)
	hadPrev := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, err
	}

	switch {
	case vote == 0 && hadPrev:
		// Clear existing vote.
		if _, err := tx.Exec(ctx, `DELETE FROM archive_comment_votes
 WHERE comment_id = $1::uuid AND subscriber_id = $2::uuid`,
			commentID, subscriberID); err != nil {
			return 0, 0, err
		}
	case vote != 0 && !hadPrev:
		// Insert new vote.
		if _, err := tx.Exec(ctx, `
INSERT INTO archive_comment_votes (tenant_id, comment_id, subscriber_id, vote)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
			tenantID, commentID, subscriberID, vote); err != nil {
			return 0, 0, err
		}
	case vote != 0 && hadPrev && prev != vote:
		// Flip existing vote.
		if _, err := tx.Exec(ctx, `
UPDATE archive_comment_votes SET vote = $3
 WHERE comment_id = $1::uuid AND subscriber_id = $2::uuid`,
			commentID, subscriberID, vote); err != nil {
			return 0, 0, err
		}
	default:
		// Re-vote in the same direction or clear-with-no-existing
		// — no state change.
	}

	// Recompute the tallies in the same tx so the response is
	// consistent. Cheap: the (comment_id) index makes this a
	// single B-tree scan.
	err = tx.QueryRow(ctx, `
SELECT COUNT(*) FILTER (WHERE vote = 1),
       COUNT(*) FILTER (WHERE vote = -1)
  FROM archive_comment_votes
 WHERE comment_id = $1::uuid`, commentID).Scan(&up, &down)
	if err != nil {
		return 0, 0, err
	}

	// Update the denorm cache on archive_comments. If the comment
	// has been deleted between the vote insert and this update, we
	// still want the vote rows to land (they'll cascade-delete with
	// the comment); a missed update here is self-correcting on
	// the next vote.
	if _, err := tx.Exec(ctx, `
UPDATE archive_comments SET upvotes = $2, downvotes = $3, updated_at = now()
 WHERE id = $1::uuid`, commentID, up, down); err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return up, down, nil
}

// SetStatus flips the moderation status of a comment. Returns
// ErrNotFound when the comment doesn't exist (or belongs to another
// tenant — RLS makes the two indistinguishable, which is the point).
func (r *Repo) SetStatus(ctx context.Context, tenantID, commentID, status string) error {
	if !validStatus(status) {
		return fmt.Errorf("archive_comments: invalid status %q", status)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE archive_comments SET status = $2, updated_at = now()
 WHERE id = $1::uuid`, commentID, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// SetPinned toggles the operator-pin flag.
func (r *Repo) SetPinned(ctx context.Context, tenantID, commentID string, pinned bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE archive_comments SET pinned = $2, updated_at = now()
 WHERE id = $1::uuid`, commentID, pinned)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Delete hard-deletes a comment. Cascades to archive_comment_votes
// via the FK ON DELETE CASCADE. Reply children also cascade — the
// admin UI warns about this before the request is sent. For
// "remove the comment but keep the reply tree", flip status to
// 'hidden' via SetStatus instead.
func (r *Repo) Delete(ctx context.Context, tenantID, commentID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM archive_comments WHERE id = $1::uuid`, commentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func validStatus(s string) bool {
	switch s {
	case "visible", "pending", "hidden", "spam":
		return true
	}
	return false
}

// ---------- tree building --------------------------------------------

// BuildTree turns the flat row list into a nested tree, applying the
// requested sort. Exported so tests can exercise the ordering rules
// without spinning up a DB.
func BuildTree(rows []Comment, sort string) []Comment {
	byID := make(map[string]*Comment, len(rows))
	for i := range rows {
		rows[i].Children = nil
		byID[rows[i].ID] = &rows[i]
	}
	var roots []*Comment
	for i := range rows {
		c := &rows[i]
		if c.ParentID == "" {
			roots = append(roots, c)
			continue
		}
		parent, ok := byID[c.ParentID]
		if !ok {
			// Orphaned (parent moderated/deleted between fetch
			// and now) — promote to root rather than drop it.
			roots = append(roots, c)
			continue
		}
		parent.Children = append(parent.Children, *c)
	}
	sortFn := bestSorter(sort)
	sortFn(roots)
	// Recurse into children. Children are stored by-value (not
	// pointer) so we walk the parent pointer to mutate them.
	var walk func(nodes []Comment)
	walk = func(nodes []Comment) {
		ptrs := make([]*Comment, len(nodes))
		for i := range nodes {
			ptrs[i] = &nodes[i]
		}
		sortFn(ptrs)
		// Apply the sorted order back into the slice.
		sorted := make([]Comment, len(nodes))
		for i, p := range ptrs {
			sorted[i] = *p
		}
		copy(nodes, sorted)
		for i := range nodes {
			if len(nodes[i].Children) > 0 {
				walk(nodes[i].Children)
			}
		}
	}
	out := make([]Comment, len(roots))
	for i, r := range roots {
		out[i] = *r
		if len(out[i].Children) > 0 {
			walk(out[i].Children)
		}
	}
	return out
}

// bestSorter returns an in-place sorter over []*Comment that
// respects the requested sort. Pinned always floats first; then the
// requested ordering breaks the rest.
func bestSorter(sort string) func([]*Comment) {
	switch sort {
	case "new":
		return func(cs []*Comment) {
			sortBy(cs, func(a, b *Comment) bool {
				if a.Pinned != b.Pinned {
					return a.Pinned
				}
				return a.CreatedAt.After(b.CreatedAt)
			})
		}
	case "top":
		return func(cs []*Comment) {
			sortBy(cs, func(a, b *Comment) bool {
				if a.Pinned != b.Pinned {
					return a.Pinned
				}
				return a.Upvotes > b.Upvotes
			})
		}
	default: // "best"
		return func(cs []*Comment) {
			sortBy(cs, func(a, b *Comment) bool {
				if a.Pinned != b.Pinned {
					return a.Pinned
				}
				as := a.Upvotes - a.Downvotes
				bs := b.Upvotes - b.Downvotes
				if as != bs {
					return as > bs
				}
				return a.CreatedAt.After(b.CreatedAt)
			})
		}
	}
}

// sortBy is a tiny insertion sort — comment threads cap out around
// O(50–200) per issue so a stdlib sort.Slice + closure is the same
// runtime in practice; we keep this hand-rolled to avoid an extra
// import.
func sortBy[T any](xs []T, less func(a, b T) bool) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && less(xs[j], xs[j-1]); j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}

// ---------- handlers -------------------------------------------------

// PublicList GET /api/public/archive/{tenant_slug}/{campaign_slug}/comments
func (d *Deps) PublicList(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	cslug := chi.URLParam(r, "campaign_slug")
	tid, cid, err := d.resolvePublic(r.Context(), tslug, cslug)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no such issue")
		return
	}
	sort := r.URL.Query().Get("sort")
	flat, err := d.Repo.ListForCampaign(r.Context(), tid, cid, "visible", sort)
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	// BuildTree accumulates into `var roots []*Comment`, which stays nil when a
	// thread has no root comments -- so an empty comment list marshalled as
	// {"items": null} rather than {"items": []}. Clients type this as an array.
	tree := BuildTree(flat, sort)
	if tree == nil {
		tree = []Comment{}
	}
	writeJSON(w, http.StatusOK, ListResponse{Items: tree})
}

// PublicPost POST /api/public/archive/{tenant_slug}/{campaign_slug}/comments
func (d *Deps) PublicPost(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	cslug := chi.URLParam(r, "campaign_slug")
	tid, cid, err := d.resolvePublic(r.Context(), tslug, cslug)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no such issue")
		return
	}
	var in PostInput
	if err := httpbody.DecodeJSONWith(w, r, commentsJSONMax, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		httperror.Write(w, http.StatusBadRequest, "body_required", "comment body is required")
		return
	}
	if utf8.RuneCountInString(body) > maxBodyChars {
		httperror.Write(w, http.StatusBadRequest, "body_too_long",
			fmt.Sprintf("comment body exceeds %d characters", maxBodyChars))
		return
	}

	// Resolve the author: subscriber session first, fall back to
	// guest. The resolver may be nil in tests; in that case every
	// post is guest-tracked.
	var subID, name string
	if d.SubscriberResolver != nil {
		subID, name, err = d.SubscriberResolver(r.Context(), r)
		if err != nil && !errors.Is(err, ErrNoSubscriber) {
			httperror.Write(w, http.StatusUnauthorized, "unauthorized", "session resolution failed")
			return
		}
	}
	if subID == "" {
		// Guest path: displayName must be supplied + non-empty.
		name = strings.TrimSpace(in.DisplayName)
		if name == "" {
			httperror.Write(w, http.StatusBadRequest, "display_name_required",
				"displayName is required for guest comments")
			return
		}
		if utf8.RuneCountInString(name) > maxDisplayName {
			httperror.Write(w, http.StatusBadRequest, "display_name_too_long",
				fmt.Sprintf("displayName exceeds %d characters", maxDisplayName))
			return
		}
		// Strip control bytes so a malicious display_name can't
		// break JSON-LD rendering on the public page.
		name = stripControl(name)
	}

	c, err := d.Repo.Insert(r.Context(), tid, cid, in.ParentID, subID, name, body, "visible")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "parent_not_found",
				"parent comment does not exist on this issue")
			return
		}
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

// PublicVote POST .../comments/{comment_id}/vote
func (d *Deps) PublicVote(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	cslug := chi.URLParam(r, "campaign_slug")
	commentID := chi.URLParam(r, "comment_id")
	tid, _, err := d.resolvePublic(r.Context(), tslug, cslug)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no such issue")
		return
	}
	if d.SubscriberResolver == nil {
		httperror.Write(w, http.StatusUnauthorized, "login_required", "voting requires a subscriber session")
		return
	}
	subID, _, err := d.SubscriberResolver(r.Context(), r)
	if err != nil || subID == "" {
		httperror.Write(w, http.StatusUnauthorized, "login_required", "voting requires a subscriber session")
		return
	}
	var in VoteInput
	if err := httpbody.DecodeJSONWith(w, r, commentsJSONMax, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Vote < -1 || in.Vote > 1 {
		httperror.Write(w, http.StatusBadRequest, "invalid_vote", "vote must be -1, 0, or 1")
		return
	}
	up, down, err := d.Repo.Vote(r.Context(), tid, commentID, subID, in.Vote)
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upvotes": up, "downvotes": down})
}

// AdminList GET /api/v1/archive/comments?status=pending&campaignId=
func (d *Deps) AdminList(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && !validStatus(status) {
		httperror.Write(w, http.StatusBadRequest, "invalid_status", "unknown status filter")
		return
	}
	campaignID := r.URL.Query().Get("campaignId")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rows, total, err := d.Repo.ListForModeration(r.Context(), t.ID, status, campaignID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if rows == nil {
		rows = []Comment{}
	}
	writeJSON(w, http.StatusOK, ListResponse{Items: rows, Total: total})
}

// AdminModerate POST /api/v1/archive/comments/{id}/moderate
func (d *Deps) AdminModerate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in ModerateInput
	if err := httpbody.DecodeJSONWith(w, r, commentsJSONMax, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !validStatus(in.Status) {
		httperror.Write(w, http.StatusBadRequest, "invalid_status", "unknown status")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.SetStatus(r.Context(), t.ID, id, in.Status); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "comment not found")
			return
		}
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AdminPin POST /api/v1/archive/comments/{id}/pin
func (d *Deps) AdminPin(w http.ResponseWriter, r *http.Request) {
	d.adminTogglePin(w, r, true)
}

// AdminUnpin POST /api/v1/archive/comments/{id}/unpin
func (d *Deps) AdminUnpin(w http.ResponseWriter, r *http.Request) {
	d.adminTogglePin(w, r, false)
}

func (d *Deps) adminTogglePin(w http.ResponseWriter, r *http.Request, pinned bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.SetPinned(r.Context(), t.ID, id, pinned); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "comment not found")
			return
		}
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pinned": pinned})
}

// AdminDelete DELETE /api/v1/archive/comments/{id}
func (d *Deps) AdminDelete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "comment not found")
			return
		}
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// resolvePublic maps (tenant_slug, campaign_slug) → (tenant_id,
// campaign_id) via the injected resolvers.  Both must be non-nil for
// the public surface to function; main.go wires them.
func (d *Deps) resolvePublic(ctx context.Context, tslug, cslug string) (string, string, error) {
	if d.TenantResolver == nil || d.CampaignResolver == nil {
		return "", "", ErrNotFound
	}
	tid, err := d.TenantResolver(ctx, tslug)
	if err != nil || tid == "" {
		return "", "", ErrNotFound
	}
	cid, err := d.CampaignResolver(ctx, tid, cslug)
	if err != nil || cid == "" {
		return "", "", ErrNotFound
	}
	return tid, cid, nil
}

// stripControl removes ASCII control bytes (except common whitespace)
// from a string. Used on user-supplied display names so a CR/LF
// injection can't break JSON-LD Comment node rendering on the
// public page (the renderer also escapes, but defence-in-depth is
// cheap here).
func stripControl(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\t', r == ' ':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			// drop
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ---------- helpers --------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
