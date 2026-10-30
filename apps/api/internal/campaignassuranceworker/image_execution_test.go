// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/campaignplanbuilder"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

type imageInspectorFake struct {
	report  campaignimagebroker.Report
	err     error
	request campaignimagebroker.Request
	calls   int
}

func (f *imageInspectorFake) Inspect(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
	f.calls++
	f.request = request
	return f.report, f.err
}

func TestWorkerPersistsEvidenceBoundImageOCRWithoutLeakingFetchCapability(t *testing.T) {
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	recompileImageFixture(t, &fixture)
	policyHash := strings.Repeat("8", 64)
	sourceHash, err := campaignimagebroker.SourceURLSHA256("https://images.example.test/offer.png")
	if err != nil {
		t.Fatal(err)
	}
	inspector := &imageInspectorFake{}
	inspector.report = campaignimagebroker.Report{
		BrokerVersion: campaignimagebroker.BrokerVersion, OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		FrozenSourceHash: fixture.artifacts.revision.SourceHash,
		ArtifactHash:     fixture.artifacts.artifact.OutboundMIMEHash, HTMLHash: fixture.artifacts.artifact.HTMLHash,
		PolicyHash: policyHash, ReviewedSourceCount: 1, ReceiptCount: 1, CompleteOCRCount: 1, LatencyMS: 12,
		Receipts: []campaignimagebroker.Receipt{{
			NodeID: "offer_image", HTMLLocation: "/html/images/0", Status: campaignimagebroker.StatusVerified,
			FrozenSourceHash: fixture.artifacts.revision.SourceHash,
			ArtifactHash:     fixture.artifacts.artifact.OutboundMIMEHash, HTMLHash: fixture.artifacts.artifact.HTMLHash,
			SourceURLSHA256: sourceHash, FinalURLSHA256: sourceHash,
			AssetSHA256: strings.Repeat("1", 64), RasterSHA256: strings.Repeat("2", 64),
			RasterObjectRef: "campaign-assurance/ocr/evidence.png", MediaType: "image/png",
			EncodedBytes: 1024, Width: 2, Height: 2, FrameCount: 1,
			FramePolicy: campaignimagebroker.AnimatedFirstFrame, OCRStatus: campaignimagebroker.OCRComplete,
			OCRText: "Summer offer", OCRTextSHA256: digestBytes([]byte("Summer offer")), OCRLanguage: "en-US",
			OCREngine: "sandboxed-ocr", OCREngineVersion: "sandboxed-ocr.2026-08-10",
			OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		}},
	}
	fixture.worker.ImageInspector = inspector
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeComplete || inspector.calls != 1 {
		t.Fatalf("result=%+v inspector calls=%d", result, inspector.calls)
	}
	if inspector.request.FrozenSourceHash != fixture.artifacts.revision.SourceHash ||
		inspector.request.ArtifactHash != fixture.artifacts.artifact.OutboundMIMEHash ||
		inspector.request.HTMLHash != fixture.artifacts.artifact.HTMLHash ||
		digestBytes(inspector.request.HTML) != inspector.request.HTMLHash ||
		len(inspector.request.ReviewedSources) != 1 || inspector.request.ReviewedSources[0].NodeID != "offer_image" ||
		inspector.request.ReviewedSources[0].URL != "https://images.example.test/offer.png" {
		t.Fatalf("inspector was not bound to the frozen artifact: %+v", inspector.request)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if len(fixture.assurance.extractions) != 1 {
		t.Fatalf("extractions=%+v", fixture.assurance.extractions)
	}
	extraction := fixture.assurance.extractions[0]
	if extraction.Status != campaignassurance.ExtractionComplete || extraction.LatencyMS != 12 ||
		!bytes.Contains(extraction.NormalizedExtraction, []byte(`"ocr_text":"Summer offer"`)) ||
		!bytes.Contains(extraction.NormalizedExtraction, []byte(`"status":"provided"`)) ||
		bytes.Contains(extraction.UnsupportedClaims, []byte("image_ocr")) ||
		bytes.Contains(extraction.EvidenceManifest, []byte("Summer offer")) ||
		!bytes.Contains(extraction.EvidenceManifest, []byte(`"report_sha256"`)) {
		t.Fatalf("durable OCR extraction is incomplete or overclaims: %+v", extraction)
	}
}

func TestWorkerConvertsInvalidOrFailedImageInspectorIntoUnavailableEvidence(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*imageInspectorFake, fixture)
	}{
		{
			name: "mismatched receipt",
			mutate: func(fake *imageInspectorFake, fixture fixture) {
				fake.report = campaignimagebroker.Report{
					BrokerVersion: campaignimagebroker.BrokerVersion, OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
					FrozenSourceHash: fixture.artifacts.revision.SourceHash,
					ArtifactHash:     strings.Repeat("9", 64), HTMLHash: fixture.artifacts.artifact.HTMLHash,
					PolicyHash: strings.Repeat("8", 64), ReviewedSourceCount: 1,
					ReceiptCount: 1, CompleteOCRCount: 1,
					Receipts: []campaignimagebroker.Receipt{{
						NodeID: "offer_image", Status: campaignimagebroker.StatusVerified,
						FrozenSourceHash: fixture.artifacts.revision.SourceHash,
						ArtifactHash:     strings.Repeat("9", 64), HTMLHash: fixture.artifacts.artifact.HTMLHash,
						OCRStatus: campaignimagebroker.OCRComplete, OCRText: "attacker-controlled green",
						OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
					}},
				}
			},
		},
		{
			name: "inspector execution failure",
			mutate: func(fake *imageInspectorFake, _ fixture) {
				fake.err = errors.New("remote image system failed")
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newFixture(t, campaignassurance.SourceDeterministic)
			recompileImageFixture(t, &fixture)
			inspector := &imageInspectorFake{}
			test.mutate(inspector, fixture)
			fixture.worker.ImageInspector = inspector
			result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
			if err != nil {
				t.Fatal(err)
			}
			if result.Outcome != OutcomeComplete || result.Run.GateDecision == campaignassurance.GatePass {
				t.Fatalf("unavailable image evidence became green: %+v", result)
			}
			fixture.assurance.mu.Lock()
			defer fixture.assurance.mu.Unlock()
			if len(fixture.assurance.extractions) != 1 ||
				!bytes.Contains(fixture.assurance.extractions[0].UnsupportedClaims, []byte("image_ocr_not_performed_or_incomplete")) ||
				bytes.Contains(fixture.assurance.extractions[0].NormalizedExtraction, []byte("attacker-controlled green")) ||
				!hasFindingCode(fixture.assurance.findings, "IMAGE_BROKER_UNAVAILABLE", false) {
				t.Fatalf("invalid inspector receipt was trusted: extraction=%+v findings=%+v",
					fixture.assurance.extractions, fixture.assurance.findings)
			}
		})
	}
}

func TestWorkerDoesNotInvokeImageInspectorForModeledOnlyTarget(t *testing.T) {
	fixture := newFixture(t, campaignassurance.SourceModeled)
	inspector := &imageInspectorFake{err: errors.New("must not be called")}
	fixture.worker.ImageInspector = inspector
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || inspector.calls != 0 {
		t.Fatalf("modeled-unavailable path invoked image broker: result=%+v calls=%d", result, inspector.calls)
	}
}

func recompileImageFixture(t *testing.T, fixture *fixture) {
	t.Helper()
	var nodes []semanticemail.Node
	if err := json.Unmarshal(fixture.artifacts.revision.SemanticTree, &nodes); err != nil {
		t.Fatal(err)
	}
	nodes = append(nodes, semanticemail.Node{
		ID: "offer_image", Type: semanticemail.NodeImage, Role: semanticemail.RoleInformativeImage,
		Version: semanticemail.NodeVersionV2,
		Content: semanticemail.NodeContent{Image: &semanticemail.ImageContent{
			URL: "https://images.example.test/offer.png", Alt: "Summer offer", Width: 2, Height: 2,
		}},
		Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
	})
	fixture.artifacts.revision.SemanticTree = mustTestJSON(t, nodes)
	bundle, err := campaignplanbuilder.CompileSyntheticCoverage(campaignplanbuilder.CompileInput{
		Revision: fixture.artifacts.revision, TrackingSettings: json.RawMessage(`{}`),
		PolicyVersion: "postwave.test.plan-policy.v1", EnvelopeFactoryVersion: "postwave.test.envelope.v1",
		EnvelopeFactory: func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
			suffix := scenario.ScenarioID
			if len(suffix) > 24 {
				suffix = suffix[len(suffix)-24:]
			}
			return campaigncompiler.Envelope{
				From:      mail.Address{Name: "Moosewave", Address: "sender@example.test"},
				To:        []mail.Address{{Name: "Synthetic", Address: "fixture@example.test"}},
				Date:      time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
				MessageID: "<" + suffix + "@example.test>", Boundary: "postwave-" + suffix,
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	compiled := bundle.Compiled[0]
	objectBase := "campaign-assurance/plans/" + testPlanID + "/artifacts/" + digestBytes([]byte(compiled.Artifact.ScenarioID)) + "/"
	htmlRest := objectBase + compiled.Artifact.HTMLHash + ".html"
	textRest := objectBase + compiled.Artifact.TextHash + ".txt"
	mimeRest := objectBase + compiled.Artifact.OutboundMIMEHash + ".eml"
	expires := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	artifactInput := compiled.Artifact
	artifactInput.HTMLObjectRef = campaignmaterializer.FormatObjectReference(htmlRest)
	artifactInput.TextObjectRef = campaignmaterializer.FormatObjectReference(textRest)
	artifactInput.MIMEObjectRef = campaignmaterializer.FormatObjectReference(mimeRest)
	artifactInput.ExpiresAt = &expires
	fixture.artifacts.artifact = campaignartifact.Artifact{
		ID: testArtifactID, TenantID: testTenantID, SendPlanID: testPlanID, ArtifactInput: artifactInput,
	}
	fixture.artifacts.plan.RendererVersion = bundle.RendererVersion
	fixture.artifacts.plan.CompilerVersion = bundle.CompilerVersion
	fixture.artifacts.plan.TransformManifest = bundle.TransformManifest
	fixture.artifacts.plan.CoverageManifest = bundle.CoverageManifest
	fixture.artifacts.plan.FixtureSetVersion = bundle.Manifest.FixtureSetVersion
	fixture.artifacts.plan.PolicyVersion = bundle.PolicyVersion
	coverageJSON, err := canonicalJSONObject(bundle.CoverageManifest, campaigncoverage.MaxManifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.claimed.Run.CoverageManifestHash = digestBytes(coverageJSON)
	fixture.assurance.claimed.Run.RendererVersion = bundle.RendererVersion
	fixture.assurance.claimed.Run.CompilerVersion = bundle.CompilerVersion
	fixture.assurance.claimed.Run.FixtureSetVersion = bundle.Manifest.FixtureSetVersion
	fixture.assurance.claimed.Run.PlanPolicyVersion = bundle.PolicyVersion
	fixture.assurance.claimed.Artifacts[0].ScenarioID = compiled.Artifact.ScenarioID
	fixture.assurance.claimed.Artifacts[0].OutboundMIMEHash = compiled.Artifact.OutboundMIMEHash
	fixture.assurance.claimed.Artifacts[0].MIMEStructureHash = compiled.Artifact.MIMEStructureHash
	fixture.assurance.claimed.Targets[0].OutboundMIMEHash = compiled.Artifact.OutboundMIMEHash
	fixture.objects.objects[htmlRest] = objectValue{body: []byte(compiled.HTML), contentType: "text/html; charset=utf-8"}
	fixture.objects.objects[textRest] = objectValue{body: []byte(compiled.Text), contentType: "text/plain; charset=utf-8"}
	fixture.objects.objects[mimeRest] = objectValue{body: compiled.RFC822, contentType: "message/rfc822"}
	fixture.compiled = compiled
}
