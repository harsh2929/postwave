// SPDX-License-Identifier: AGPL-3.0-only

package campaignplanbuilder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/mail"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// CompileSyntheticCoverage enumerates and compiles the complete frozen
// synthetic matrix. It returns no partial bundle: any unsupported variant,
// uncovered branch/slot, compiler error, or coordinate drift fails closed.
func CompileSyntheticCoverage(input CompileInput) (Bundle, error) {
	if input.EnvelopeFactory == nil {
		return Bundle{}, fmt.Errorf("%w: envelope factory is required", ErrInvalidInput)
	}
	if input.Revision.SourceMode != campaignartifact.SourceModeSemantic {
		return Bundle{}, fmt.Errorf("%w: only semantic source revisions support scenario coverage", ErrInvalidInput)
	}
	if strings.TrimSpace(input.Revision.ID) == "" || strings.TrimSpace(input.Revision.CampaignID) == "" {
		return Bundle{}, fmt.Errorf("%w: frozen revision and campaign identities are required", ErrInvalidInput)
	}
	for _, identity := range []struct{ name, value string }{
		{"tenant_id", input.Revision.TenantID}, {"revision_id", input.Revision.ID}, {"campaign_id", input.Revision.CampaignID},
	} {
		parsed, parseErr := uuid.Parse(identity.value)
		if parseErr != nil || parsed.String() != identity.value {
			return Bundle{}, fmt.Errorf("%w: %s must be a canonical UUID", ErrInvalidInput, identity.name)
		}
	}
	trackingSettings, transformManifest, err := buildTransformManifest(input)
	if err != nil {
		return Bundle{}, err
	}

	variants, err := adaptFrozenVariants(input.Revision)
	if err != nil {
		return Bundle{}, err
	}
	locales, err := adaptFrozenLocales(input.Revision.Locales)
	if err != nil {
		return Bundle{}, err
	}
	manifest, diagnostics := campaigncoverage.Enumerate(campaigncoverage.Input{
		Revision:          input.Revision,
		Variants:          variants.coverage,
		Locales:           locales,
		FixtureSetVersion: campaigncoverage.FixtureSetVersionV1,
	})
	if diagnostics.HasErrors() {
		return Bundle{}, fmt.Errorf("%w: %w", ErrCoverage, diagnostics)
	}
	manifestJSON, err := manifest.JSON()
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: encode coverage manifest: %v", ErrCoverage, err)
	}
	resolved, err := manifest.CompilationScenarios()
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: resolve coverage scenarios: %v", ErrCoverage, err)
	}
	manifestScenario := make(map[string]campaigncoverage.Scenario, len(manifest.Scenarios))
	variantIdentity := make(map[string]campaigncoverage.VariantIdentity, len(manifest.Variants))
	for _, scenario := range manifest.Scenarios {
		manifestScenario[scenario.ID] = scenario
	}
	for _, variant := range manifest.Variants {
		variantIdentity[variant.ID] = variant
	}

	compiled := make([]campaigncompiler.Result, 0, len(resolved))
	for _, scenario := range resolved {
		factoryScenario := cloneCompilationScenario(scenario)
		envelope, envelopeErr := resolveDeterministicEnvelope(input.EnvelopeFactory, factoryScenario)
		if envelopeErr != nil {
			return Bundle{}, fmt.Errorf("%w: scenario %s envelope: %v", ErrCompile, scenario.ScenarioID, envelopeErr)
		}
		revision := input.Revision
		var reviewedDocument *semanticemail.DocumentV2
		persistedVariantID := scenario.VariantID
		if variants.control {
			if scenario.VariantID != "control" {
				return Bundle{}, fmt.Errorf("%w: control manifest emitted variant %q", ErrScenarioDrift, scenario.VariantID)
			}
			persistedVariantID = ""
		} else {
			variant, ok := variants.byID[scenario.VariantID]
			if !ok {
				return Bundle{}, fmt.Errorf("%w: scenario %s references unadapted variant %q", ErrScenarioDrift, scenario.ScenarioID, scenario.VariantID)
			}
			revision.Subject = variant.Subject
			document := semanticemail.NormalizeV2(variant.Document)
			reviewedDocument = &document
		}
		result, compileErr := campaigncompiler.Compile(campaigncompiler.Input{
			Revision:         revision,
			SemanticDocument: reviewedDocument,
			Scenario: campaigncompiler.Scenario{
				ID: scenario.ScenarioID, VariantID: persistedVariantID,
				Locale: scenario.Locale, BranchKey: scenario.BranchKey,
				FixtureID: scenario.FixtureID, Slots: cloneSlots(scenario.Slots),
			},
			TrackingSettings: append(json.RawMessage(nil), trackingSettings...),
			StructuredPolicy: input.StructuredPolicy,
			Envelope:         envelope,
		})
		if compileErr != nil {
			return Bundle{}, fmt.Errorf("%w: scenario %s: %v", ErrCompile, scenario.ScenarioID, compileErr)
		}
		if err := validateOneResult(manifest, manifestScenario[scenario.ScenarioID], variantIdentity[scenario.VariantID], result); err != nil {
			return Bundle{}, err
		}
		compiled = append(compiled, result)
	}
	if err := ValidateCompiledSet(manifest, compiled); err != nil {
		return Bundle{}, err
	}
	return Bundle{
		BuilderVersion: Version, VariantAdapter: ReviewedVariantAdapterVersion,
		LocaleAdapter: FrozenLocaleAdapterVersion, TenantID: input.Revision.TenantID, RevisionID: input.Revision.ID,
		CampaignID: input.Revision.CampaignID, SourceHash: input.Revision.SourceHash,
		RendererVersion: semanticemail.HTMLRendererVersion, CompilerVersion: campaigncompiler.Version,
		PolicyVersion: strings.TrimSpace(input.PolicyVersion), EnvelopeFactory: strings.TrimSpace(input.EnvelopeFactoryVersion),
		TrackingSettings: append(json.RawMessage(nil), trackingSettings...), StructuredPolicy: input.StructuredPolicy,
		Manifest: manifest, CoverageManifest: append(json.RawMessage(nil), manifestJSON...),
		TransformManifest:   append(json.RawMessage(nil), transformManifest...),
		CoverageDiagnostics: append(campaigncoverage.Diagnostics(nil), diagnostics...),
		Compiled:            cloneCompiled(compiled),
	}, nil
}

// ValidateCompiledSet independently proves a one-to-one, canonical-order
// mapping between a closed coverage manifest and compiler results. It is safe
// to call again immediately before any external write.
func ValidateCompiledSet(manifest campaigncoverage.Manifest, compiled []campaigncompiler.Result) error {
	if diagnostics := campaigncoverage.ValidateManifest(manifest); diagnostics.HasErrors() {
		return fmt.Errorf("%w: invalid coverage manifest: %w", ErrCoverage, diagnostics)
	}
	if len(compiled) != len(manifest.Scenarios) {
		return fmt.Errorf("%w: got %d compiler results for %d required scenarios", ErrCompiledSetMismatch, len(compiled), len(manifest.Scenarios))
	}
	variantIdentity := make(map[string]campaigncoverage.VariantIdentity, len(manifest.Variants))
	for _, variant := range manifest.Variants {
		variantIdentity[variant.ID] = variant
	}
	seen := make(map[string]int, len(compiled))
	for index, result := range compiled {
		scenarioID := strings.TrimSpace(result.Artifact.ScenarioID)
		if first, duplicate := seen[scenarioID]; duplicate {
			return fmt.Errorf("%w: duplicate scenario %q at results %d and %d", ErrCompiledSetMismatch, scenarioID, first, index)
		}
		seen[scenarioID] = index
		expected := manifest.Scenarios[index]
		if scenarioID != expected.ID {
			if _, known := scenarioByID(manifest)[scenarioID]; !known {
				return fmt.Errorf("%w: unexpected scenario %q at result %d", ErrCompiledSetMismatch, scenarioID, index)
			}
			return fmt.Errorf("%w: result order drift at %d: got %q want %q", ErrScenarioDrift, index, scenarioID, expected.ID)
		}
		if err := validateOneResult(manifest, expected, variantIdentity[expected.VariantID], result); err != nil {
			return err
		}
	}
	for _, scenario := range manifest.Scenarios {
		if _, ok := seen[scenario.ID]; !ok {
			return fmt.Errorf("%w: missing required scenario %q", ErrCompiledSetMismatch, scenario.ID)
		}
	}
	return nil
}

func validateOneResult(manifest campaigncoverage.Manifest, scenario campaigncoverage.Scenario, variant campaigncoverage.VariantIdentity, result campaigncompiler.Result) error {
	expectedVariantID := scenario.VariantID
	if len(manifest.Variants) == 1 && manifest.Variants[0].ID == "control" {
		expectedVariantID = ""
	}
	coordinates := []struct {
		name, actual, expected string
	}{
		{"scenario_id", result.Artifact.ScenarioID, scenario.ID},
		{"variant_id", result.Artifact.VariantID, expectedVariantID},
		{"locale", result.Artifact.Locale, scenario.Locale},
		{"branch_key", result.Artifact.BranchKey, scenario.BranchKey},
		{"fixture_id", result.Artifact.FixtureID, scenario.FixtureID},
		{"source_hash", result.Artifact.SourceHash, manifest.SourceHash},
		{"receipt_source_hash", result.Receipt.SourceHash, manifest.SourceHash},
		{"semantic_document_sha256", result.Receipt.SemanticDocumentSHA256, variant.DocumentHash},
		{"manifest_semantic_document_sha256", result.RepresentationManifest.SemanticDocumentSHA256, variant.DocumentHash},
	}
	for _, coordinate := range coordinates {
		if coordinate.actual != coordinate.expected {
			return fmt.Errorf("%w: scenario %s %s = %q, want %q", ErrScenarioDrift, scenario.ID, coordinate.name, coordinate.actual, coordinate.expected)
		}
	}
	actualNodes := make([]string, len(result.Receipt.IncludedNodeIDs))
	for index, nodeID := range result.Receipt.IncludedNodeIDs {
		actualNodes[index] = string(nodeID)
	}
	if !slices.Equal(actualNodes, scenario.IncludedNodeIDs) {
		return fmt.Errorf("%w: scenario %s included semantic nodes differ from the coverage proof", ErrScenarioDrift, scenario.ID)
	}
	if result.Receipt.CompilerVersion != campaigncompiler.Version {
		return fmt.Errorf("%w: scenario %s compiler version = %q", ErrScenarioDrift, scenario.ID, result.Receipt.CompilerVersion)
	}
	receiptJSON, err := json.Marshal(result.Receipt)
	if err != nil || !bytes.Equal(receiptJSON, result.Artifact.CompilerReceipt) {
		return fmt.Errorf("%w: scenario %s typed compiler receipt differs from persisted receipt bytes", ErrScenarioDrift, scenario.ID)
	}
	representationJSON, err := json.Marshal(result.RepresentationManifest)
	if err != nil || !bytes.Equal(representationJSON, result.Artifact.RepresentationManifest) {
		return fmt.Errorf("%w: scenario %s typed representation manifest differs from persisted manifest bytes", ErrScenarioDrift, scenario.ID)
	}
	return nil
}

// PlanInput returns the exact preparing-plan request that must be persisted
// between compilation and FinalizeSyntheticPlan. The repository remains the
// authority for idempotency, tenant ownership, and plan numbering.
func (bundle Bundle) PlanInput(requestID, createdBy string) (campaignartifact.PlanInput, error) {
	if err := validateBundle(bundle); err != nil {
		return campaignartifact.PlanInput{}, err
	}
	parsedRequest, requestErr := uuid.Parse(strings.TrimSpace(requestID))
	parsedActor, actorErr := uuid.Parse(strings.TrimSpace(createdBy))
	if requestErr != nil || actorErr != nil || parsedRequest.String() != strings.TrimSpace(requestID) || parsedActor.String() != strings.TrimSpace(createdBy) {
		return campaignartifact.PlanInput{}, fmt.Errorf("%w: request_id and created_by must be canonical UUIDs", ErrInvalidInput)
	}
	return campaignartifact.PlanInput{
		CampaignID: bundle.CampaignID, ContentRevisionID: bundle.RevisionID,
		RequestID: strings.TrimSpace(requestID), CreatedBy: strings.TrimSpace(createdBy),
		RendererVersion: bundle.RendererVersion, CompilerVersion: bundle.CompilerVersion,
		TransformManifest: append(json.RawMessage(nil), bundle.TransformManifest...),
		CoverageManifest:  append(json.RawMessage(nil), bundle.CoverageManifest...),
		FixtureSetVersion: bundle.Manifest.FixtureSetVersion, PolicyVersion: bundle.PolicyVersion,
	}, nil
}

// FinalizeSyntheticPlan revalidates both the bundle and its preparing plan
// binding before handing exact bytes to campaignmaterializer.
func (b *Builder) FinalizeSyntheticPlan(ctx context.Context, input FinalizeInput) (FinalizeResult, error) {
	if b == nil || b.Materializer == nil {
		return FinalizeResult{}, fmt.Errorf("%w: materializer is required", ErrInvalidInput)
	}
	if err := validateBundle(input.Bundle); err != nil {
		return FinalizeResult{}, err
	}
	plan := input.Plan
	if input.TenantID != input.Bundle.TenantID || (plan.TenantID != "" && plan.TenantID != input.Bundle.TenantID) ||
		plan.ID == "" || plan.CampaignID != input.Bundle.CampaignID ||
		plan.ContentRevisionID != input.Bundle.RevisionID || plan.State != campaignartifact.PlanPreparing {
		return FinalizeResult{}, fmt.Errorf("%w: plan identity/state does not match the compiled bundle", ErrPlanDrift)
	}
	if plan.CompilerVersion != input.Bundle.CompilerVersion || plan.RendererVersion != input.Bundle.RendererVersion ||
		plan.FixtureSetVersion != input.Bundle.Manifest.FixtureSetVersion || plan.PolicyVersion != input.Bundle.PolicyVersion {
		return FinalizeResult{}, fmt.Errorf("%w: plan compiler, renderer, fixture-set, or policy version differs from the compiled bundle", ErrPlanDrift)
	}
	storedCoverage, err := decodeStoredCoverageManifest(plan.CoverageManifest)
	if err != nil {
		return FinalizeResult{}, fmt.Errorf("%w: invalid stored coverage manifest: %v", ErrPlanDrift, err)
	}
	storedCoverageJSON, err := storedCoverage.JSON()
	if err != nil || !bytes.Equal(storedCoverageJSON, input.Bundle.CoverageManifest) {
		return FinalizeResult{}, fmt.Errorf("%w: plan coverage manifest differs from the compiled bundle", ErrPlanDrift)
	}
	storedTransform, err := canonicalJSONObject(plan.TransformManifest)
	if err != nil || !bytes.Equal(storedTransform, input.Bundle.TransformManifest) {
		return FinalizeResult{}, fmt.Errorf("%w: plan transform manifest differs from the compiled bundle", ErrPlanDrift)
	}
	materialized, err := b.Materializer.FinalizeSyntheticPlan(ctx, campaignmaterializer.Input{
		TenantID: input.TenantID, CampaignID: input.Bundle.CampaignID, PlanID: plan.ID,
		SyntheticFixture: true, ExpiresAt: input.ExpiresAt,
		Compiled: cloneCompiled(input.Bundle.Compiled),
	})
	if err != nil {
		return FinalizeResult{}, err
	}
	return FinalizeResult{Bundle: cloneBundle(input.Bundle), Materialized: materialized}, nil
}

func validateBundle(bundle Bundle) error {
	if bundle.BuilderVersion != Version || bundle.VariantAdapter != ReviewedVariantAdapterVersion || bundle.LocaleAdapter != FrozenLocaleAdapterVersion ||
		bundle.RendererVersion != semanticemail.HTMLRendererVersion || bundle.CompilerVersion != campaigncompiler.Version ||
		!validImplementationVersion(bundle.PolicyVersion) || !validImplementationVersion(bundle.EnvelopeFactory) {
		return fmt.Errorf("%w: bundle implementation identities are unsupported", ErrInvalidInput)
	}
	for _, value := range []string{bundle.TenantID, bundle.RevisionID, bundle.CampaignID} {
		parsed, err := uuid.Parse(value)
		if err != nil || parsed.String() != value {
			return fmt.Errorf("%w: bundle tenant/revision/campaign identity is not a canonical UUID", ErrInvalidInput)
		}
	}
	manifestJSON, err := bundle.Manifest.JSON()
	if err != nil {
		return fmt.Errorf("%w: invalid bundle coverage manifest: %v", ErrCoverage, err)
	}
	if err := validateTransformManifest(bundle.TransformManifest, bundle); err != nil {
		return fmt.Errorf("%w: bundle transform manifest is invalid or non-canonical", ErrScenarioDrift)
	}
	if !bytes.Equal(bundle.CoverageManifest, manifestJSON) || bundle.SourceHash != bundle.Manifest.SourceHash {
		return fmt.Errorf("%w: bundle manifest bytes or source identity drifted", ErrScenarioDrift)
	}
	return ValidateCompiledSet(bundle.Manifest, bundle.Compiled)
}

func scenarioByID(manifest campaigncoverage.Manifest) map[string]campaigncoverage.Scenario {
	out := make(map[string]campaigncoverage.Scenario, len(manifest.Scenarios))
	for _, scenario := range manifest.Scenarios {
		out[scenario.ID] = scenario
	}
	return out
}

func cloneCompilationScenario(input campaigncoverage.CompilationScenario) campaigncoverage.CompilationScenario {
	input.Slots = cloneSlots(input.Slots)
	return input
}

func resolveDeterministicEnvelope(factory EnvelopeFactory, scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
	first, err := factory(cloneCompilationScenario(scenario))
	if err != nil {
		return campaigncompiler.Envelope{}, err
	}
	first = cloneEnvelope(first)
	second, err := factory(cloneCompilationScenario(scenario))
	if err != nil {
		return campaigncompiler.Envelope{}, fmt.Errorf("repeat deterministic envelope resolution: %w", err)
	}
	second = cloneEnvelope(second)
	if !equalEnvelope(first, second) {
		return campaigncompiler.Envelope{}, errors.New("envelope factory returned different wire metadata for the same frozen scenario")
	}
	if err := validateSyntheticEnvelope(first); err != nil {
		return campaigncompiler.Envelope{}, err
	}
	return first, nil
}

func cloneEnvelope(input campaigncompiler.Envelope) campaigncompiler.Envelope {
	input.To = append([]mail.Address(nil), input.To...)
	input.Cc = append([]mail.Address(nil), input.Cc...)
	input.ReplyTo = append([]mail.Address(nil), input.ReplyTo...)
	input.Headers = maps.Clone(input.Headers)
	return input
}

func equalEnvelope(left, right campaigncompiler.Envelope) bool {
	return left.From == right.From && slices.Equal(left.To, right.To) && slices.Equal(left.Cc, right.Cc) &&
		slices.Equal(left.ReplyTo, right.ReplyTo) && maps.Equal(left.Headers, right.Headers) &&
		left.Date.Format(time.RFC1123Z) == right.Date.Format(time.RFC1123Z) &&
		left.MessageID == right.MessageID && left.Boundary == right.Boundary
}

func validateSyntheticEnvelope(envelope campaigncompiler.Envelope) error {
	if len(envelope.To) == 0 {
		return errors.New("synthetic envelope requires at least one To address")
	}
	for _, group := range [][]mail.Address{envelope.To, envelope.Cc} {
		for _, address := range group {
			parsed, err := mail.ParseAddress(address.Address)
			if err != nil || parsed.Address != address.Address {
				return fmt.Errorf("invalid synthetic recipient address %q", address.Address)
			}
			at := strings.LastIndexByte(address.Address, '@')
			if at < 1 || !reservedExampleDomain(address.Address[at+1:]) {
				return errors.New("synthetic recipient addresses must use an RFC 2606 example/test domain")
			}
		}
	}
	return nil
}

func reservedExampleDomain(value string) bool {
	domain := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
	if domain == "example.com" || domain == "example.net" || domain == "example.org" || domain == "localhost" {
		return true
	}
	for _, suffix := range []string{".test", ".example", ".invalid", ".localhost"} {
		if strings.HasSuffix(domain, suffix) {
			return true
		}
	}
	return domain == "test" || domain == "example" || domain == "invalid"
}

func decodeStoredCoverageManifest(raw json.RawMessage) (campaigncoverage.Manifest, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var manifest campaigncoverage.Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return campaigncoverage.Manifest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return campaigncoverage.Manifest{}, errors.New("coverage manifest contains trailing JSON")
	}
	if diagnostics := campaigncoverage.ValidateManifest(manifest); diagnostics.HasErrors() {
		return campaigncoverage.Manifest{}, diagnostics
	}
	return manifest, nil
}

func cloneSlots(input map[semanticemail.SlotID]string) map[semanticemail.SlotID]string {
	out := make(map[semanticemail.SlotID]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func cloneCompiled(input []campaigncompiler.Result) []campaigncompiler.Result {
	out := make([]campaigncompiler.Result, len(input))
	copy(out, input)
	for index := range out {
		out[index].StructuredData = append(json.RawMessage(nil), input[index].StructuredData...)
		out[index].RFC822 = append([]byte(nil), input[index].RFC822...)
		out[index].Artifact.CompilerReceipt = append(json.RawMessage(nil), input[index].Artifact.CompilerReceipt...)
		out[index].Artifact.RepresentationManifest = append(json.RawMessage(nil), input[index].Artifact.RepresentationManifest...)
		out[index].Receipt.IncludedNodeIDs = append([]semanticemail.NodeID(nil), input[index].Receipt.IncludedNodeIDs...)
		out[index].Receipt.StructuredStatuses = append([]semanticemail.StructuredDataStatus(nil), input[index].Receipt.StructuredStatuses...)
		out[index].RepresentationManifest.AlternativeOrder = append([]string(nil), input[index].RepresentationManifest.AlternativeOrder...)
	}
	return out
}

func cloneBundle(input Bundle) Bundle {
	input.CoverageManifest = append(json.RawMessage(nil), input.CoverageManifest...)
	input.TransformManifest = append(json.RawMessage(nil), input.TransformManifest...)
	input.TrackingSettings = append(json.RawMessage(nil), input.TrackingSettings...)
	input.CoverageDiagnostics = append(campaigncoverage.Diagnostics(nil), input.CoverageDiagnostics...)
	input.Compiled = cloneCompiled(input.Compiled)
	return input
}
