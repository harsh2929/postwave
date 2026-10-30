// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

type fakePreparationArtifacts struct {
	revision      campaignartifact.Revision
	plan          campaignartifact.Plan
	freezeCalls   int
	getCalls      int
	createCalls   int
	finalizeCalls int
	planInput     campaignartifact.PlanInput
	artifacts     []campaignartifact.ArtifactInput
}

func (f *fakePreparationArtifacts) FreezeCurrent(
	context.Context, string, string, string,
) (*campaignartifact.Revision, error) {
	f.freezeCalls++
	copy := f.revision
	return &copy, nil
}

func (f *fakePreparationArtifacts) GetRevision(
	context.Context, string, string, string,
) (*campaignartifact.Revision, error) {
	f.getCalls++
	copy := f.revision
	return &copy, nil
}

func (f *fakePreparationArtifacts) CreatePlan(
	_ context.Context,
	tenantID string,
	input campaignartifact.PlanInput,
) (*campaignartifact.Plan, error) {
	f.createCalls++
	f.planInput = input
	copy := f.plan
	copy.TenantID = tenantID
	copy.CampaignID = input.CampaignID
	copy.ContentRevisionID = input.ContentRevisionID
	copy.RendererVersion = input.RendererVersion
	copy.CompilerVersion = input.CompilerVersion
	copy.TransformManifest = append(json.RawMessage(nil), input.TransformManifest...)
	copy.CoverageManifest = append(json.RawMessage(nil), input.CoverageManifest...)
	copy.FixtureSetVersion = input.FixtureSetVersion
	copy.PolicyVersion = input.PolicyVersion
	return &copy, nil
}

func (f *fakePreparationArtifacts) FinalizePlan(
	_ context.Context,
	_, _ string,
	artifacts []campaignartifact.ArtifactInput,
) (*campaignartifact.Plan, error) {
	f.finalizeCalls++
	f.artifacts = append([]campaignartifact.ArtifactInput(nil), artifacts...)
	copy := f.plan
	copy.TenantID = f.revision.TenantID
	copy.CampaignID = f.revision.CampaignID
	copy.ContentRevisionID = f.revision.ID
	copy.State = campaignartifact.PlanReady
	return &copy, nil
}

func TestCurrentSnapshotPreparerFreezesCompilesAndFinalizesExactScenarioSet(t *testing.T) {
	t.Parallel()
	revision := semanticPreparationRevision(t)
	store := &fakePreparationArtifacts{
		revision: revision,
		plan: campaignartifact.Plan{
			ID: testPlanID, State: campaignartifact.PlanPreparing,
			CreatedAt: time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC),
		},
	}
	preparer := NewCurrentSnapshotPreparer(store, uploads.NewMemoryStore())
	prepared, err := preparer.PrepareAssuranceSnapshot(context.Background(), PrepareSnapshotCommand{
		TenantID: testTenantID, CampaignID: testCampaignID,
		RequestID: testRequestID, ActorID: testActorID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if prepared != (PreparedSnapshot{ContentRevisionID: testRevisionID, SendPlanID: testPlanID}) ||
		store.freezeCalls != 1 || store.getCalls != 0 || store.createCalls != 1 || store.finalizeCalls != 1 {
		t.Fatalf("prepared=%+v store=%+v", prepared, store)
	}
	if store.planInput.RequestID != testRequestID || store.planInput.CreatedBy != testActorID ||
		store.planInput.ContentRevisionID != testRevisionID ||
		!strings.Contains(string(store.planInput.TransformManifest), `"tracking_settings":{"utm_source":"assurance"}`) {
		t.Fatalf("plan input=%+v", store.planInput)
	}
	if len(store.artifacts) != 1 || store.artifacts[0].SourceHash != revision.SourceHash ||
		store.artifacts[0].MIMEObjectRef == "" || store.artifacts[0].ExpiresAt == nil ||
		!store.artifacts[0].ExpiresAt.Equal(store.plan.CreatedAt.Add(defaultSyntheticArtifactTTL)) {
		t.Fatalf("artifacts=%+v", store.artifacts)
	}
}

func TestCurrentSnapshotPreparerCanUseExactRevisionAndReplayReadyPlan(t *testing.T) {
	t.Parallel()
	revision := semanticPreparationRevision(t)
	store := &fakePreparationArtifacts{
		revision: revision,
		plan: campaignartifact.Plan{
			ID: testPlanID, State: campaignartifact.PlanReady,
			CreatedAt: time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC),
		},
	}
	preparer := NewCurrentSnapshotPreparer(store, uploads.NewMemoryStore())
	prepared, err := preparer.PrepareAssuranceSnapshot(context.Background(), PrepareSnapshotCommand{
		TenantID: testTenantID, CampaignID: testCampaignID,
		ContentRevisionID: testRevisionID, RequestID: testRequestID, ActorID: testActorID,
	})
	if err != nil || prepared.SendPlanID != testPlanID || store.freezeCalls != 0 ||
		store.getCalls != 1 || store.finalizeCalls != 0 {
		t.Fatalf("prepared=%+v err=%v store=%+v", prepared, err, store)
	}
}

func TestCurrentSnapshotPreparerRejectsUnsupportedSourceAndUnsafeTTL(t *testing.T) {
	t.Parallel()
	legacy := semanticPreparationRevision(t)
	legacy.SourceMode = campaignartifact.SourceModeLegacyHTML
	store := &fakePreparationArtifacts{
		revision: legacy,
		plan:     campaignartifact.Plan{ID: testPlanID, State: campaignartifact.PlanPreparing, CreatedAt: time.Now().UTC()},
	}
	preparer := NewCurrentSnapshotPreparer(store, uploads.NewMemoryStore())
	_, err := preparer.PrepareAssuranceSnapshot(context.Background(), PrepareSnapshotCommand{
		TenantID: testTenantID, CampaignID: testCampaignID,
		RequestID: testRequestID, ActorID: testActorID,
	})
	if !errors.Is(err, ErrSnapshotUnsupported) || store.createCalls != 0 {
		t.Fatalf("legacy err=%v create_calls=%d", err, store.createCalls)
	}

	store.revision = semanticPreparationRevision(t)
	preparer.ArtifactTTL = time.Hour
	_, err = preparer.PrepareAssuranceSnapshot(context.Background(), PrepareSnapshotCommand{
		TenantID: testTenantID, CampaignID: testCampaignID,
		RequestID: testRequestID, ActorID: testActorID,
	})
	if !errors.Is(err, ErrPreparationUnavailable) {
		t.Fatalf("unsafe TTL err=%v", err)
	}
}

func semanticPreparationRevision(t *testing.T) campaignartifact.Revision {
	t.Helper()
	nodes := []semanticemail.Node{
		{
			ID: "heading", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
				Level: 1, Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Assurance fixture"}}},
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
		{
			ID: "primary_action", Type: semanticemail.NodeAction, Role: semanticemail.RolePrimaryAction,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Action: &semanticemail.ActionContent{
				ActionID: "continue", Label: "Continue", CanonicalURL: "https://example.test/continue",
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
	}
	tree, err := json.Marshal(nodes)
	if err != nil {
		t.Fatal(err)
	}
	return campaignartifact.Revision{
		ID: testRevisionID, TenantID: testTenantID, CampaignID: testCampaignID,
		RevisionNo: 1, SourceMode: campaignartifact.SourceModeSemantic,
		ContentSchemaVersion: semanticemail.SchemaVersionV2, Subject: "Assurance fixture",
		SemanticTree: tree, FactContract: json.RawMessage(`{}`), Variants: json.RawMessage(`[]`),
		Locales: json.RawMessage(`["en-US"]`), TrackingSettings: json.RawMessage(`{"utm_source":"assurance"}`),
		SourceHash: strings.Repeat("a", 64), CreatedAt: time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC),
	}
}
