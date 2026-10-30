// SPDX-License-Identifier: AGPL-3.0-only

package campaigncompiler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func TestCompileSemanticProducesCanonicalMultipartArtifact(t *testing.T) {
	t.Parallel()

	input := validSemanticInput(t)
	result, err := Compile(input)
	if err != nil {
		t.Fatal(err)
	}

	for _, fragment := range []string{
		`data-postwave-preheader`,
		`Next Thursday at 4 PM`,
		`Hello Asha`,
		`utm_medium=email`,
		`utm_source=postwave`,
		`application/ld+json`,
	} {
		if !strings.Contains(result.HTML, fragment) {
			t.Errorf("HTML missing %q: %s", fragment, result.HTML)
		}
	}
	if !strings.Contains(result.Text, "Reserve my seat: https://example.test/register") {
		t.Fatalf("semantic text did not preserve the canonical action: %s", result.Text)
	}
	if strings.Contains(result.Text, "utm_source") {
		t.Fatalf("transport tracking leaked into semantic plain text: %s", result.Text)
	}
	if len(result.StructuredData) == 0 || !json.Valid(result.StructuredData) {
		t.Fatalf("structured data is missing or invalid: %s", result.StructuredData)
	}

	if result.Receipt.CompilerVersion != Version ||
		result.Receipt.SemanticCompiler != semanticemail.CompilerVersion ||
		result.Receipt.Transform.Version != campaigntransform.Version {
		t.Fatalf("compiler receipt lost implementation identity: %+v", result.Receipt)
	}
	if result.RepresentationManifest.Locale != "en-US" ||
		result.RepresentationManifest.PlainTextOrigin != "semantic_projection" ||
		!reflect.DeepEqual(result.RepresentationManifest.AlternativeOrder, []string{"text/plain", "text/html"}) {
		t.Fatalf("representation manifest = %+v", result.RepresentationManifest)
	}
	if result.Artifact.Locale != "en-US" || result.Artifact.BranchKey != "default" ||
		result.Artifact.OutboundMIMEHash != result.RepresentationManifest.OutboundMIMESHA256 ||
		result.Artifact.HTMLHash != result.RepresentationManifest.HTMLSHA256 ||
		result.Artifact.TextHash != result.RepresentationManifest.TextSHA256 ||
		result.Artifact.StructuredDataHash != result.RepresentationManifest.StructuredDataSHA256 {
		t.Fatalf("artifact and manifest are not bound to the same projections:\nartifact=%+v\nmanifest=%+v", result.Artifact, result.RepresentationManifest)
	}
	if digestBytes([]byte(result.HTML)) != result.Artifact.HTMLHash ||
		digestBytes([]byte(result.Text)) != result.Artifact.TextHash ||
		result.Receipt.Transform.OutputHTMLSHA256 != result.Artifact.HTMLHash {
		t.Fatal("materialized projection bytes, transform receipt, and artifact hashes diverged")
	}
	if !json.Valid(result.Artifact.CompilerReceipt) || !json.Valid(result.Artifact.RepresentationManifest) {
		t.Fatal("persisted receipt or representation manifest is not JSON")
	}

	parts := decodeAlternative(t, result.RFC822)
	if got := parts["text/plain"]; normalizeNewlinesForTest(got) != normalizeNewlinesForTest(result.Text) {
		t.Fatalf("MIME text part differs from compiler projection:\n%s", got)
	}
	if got := parts["text/html"]; normalizeNewlinesForTest(got) != normalizeNewlinesForTest(result.HTML) {
		t.Fatalf("MIME HTML part differs from compiler projection:\n%s", got)
	}
}

func TestCompileIsDeterministicAndWireMetadataHasNarrowEffect(t *testing.T) {
	t.Parallel()

	input := validSemanticInput(t)
	first, err := Compile(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Compile(input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("identical complete input did not reproduce identical compiler output")
	}

	input.Envelope.MessageID = "<different@example.test>"
	input.Envelope.Boundary = "postwave-boundary-different"
	changed, err := Compile(input)
	if err != nil {
		t.Fatal(err)
	}
	if changed.HTML != first.HTML || changed.Text != first.Text ||
		changed.Artifact.HTMLHash != first.Artifact.HTMLHash ||
		changed.Artifact.TextHash != first.Artifact.TextHash ||
		changed.Artifact.MIMEStructureHash != first.Artifact.MIMEStructureHash {
		t.Fatal("wire-only metadata altered a content projection or MIME structure identity")
	}
	if bytes.Equal(changed.RFC822, first.RFC822) || changed.Artifact.OutboundMIMEHash == first.Artifact.OutboundMIMEHash {
		t.Fatal("wire metadata did not alter exact outbound MIME identity")
	}
}

func TestCompileRejectsAmbiguousOrIncompleteInputs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*Input)
		want   error
	}{
		{
			name: "uppercase source hash",
			mutate: func(input *Input) {
				input.Revision.SourceHash = strings.ToUpper(input.Revision.SourceHash)
			},
			want: ErrInvalidInput,
		},
		{
			name: "invalid locale",
			mutate: func(input *Input) {
				input.Scenario.Locale = "not_a_locale"
			},
			want: ErrInvalidInput,
		},
		{
			name: "unknown semantic field",
			mutate: func(input *Input) {
				input.Revision.SemanticTree = append(input.Revision.SemanticTree[:len(input.Revision.SemanticTree)-1], []byte(`,{"id":"extra","type":"paragraph","role":"body","version":2,"content":{"paragraph":{"text":{"runs":[{"kind":"text","text":"x"}]}},"unknown":true},"provenance":{"source":"user"}}]`)...)
			},
			want: ErrInvalidInput,
		},
		{
			name: "unsupported semantic schema",
			mutate: func(input *Input) {
				input.Revision.ContentSchemaVersion = 1
			},
			want: ErrUnsupportedSource,
		},
		{
			name: "malformed tracking settings",
			mutate: func(input *Input) {
				input.TrackingSettings = json.RawMessage(`{"google_analytics":"yes"}`)
			},
			want: campaigntransform.ErrInvalidTrackingSettings,
		},
		{
			name: "malformed fact contract",
			mutate: func(input *Input) {
				input.Revision.FactContract = json.RawMessage(`{broken`)
			},
			want: ErrInvalidInput,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			input := validSemanticInput(t)
			test.mutate(&input)
			if _, err := Compile(input); !errors.Is(err, test.want) {
				t.Fatalf("Compile() error = %v, want errors.Is(%v)", err, test.want)
			}
		})
	}
}

func TestCompileLegacyRequiresReviewedPlainText(t *testing.T) {
	t.Parallel()

	input := validSemanticInput(t)
	input.Revision.SourceMode = campaignartifact.SourceModeLegacyHTML
	input.Revision.ContentSchemaVersion = 1
	input.Revision.SemanticTree = json.RawMessage(`[]`)
	html := `<html><body><h1>Legacy campaign</h1><a href="https://example.test/go">Go</a></body></html>`
	input.Revision.LegacyHTML = &html
	input.Revision.ReviewedPlainText = nil
	if _, err := Compile(input); !errors.Is(err, ErrLegacyPlainTextRequired) {
		t.Fatalf("Compile() error = %v, want reviewed-plain-text failure", err)
	}

	plain := "Legacy campaign\n\nGo: https://example.test/go\n"
	input.Revision.ReviewedPlainText = &plain
	result, err := Compile(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != normalizeCRLF(plain) || result.RepresentationManifest.PlainTextOrigin != "reviewed_legacy_plain_text" {
		t.Fatalf("legacy plain-text provenance was lost: %+v", result.RepresentationManifest)
	}
}

func TestCompileBindsReviewedSemanticDocumentInsteadOfBaseRevision(t *testing.T) {
	t.Parallel()
	input := validSemanticInput(t)
	var nodes []semanticemail.Node
	if err := json.Unmarshal(input.Revision.SemanticTree, &nodes); err != nil {
		t.Fatal(err)
	}
	nodes[0].Content.Heading.Text.Runs[0].Text = "Reviewed variant heading"
	document := semanticemail.NormalizeV2(semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2,
		Language:      "en-US",
		Direction:     semanticemail.DirectionAuto,
		Nodes:         nodes,
	})
	input.SemanticDocument = &document
	result, err := Compile(input)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.HTML, "Reviewed variant heading") || strings.Contains(result.HTML, "Workflow Automation Live") {
		t.Fatalf("compiler ignored reviewed semantic document: %s", result.HTML)
	}
	if result.Receipt.SemanticDocumentSHA256 == "" ||
		result.Receipt.SemanticDocumentSHA256 != result.RepresentationManifest.SemanticDocumentSHA256 {
		t.Fatalf("reviewed document identity was not bound to receipts: %+v %+v", result.Receipt, result.RepresentationManifest)
	}
}

func validSemanticInput(t *testing.T) Input {
	t.Helper()
	nodes := []semanticemail.Node{
		{
			ID: "title", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
				Level: 1,
				Text:  semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Workflow Automation Live"}}},
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
		{
			ID: "intro", Type: semanticemail.NodeParagraph, Role: semanticemail.RoleBody,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Paragraph: &semanticemail.ParagraphContent{Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{
				{Kind: semanticemail.InlineText, Text: "Hello "},
				{Kind: semanticemail.InlineSlot, Slot: &semanticemail.SlotReference{ID: "first_name", SemanticClass: semanticemail.SlotName, Required: true}},
				{Kind: semanticemail.InlineText, Text: "."},
			}}}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
		{
			ID: "cta", Type: semanticemail.NodeAction, Role: semanticemail.RolePrimaryAction,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Action: &semanticemail.ActionContent{
				ActionID: "reserve", Label: "Reserve my seat", CanonicalURL: "https://example.test/register",
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
		{
			ID: "offer", Type: semanticemail.NodeOffer, Role: semanticemail.RoleOffer,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Offer: &semanticemail.OfferContent{
				Description: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Save 20% on registration"}}},
				Code:        "SAVE20",
				Terms:       semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Valid through Wednesday"}}},
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
		{
			ID: "schema_offer", Type: semanticemail.NodeStructuredData, Role: semanticemail.RoleStructuredData,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{StructuredData: &semanticemail.StructuredDataContent{
				Enabled: true, Provider: semanticemail.ProviderGmail,
				RegistryVersion: semanticemail.GmailRegistryVersion,
				UseCase:         semanticemail.UseCaseGmailPromotion,
				Kind:            semanticemail.StructuredDiscountOffer,
				Declaration: semanticemail.StructuredDeclaration{
					DiscountOffer: &semanticemail.DiscountOfferDeclaration{OfferNodeID: "offer"},
				},
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		},
	}
	tree, err := json.Marshal(nodes)
	if err != nil {
		t.Fatal(err)
	}
	preview := "Next Thursday at 4 PM"
	return Input{
		Revision: campaignartifact.Revision{
			ID: "00000000-0000-4000-8000-000000000001", CampaignID: "00000000-0000-4000-8000-000000000002",
			SourceMode: campaignartifact.SourceModeSemantic, ContentSchemaVersion: semanticemail.SchemaVersionV2,
			Subject: "Workflow Automation Live", PreviewText: &preview, SemanticTree: tree,
			FactContract: json.RawMessage(`{"language":"en-US"}`),
			SourceHash:   strings.Repeat("a", 64),
		},
		Scenario: Scenario{
			ID: "base--en-US--default--fixture-a", Locale: "EN-us", FixtureID: "fixture-a",
			Slots: map[semanticemail.SlotID]string{"first_name": "Asha"},
		},
		TrackingSettings: json.RawMessage(`{"google_analytics":true,"utm_source":"postwave","utm_medium":"email"}`),
		StructuredPolicy: semanticemail.StructuredPolicy{Gmail: semanticemail.GmailPolicy{
			RegisteredSender: true, Authenticated: true, Promotions: true,
		}},
		Envelope: Envelope{
			From:      mail.Address{Name: "Moosewave", Address: "news@example.test"},
			To:        []mail.Address{{Name: "Assurance Fixture", Address: "fixture@example.test"}},
			Headers:   map[string]string{"List-Unsubscribe": "<https://example.test/unsubscribe>"},
			Date:      time.Date(2026, 8, 9, 12, 30, 0, 0, time.FixedZone("IST", 5*60*60+30*60)),
			MessageID: "<assurance-1@example.test>", Boundary: "postwave-boundary-assurance-1",
		},
	}
}

func decodeAlternative(t *testing.T, raw []byte) map[string]string {
	t.Helper()
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	if mediaType != "multipart/alternative" {
		t.Fatalf("Content-Type = %q, want multipart/alternative", mediaType)
	}
	reader := multipart.NewReader(message.Body, parameters["boundary"])
	parts := make(map[string]string, 2)
	var order []string
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		partType, _, parseErr := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		decoded, readErr := io.ReadAll(quotedprintable.NewReader(part))
		if readErr != nil {
			t.Fatal(readErr)
		}
		order = append(order, partType)
		parts[partType] = string(decoded)
	}
	if !reflect.DeepEqual(order, []string{"text/plain", "text/html"}) {
		t.Fatalf("MIME alternative order = %v", order)
	}
	return parts
}

func normalizeNewlinesForTest(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return value
}
