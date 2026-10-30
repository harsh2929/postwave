// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// This exercises a real downloaded free export and the canonical database sink.
// It does not make an Amplitude API call or certify the paid cohort API.
func TestAmplitudeFreeCSVCanonicalMapping_DB(t *testing.T) {
	if !livecert.Bool("ANALYTICS_FREE_CSV_DB") {
		t.Skip("ANALYTICS_FREE_CSV_DB=1 not set")
	}
	databaseURL := livecert.Env("ANALYTICS_LIVE_LIFECYCLE_DATABASE_URL")
	if !analyticsLifecycleDatabaseAllowed(databaseURL) {
		t.Fatal("CSV proof requires an explicit loopback postwave_local_qa_* database")
	}
	t.Setenv("DATABASE_MAX_CONNS", "4")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'Disposable analytics CSV QA', 'analytics-csv-' || $1::text, 'studio')`, tenantID)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cleanupCancel()
		tx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID); err != nil {
			t.Error(err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Error(err)
		}
	})
	body, err := os.ReadFile("testdata/amplitude-free-cohort.csv")
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := parseAmplitudeCohortCSV(body)
	if err != nil || len(profiles) != 1 {
		t.Fatalf("free export parse count=%d error=%v", len(profiles), err)
	}
	sink := SubscriberProfileSink{Repo: &subscribers.Repo{Pool: pool, CustomFields: &customfields.Validator{Repo: &customfields.Repo{Pool: pool}, Mode: customfields.ModeAuto}}}
	profile := profiles[0]
	id, err := sink.UpsertAnalyticsProfile(ctx, tenantID, ProviderAmplitude, profile)
	if err != nil {
		t.Fatal(err)
	}
	read := func() (string, int, map[string]any) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var status, source string
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT status, source_platform, custom_fields FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id).Scan(&status, &source, &raw); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid`, tenantID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		var traits map[string]any
		if err := json.Unmarshal(raw, &traits); err != nil || source != ProviderAmplitude {
			t.Fatal("CSV profile lost provenance or valid properties")
		}
		return status, count, traits
	}
	status, count, traits := read()
	rawTraits, _ := traits["_analytics_traits"].(map[string]any)
	if status != subscribers.StatusUnconfirmed || count != 1 || rawTraits["gp:qa_fixture"] != "True" || traits["library"] != "http/2.0" || traits["analytics_user_id"] != profile.UserID || traits["analytics_anonymous_id"] != profile.AnonymousID {
		t.Fatal("CSV sink lost identity/properties or invented marketing consent")
	}
	recorder := &livecert.Recorder{Provider: ProviderAmplitude, ReportPath: livecert.Env("ANALYTICS_LIVE_LIFECYCLE_REPORT")}
	if err := recorder.Record("automated_free_csv_canonical_mapping", map[string]any{"artifact": "free_ui_export", "profiles": count, "properties_preserved": true, "canonical_status": status, "native_api_exercised": false}); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE subscribers SET status='blocklisted' WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	replayedID, err := sink.UpsertAnalyticsProfile(ctx, tenantID, ProviderAmplitude, profile)
	if err != nil || replayedID != id {
		t.Fatalf("CSV replay duplicated identity: error=%v", err)
	}
	status, count, _ = read()
	if status != subscribers.StatusBlocklisted || count != 1 {
		t.Fatal("CSV replay duplicated the subscriber or replaced their opt-out")
	}
	if err := recorder.Record("automated_free_csv_replay_preserves_opt_out", map[string]any{"profiles": count, "same_subscriber_id": true, "canonical_status": status, "native_api_exercised": false}); err != nil {
		t.Fatal(err)
	}
}
