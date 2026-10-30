package forms

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestAllowedTransition documents the legal status DAG. Mirror of the
// Phase 3 spec: draft <-> published, both -> archived, archived terminal.
func TestAllowedTransition(t *testing.T) {
	tests := []struct {
		from, to Status
		want     bool
	}{
		{StatusDraft, StatusDraft, true},
		{StatusDraft, StatusPublished, true},
		{StatusDraft, StatusArchived, true},
		{StatusPublished, StatusDraft, true},
		{StatusPublished, StatusArchived, true},
		{StatusArchived, StatusDraft, false},
		{StatusArchived, StatusPublished, false},
	}
	for _, tt := range tests {
		got := AllowedTransition(tt.from, tt.to)
		if got != tt.want {
			t.Errorf("AllowedTransition(%q, %q) = %v, want %v", tt.from, tt.to, got, tt.want)
		}
	}
}

// TestNewConfirmationToken sanity-checks token generation: 64 hex chars,
// non-deterministic across calls.
func TestNewConfirmationToken(t *testing.T) {
	a, err := NewConfirmationToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 64 {
		t.Errorf("token len = %d, want 64", len(a))
	}
	for _, c := range a {
		ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
		if !ok {
			t.Errorf("non-hex char %q in %q", c, a)
			break
		}
	}
	b, _ := NewConfirmationToken()
	if a == b {
		t.Errorf("two consecutive tokens collided: %q", a)
	}
}

// Every accepted submission becomes a subscriber, so the public form accepts
// exactly the mailboxes the subscriber store does. The looser check it had
// accepted addresses the store refuses — recorded, answered "subscribed", and
// then never able to reach the audience.
func TestPublicSubmitAcceptsExactlyTheMailboxesASubscriberCanHave(t *testing.T) {
	for raw, want := range map[string]string{
		"a@b.co":                    "a@b.co",
		"User.Name+tag@Example.com": "user.name+tag@example.com",
		"x@xn--bcher-kva.example":   "x@xn--bcher-kva.example",
	} {
		if got, ok := normalizePublicSubmitEmail(raw); !ok || got != want {
			t.Errorf("normalizePublicSubmitEmail(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	for _, raw := range []string{
		"", "no-at", "@nohost", "user@", "user@domain", "a b@c.de", "with,comma@x.io",
		"a..b@example.com", ".a@example.com", "ünïcode@example.com", "a@bücher.example",
		"a@under_score.example", `"quoted"@example.com`, "a@-leading.example",
	} {
		if got, ok := normalizePublicSubmitEmail(raw); ok {
			t.Errorf("normalizePublicSubmitEmail(%q) = %q; the subscriber store refuses it", raw, got)
		}
	}
}

func TestNormalizePublicSubmitEmailRejectsRawControlsBeforeTrimming(t *testing.T) {
	for _, raw := range []string{
		"reader@example.com\v",
		"reader@example.com\f",
		"reader@example.com\u0085",
		"reader@example.com\u009f",
		"reader@example.com\x00",
	} {
		if got, ok := normalizePublicSubmitEmail(raw); ok || got != "" {
			t.Errorf("normalizePublicSubmitEmail(%q) = %q, %v; want rejected", raw, got, ok)
		}
	}

	got, ok := normalizePublicSubmitEmail("  Reader@Example.COM  ")
	if !ok || got != "reader@example.com" {
		t.Fatalf("ordinary outer whitespace normalization = %q, %v", got, ok)
	}

	if got, ok := normalizePublicSubmitEmail(string([]byte("reader@example.com\xff"))); ok || got != "" {
		t.Fatalf("invalid UTF-8 email = %q, %v; want rejected", got, ok)
	}
}

// TestRepoList_QFilter inserts 5 forms with mixed names/slugs and
// asserts that List(q="alpha") returns only substring matches across
// name OR slug. Skips silently when DATABASE_URL is unset.
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

	tenantID := seedFormsTenant(t, ctx, pool)
	prefix := "qf-" + randHex4(t) + "-"
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupForms(pool, tenantID, prefix) })

	type seed struct{ name, slug string }
	seeds := []seed{
		{prefix + "Alpha Form", prefix + "form-a"},
		{prefix + "Beta Form", prefix + "form-alpha-too"},
		{prefix + "Gamma Form", prefix + "form-c"},
		{prefix + "Delta Form", prefix + "form-d"},
		{prefix + "Echo Form", prefix + "form-e"},
	}
	for _, s := range seeds {
		if _, err := repo.Create(ctx, tenantID,
			CreateInput{Slug: s.slug, Name: s.name, OptInMode: OptInSingle},
			map[string]any{}, map[string]any{}); err != nil {
			t.Fatalf("seed %q: %v", s.name, err)
		}
	}

	got, err := repo.List(ctx, tenantID, "alpha")
	if err != nil {
		t.Fatalf("List q=alpha: %v", err)
	}
	matched := 0
	for _, f := range got {
		if strings.HasPrefix(f.Slug, prefix) {
			matched++
		}
	}
	// Two rows should match: name "Alpha Form" + slug "...form-alpha-too".
	if matched != 2 {
		t.Fatalf("q=alpha: matched %d test rows, want 2 (got=%v)", matched, got)
	}
}

func TestPublicSlugUniqueViolationClassification(t *testing.T) {
	publicCollision := &pgconn.PgError{
		Code:           "23505",
		ConstraintName: "forms_public_slug_uniq",
	}
	if !isUniqueConstraintViolation(publicCollision, "forms_public_slug_uniq") {
		t.Fatal("global published-form slug collision was not classified")
	}
	if !isUniqueViolation(publicCollision) {
		t.Fatal("global published-form slug collision lost generic unique classification")
	}
	tenantCollision := &pgconn.PgError{
		Code:           "23505",
		ConstraintName: "forms_tenant_id_slug_key",
	}
	if isUniqueConstraintViolation(tenantCollision, "forms_public_slug_uniq") {
		t.Fatal("tenant-local slug collision was misclassified as a public URL collision")
	}
}

// TestRepoPublishRejectsCrossTenantHostedSlug proves that the tenant-less
// /forms/{slug} namespace cannot be claimed by two workspaces. It runs when a
// migrated integration database is available and otherwise leaves the static
// migration contract test to cover the release artifact.
func TestRepoPublishRejectsCrossTenantHostedSlug(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantA := seedFormsTenant(t, ctx, pool)
	tenantB := seedFormsTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	slug := "global-form-" + randHex4(t)
	create := func(tenantID, name string) *Form {
		t.Helper()
		form, createErr := repo.Create(ctx, tenantID,
			CreateInput{Slug: slug, Name: name, OptInMode: OptInSingle},
			map[string]any{}, map[string]any{})
		if createErr != nil {
			t.Fatalf("create %s: %v", name, createErr)
		}
		return form
	}

	formA := create(tenantA, "Workspace A form")
	formB := create(tenantB, "Workspace B form")
	published := StatusPublished
	if _, err := repo.Update(ctx, tenantA, formA.ID, UpdateInput{Status: &published}); err != nil {
		t.Fatalf("publish first claim: %v", err)
	}
	if _, err := repo.Update(ctx, tenantB, formB.ID, UpdateInput{Status: &published}); !errors.Is(err, ErrPublicSlugConflict) {
		t.Fatalf("publish second claim error = %v, want ErrPublicSlugConflict", err)
	}

	resolved, err := repo.ByPublicSlug(ctx, strings.ToUpper(slug))
	if err != nil {
		t.Fatalf("resolve public slug: %v", err)
	}
	if resolved.ID != formA.ID || resolved.TenantID != tenantA {
		t.Fatalf("public slug resolved to form %s tenant %s, want form %s tenant %s",
			resolved.ID, resolved.TenantID, formA.ID, tenantA)
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

func seedFormsTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
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
VALUES ($1::uuid, $2, 'Forms q-filter test', 'studio')`,
		tenantID, "forms-qfilter-"+randHex4(t)); err != nil {
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

func cleanupForms(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM forms WHERE tenant_id = $1::uuid AND slug LIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}
