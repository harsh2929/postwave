// SPDX-License-Identifier: AGPL-3.0-only
package archive

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// FeedIssue is a published archive issue projected for the public RSS / JSON
// feeds, including the author + tags that drive the per-author and per-tag
// feed slices. Distinct from IssueSummary (the paginated HTML index): feeds
// need author/tags but not the view-count analytics.
type FeedIssue struct {
	Slug        string
	Subject     string
	Excerpt     string
	HTMLBody    string
	HeroImage   string
	PublishedAt time.Time
	AuthorName  string
	Tags        []string
}

// feedIssuesQuery deliberately keeps the candidate scan lightweight. Filtered
// tag/author feeds inspect up to 200 rows before retaining 50; selecting each
// multi-megabyte body during that scan creates avoidable database and memory
// pressure. HydrateFeedIssues fetches rich content for only the retained rows.
const feedIssuesQuery = `
SELECT COALESCE(archive_slug, ''),
       COALESCE(subject, ''),
       COALESCE(archive_excerpt, ''),
       COALESCE(finished_at, created_at),
       COALESCE(archive_author_name, ''),
       COALESCE(archive_tags, '{}')
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND archive_public = true
   AND archive_slug IS NOT NULL
 ORDER BY archive_pinned DESC, COALESCE(finished_at, created_at) DESC
 LIMIT $2`

// FeedIssues returns up to limit published archive issues (pinned first, then
// newest) with their author + tags, for the public feeds. Same "published"
// gate as the HTML index (archive_public AND archive_slug set). Callers that
// build a filtered slice (per-tag / per-author) pass a larger limit and trim
// after matching, since the tag/author match is computed app-side.
func (r *Repo) FeedIssues(ctx context.Context, tenantID string, limit int) ([]FeedIssue, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, feedIssuesQuery, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FeedIssue{}
	for rows.Next() {
		var fi FeedIssue
		if err := rows.Scan(
			&fi.Slug,
			&fi.Subject,
			&fi.Excerpt,
			&fi.PublishedAt,
			&fi.AuthorName,
			&fi.Tags,
		); err != nil {
			return nil, err
		}
		out = append(out, fi)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

const hydrateFeedIssuesQuery = `
SELECT COALESCE(archive_slug, ''),
       COALESCE(body, body_html, '')::text,
       COALESCE(archive_hero_image, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND archive_public = true
   AND archive_slug = ANY($2::text[])`

// HydrateFeedIssues loads full HTML and hero-image data for a bounded set of
// already-selected feed candidates. A row concurrently unpublished between
// the candidate and hydration reads is omitted rather than exposing stale
// public metadata. Output order remains identical to the candidate order.
func (r *Repo) HydrateFeedIssues(ctx context.Context, tenantID string, items []FeedIssue) ([]FeedIssue, error) {
	if len(items) == 0 {
		return items, nil
	}
	slugs := make([]string, 0, len(items))
	indexes := make(map[string]int, len(items))
	for i := range items {
		slugs = append(slugs, items[i].Slug)
		indexes[items[i].Slug] = i
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, hydrateFeedIssuesQuery, tenantID, slugs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := make(map[string]bool, len(items))
	for rows.Next() {
		var slug, body, hero string
		if err := rows.Scan(&slug, &body, &hero); err != nil {
			return nil, err
		}
		if i, ok := indexes[slug]; ok {
			items[i].HTMLBody = body
			items[i].HeroImage = hero
			found[slug] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	out := make([]FeedIssue, 0, len(items))
	for _, item := range items {
		if found[item.Slug] {
			out = append(out, item)
		}
	}
	return out, nil
}
