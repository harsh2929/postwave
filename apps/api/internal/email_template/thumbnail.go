// SPDX-License-Identifier: AGPL-3.0-only
//
// thumbnail.go — Phase 2 deeper-investment `p2-template-png-snapshots`.
//
// Renders a 600x400 PNG snapshot for a campaign template and serves
// it from a cache table (`template_thumbnails`, migration 0339).
// Eliminates the per-card iframe parse cost on the Templates page
// that the audit identified as the slowest interactive surface in
// the desktop client (an iframe per row + a srcDoc rewrite on every
// scroll cost ~120ms each, dominated by browser HTML parse).
//
// Why pure-stdlib drawing instead of headless Chrome (chromedp/rod)
//
//   - Adding a headless browser drags ~150MB of binary deps + a
//     subprocess lifecycle into the API container. We don't ship the
//     Chrome binary in the gateway image today, and the operator
//     desktop only needs a recognisable thumbnail for at-a-glance
//     scanning — not pixel-perfect fidelity.
//   - The HTML body of a template is almost always table-based
//     markup with a header band, hero block, body copy, and a CTA.
//     A primitive renderer that extracts colors from inline styles
//     and lays them out as horizontal bands captures enough visual
//     signal that an operator can tell two templates apart from the
//     gallery view. Pixel-perfect rendering is a Phase 3 swap: same
//     `Render` interface, different implementation (chromedp behind
//     a feature flag).
//   - Stays inside the green-build envelope: no new go.mod
//     additions, no system packages, no init time cost.
//
// Cache invalidation
//
//   - The PNG is keyed by `(template_id, content_hash)`. `content_hash`
//     is sha256(subject || U+001F || body_html); a template Update
//     handler doesn't have to touch the cache — the next GET will
//     observe a hash mismatch and rebuild.
//   - The regeneration worker (RegenerateStaleThumbnails) sweeps
//     rows where the source template's `updated_at` is newer than
//     the cache's `generated_at`. Run it on a slow ticker (default
//     5m). Missing-cache rows are also picked up so a fresh tenant
//     warms naturally without a synchronous render on the GET path.
//
// Metrics
//
//   - `pw_template_thumbnail_total{outcome,reason}` — outcome ∈
//     {ok, error}; reason ∈ {cache_hit, cache_miss, not_found,
//     render_error, db_error}. The cache-hit rate is the headline
//     SLI: hit rate <80% means the worker is falling behind.
//   - `pw_template_duration_seconds{handler="thumbnail"}` — via the
//     standard RecordSurface wrapper.

package email_template

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// thumbnailWidth/Height are the canonical card-thumbnail dimensions
// the Templates page lays out. Mirrors the task brief; if the
// desktop ever asks for retina @2x we add it as a separate cache
// key (template_id, scale) — not a column flag.
const (
	thumbnailWidth  = 600
	thumbnailHeight = 400
)

// thumbCounter is the standardized counter for the thumbnail surface.
// `outcome` + `reason` are the mandatory labels — we use
// `reason="cache_hit"` vs `reason="cache_miss"` for the headline SLI.
var thumbCounter = observability.MustRegisterSurfaceCounter("template_thumbnail", "serve")

// thumbHistogram tracks wall-clock time per thumbnail GET (cache or
// render). Multiplexed via the `handler` label so a Phase-3 swap to
// chromedp can record under `handler="render_chromedp"` without
// breaking dashboards.
var thumbHistogram = observability.MustRegisterSurfaceHistogram("template_thumbnail", "serve")

// recordThumb is a one-liner for emitting the counter pair. Kept
// internal so the call sites in MountRoutes/Handler stay tight.
func recordThumb(outcome, reason string) {
	thumbCounter.WithLabelValues(outcome, reason).Inc()
}

// ThumbnailDeps owns the pool + a renderer hook so tests can stub
// the PNG renderer without touching the image stdlib.
//
// The renderer is a function (not an interface) because there's only
// one production implementation and one test stub — an interface
// would be ceremony without a payoff. If we ever add a feature-
// flagged chromedp path we'll promote this to an interface.
type ThumbnailDeps struct {
	Pool *db.Pool
	// Renderer produces the PNG bytes for a given template body.
	// When nil, DefaultRender is used. Tests inject a deterministic
	// stub so the binary contents don't drift across libpng versions.
	Renderer func(t ThumbnailSource) ([]byte, error)
}

// ThumbnailSource is the input the renderer sees. Kept narrow so
// the renderer stays oblivious to the campaign_templates row shape.
type ThumbnailSource struct {
	Subject  string
	BodyHTML string
	Name     string
}

// MountRoutes wires GET /api/v1/templates/{id}/thumbnail.png onto the
// supplied router. The caller must still apply the campaign-template read
// scope. Serve independently requires a tenant context and never enters
// worker scope, so accidentally mounting this method cannot turn a template
// UUID into a cross-tenant content oracle.
func (d *ThumbnailDeps) MountRoutes(r chi.Router) {
	if d.Pool == nil {
		// Make the wiring bug loud at boot rather than at first GET.
		panic("email_template/thumbnail: Pool is required")
	}
	r.Get("/api/v1/templates/{id}/thumbnail.png", d.Serve)
}

// Serve resolves the template, returns the cached PNG if the
// content_hash matches, otherwise renders + caches + returns.
//
// Status policy:
//   - 200 image/png on success (cache hit OR fresh render)
//   - 404 application/json on missing template
//   - 500 application/json on render or cache write failure
//
// We send ETag = content_hash and a private, must-revalidate policy, so a
// client revalidates on every use and an unchanged template costs only a
// 304 (If-None-Match) while an edited one is never shown stale.
func (d *ThumbnailDeps) Serve(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant, ok := middleware.TenantFromContext(ctx)
	if !ok || strings.TrimSpace(tenant.ID) == "" {
		recordThumb("error", "no_tenant")
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "no_tenant", "message": "tenant context required"}})
		return
	}
	id := chi.URLParam(r, "id")
	if !looksLikeUUID(id) {
		recordThumb("error", "bad_request")
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "bad_request", "message": "id required"}})
		return
	}

	src, ownerTenantID, srcUpdatedAt, err := d.loadTemplate(ctx, tenant.ID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			recordThumb("error", "not_found")
			writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "not_found", "message": "template not found"}})
			return
		}
		recordThumb("error", "db_error")
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "db_error", "message": "an internal error occurred"}})
		return
	}
	_ = srcUpdatedAt // reserved for the worker; per-request path uses content_hash only.

	want := ContentHash(src)

	// Conditional GET — the desktop sets If-None-Match to the etag
	// it cached. 304 is a flat win when the source hasn't moved.
	if match := r.Header.Get("If-None-Match"); match != "" {
		// Quoted etags are RFC-compliant; tolerate either form.
		trimmed := strings.Trim(match, "\"")
		if trimmed == want {
			setCacheHeaders(w, want)
			w.WriteHeader(http.StatusNotModified)
			recordThumb("ok", "cache_hit")
			return
		}
	}

	pngBytes, gotHash, err := d.loadCache(ctx, tenant.ID, id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		recordThumb("error", "db_error")
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "db_error", "message": "an internal error occurred"}})
		return
	}
	if err == nil && gotHash == want && len(pngBytes) > 0 {
		recordThumb("ok", "cache_hit")
		writePNG(w, pngBytes, want)
		return
	}

	// Cache miss or stale — render on-demand. We block the GET
	// because the worker may not have caught up yet; the renderer
	// is bounded (<10 ms for typical inputs).
	renderer := d.Renderer
	if renderer == nil {
		renderer = DefaultRender
	}
	pngBytes, err = renderer(src)
	if err != nil {
		recordThumb("error", "render_error")
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "render_error", "message": "an internal error occurred"}})
		return
	}
	if err := d.upsertCacheForTenant(ctx, tenant.ID, id, ownerTenantID, want, pngBytes); err != nil {
		// We still return the PNG — failing to persist the cache
		// shouldn't 500 the user-visible request. The reason label
		// lets the dashboards spot a sustained "ok+cache_write_fail"
		// pattern that would mean we're regenerating every GET.
		recordThumb("ok", "cache_write_fail")
		writePNG(w, pngBytes, want)
		return
	}
	recordThumb("ok", "cache_miss")
	writePNG(w, pngBytes, want)
}

// ContentHash is the canonical content_hash for a thumbnail. Exposed
// so the regeneration worker can compare without re-deriving the
// hash in two places.
func ContentHash(src ThumbnailSource) string {
	h := sha256.New()
	// U+001F (unit separator) is a safe in-band delimiter — it
	// never appears in HTML or human-typed subjects. Avoids the
	// classic "subject ending in '<html>' collides with body
	// starting with the same prefix" issue a simple concat would
	// have.
	h.Write([]byte(src.Subject))
	h.Write([]byte{0x1f})
	h.Write([]byte(src.BodyHTML))
	return hex.EncodeToString(h.Sum(nil))
}

// loadTemplate fetches the minimal columns the thumbnail path needs.
// We deliberately don't go through the campaigntemplates repo — that
// surface returns the full Template struct with merge variables, and
// pulling all of it on every GET would waste bytes on the wire and
// CPU on the scan.
func (d *ThumbnailDeps) loadTemplate(ctx context.Context, tenantID, id string) (ThumbnailSource, string, time.Time, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return ThumbnailSource{}, "", time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var src ThumbnailSource
	var ownerTenantID string
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
SELECT COALESCE(tenant_id::text, ''), name, subject, COALESCE(body_html, ''), updated_at
  FROM campaign_templates
	WHERE id::text = $1
	  AND (tenant_id = $2::uuid OR tenant_id IS NULL)`, id, tenantID).Scan(&ownerTenantID, &src.Name, &src.Subject, &src.BodyHTML, &updatedAt)
	if err != nil {
		return ThumbnailSource{}, "", time.Time{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ThumbnailSource{}, "", time.Time{}, err
	}
	return src, ownerTenantID, updatedAt, nil
}

// loadCache returns the cached PNG + stored content_hash. The caller
// decides whether the stored hash matches the wanted one.
func (d *ThumbnailDeps) loadCache(ctx context.Context, tenantID, templateID string) ([]byte, string, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var pngBytes []byte
	var hash string
	if err := tx.QueryRow(ctx, `
SELECT png, content_hash FROM template_thumbnails WHERE template_id::text = $1`, templateID).Scan(&pngBytes, &hash); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return pngBytes, hash, nil
}

// upsertCache replaces the cached PNG for `templateID`. We use the
// single-row-per-template pattern: the GET handler only needs the
// freshest render, and history would just bloat the table.
func (d *ThumbnailDeps) upsertCacheForTenant(ctx context.Context, actingTenantID, templateID, ownerTenantID, hash string, pngBytes []byte) error {
	tx, err := db.WithTenant(ctx, d.Pool, actingTenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := upsertCacheRow(ctx, tx, templateID, ownerTenantID, hash, pngBytes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *ThumbnailDeps) upsertCacheWorker(ctx context.Context, templateID, ownerTenantID, hash string, pngBytes []byte) error {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := upsertCacheRow(ctx, tx, templateID, ownerTenantID, hash, pngBytes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func upsertCacheRow(ctx context.Context, tx pgx.Tx, templateID, ownerTenantID, hash string, pngBytes []byte) error {
	// We pass tenant_id as either a real UUID or NULL (platform row).
	// Encoding the NULL via NULLIF lets us keep the query a single
	// statement instead of branching at the Go layer.
	var tenantArg any
	if ownerTenantID == "" {
		tenantArg = nil
	} else {
		tenantArg = ownerTenantID
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO template_thumbnails (template_id, tenant_id, content_hash, png, width, height, generated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, now())
ON CONFLICT (template_id) DO UPDATE
   SET content_hash = EXCLUDED.content_hash,
       png          = EXCLUDED.png,
       width        = EXCLUDED.width,
       height       = EXCLUDED.height,
       generated_at = now()`,
		templateID, tenantArg, hash, pngBytes, thumbnailWidth, thumbnailHeight); err != nil {
		return err
	}
	return nil
}

// RegenerateStaleThumbnails sweeps the template_thumbnails table for
// rows whose source template has moved on (`updated_at >
// generated_at`) or whose cache row is missing entirely. Bounded by
// `limit` so a single tick can't monopolize the worker. Returns the
// number of rows refreshed.
//
// Designed to be called by a periodic background worker (e.g.
// every 5 minutes). The worker scope bypasses the tenant predicate
// so a single sweep covers every tenant + the platform rows.
func (d *ThumbnailDeps) RegenerateStaleThumbnails(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = 50
	}
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT t.id::text, COALESCE(t.tenant_id::text, ''), t.name, t.subject, COALESCE(t.body_html, ''), t.updated_at
  FROM campaign_templates t
  LEFT JOIN template_thumbnails c ON c.template_id = t.id
 WHERE c.template_id IS NULL
    OR c.generated_at < t.updated_at
 ORDER BY t.updated_at DESC
 LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type todo struct {
		id, tenantID string
		src          ThumbnailSource
	}
	var queue []todo
	for rows.Next() {
		var id, tenantID string
		var src ThumbnailSource
		var updatedAt time.Time
		if err := rows.Scan(&id, &tenantID, &src.Name, &src.Subject, &src.BodyHTML, &updatedAt); err != nil {
			rows.Close()
			return 0, err
		}
		queue = append(queue, todo{id: id, tenantID: tenantID, src: src})
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	renderer := d.Renderer
	if renderer == nil {
		renderer = DefaultRender
	}
	regenerated := 0
	for _, t := range queue {
		pngBytes, err := renderer(t.src)
		if err != nil {
			// Skip the one bad row but keep walking — a transient
			// renderer error shouldn't block the rest of the sweep.
			recordThumb("error", "worker_render_error")
			continue
		}
		if err := d.upsertCacheWorker(ctx, t.id, t.tenantID, ContentHash(t.src), pngBytes); err != nil {
			recordThumb("error", "worker_cache_write_fail")
			continue
		}
		regenerated++
	}
	return regenerated, nil
}

// DefaultRender produces a 600x400 PNG that captures enough visual
// signal from `src` for an operator to distinguish two templates in
// the gallery. The renderer is intentionally primitive — see the
// file header for the rationale.
//
// Layout:
//   - Top band (44 px): "header" — colored bar derived from a hash
//     of the template name. Two templates with the same name share
//     the same header color (handy in side-by-side comparisons).
//   - Body region: alternating horizontal bands sized by the
//     density of text vs tags in the body HTML. Operators see a
//     "dense email" vs a "sparse email" at a glance.
//   - Footer band (24 px): a single neutral bar suggesting a CTA
//     row — most operator-authored bodies end with one.
//
// Returns a deterministic byte slice for a given input so caching
// works correctly. PNG encoding of the same image.RGBA is stable
// across Go versions thanks to image/png using fixed filter +
// compression parameters.
func DefaultRender(src ThumbnailSource) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, thumbnailWidth, thumbnailHeight))
	bg := color.RGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
	draw.Draw(img, img.Bounds(), &image.Uniform{C: bg}, image.Point{}, draw.Src)

	header := colorFromString(src.Name + "|" + src.Subject)
	drawRect(img, image.Rect(0, 0, thumbnailWidth, 44), header)

	// Density-driven body bands. We sniff the HTML for paragraph-like
	// segments by splitting on tag boundaries and binning the result
	// — no full HTML parse, just a coarse signal.
	bands := bodyBands(src.BodyHTML)
	y := 60
	bandY := y
	muted := color.RGBA{R: 0xee, G: 0xee, B: 0xee, A: 0xff}
	accent := color.RGBA{R: 0xdd, G: 0xdd, B: 0xdd, A: 0xff}
	for i, h := range bands {
		end := bandY + h
		if end > thumbnailHeight-32 {
			end = thumbnailHeight - 32
		}
		c := muted
		if i%2 == 1 {
			c = accent
		}
		drawRect(img, image.Rect(40, bandY, thumbnailWidth-40, end), c)
		bandY = end + 8
		if bandY >= thumbnailHeight-32 {
			break
		}
	}

	// CTA-suggesting footer band.
	footer := color.RGBA{R: header.R, G: header.G, B: header.B, A: 0xa0}
	drawRect(img, image.Rect(200, thumbnailHeight-44, 400, thumbnailHeight-20), footer)

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("thumbnail: encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// drawRect fills a rectangle with a solid color. Pulled out to keep
// the renderer body readable.
func drawRect(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	draw.Draw(img, r, &image.Uniform{C: c}, image.Point{}, draw.Src)
}

// colorFromString picks a stable, eye-friendly color for a string.
// We hash, then quantize to a palette so close-but-not-identical
// names don't produce visually identical colors (anti-collision).
func colorFromString(s string) color.RGBA {
	sum := sha256.Sum256([]byte(s))
	// Use the first 3 bytes for RGB, then push the components into a
	// mid-luminance range so the header always reads as colored
	// rather than near-black or near-white.
	r := 0x40 + int(sum[0])/2
	g := 0x40 + int(sum[1])/2
	b := 0x40 + int(sum[2])/2
	return color.RGBA{R: clampByte(r), G: clampByte(g), B: clampByte(b), A: 0xff}
}

func clampByte(v int) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

// bodyBands returns the heights of the simulated content bands.
// More text → more bands of varied height; very short bodies → a
// single tall band. Bounded so the result never overflows.
func bodyBands(html string) []int {
	if strings.TrimSpace(html) == "" {
		return []int{220}
	}
	// Strip tags so the heuristic is on visible-ish text length.
	stripped := tagRE.ReplaceAllString(html, " ")
	stripped = strings.Join(strings.Fields(stripped), " ")
	n := len(stripped)
	switch {
	case n < 80:
		return []int{220}
	case n < 400:
		return []int{60, 100, 50}
	case n < 1500:
		return []int{36, 36, 60, 36, 36, 50}
	default:
		return []int{24, 24, 60, 24, 24, 24, 24, 50, 24}
	}
}

// tagRE strips HTML tags for the band heuristic. Permissive — we
// don't need a real parser, just want to avoid counting `<p>` as
// text characters.
var tagRE = regexp.MustCompile(`(?is)<[^>]+>`)

// uuidRE is the cheap shape check on path UUIDs. Avoids hitting the
// DB for an obvious garbage input.
var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func looksLikeUUID(s string) bool { return uuidRE.MatchString(s) }

// writePNG sets the image response headers and flushes the body.
func writePNG(w http.ResponseWriter, body []byte, etag string) {
	setCacheHeaders(w, etag)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// setCacheHeaders is shared by the 200 + 304 paths so the desktop
// always sees the same etag/cache-control regardless of branch.
//
// A thumbnail is a picture of a tenant's own template, served behind
// tenant authentication from a URL keyed by template id. It is therefore
// private and revalidated on every use: the content-hash ETag turns each
// revalidation into a cheap 304, so an edited template never shows a
// day-old picture and no shared cache can hand one tenant's PNG to another.
// Vary is added to, never replaced: the route's cache policy has already
// declared Authorization and Cookie.
func setCacheHeaders(w http.ResponseWriter, etag string) {
	w.Header().Set("ETag", "\""+etag+"\"")
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	addVary(w, "Accept-Encoding")
}

func addVary(w http.ResponseWriter, value string) {
	for _, existing := range w.Header().Values("Vary") {
		for _, part := range strings.Split(existing, ",") {
			if strings.EqualFold(strings.TrimSpace(part), value) {
				return
			}
		}
	}
	w.Header().Add("Vary", value)
}
