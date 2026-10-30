// SPDX-License-Identifier: AGPL-3.0-only

package campaignmaterializer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
)

const (
	testTenantID   = "00000000-0000-4000-8000-000000000001"
	testCampaignID = "00000000-0000-4000-8000-000000000002"
	testPlanID     = "00000000-0000-4000-8000-000000000003"
)

type storedCall struct {
	rest, contentType string
	body              []byte
}

type fakeObjectStore struct {
	puts      []storedCall
	deletes   []string
	failPutAt int
	deleteErr error
}

func (f *fakeObjectStore) Put(_ context.Context, _ string, rest, contentType string, body io.Reader) (string, error) {
	value, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	if f.failPutAt > 0 && len(f.puts)+1 == f.failPutAt {
		return "", errors.New("object write failed")
	}
	f.puts = append(f.puts, storedCall{rest: rest, contentType: contentType, body: value})
	return "tenants/fixture/" + rest, nil
}

func (f *fakeObjectStore) Delete(_ context.Context, _ string, rest string) error {
	f.deletes = append(f.deletes, rest)
	return f.deleteErr
}

type fakeFinalizer struct {
	artifacts []campaignartifact.ArtifactInput
	err       error
	plan      *campaignartifact.Plan
}

func (f *fakeFinalizer) FinalizePlan(_ context.Context, _, _ string, artifacts []campaignartifact.ArtifactInput) (*campaignartifact.Plan, error) {
	f.artifacts = cloneArtifacts(artifacts)
	return f.plan, f.err
}

func TestFinalizeSyntheticPlanPersistsExactBytesAndFinalizes(t *testing.T) {
	t.Parallel()
	compiled := compileFixture(t, "scenario-a")
	objects := &fakeObjectStore{}
	finalizer := &fakeFinalizer{plan: readyPlan()}
	materializer := &Materializer{Objects: objects, Finalizer: finalizer}
	expires := time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC)

	result, err := materializer.FinalizeSyntheticPlan(context.Background(), Input{
		TenantID: testTenantID, CampaignID: testCampaignID, PlanID: testPlanID,
		SyntheticFixture: true, ExpiresAt: expires, Compiled: []campaigncompiler.Result{compiled},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Plan.ID != testPlanID || len(result.Artifacts) != 1 || len(finalizer.artifacts) != 1 {
		t.Fatalf("result = %+v", result)
	}
	if len(objects.puts) != 3 || len(objects.deletes) != 0 {
		t.Fatalf("object operations: puts=%d deletes=%v", len(objects.puts), objects.deletes)
	}
	wantBodies := map[string][]byte{
		"text/html; charset=utf-8":  []byte(compiled.HTML),
		"text/plain; charset=utf-8": []byte(compiled.Text),
		"message/rfc822":            compiled.RFC822,
	}
	for _, call := range objects.puts {
		if string(call.body) != string(wantBodies[call.contentType]) {
			t.Fatalf("stored %s bytes differ from compiler output", call.contentType)
		}
		if !strings.Contains(call.rest, testPlanID) || !strings.Contains(call.rest, digest(call.body)) {
			t.Fatalf("content-addressed key = %q", call.rest)
		}
	}
	artifact := result.Artifacts[0]
	for _, reference := range []string{artifact.HTMLObjectRef, artifact.TextObjectRef, artifact.MIMEObjectRef} {
		if _, err := ParseObjectReference(reference); err != nil {
			t.Fatalf("object reference %q: %v", reference, err)
		}
	}
	if artifact.ExpiresAt == nil || !artifact.ExpiresAt.Equal(expires) {
		t.Fatalf("expires_at = %v, want %s", artifact.ExpiresAt, expires)
	}
}

func TestFinalizeSyntheticPlanRollsBackOnlyPreDatabaseFailures(t *testing.T) {
	t.Parallel()
	compiled := compileFixture(t, "scenario-a")

	objects := &fakeObjectStore{failPutAt: 2}
	finalizer := &fakeFinalizer{plan: readyPlan()}
	_, err := (&Materializer{Objects: objects, Finalizer: finalizer}).FinalizeSyntheticPlan(context.Background(), validInput(compiled))
	if err == nil || len(objects.puts) != 1 || len(objects.deletes) != 2 || len(finalizer.artifacts) != 0 {
		t.Fatalf("pre-DB failure err=%v puts=%d deletes=%v finalized=%d", err, len(objects.puts), objects.deletes, len(finalizer.artifacts))
	}

	objects = &fakeObjectStore{}
	finalizer = &fakeFinalizer{err: errors.New("commit response lost")}
	_, err = (&Materializer{Objects: objects, Finalizer: finalizer}).FinalizeSyntheticPlan(context.Background(), validInput(compiled))
	if err == nil || len(objects.puts) != 3 || len(objects.deletes) != 0 {
		t.Fatalf("ambiguous DB failure err=%v puts=%d deletes=%v", err, len(objects.puts), objects.deletes)
	}
}

func TestFinalizeSyntheticPlanRejectsTamperingAndRealRecipientModeBeforeWrites(t *testing.T) {
	t.Parallel()
	compiled := compileFixture(t, "scenario-a")
	objects := &fakeObjectStore{}
	finalizer := &fakeFinalizer{plan: readyPlan()}
	materializer := &Materializer{Objects: objects, Finalizer: finalizer}

	input := validInput(compiled)
	input.SyntheticFixture = false
	if _, err := materializer.FinalizeSyntheticPlan(context.Background(), input); !errors.Is(err, ErrSyntheticRequired) {
		t.Fatalf("non-synthetic error = %v", err)
	}

	input = validInput(compiled)
	input.Compiled[0].HTML += "tampered"
	if _, err := materializer.FinalizeSyntheticPlan(context.Background(), input); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("tamper error = %v", err)
	}
	if len(objects.puts) != 0 || len(finalizer.artifacts) != 0 {
		t.Fatal("invalid compiler result caused external writes")
	}

	input = validInput(compiled)
	input.Compiled[0].Artifact.CompilerReceipt = json.RawMessage(`{}`)
	if _, err := materializer.FinalizeSyntheticPlan(context.Background(), input); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("receipt tamper error = %v", err)
	}

	input = validInput(compiled)
	input.Compiled[0].Artifact.RepresentationManifest = json.RawMessage(`{}`)
	if _, err := materializer.FinalizeSyntheticPlan(context.Background(), input); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("representation tamper error = %v", err)
	}
	if len(objects.puts) != 0 || len(finalizer.artifacts) != 0 {
		t.Fatal("receipt/manifest tampering caused external writes")
	}
}

func TestFinalizeSyntheticPlanRejectsDuplicateScenarios(t *testing.T) {
	t.Parallel()
	compiled := compileFixture(t, "scenario-a")
	input := validInput(compiled)
	input.Compiled = append(input.Compiled, compiled)
	objects := &fakeObjectStore{}
	_, err := (&Materializer{Objects: objects, Finalizer: &fakeFinalizer{plan: readyPlan()}}).
		FinalizeSyntheticPlan(context.Background(), input)
	if !errors.Is(err, ErrInvalidInput) || len(objects.puts) != 0 {
		t.Fatalf("duplicate scenario error=%v puts=%d", err, len(objects.puts))
	}
}

func TestParseObjectReferenceRejectsURLsAndTraversal(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"https://bucket.example/object",
		ObjectReferenceVersion + ":../secret",
		ObjectReferenceVersion + ":/absolute",
		ObjectReferenceVersion + ":safe\nunsafe",
	} {
		if _, err := ParseObjectReference(value); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("ParseObjectReference(%q) error = %v", value, err)
		}
	}
}

func compileFixture(t *testing.T, scenarioID string) campaigncompiler.Result {
	t.Helper()
	html := `<html><body><h1>Fixture campaign</h1><a href="https://example.test/go">Go</a></body></html>`
	plain := "Fixture campaign\n\nGo: https://example.test/go\n"
	result, err := campaigncompiler.Compile(campaigncompiler.Input{
		Revision: campaignartifact.Revision{
			ID: "00000000-0000-4000-8000-000000000010", CampaignID: testCampaignID,
			SourceMode: campaignartifact.SourceModeLegacyHTML, ContentSchemaVersion: 1,
			Subject: "Fixture campaign", LegacyHTML: &html, ReviewedPlainText: &plain,
			SemanticTree: json.RawMessage(`[]`), FactContract: json.RawMessage(`{}`),
			SourceHash: strings.Repeat("a", 64),
		},
		Scenario:         campaigncompiler.Scenario{ID: scenarioID, Locale: "en-US", FixtureID: "synthetic-a"},
		TrackingSettings: json.RawMessage(`{}`),
		Envelope: campaigncompiler.Envelope{
			From:      mail.Address{Name: "Moosewave", Address: "news@example.test"},
			To:        []mail.Address{{Name: "Synthetic Fixture", Address: "fixture@example.test"}},
			Date:      time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
			MessageID: "<fixture@example.test>", Boundary: "postwave-materializer-fixture",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func validInput(compiled campaigncompiler.Result) Input {
	return Input{
		TenantID: testTenantID, CampaignID: testCampaignID, PlanID: testPlanID,
		SyntheticFixture: true,
		ExpiresAt:        time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC),
		Compiled:         []campaigncompiler.Result{compiled},
	}
}

func readyPlan() *campaignartifact.Plan {
	return &campaignartifact.Plan{ID: testPlanID, CampaignID: testCampaignID, State: campaignartifact.PlanReady}
}
