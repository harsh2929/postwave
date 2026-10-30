// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestRepoList_QFilter inserts 5 templates with mixed name/subject and
// asserts that List(q) filters on either column (case-insensitive).
// Skips when DATABASE_URL is unset.
func TestRepoList_QFilter(t *testing.T) {
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

	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	prefix := "qf-" + randHex4(t) + "-"
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupTemplates(pool, tenantID, prefix) })

	seeds := []struct{ slug, name, subject string }{
		{prefix + "a", prefix + "Alpha tmpl", "weekly digest"},
		{prefix + "b", prefix + "Beta tmpl", "alpha promo"},
		{prefix + "c", prefix + "Gamma tmpl", "weekly digest"},
		{prefix + "d", prefix + "Delta tmpl", "monthly recap"},
		{prefix + "e", prefix + "Echo tmpl", "monthly recap"},
	}
	for _, s := range seeds {
		if _, err := repo.Create(ctx, tenantID, CreateInput{
			Slug: s.slug, Name: s.name, Subject: s.subject,
			Tags: []string{}, // schema NOT NULL on tags + variables
		}); err != nil {
			t.Fatalf("seed %q: %v", s.name, err)
		}
	}

	got, err := repo.List(ctx, tenantID, ListFilter{Query: "alpha"})
	if err != nil {
		t.Fatalf("List q=alpha: %v", err)
	}
	matched := 0
	for _, tpl := range got {
		if strings.HasPrefix(tpl.Slug, prefix) {
			matched++
		}
	}
	// Two rows: name has Alpha (row a) + subject has alpha (row b).
	if matched != 2 {
		t.Fatalf("q=alpha: matched %d test rows, want 2 (got=%v)", matched, got)
	}
}

func TestLegacyListBounds(t *testing.T) {
	tests := []struct {
		name          string
		page, perPage int
		wantPage      int
		wantPerPage   int
	}{
		{name: "defaults", wantPage: 1, wantPerPage: defaultLegacyListPageSize},
		{name: "requested page", page: 3, perPage: 25, wantPage: 3, wantPerPage: 25},
		{name: "caps oversized pages", page: 2, perPage: 3_132, wantPage: 2, wantPerPage: maxLegacyListPageSize},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, perPage := legacyListBounds(tt.page, tt.perPage)
			if page != tt.wantPage || perPage != tt.wantPerPage {
				t.Fatalf("legacyListBounds(%d, %d) = (%d, %d), want (%d, %d)",
					tt.page, tt.perPage, page, perPage, tt.wantPage, tt.wantPerPage)
			}
		})
	}
	if strings.Contains(legacyListBodyProjection, "t.body_") {
		t.Fatalf("legacy list projection must omit stored bodies: %q", legacyListBodyProjection)
	}
}

func TestRepoList_IsCompactAndPaged(t *testing.T) {
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

	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	prefix := "page-" + randHex4(t) + "-"
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupTemplates(pool, tenantID, prefix) })

	for _, suffix := range []string{"a", "b"} {
		if _, err := repo.Create(ctx, tenantID, CreateInput{
			Slug:     prefix + suffix,
			Name:     prefix + suffix,
			Subject:  "Paged template",
			BodyHTML: "<p>large HTML body</p>",
			BodyMJML: "<mjml><mj-body /></mjml>",
			Tags:     []string{},
		}); err != nil {
			t.Fatalf("seed %s: %v", suffix, err)
		}
	}

	first, err := repo.List(ctx, tenantID, ListFilter{Query: prefix, Page: 1, PerPage: 1})
	if err != nil {
		t.Fatalf("List page 1: %v", err)
	}
	second, err := repo.List(ctx, tenantID, ListFilter{Query: prefix, Page: 2, PerPage: 1})
	if err != nil {
		t.Fatalf("List page 2: %v", err)
	}
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("page lengths = %d and %d, want 1 and 1", len(first), len(second))
	}
	if first[0].ID == second[0].ID {
		t.Fatalf("page 2 repeated page 1 template %q", first[0].ID)
	}
	for _, row := range append(first, second...) {
		if row.BodyHTML != "" || row.BodyMJML != "" {
			t.Fatalf("legacy list returned template bodies for %q", row.ID)
		}
	}
}

func randHex4(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func seedCampaignTemplateTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
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
VALUES ($1::uuid, $2, 'Campaign template q-filter test', 'studio')`,
		tenantID, "campaign-template-qfilter-"+randHex4(t)); err != nil {
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

func cleanupTemplates(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM campaign_templates WHERE tenant_id = $1::uuid AND slug LIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"slug":"x","name":"X","subject":"S","body_html":"` + strings.Repeat("a", int(campaignTemplateJSONMaxBodyBytes)+1) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaign-templates", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	d.Create(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
