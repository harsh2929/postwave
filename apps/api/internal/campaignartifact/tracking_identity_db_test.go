// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestTrackingSettingsChangeCreatesANewRestrictedRoleRevision_DB(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_ASSURANCE_TEST_DATABASE_URL and POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// The admin connection is fixture-only. The app connection deliberately
	// stays on db.New so an RLS-bypass role fails the runtime proof.
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	var ready bool
	if err := admin.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'campaign_content_revisions'
     AND column_name = 'tracking_settings'
)`).Scan(&ready); err != nil || !ready {
		t.Fatalf("migration 1936 is unavailable: ready=%v err=%v", ready, err)
	}

	tenantID, campaignID := uuid.NewString(), uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:14]
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_, _ = admin.Exec(cleanup, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Tracking identity proof', 'studio')`, tenantID, "tracking-identity-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO campaigns (
  id, tenant_id, name, subject, status, body_html, plain_text,
  content_blocks, source_mode, content_schema_version, fact_contract,
  tracking_settings
)
VALUES (
  $1::uuid, $2::uuid, 'Tracking identity', 'Launch', 'draft',
  '<h1>Launch</h1>', 'Launch', $3::jsonb, 'semantic', 2, '{}'::jsonb,
  '{"utm_source":"first"}'::jsonb
)`, campaignID, tenantID, []byte(headingPatchTree(t))); err != nil {
		t.Fatal(err)
	}

	repo := NewRepo(app)
	first, err := repo.FreezeCurrent(ctx, tenantID, campaignID, "")
	if err != nil {
		t.Fatalf("first restricted-role freeze: %v", err)
	}
	if trackingUTMSource(t, first.TrackingSettings) != "first" {
		t.Fatalf("first tracking settings=%s", first.TrackingSettings)
	}
	if _, err := admin.Exec(ctx, `
UPDATE campaigns
   SET tracking_settings = '{"utm_source":"second"}'::jsonb,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID); err != nil {
		t.Fatal(err)
	}
	second, err := repo.FreezeCurrent(ctx, tenantID, campaignID, "")
	if err != nil {
		t.Fatalf("second restricted-role freeze: %v", err)
	}
	if second.ID == first.ID || second.SourceHash == first.SourceHash ||
		second.RevisionNo != first.RevisionNo+1 ||
		trackingUTMSource(t, second.TrackingSettings) != "second" {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
	replayed, err := repo.FreezeCurrent(ctx, tenantID, campaignID, "")
	if err != nil || replayed.ID != second.ID || replayed.SourceHash != second.SourceHash {
		t.Fatalf("content-addressed replay=%+v err=%v", replayed, err)
	}
}

func trackingUTMSource(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var settings struct {
		UTMSource string `json:"utm_source"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("decode tracking settings %q: %v", raw, err)
	}
	return settings.UTMSource
}
