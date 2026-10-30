package archive

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestBuildSitemap_HasIndexAndIssues(t *testing.T) {
	issues := []IssueSummary{
		{Slug: "first-issue", Subject: "Hello", PublishedAt: time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)},
		{Slug: "second", Subject: "Hi", PublishedAt: time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)},
	}
	out := BuildSitemap("https://archive.example/acme", issues)
	if !strings.Contains(out, "<?xml") {
		t.Fatalf("missing xml header: %s", out)
	}
	if !strings.Contains(out, "<loc>https://archive.example/acme</loc>") {
		t.Fatalf("missing index loc: %s", out)
	}
	if !strings.Contains(out, "<loc>https://archive.example/acme/first-issue</loc>") {
		t.Fatalf("missing issue loc: %s", out)
	}
	if !strings.Contains(out, "<lastmod>2026-04-01</lastmod>") {
		t.Fatalf("missing lastmod: %s", out)
	}
}

func TestBuildSitemap_EmptyStillValid(t *testing.T) {
	out := BuildSitemap("https://x/y", nil)
	if !strings.Contains(out, "<urlset") {
		t.Fatalf("missing urlset: %s", out)
	}
}

func TestListIssuesRejectsMalformedCursorBeforeDatabaseAccess(t *testing.T) {
	malformedV2 := base64.RawURLEncoding.EncodeToString([]byte(
		"v2|p|2026-07-26T08:15:12Z|not-a-uuid",
	))
	for _, cursor := range []string{"not-a-cursor", malformedV2} {
		repo := &Repo{Pool: nil}
		_, err := repo.ListIssues(
			context.Background(),
			"00000000-0000-4000-8000-000000000001",
			cursor,
			25,
			"",
		)
		if !errors.Is(err, ErrInvalidCursor) {
			t.Fatalf("cursor %q: error = %v, want ErrInvalidCursor", cursor, err)
		}
	}
}

func TestArchiveCursorRoundTrip(t *testing.T) {
	wantTime := time.Date(2026, 7, 26, 8, 15, 12, 345, time.UTC)
	wantCampaignID := uuid.MustParse("00000000-0000-4000-8000-000000000002")
	raw := encodeArchiveCursor(true, wantTime, wantCampaignID)
	decoded, ok := decodeArchiveCursor(raw)
	if !ok {
		t.Fatalf("decodeArchiveCursor(%q) was rejected", raw)
	}
	if decoded.kind != archiveCursorStable {
		t.Fatalf("decoded kind = %v, want stable", decoded.kind)
	}
	if !decoded.pinned {
		t.Fatal("decoded pinned = false, want true")
	}
	if !decoded.publishedAt.Equal(wantTime) {
		t.Fatalf("decoded time = %s, want %s", decoded.publishedAt, wantTime)
	}
	if decoded.campaignID != wantCampaignID {
		t.Fatalf("decoded campaign id = %s, want %s", decoded.campaignID, wantCampaignID)
	}
}

func TestParseArchiveCursorPreservesHistoricalFormats(t *testing.T) {
	wantTime := time.Date(2026, 7, 26, 8, 15, 12, 345, time.UTC)
	legacyCompound := base64.RawURLEncoding.EncodeToString([]byte(
		"u|" + wantTime.Format(time.RFC3339Nano),
	))
	tests := []struct {
		name       string
		raw        string
		wantKind   archiveCursorKind
		wantPinned bool
	}{
		{
			name:     "bare timestamp",
			raw:      wantTime.Format(time.RFC3339Nano),
			wantKind: archiveCursorLegacyTimestamp,
		},
		{
			name:       "encoded pinned timestamp",
			raw:        legacyCompound,
			wantKind:   archiveCursorLegacyCompound,
			wantPinned: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseArchiveCursor(test.raw)
			if err != nil {
				t.Fatalf("parseArchiveCursor(%q): %v", test.raw, err)
			}
			if got.kind != test.wantKind {
				t.Fatalf("kind = %v, want %v", got.kind, test.wantKind)
			}
			if got.pinned != test.wantPinned {
				t.Fatalf("pinned = %v, want %v", got.pinned, test.wantPinned)
			}
			if !got.publishedAt.Equal(wantTime) {
				t.Fatalf("time = %s, want %s", got.publishedAt, wantTime)
			}
			if got.campaignID != uuid.Nil {
				t.Fatalf("legacy cursor unexpectedly acquired campaign id %s", got.campaignID)
			}
		})
	}
}

func TestStableArchiveCursorPredicateUsesUUIDTiebreaker(t *testing.T) {
	publishedAt := time.Date(2026, 7, 26, 8, 15, 12, 0, time.UTC)
	campaignID := uuid.MustParse("ffffffff-ffff-4fff-bfff-ffffffffffff")
	cursor := archiveCursor{
		kind:        archiveCursorStable,
		pinned:      true,
		publishedAt: publishedAt,
		campaignID:  campaignID,
	}

	sqlQ, args := appendArchiveCursorPredicate(
		"SELECT issue FROM campaigns WHERE tenant_id = $1",
		[]any{"tenant-id", 26},
		cursor,
	)

	wantPredicate := "(COALESCE(archive_pinned, false), COALESCE(finished_at, created_at), campaigns.id) < ($3::boolean, $4::timestamptz, $5::uuid)"
	if !strings.Contains(sqlQ, wantPredicate) {
		t.Fatalf("query lacks stable three-column predicate:\n%s", sqlQ)
	}
	if len(args) != 5 {
		t.Fatalf("args length = %d, want 5", len(args))
	}
	if args[2] != true {
		t.Fatalf("pinned arg = %#v, want true", args[2])
	}
	if got, ok := args[3].(time.Time); !ok || !got.Equal(publishedAt) {
		t.Fatalf("published-at arg = %#v, want %s", args[3], publishedAt)
	}
	if got, ok := args[4].(string); !ok || got != campaignID.String() {
		t.Fatalf("campaign-id arg = %#v, want %s", args[4], campaignID)
	}

	lowerCampaignID := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	if encodeArchiveCursor(true, publishedAt, campaignID) ==
		encodeArchiveCursor(true, publishedAt, lowerCampaignID) {
		t.Fatal("equal pinned/time rows produced identical stable cursors")
	}
}

func TestWriteSitemapErrorUsesXMLContract(t *testing.T) {
	w := httptest.NewRecorder()

	writeSitemapError(w, http.StatusNotFound, "not_found", "no such archive")

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/xml; charset=utf-8" {
		t.Fatalf("content-type = %q, want application/xml", ct)
	}
	if body := w.Body.String(); !strings.Contains(body, "<code>not_found</code>") {
		t.Fatalf("body missing XML error code: %s", body)
	}
}

func TestAdminPublishRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"slug":"issue","excerpt":"` + strings.Repeat("a", int(archiveJSONMaxBodyBytes)+1) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/c1/publish-archive", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	d.AdminPublish(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestAdminPublishRejectsInvalidRequestsBeforeRepositoryAccess(t *testing.T) {
	const (
		tenantID   = "00000000-0000-4000-8000-000000000001"
		campaignID = "00000000-0000-4000-8000-000000000002"
	)
	tests := []struct {
		name       string
		pathID     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "empty body",
			pathID:     campaignID,
			body:       "",
			wantStatus: http.StatusBadRequest,
			wantCode:   "bad_json",
		},
		{
			name:       "malformed campaign id",
			pathID:     "not-a-uuid",
			body:       `{"slug":"issue","excerpt":""}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_campaign_id",
		},
		{
			name:       "missing slug",
			pathID:     campaignID,
			body:       `{"slug":"","excerpt":""}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "slug_required",
		},
		{
			name:       "invalid slug",
			pathID:     campaignID,
			body:       `{"slug":"Not Valid","excerpt":""}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "invalid_slug",
		},
		{
			name:       "oversized excerpt",
			pathID:     campaignID,
			body:       `{"slug":"issue","excerpt":"` + strings.Repeat("a", PublishExcerptMaxLen+1) + `"}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "invalid_excerpt",
		},
		{
			name:       "private image host",
			pathID:     campaignID,
			body:       `{"slug":"issue","excerpt":"","ogImage":"http://127.0.0.1/private.png"}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "invalid_og_image",
		},
		{
			name:       "unknown field",
			pathID:     campaignID,
			body:       `{"slug":"issue","excerpt":"","membersOnly":true}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "unknown_field",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			d := &Deps{Repo: nil}
			req := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/campaigns/"+test.pathID+"/publish-archive",
				strings.NewReader(test.body),
			)
			if test.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			routeContext := chi.NewRouteContext()
			routeContext.URLParams.Add("id", test.pathID)
			req = req.WithContext(context.WithValue(
				req.Context(),
				chi.RouteCtxKey,
				routeContext,
			))
			req = req.WithContext(middleware.WithTenant(
				req.Context(),
				&middleware.Tenant{ID: tenantID},
			))
			rec := httptest.NewRecorder()

			d.AdminPublish(rec, req)

			if rec.Code != test.wantStatus {
				t.Fatalf(
					"status = %d, want %d; body=%s",
					rec.Code,
					test.wantStatus,
					rec.Body.String(),
				)
			}
			if !strings.Contains(rec.Body.String(), `"`+test.wantCode+`"`) {
				t.Fatalf(
					"response missing code %q: %s",
					test.wantCode,
					rec.Body.String(),
				)
			}
		})
	}
}

func TestAdminUnpublishRejectsInvalidCampaignIDBeforeRepositoryAccess(t *testing.T) {
	d := &Deps{Repo: nil}
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaigns/not-a-uuid/unpublish-archive",
		strings.NewReader(`{}`),
	)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", "not-a-uuid")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
	req = req.WithContext(middleware.WithTenant(
		req.Context(),
		&middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"},
	))
	rec := httptest.NewRecorder()

	d.AdminUnpublish(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"invalid_campaign_id"`) {
		t.Fatalf("response missing invalid_campaign_id: %s", rec.Body.String())
	}
}

func TestIssueSummaryCampaignIDIsAdminOnlyByConstruction(t *testing.T) {
	public, err := json.Marshal(IssueSummary{Slug: "issue"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(public), "campaignId") {
		t.Fatalf("zero campaign id leaked into public-compatible summary: %s", public)
	}

	admin, err := json.Marshal(IssueSummary{
		Slug:       "issue",
		CampaignID: "00000000-0000-4000-8000-000000000002",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(admin), `"campaignId"`) {
		t.Fatalf("admin summary omitted canonical campaign id: %s", admin)
	}
}

// TestRepoListIssues_QFilter inserts 5 archived campaigns with mixed
// subjects/slugs and asserts that ListIssues(q) filters on either
// column (case-insensitive). Skips silently when DATABASE_URL is unset.
func TestRepoListIssues_QFilter(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := seedArchiveTenant(t, ctx, pool)
	tag := randHex4Arc(t)
	slugPrefix := "qfa-" + tag + "-"
	t.Cleanup(func() { cleanupArchive(pool, tenantID, slugPrefix) })

	type seed struct{ slug, subject string }
	seeds := []seed{
		{slugPrefix + "alpha", "Weekly digest"},
		{slugPrefix + "two", "Alpha launch update"},
		{slugPrefix + "three", "Monthly recap"},
		{slugPrefix + "four", "Beta promo"},
		{slugPrefix + "five", "Gamma release"},
	}

	// Seed minimal campaign rows with archive_public=true via tenant tx.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	for _, s := range seeds {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, archive_public, archive_slug, archive_excerpt, finished_at)
VALUES ($1::uuid, $2, $3, 'sent', true, $4, $2, now())`,
			tenantID, s.subject, s.subject, s.slug); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed %q: %v", s.slug, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	// Bind the tenant GUC on a separate connection so the RLS-enforced
	// campaigns SELECT in ListIssues (which uses Pool.Acquire) sees the
	// scoped row set. Mirrors how the AdminList handler is wrapped by
	// the tenant middleware in main.go (the middleware binds the GUC
	// for the request lifetime via session_replication_role bypass at
	// pool-level, which is not active in unit tests).
	repo := &Repo{Pool: pool}
	page, err := repo.ListIssues(ctx, tenantID, "", 100, "alpha")
	if err != nil {
		t.Fatalf("ListIssues q=alpha: %v", err)
	}
	matched := 0
	for _, it := range page.Items {
		if strings.HasPrefix(it.Slug, slugPrefix) {
			matched++
		}
	}
	// Two: slug "qfa-...-alpha" + subject "Alpha launch update".
	if matched != 2 {
		t.Fatalf("q=alpha: matched %d, want 2 (got=%v)", matched, page.Items)
	}
}

func randHex4Arc(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func seedArchiveTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Archive q-filter test', 'studio')`,
		tenantID, "archive-qfilter-"+randHex4Arc(t)); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
	return tenantID
}

func cleanupArchive(pool *db.Pool, tenantID, slugPrefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM campaigns WHERE tenant_id = $1::uuid AND archive_slug LIKE $2`, tenantID, slugPrefix+"%")
	_ = tx.Commit(ctx)
}
