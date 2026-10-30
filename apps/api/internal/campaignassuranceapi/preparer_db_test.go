// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

func TestCurrentSnapshotPreparationAndRunCreationRestrictedRole_DB(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_ASSURANCE_TEST_DATABASE_URL and POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	// Seed and cleanup through a raw fixture-only admin pool. The runtime pool
	// below still goes through db.New and therefore rejects privileged roles.
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

	tenantID, campaignID, actorID, requestID :=
		uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:14]
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_, _ = admin.Exec(cleanup, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Assurance preparation proof', 'studio')`,
		tenantID, "assurance-prepare-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'editor')`,
		actorID, tenantID, "assurance-prepare-"+suffix, "prepare-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	semantic := semanticPreparationRevision(t)
	if _, err := admin.Exec(ctx, `
INSERT INTO campaigns (
  id, tenant_id, name, subject, status, body_html, plain_text,
  content_blocks, source_mode, content_schema_version, fact_contract,
  tracking_settings, delivery_settings
)
VALUES (
  $1::uuid, $2::uuid, 'Prepared assurance', 'Assurance fixture', 'draft',
  '<h1>Assurance fixture</h1>', 'Assurance fixture', $3::jsonb,
  'semantic', 2, '{}'::jsonb, '{"utm_source":"current-control"}'::jsonb,
  '{"locales":["en-US"]}'::jsonb
)`, campaignID, tenantID, []byte(semantic.SemanticTree)); err != nil {
		t.Fatal(err)
	}

	artifacts := campaignartifact.NewRepo(app)
	preparer := NewCurrentSnapshotPreparer(artifacts, uploads.NewMemoryStore())
	command := PrepareSnapshotCommand{
		TenantID: tenantID, CampaignID: campaignID,
		RequestID: requestID, ActorID: actorID,
	}
	prepared, err := preparer.PrepareAssuranceSnapshot(ctx, command)
	if err != nil {
		t.Fatalf("prepare exact current snapshot: %v", err)
	}
	replayed, err := preparer.PrepareAssuranceSnapshot(ctx, command)
	if err != nil || replayed != prepared {
		t.Fatalf("prepare replay=%+v original=%+v err=%v", replayed, prepared, err)
	}
	plan, err := artifacts.GetPlan(ctx, tenantID, campaignID, prepared.SendPlanID)
	if err != nil || plan.State != campaignartifact.PlanReady ||
		transformTrackingUTMSource(t, plan.TransformManifest) != "current-control" {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
	storedArtifacts, err := artifacts.ListArtifacts(ctx, tenantID, campaignID, prepared.SendPlanID)
	if err != nil || len(storedArtifacts) != 1 || storedArtifacts[0].MIMEObjectRef == "" {
		t.Fatalf("artifacts=%+v err=%v", storedArtifacts, err)
	}

	scheduler := &fakeScheduler{}
	service, err := NewService(campaignassurance.NewRepo(app), testSuiteRegistry(t), scheduler)
	if err != nil {
		t.Fatal(err)
	}
	start := StartRunCommand{
		TenantID: tenantID, CampaignID: campaignID,
		ContentRevisionID: prepared.ContentRevisionID, SendPlanID: prepared.SendPlanID,
		RequestID: requestID, Profile: campaignassurance.ProfileFast, ActorID: actorID,
	}
	run, sources, err := service.StartRun(ctx, start)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	replayedRun, replayedSources, err := service.StartRun(ctx, start)
	if err != nil || replayedRun.ID != run.ID || run.State != campaignassurance.StateQueued ||
		len(sources) != 1 || sources[0] != campaignassurance.SourceDeterministic ||
		len(replayedSources) != 1 || len(scheduler.commands) != 2 ||
		scheduler.commands[0] != scheduler.commands[1] {
		t.Fatalf("run=%+v replay=%+v sources=%v/%v commands=%+v err=%v",
			run, replayedRun, sources, replayedSources, scheduler.commands, err)
	}
}

func transformTrackingUTMSource(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var manifest struct {
		TrackingSettings struct {
			UTMSource string `json:"utm_source"`
		} `json:"tracking_settings"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode transform manifest %q: %v", raw, err)
	}
	return manifest.TrackingSettings.UTMSource
}
