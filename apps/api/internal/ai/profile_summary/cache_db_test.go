// SPDX-License-Identifier: AGPL-3.0-only
package profile_summary

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// Exercise PostgreSQL's parameter inference, the 24h expiry, and the conflict
// update path. A mocked SQL executor cannot detect the timestamp/interval clash.
func TestSummaryCacheTimestampRoundTrip(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID, subscriberID := uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Summary QA', 'studio')`, tenantID, "summary-qa-"+tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO subscribers (id, tenant_id, email, status, consent_source) VALUES ($1::uuid, $2::uuid, 'summary-qa@example.test', 'enabled', 'unknown')`, subscriberID, tenantID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	for _, text := range []string{"First summary", "Updated summary"} {
		if err := upsertCache(ctx, tx, tenantID, subscriberID, "same-signals", text, []Driver{{Key: "consent", Value: "unknown"}}, "deterministic", now); err != nil {
			t.Fatal(err)
		}
		cached, hit, err := loadCache(ctx, tx, tenantID, subscriberID, "same-signals")
		if err != nil || !hit || cached == nil {
			t.Fatalf("load cache: hit=%v err=%v", hit, err)
		}
		if cached.Summary != text || !cached.LastUpdated.Equal(now) {
			t.Fatalf("cache round trip: %+v", cached)
		}
		var expires time.Time
		if err := tx.QueryRow(ctx, `SELECT expires_at FROM ai_profile_summary_cache WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID).Scan(&expires); err != nil {
			t.Fatal(err)
		}
		if !expires.Equal(now.Add(24 * time.Hour)) {
			t.Fatalf("expiry = %s", expires)
		}
	}
}
