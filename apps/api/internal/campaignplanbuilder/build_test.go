// SPDX-License-Identifier: AGPL-3.0-only

package campaignplanbuilder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/mail"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	testTenantID   = "00000000-0000-4000-8000-000000000001"
	testCampaignID = "00000000-0000-4000-8000-000000000002"
	testRevisionID = "00000000-0000-4000-8000-000000000003"
	testPlanID     = "00000000-0000-4000-8000-000000000004"
)

func TestCompileSyntheticCoverageBindsEveryControlScenario(t *testing.T) {
	t.Parallel()
	input := validCompileInput(t)
	bundle, err := CompileSyntheticCoverage(input)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.BuilderVersion != Version || bundle.VariantAdapter != ReviewedVariantAdapterVersion ||
		bundle.LocaleAdapter != FrozenLocaleAdapterVersion {
		t.Fatalf("bundle implementation identity = %+v", bundle)
	}
	if len(bundle.Compiled) != len(bundle.Manifest.Scenarios) || len(bundle.Compiled) == 0 {
		t.Fatalf("compiled/required scenarios = %d/%d", len(bundle.Compiled), len(bundle.Manifest.Scenarios))
	}
	for index, compiled := range bundle.Compiled {
		scenario := bundle.Manifest.Scenarios[index]
		if compiled.Artifact.ScenarioID != scenario.ID || compiled.Artifact.VariantID != "" ||
			compiled.Artifact.Locale != scenario.Locale || compiled.Artifact.BranchKey != scenario.BranchKey ||
			compiled.Artifact.FixtureID != scenario.FixtureID {
			t.Fatalf("artifact %d drifted from manifest scenario\nartifact=%+v\nscenario=%+v", index, compiled.Artifact, scenario)
		}
		if compiled.Receipt.SemanticDocumentSHA256 == "" || compiled.Receipt.SemanticDocumentSHA256 != bundle.Manifest.Variants[0].DocumentHash {
			t.Fatalf("compiler document receipt = %q, want %q", compiled.Receipt.SemanticDocumentSHA256, bundle.Manifest.Variants[0].DocumentHash)
		}
	}
	if err := ValidateCompiledSet(bundle.Manifest, bundle.Compiled); err != nil {
		t.Fatal(err)
	}
	planInput, err := bundle.PlanInput("00000000-0000-4000-8000-000000000099", "00000000-0000-4000-8000-000000000098")
	if err != nil {
		t.Fatal(err)
	}
	if planInput.CampaignID != bundle.CampaignID || planInput.ContentRevisionID != bundle.RevisionID ||
		planInput.CompilerVersion != bundle.CompilerVersion || planInput.RendererVersion != bundle.RendererVersion ||
		!bytes.Equal(planInput.CoverageManifest, bundle.CoverageManifest) || !bytes.Equal(planInput.TransformManifest, bundle.TransformManifest) {
		t.Fatalf("plan input drifted from bundle: %+v", planInput)
	}
	if _, err := bundle.PlanInput("not-a-request", "not-an-actor"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid plan identities error = %v", err)
	}
	encoded, err := bundle.Manifest.JSON()
	if err != nil || !bytes.Equal(encoded, bundle.CoverageManifest) {
		t.Fatalf("coverage JSON mismatch: err=%v", err)
	}
}

func TestCompileSyntheticCoverageUsesReviewedVariantDocumentsAndSubjects(t *testing.T) {
	t.Parallel()
	input := validCompileInput(t)
	entries := []reviewedSemanticVariantV1{
		reviewedEntry("00000000-0000-4000-8000-000000000012", "Subject B", testDocument("Variant B")),
		reviewedEntry("00000000-0000-4000-8000-000000000011", "Subject A", testDocument("Variant A")),
	}
	input.Revision.Variants = mustJSON(t, entries)
	bundle, err := CompileSyntheticCoverage(input)
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{bundle.Manifest.Variants[0].ID, bundle.Manifest.Variants[1].ID}; !slices.Equal(got, []string{entries[1].ID, entries[0].ID}) {
		t.Fatalf("canonical variant order = %v", got)
	}
	wantSubject := map[string]string{entries[0].ID: entries[0].Subject, entries[1].ID: entries[1].Subject}
	wantHeading := map[string]string{entries[0].ID: "Variant B", entries[1].ID: "Variant A"}
	documentHash := map[string]string{}
	for _, variant := range bundle.Manifest.Variants {
		documentHash[variant.ID] = variant.DocumentHash
	}
	for _, compiled := range bundle.Compiled {
		variantID := compiled.Artifact.VariantID
		if compiled.Subject != wantSubject[variantID] {
			t.Fatalf("variant %s subject = %q, want %q", variantID, compiled.Subject, wantSubject[variantID])
		}
		if compiled.Receipt.SemanticDocumentSHA256 != documentHash[variantID] {
			t.Fatalf("variant %s document hash = %q, want %q", variantID, compiled.Receipt.SemanticDocumentSHA256, documentHash[variantID])
		}
		if !strings.Contains(compiled.HTML, wantHeading[variantID]) || strings.Contains(compiled.HTML, ">Base<") {
			t.Fatalf("variant %s rendered the base revision instead of its reviewed document: %s", variantID, compiled.HTML)
		}
	}
}

func TestCompileSyntheticCoverageRejectsNondeterministicOrRealRecipientEnvelopes(t *testing.T) {
	t.Parallel()
	t.Run("nondeterministic", func(t *testing.T) {
		input := validCompileInput(t)
		calls := 0
		input.EnvelopeFactory = func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
			calls++
			envelope := deterministicEnvelope(scenario)
			envelope.MessageID = fmt.Sprintf("<call-%d@example.test>", calls)
			return envelope, nil
		}
		if _, err := CompileSyntheticCoverage(input); !errors.Is(err, ErrCompile) || !strings.Contains(err.Error(), "different wire metadata") {
			t.Fatalf("error = %v, want deterministic-envelope failure", err)
		}
	})
	t.Run("real recipient", func(t *testing.T) {
		input := validCompileInput(t)
		input.EnvelopeFactory = func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
			envelope := deterministicEnvelope(scenario)
			envelope.To = []mail.Address{{Address: "person@customer-company.com"}}
			return envelope, nil
		}
		if _, err := CompileSyntheticCoverage(input); !errors.Is(err, ErrCompile) || !strings.Contains(err.Error(), "RFC 2606") {
			t.Fatalf("error = %v, want synthetic-recipient failure", err)
		}
	})
}

func TestCompileSyntheticCoverageIsDeterministicAndDefendsFactorySlots(t *testing.T) {
	t.Parallel()
	input := validCompileInput(t)
	first, err := CompileSyntheticCoverage(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := CompileSyntheticCoverage(input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("identical frozen input did not produce an identical bundle")
	}

	input.EnvelopeFactory = func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
		for slotID := range scenario.Slots {
			scenario.Slots[slotID] = "factory attempted mutation"
		}
		return deterministicEnvelope(scenario), nil
	}
	mutatingFactory, err := CompileSyntheticCoverage(input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, mutatingFactory) {
		t.Fatal("envelope factory mutated compiler-owned synthetic fixture slots")
	}
}

func TestStrictFrozenAdaptersRejectLegacyAmbiguityAndLocaleDrift(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*CompileInput)
		want   error
	}{
		{
			name: "historical HTML variant shape",
			mutate: func(input *CompileInput) {
				input.Revision.Variants = json.RawMessage(`[{"id":"00000000-0000-4000-8000-000000000011","variant_label":"A","subject":"A","body_html":"<p>A</p>"}]`)
			},
			want: ErrVariantAdapter,
		},
		{
			name: "unknown nested semantic field",
			mutate: func(input *CompileInput) {
				entry := reviewedEntry("00000000-0000-4000-8000-000000000011", "A", testDocument("A"))
				raw := mustJSON(t, []reviewedSemanticVariantV1{entry})
				raw = bytes.Replace(raw, []byte(`"schema_version":2`), []byte(`"schema_version":2,"unknown":true`), 1)
				input.Revision.Variants = raw
			},
			want: ErrVariantAdapter,
		},
		{
			name: "non-normalized reviewed document",
			mutate: func(input *CompileInput) {
				entry := reviewedEntry("00000000-0000-4000-8000-000000000011", "A", testDocument("A"))
				entry.Document.Language = "EN-us"
				input.Revision.Variants = mustJSON(t, []reviewedSemanticVariantV1{entry})
			},
			want: ErrVariantAdapter,
		},
		{
			name: "non UUID variant identity",
			mutate: func(input *CompileInput) {
				entry := reviewedEntry("variant-a", "A", testDocument("A"))
				input.Revision.Variants = mustJSON(t, []reviewedSemanticVariantV1{entry})
			},
			want: ErrVariantAdapter,
		},
		{
			name:   "canonical locale duplicate",
			mutate: func(input *CompileInput) { input.Revision.Locales = json.RawMessage(`["en-US","EN-us"]`) },
			want:   ErrLocaleAdapter,
		},
		{
			name:   "locale trailing JSON",
			mutate: func(input *CompileInput) { input.Revision.Locales = json.RawMessage(`["en-US"] true`) },
			want:   ErrLocaleAdapter,
		},
		{
			name:   "legacy source",
			mutate: func(input *CompileInput) { input.Revision.SourceMode = campaignartifact.SourceModeLegacyHTML },
			want:   ErrInvalidInput,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			input := validCompileInput(t)
			test.mutate(&input)
			if _, err := CompileSyntheticCoverage(input); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want errors.Is(%v)", err, test.want)
			}
		})
	}
}

func TestCompileSyntheticCoverageFailsOnUncoveredCriticalBranch(t *testing.T) {
	t.Parallel()
	input := validCompileInput(t)
	nodes := decodeNodes(t, input.Revision.SemanticTree)
	nodes[1].Conditions = append(nodes[1].Conditions, semanticemail.Condition{
		ID: "segment_basic", SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "basic",
	})
	input.Revision.SemanticTree = mustJSON(t, nodes)
	if _, err := CompileSyntheticCoverage(input); !errors.Is(err, ErrCoverage) ||
		!strings.Contains(err.Error(), string(campaigncoverage.CodeCriticalBranchDead)) {
		t.Fatalf("error = %v, want uncovered critical branch", err)
	}
}

func TestValidateCompiledSetRejectsMissingDuplicateAndDriftedResults(t *testing.T) {
	t.Parallel()
	bundle, err := CompileSyntheticCoverage(validCompileInput(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Compiled) < 2 {
		t.Fatal("fixture requires at least two scenarios")
	}
	tests := []struct {
		name   string
		mutate func([]campaigncompiler.Result) []campaigncompiler.Result
		want   error
	}{
		{name: "missing", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result { return results[:len(results)-1] }, want: ErrCompiledSetMismatch},
		{name: "duplicate", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[1] = results[0]
			return results
		}, want: ErrCompiledSetMismatch},
		{name: "reordered", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[0], results[1] = results[1], results[0]
			return results
		}, want: ErrScenarioDrift},
		{name: "coordinate", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[0].Artifact.BranchKey = "drift"
			return results
		}, want: ErrScenarioDrift},
		{name: "node proof", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[0].Receipt.IncludedNodeIDs = nil
			return results
		}, want: ErrScenarioDrift},
		{name: "document hash", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[0].Receipt.SemanticDocumentSHA256 = strings.Repeat("f", 64)
			return results
		}, want: ErrScenarioDrift},
		{name: "persisted receipt", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[0].Artifact.CompilerReceipt = json.RawMessage(`{}`)
			return results
		}, want: ErrScenarioDrift},
		{name: "persisted representation", mutate: func(results []campaigncompiler.Result) []campaigncompiler.Result {
			results[0].Artifact.RepresentationManifest = json.RawMessage(`{}`)
			return results
		}, want: ErrScenarioDrift},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			results := cloneCompiled(bundle.Compiled)
			results = test.mutate(results)
			if err := ValidateCompiledSet(bundle.Manifest, results); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want errors.Is(%v)", err, test.want)
			}
		})
	}
}

func TestPropertyEveryManifestScenarioHasExactlyOneArtifact(t *testing.T) {
	random := rand.New(rand.NewSource(20260809))
	for iteration := 0; iteration < 12; iteration++ {
		input := validCompileInput(t)
		variantCount := 1 + random.Intn(3)
		entries := make([]reviewedSemanticVariantV1, variantCount)
		for index := range entries {
			id := fmt.Sprintf("00000000-0000-4000-8000-%012d", 100+index)
			entries[index] = reviewedEntry(id, fmt.Sprintf("Subject %d", index), testDocument(fmt.Sprintf("Variant %d", index)))
		}
		random.Shuffle(len(entries), func(left, right int) { entries[left], entries[right] = entries[right], entries[left] })
		input.Revision.Variants = mustJSON(t, entries)
		if iteration%2 == 0 {
			input.Revision.Locales = json.RawMessage(`["fr","en-US"]`)
		}
		bundle, err := CompileSyntheticCoverage(input)
		if err != nil {
			t.Fatalf("iteration %d: %v", iteration, err)
		}
		if err := ValidateCompiledSet(bundle.Manifest, bundle.Compiled); err != nil {
			t.Fatalf("iteration %d: %v", iteration, err)
		}
		seen := make(map[string]int, len(bundle.Compiled))
		for _, result := range bundle.Compiled {
			seen[result.Artifact.ScenarioID]++
		}
		for _, scenario := range bundle.Manifest.Scenarios {
			if seen[scenario.ID] != 1 {
				t.Fatalf("iteration %d scenario %s artifact count = %d", iteration, scenario.ID, seen[scenario.ID])
			}
		}
	}
}

type recordingObjectStore struct {
	puts []storedObject
}

type storedObject struct {
	rest        string
	contentType string
	body        []byte
}

func (s *recordingObjectStore) Put(_ context.Context, _ string, rest, contentType string, body io.Reader) (string, error) {
	value, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	s.puts = append(s.puts, storedObject{rest: rest, contentType: contentType, body: value})
	return "tenant-prefix/" + rest, nil
}

func (s *recordingObjectStore) Delete(context.Context, string, string) error { return nil }

type recordingFinalizer struct {
	plan      campaignartifact.Plan
	artifacts []campaignartifact.ArtifactInput
}

func (f *recordingFinalizer) FinalizePlan(_ context.Context, _, _ string, artifacts []campaignartifact.ArtifactInput) (*campaignartifact.Plan, error) {
	f.artifacts = append([]campaignartifact.ArtifactInput(nil), artifacts...)
	result := f.plan
	result.State = campaignartifact.PlanReady
	return &result, nil
}

func TestFinalizeSyntheticPlanValidatesPlanThenUsesRealMaterializer(t *testing.T) {
	bundle, err := CompileSyntheticCoverage(validCompileInput(t))
	if err != nil {
		t.Fatal(err)
	}
	plan := preparingPlan(bundle)
	// jsonb does not preserve the caller's object member ordering. Model that
	// storage round-trip and prove plan binding compares validated content,
	// rather than brittle source bytes.
	var storedCoverage any
	if err := json.Unmarshal(plan.CoverageManifest, &storedCoverage); err != nil {
		t.Fatal(err)
	}
	plan.CoverageManifest = mustJSON(t, storedCoverage)
	objects := &recordingObjectStore{}
	finalizer := &recordingFinalizer{plan: plan}
	realMaterializer := &campaignmaterializer.Materializer{Objects: objects, Finalizer: finalizer}
	builder := &Builder{Materializer: realMaterializer}
	result, err := builder.FinalizeSyntheticPlan(context.Background(), FinalizeInput{
		TenantID: testTenantID, Plan: plan, Bundle: bundle,
		ExpiresAt: time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Materialized.Plan.State != campaignartifact.PlanReady || len(finalizer.artifacts) != len(bundle.Manifest.Scenarios) {
		t.Fatalf("materialized result = %+v artifacts=%d", result.Materialized.Plan, len(finalizer.artifacts))
	}
	if len(objects.puts) != len(bundle.Compiled)*3 {
		t.Fatalf("stored objects = %d, want %d", len(objects.puts), len(bundle.Compiled)*3)
	}
	seen := make(map[string]bool, len(finalizer.artifacts))
	for _, artifact := range finalizer.artifacts {
		seen[artifact.ScenarioID] = true
		if artifact.HTMLObjectRef == "" || artifact.TextObjectRef == "" || artifact.MIMEObjectRef == "" {
			t.Fatalf("artifact has incomplete object references: %+v", artifact)
		}
	}
	for _, scenario := range bundle.Manifest.Scenarios {
		if !seen[scenario.ID] {
			t.Fatalf("materializer did not receive scenario %s", scenario.ID)
		}
	}

	objects.puts = nil
	if _, err := builder.FinalizeSyntheticPlan(context.Background(), FinalizeInput{
		TenantID: "00000000-0000-4000-8000-000000000099", Plan: plan, Bundle: bundle, ExpiresAt: time.Now().UTC(),
	}); !errors.Is(err, ErrPlanDrift) || len(objects.puts) != 0 {
		t.Fatalf("tenant drift error=%v writes=%d", err, len(objects.puts))
	}

	driftedPlan := plan
	driftedPlan.CoverageManifest = append(json.RawMessage(nil), plan.CoverageManifest...)
	driftedPlan.CoverageManifest[1] = 'x'
	if _, err := builder.FinalizeSyntheticPlan(context.Background(), FinalizeInput{
		TenantID: testTenantID, Plan: driftedPlan, Bundle: bundle, ExpiresAt: time.Now().UTC(),
	}); !errors.Is(err, ErrPlanDrift) || len(objects.puts) != 0 {
		t.Fatalf("plan drift error=%v writes=%d", err, len(objects.puts))
	}

	driftedPlan = plan
	driftedPlan.TransformManifest = json.RawMessage(`{"version":"wrong"}`)
	if _, err := builder.FinalizeSyntheticPlan(context.Background(), FinalizeInput{
		TenantID: testTenantID, Plan: driftedPlan, Bundle: bundle, ExpiresAt: time.Now().UTC(),
	}); !errors.Is(err, ErrPlanDrift) || len(objects.puts) != 0 {
		t.Fatalf("transform-plan drift error=%v writes=%d", err, len(objects.puts))
	}
}

func TestFinalizeSyntheticPlanRejectsTamperedBundleBeforeWrites(t *testing.T) {
	bundle, err := CompileSyntheticCoverage(validCompileInput(t))
	if err != nil {
		t.Fatal(err)
	}
	plan := preparingPlan(bundle)
	objects := &recordingObjectStore{}
	finalizer := &recordingFinalizer{plan: plan}
	builder := &Builder{Materializer: &campaignmaterializer.Materializer{Objects: objects, Finalizer: finalizer}}
	bundle.Compiled = bundle.Compiled[:len(bundle.Compiled)-1]
	if _, err := builder.FinalizeSyntheticPlan(context.Background(), FinalizeInput{
		TenantID: testTenantID, Plan: plan, Bundle: bundle, ExpiresAt: time.Now().UTC(),
	}); !errors.Is(err, ErrCompiledSetMismatch) || len(objects.puts) != 0 || len(finalizer.artifacts) != 0 {
		t.Fatalf("tampered bundle error=%v writes=%d finalized=%d", err, len(objects.puts), len(finalizer.artifacts))
	}

	bundle, err = CompileSyntheticCoverage(validCompileInput(t))
	if err != nil {
		t.Fatal(err)
	}
	plan = preparingPlan(bundle)
	bundle.TrackingSettings = json.RawMessage(`{"google_analytics":true}`)
	if _, err := builder.FinalizeSyntheticPlan(context.Background(), FinalizeInput{
		TenantID: testTenantID, Plan: plan, Bundle: bundle, ExpiresAt: time.Now().UTC(),
	}); !errors.Is(err, ErrScenarioDrift) || len(objects.puts) != 0 {
		t.Fatalf("tampered transform input error=%v writes=%d", err, len(objects.puts))
	}
}

func validCompileInput(t *testing.T) CompileInput {
	t.Helper()
	document := testDocument("Base")
	nodes := mustJSON(t, document.Nodes)
	return CompileInput{
		Revision: campaignartifact.Revision{
			ID: testRevisionID, TenantID: testTenantID, CampaignID: testCampaignID, RevisionNo: 1,
			SourceMode: campaignartifact.SourceModeSemantic, ContentSchemaVersion: semanticemail.SchemaVersionV2,
			Subject: "Base subject", SemanticTree: nodes, FactContract: json.RawMessage(`{}`),
			Variants: json.RawMessage(`[]`), Locales: json.RawMessage(`["en-US"]`),
			SourceHash: strings.Repeat("a", 64),
		},
		TrackingSettings: json.RawMessage(`{}`),
		PolicyVersion:    "postwave.structured-policy.test.v1", EnvelopeFactoryVersion: "postwave.synthetic-envelope.test.v1",
		EnvelopeFactory: func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
			return deterministicEnvelope(scenario), nil
		},
	}
}

func deterministicEnvelope(scenario campaigncoverage.CompilationScenario) campaigncompiler.Envelope {
	suffix := scenario.ScenarioID
	if len(suffix) > 32 {
		suffix = suffix[len(suffix)-32:]
	}
	return campaigncompiler.Envelope{
		From:      mail.Address{Name: "Moosewave", Address: "news@example.test"},
		To:        []mail.Address{{Name: "Synthetic Fixture", Address: "fixture@example.test"}},
		Date:      time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
		MessageID: "<scn-" + suffix + "@example.test>", Boundary: "postwave-" + suffix,
	}
}

func reviewedEntry(id, subject string, document semanticemail.DocumentV2) reviewedSemanticVariantV1 {
	return reviewedSemanticVariantV1{
		AdapterVersion: ReviewedVariantAdapterVersion, ID: id, Subject: subject,
		Document: semanticemail.NormalizeV2(document),
	}
}

func testDocument(title string) semanticemail.DocumentV2 {
	document := semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2, Language: "en-US", Direction: semanticemail.DirectionAuto,
		Nodes: []semanticemail.Node{
			{
				ID: "heading", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading, Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
					Level: 1, Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: title}}},
				}},
				Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
			{
				ID: "plan_fact", Type: semanticemail.NodeFact, Role: semanticemail.RoleProductFact, Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Fact: &semanticemail.FactContent{Label: "Plan", Value: "Premium"}},
				Conditions: []semanticemail.Condition{{
					ID: "segment_premium", SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "premium",
				}},
				Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
			{
				ID: "primary_action", Type: semanticemail.NodeAction, Role: semanticemail.RolePrimaryAction, Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Action: &semanticemail.ActionContent{
					ActionID: "act_start", Label: "Start now", CanonicalURL: "https://example.test/start",
				}},
				Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
		},
	}
	for index := range document.Nodes {
		document.Nodes[index].Localizations = map[string]semanticemail.NodeContent{
			"fr": document.Nodes[index].Content,
		}
	}
	return semanticemail.NormalizeV2(document)
}

func decodeNodes(t *testing.T, raw json.RawMessage) []semanticemail.Node {
	t.Helper()
	var nodes []semanticemail.Node
	if err := json.Unmarshal(raw, &nodes); err != nil {
		t.Fatal(err)
	}
	return nodes
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func preparingPlan(bundle Bundle) campaignartifact.Plan {
	return campaignartifact.Plan{
		ID: testPlanID, TenantID: testTenantID, CampaignID: bundle.CampaignID,
		ContentRevisionID: bundle.RevisionID, State: campaignartifact.PlanPreparing,
		CompilerVersion: campaigncompiler.Version, FixtureSetVersion: bundle.Manifest.FixtureSetVersion,
		CoverageManifest: append(json.RawMessage(nil), bundle.CoverageManifest...),
		RendererVersion:  bundle.RendererVersion, PolicyVersion: bundle.PolicyVersion,
		TransformManifest: append(json.RawMessage(nil), bundle.TransformManifest...),
	}
}
