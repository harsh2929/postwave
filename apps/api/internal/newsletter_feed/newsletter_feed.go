// SPDX-License-Identifier: AGPL-3.0-only
//
// Package newsletter_feed serves RSS 2.0 and JSON Feed v1.1 atop the archive
// package, so readers can subscribe to published issues from feed readers
// (Inoreader, NetNewsWire, Feedly, Substack-style imports) instead of relying
// on email delivery alone.
//
// Public surfaces (unauthenticated; same tenant_slug resolution as archive):
//
//	GET /api/public/archive/{tenant_slug}/feed.xml                       whole archive (RSS)
//	GET /api/public/archive/{tenant_slug}/feed.json                      whole archive (JSON Feed)
//	GET /api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.xml        per-tag slice (RSS)
//	GET /api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.json       per-tag slice (JSON Feed)
//	GET /api/public/archive/{tenant_slug}/author/{author_slug}/feed.xml  per-author slice (RSS)
//	GET /api/public/archive/{tenant_slug}/author/{author_slug}/feed.json per-author slice (JSON Feed)
//
// The per-tag / per-author slices filter the same published set by a
// kebab-case slug match against the issue's archive_tags / archive_author_name
// (so /tag/release-notes matches the "Release Notes" tag, /author/jane-doe
// matches author "Jane Doe"). No schema of its own — a thin composition over
// archive.Repo. ETag is derived from the (filtered) item set for conditional
// GETs.
package newsletter_feed

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/archive"
)

// feedItemCap is how many items a feed returns. Feed readers don't need the
// full back-catalogue, and the HTML index already paginates.
const feedItemCap = 50

// filterScanDepth is how many recent published issues a per-tag/per-author
// slice scans before trimming to feedItemCap. The tag/author match is
// computed app-side (slug comparison), so we over-fetch to ensure a slice's
// recent issues are found even when interleaved with other content.
const filterScanDepth = 200

// Deps wires the feed package.
type Deps struct {
	ArchiveRepo *archive.Repo
	// PublicBaseURL is the canonical hosted-archive origin used in feed links.
	// A database-verified custom-domain request overrides it through the
	// archive middleware's private request context, never through Host or a
	// client-supplied forwarding header alone.
	PublicBaseURL string // e.g. https://archive.moosewave.com
}

// MountRoutes registers the whole-archive feeds plus the per-tag and
// per-author slices. The literal `feed.xml` / `tag` / `author` segments
// outrank the archive package's `{campaign_slug}` catch-all at the same
// depth (chi radix precedence), so these resolve correctly alongside it.
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.ArchiveRepo == nil {
		return
	}
	r.Get("/api/public/archive/{tenant_slug}/feed.xml", d.RSS)
	r.Get("/api/public/archive/{tenant_slug}/feed.json", d.JSONFeed)
	r.Get("/api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.xml", d.TagRSS)
	r.Get("/api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.json", d.TagJSON)
	r.Get("/api/public/archive/{tenant_slug}/author/{author_slug}/feed.xml", d.AuthorRSS)
	r.Get("/api/public/archive/{tenant_slug}/author/{author_slug}/feed.json", d.AuthorJSON)
}

// ---- handlers: whole archive ----

func (d *Deps) RSS(w http.ResponseWriter, r *http.Request)      { d.serveRSS(w, r, "", "", nil) }
func (d *Deps) JSONFeed(w http.ResponseWriter, r *http.Request) { d.serveJSON(w, r, "", "", nil) }

// ---- handlers: per-tag slice ----

func (d *Deps) TagRSS(w http.ResponseWriter, r *http.Request) {
	s := chi.URLParam(r, "tag_slug")
	d.serveRSS(w, r, "tag/"+s, "tag "+s, tagKeep(s))
}
func (d *Deps) TagJSON(w http.ResponseWriter, r *http.Request) {
	s := chi.URLParam(r, "tag_slug")
	d.serveJSON(w, r, "tag/"+s, "tag "+s, tagKeep(s))
}

// ---- handlers: per-author slice ----

func (d *Deps) AuthorRSS(w http.ResponseWriter, r *http.Request) {
	s := chi.URLParam(r, "author_slug")
	d.serveRSS(w, r, "author/"+s, "author "+s, authorKeep(s))
}
func (d *Deps) AuthorJSON(w http.ResponseWriter, r *http.Request) {
	s := chi.URLParam(r, "author_slug")
	d.serveJSON(w, r, "author/"+s, "author "+s, authorKeep(s))
}

// serveRSS renders an RSS 2.0 feed. subPath is the archive sub-path the feed
// points at ("" for whole archive, "tag/x", "author/y"); label suffixes the
// title; keep filters the item set (nil = all).
func (d *Deps) serveRSS(w http.ResponseWriter, r *http.Request, subPath, label string, keep func(archive.FeedIssue) bool) {
	tslug := chi.URLParam(r, "tenant_slug")
	items, etag, err := d.loadItems(r.Context(), tslug, keep)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if respondNotModified(w, r, etag) {
		return
	}
	customHost, _ := archive.VerifiedCustomDomainHost(r.Context())
	publicURLs := resolveFeedPublicURLs(
		d.PublicBaseURL, tslug, subPath, "feed.xml", r.URL.EscapedPath(), customHost,
	)
	title := tslug + " newsletter archive"
	desc := "Published issues from " + tslug + "."
	if label != "" {
		title += " — " + label
		desc = "Published " + label + " issues from " + tslug + "."
	}
	rss := buildRSS(rssRenderOptions{
		Title:       title,
		Description: desc,
		HomeURL:     publicURLs.HomeURL,
		FeedURL:     publicURLs.FeedURL,
		ItemBaseURL: publicURLs.ItemBaseURL,
	}, items)
	w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(xml.Header))
	_ = xml.NewEncoder(w).Encode(rss)
}

// serveJSON renders a JSON Feed v1.1 document. Parameters mirror serveRSS.
func (d *Deps) serveJSON(w http.ResponseWriter, r *http.Request, subPath, label string, keep func(archive.FeedIssue) bool) {
	tslug := chi.URLParam(r, "tenant_slug")
	items, etag, err := d.loadItems(r.Context(), tslug, keep)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if respondNotModified(w, r, etag) {
		return
	}
	customHost, _ := archive.VerifiedCustomDomainHost(r.Context())
	publicURLs := resolveFeedPublicURLs(
		d.PublicBaseURL, tslug, subPath, "feed.json", r.URL.EscapedPath(), customHost,
	)
	title := tslug + " newsletter archive"
	if label != "" {
		title += " — " + label
	}
	feed := map[string]any{
		"version":       "https://jsonfeed.org/version/1.1",
		"title":         title,
		"home_page_url": publicURLs.HomeURL,
		"feed_url":      publicURLs.FeedURL,
		"language":      "en",
	}
	jitems := make([]map[string]any, 0, len(items))
	for _, it := range items {
		jitems = append(jitems, buildJSONFeedItem(publicURLs.ItemBaseURL, it))
	}
	feed["items"] = jitems
	w.Header().Set("Content-Type", "application/feed+json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=300")
	_ = json.NewEncoder(w).Encode(feed)
}

// loadItems resolves the tenant slug + pulls recent published issues. When a
// keep filter is supplied (per-tag / per-author) it over-fetches up to
// filterScanDepth, applies the filter, then trims to feedItemCap.
func (d *Deps) loadItems(ctx context.Context, tslug string, keep func(archive.FeedIssue) bool) ([]archive.FeedIssue, string, error) {
	tid, err := d.ArchiveRepo.TenantBySlug(ctx, tslug)
	if err != nil {
		return nil, "", err
	}
	fetch := feedItemCap
	if keep != nil {
		fetch = filterScanDepth
	}
	all, err := d.ArchiveRepo.FeedIssues(ctx, tid, fetch)
	if err != nil {
		return nil, "", err
	}
	items := all
	if keep != nil {
		items = make([]archive.FeedIssue, 0, feedItemCap)
		for _, it := range all {
			if keep(it) {
				items = append(items, it)
				if len(items) == feedItemCap {
					break
				}
			}
		}
	}
	items, err = d.ArchiveRepo.HydrateFeedIssues(ctx, tid, items)
	if err != nil {
		return nil, "", err
	}
	return items, etagFor(items), nil
}

func etagFor(items []archive.FeedIssue) string {
	if len(items) == 0 {
		return `W/"empty"`
	}
	h := sha256.New()
	writeFeedHashCount(h, len(items))
	for _, it := range items {
		for _, field := range []string{
			it.Slug,
			it.Subject,
			it.Excerpt,
			it.HTMLBody,
			it.HeroImage,
			it.PublishedAt.UTC().Format(time.RFC3339Nano),
			it.AuthorName,
		} {
			writeFeedHashField(h, field)
		}
		writeFeedHashCount(h, len(it.Tags))
		for _, tag := range it.Tags {
			writeFeedHashField(h, tag)
		}
	}
	return `W/"` + hex.EncodeToString(h.Sum(nil))[:16] + `"`
}

func respondNotModified(w http.ResponseWriter, r *http.Request, etag string) bool {
	if r.Header.Get("If-None-Match") == etag {
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	return false
}

// slugify renders a display string (a tag name or author name) as a
// URL-safe, kebab-case slug — matching how the public archive links to a
// tag/author. ASCII-lowercase; runs of non-alphanumerics collapse to a
// single hyphen; leading/trailing hyphens trimmed.
func slugify(s string) string {
	var b strings.Builder
	prevHyphen := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevHyphen = false
		default:
			if b.Len() > 0 && !prevHyphen {
				b.WriteByte('-')
				prevHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// tagKeep matches an issue whose any tag slugifies to slug.
func tagKeep(slug string) func(archive.FeedIssue) bool {
	return func(fi archive.FeedIssue) bool {
		for _, t := range fi.Tags {
			if slugify(t) == slug {
				return true
			}
		}
		return false
	}
}

// authorKeep matches an issue whose author name slugifies to slug.
func authorKeep(slug string) func(archive.FeedIssue) bool {
	return func(fi archive.FeedIssue) bool {
		return fi.AuthorName != "" && slugify(fi.AuthorName) == slug
	}
}
