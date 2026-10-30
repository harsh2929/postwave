// SPDX-License-Identifier: AGPL-3.0-only
//
// members.go — who is in a segment right now.
//
//	GET /api/v1/segments/{id}/members?page=1&per_page=50
//
// The overview's Members card could only list a snapshot's frozen sample, so a
// freshly created segment read "No snapshots yet" until someone pressed
// "Capture snapshot" — the one question an operator opens a segment to answer
// needed a write first. This endpoint answers it live: it evaluates the
// segment's definition under the segment's own archive scope and pages through
// the matching subscribers, newest first. Snapshots stay what they are for:
// freezing an audience at a moment.
//
// The page and the total are read from one repeatable-read snapshot, so the
// "N of M" a client renders is internally consistent.

package segments

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	liveMembersDefaultPerPage = 50
	liveMembersMaxPerPage     = 200
	// liveMembersMaxPage keeps OFFSET far from integer overflow; a million
	// pages of 200 is past any segment this surface is meant to browse.
	liveMembersMaxPage = 1_000_000
)

// LiveMember is one subscriber currently in a segment.
type LiveMember struct {
	SubscriberID string `json:"subscriber_id"`
	Email        string `json:"email"`
	// Archived is true only for segments that include archived subscribers.
	Archived bool `json:"archived"`
}

// LiveMembersResponse is one page of a segment's current members.
type LiveMembersResponse struct {
	Items   []LiveMember `json:"items"`
	Page    int          `json:"page"`
	PerPage int          `json:"per_page"`
	// Total is every subscriber the segment matches, not just this page.
	Total int `json:"total"`
	// ArchiveScope is "active_only" or "including_archived", the segment's own
	// setting, so a client can say which population it is showing.
	ArchiveScope string    `json:"archive_scope"`
	GeneratedAt  time.Time `json:"generated_at"`
}

// SegmentMembers GET /api/v1/segments/{id}/members.
func (d *Deps) SegmentMembers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	page, perPage, err := parseMembersPage(r)
	if err != nil {
		httperror.WriteValidation(w, "bad_pagination", err.Error())
		return
	}
	seg, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), previewCountTimeout)
	defer cancel()
	predicate, err := CompilePopulation(ctx, seg.QueryAST, t.ID, d.Repo, DefinitionPopulation(seg.IncludeArchived))
	if err != nil {
		if !isDefinitionError(err) {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		// The stored definition no longer compiles (for example it refers to a
		// segment that was deleted). The request is fine; the segment is not.
		httperror.Write(w, http.StatusUnprocessableEntity, "segment_rules_invalid",
			"This segment's rules can't be evaluated. Edit the segment to fix them.")
		return
	}
	resp, err := d.Repo.LiveMembers(ctx, t.ID, predicate, page, perPage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	resp.ArchiveScope = previewArchiveScope(seg.IncludeArchived)
	writeJSON(w, http.StatusOK, resp)
}

// isDefinitionError reports whether a CompilePopulation error is the stored
// definition's fault (a rule the compiler rejects, a referenced segment that no
// longer exists) rather than a database or deadline failure on the way, which
// is ours and must not be blamed on the segment.
func isDefinitionError(err error) bool {
	return !errors.Is(err, ErrReferencedSegmentUnavailable) &&
		!errors.Is(err, context.Canceled) &&
		!errors.Is(err, context.DeadlineExceeded)
}

// parseMembersPage reads page (from 1) and per_page (1..200, default 50).
// Unlike the snapshot reader it refuses malformed values instead of silently
// substituting defaults, so a client bug shows up as a 400, not as page one.
func parseMembersPage(r *http.Request) (page, perPage int, err error) {
	page, perPage = 1, liveMembersDefaultPerPage
	q := r.URL.Query()
	if raw := q.Get("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil || page < 1 || page > liveMembersMaxPage {
			return 0, 0, errors.New("page must be a whole number from 1 to " + strconv.Itoa(liveMembersMaxPage))
		}
	}
	if raw := q.Get("per_page"); raw != "" {
		perPage, err = strconv.Atoi(raw)
		if err != nil || perPage < 1 || perPage > liveMembersMaxPerPage {
			return 0, 0, errors.New("per_page must be a whole number from 1 to " + strconv.Itoa(liveMembersMaxPerPage))
		}
	}
	return page, perPage, nil
}

// LiveMembers pages through the subscribers a compiled segment predicate
// matches, newest first, with the total from the same snapshot.
func (r *Repo) LiveMembers(ctx context.Context, tenantID string, predicate PopulationPredicate, page, perPage int) (*LiveMembersResponse, error) {
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &LiveMembersResponse{Items: []LiveMember{}, Page: page, PerPage: perPage}
	if err = tx.QueryRow(ctx, "SELECT COUNT(*) FROM subscribers WHERE "+predicate.SQL, predicate.Args...).Scan(&out.Total); err != nil {
		return nil, err
	}
	next := len(predicate.Args)
	rows, err := tx.Query(ctx, `
SELECT subscribers.id::text, subscribers.email::text, subscribers.archived_at IS NOT NULL
  FROM subscribers
 WHERE `+predicate.SQL+`
 ORDER BY subscribers.created_at DESC, subscribers.id DESC
 LIMIT $`+strconv.Itoa(next+1)+` OFFSET $`+strconv.Itoa(next+2),
		append(append([]any{}, predicate.Args...), perPage, (page-1)*perPage)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m LiveMember
		if err := rows.Scan(&m.SubscriberID, &m.Email, &m.Archived); err != nil {
			return nil, err
		}
		out.Items = append(out.Items, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out.GeneratedAt = time.Now().UTC()
	return out, nil
}
