// SPDX-License-Identifier: AGPL-3.0-only

// Package campaigncompiler turns one immutable content revision and one exact
// synthetic/recipient scenario into the canonical projections, RFC message,
// hashes, and receipts consumed by assurance and live dispatch.
package campaigncompiler

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/mimecomposer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"golang.org/x/text/language"
)

const Version = "postwave.campaign-compiler.v1"

var (
	ErrInvalidInput            = errors.New("campaign compiler: invalid input")
	ErrUnsupportedSource       = errors.New("campaign compiler: unsupported source")
	ErrLegacyPlainTextRequired = errors.New("campaign compiler: reviewed legacy plain text is required")
)

type Scenario struct {
	ID        string                          `json:"id"`
	VariantID string                          `json:"variant_id,omitempty"`
	Locale    string                          `json:"locale"`
	BranchKey string                          `json:"branch_key"`
	FixtureID string                          `json:"fixture_id"`
	Slots     map[semanticemail.SlotID]string `json:"slots"`
}

type Envelope struct {
	From      mail.Address
	To        []mail.Address
	Cc        []mail.Address
	ReplyTo   []mail.Address
	Headers   map[string]string
	Date      time.Time
	MessageID string
	Boundary  string
}

type Input struct {
	Revision campaignartifact.Revision
	// SemanticDocument is the effective, reviewed v2 document for this
	// scenario. It is required by variant orchestration and must be nil for
	// legacy HTML. A nil value for semantic input compiles the revision's base
	// semantic tree (the control variant).
	SemanticDocument *semanticemail.DocumentV2
	Scenario         Scenario
	TrackingSettings json.RawMessage
	StructuredPolicy semanticemail.StructuredPolicy
	// PollOptionLinks is recipient-specific compiler input. It is never part of
	// the immutable semantic revision or stored synthetic assurance artifact.
	PollOptionLinks semanticemail.PollOptionLinks
	// HoneypotDecoys is recipient-specific compiler input for the same reason
	// and with the same guarantees as PollOptionLinks: minted per recipient at
	// send time, never authored into the immutable semantic revision, and never
	// part of a stored synthetic assurance artifact. Nil for every synthetic
	// projection, which is what keeps those recipient-free and keeps a frozen
	// artifact matching its own live compilation.
	HoneypotDecoys []string
	Envelope       Envelope
}

type Receipt struct {
	CompilerVersion        string                               `json:"compiler_version"`
	SourceMode             string                               `json:"source_mode"`
	SourceHash             string                               `json:"source_hash"`
	ContentSchema          int                                  `json:"content_schema_version"`
	SemanticDocumentSHA256 string                               `json:"semantic_document_sha256,omitempty"`
	SemanticCompiler       string                               `json:"semantic_compiler_version,omitempty"`
	HTMLRenderer           string                               `json:"html_renderer_version,omitempty"`
	TextRenderer           string                               `json:"text_renderer_version,omitempty"`
	StructuredRegistry     string                               `json:"structured_registry_version,omitempty"`
	MIMEFormat             string                               `json:"mime_format_version"`
	MIMEContentHash        string                               `json:"mime_content_hash_version"`
	Transform              campaigntransform.Receipt            `json:"transform"`
	IncludedNodeIDs        []semanticemail.NodeID               `json:"included_node_ids,omitempty"`
	StructuredStatuses     []semanticemail.StructuredDataStatus `json:"structured_statuses,omitempty"`
}

type RepresentationManifest struct {
	Version                string   `json:"version"`
	SourceMode             string   `json:"source_mode"`
	Locale                 string   `json:"locale"`
	PlainTextOrigin        string   `json:"plain_text_origin"`
	AlternativeOrder       []string `json:"alternative_order"`
	HTMLSHA256             string   `json:"html_sha256"`
	TextSHA256             string   `json:"text_sha256"`
	StructuredDataSHA256   string   `json:"structured_data_sha256,omitempty"`
	SemanticDocumentSHA256 string   `json:"semantic_document_sha256,omitempty"`
	MIMEStructureSHA256    string   `json:"mime_structure_sha256"`
	OutboundMIMESHA256     string   `json:"outbound_mime_sha256"`
	StructuredDataPresent  bool     `json:"structured_data_present"`
}

type Result struct {
	Subject                string
	HTML                   string
	Text                   string
	StructuredData         json.RawMessage
	RFC822                 []byte
	Receipt                Receipt
	RepresentationManifest RepresentationManifest
	Artifact               campaignartifact.ArtifactInput
}

type mimeStructure struct {
	Version   string   `json:"version"`
	MediaType string   `json:"media_type"`
	Parts     []string `json:"parts"`
	Encoding  string   `json:"transfer_encoding"`
}

// Compile performs no I/O and uses no implicit clock or randomness. Callers
// supply wire metadata so the same complete input reproduces identical bytes.
func Compile(input Input) (Result, error) {
	locale, err := validateInput(input)
	if err != nil {
		return Result{}, err
	}
	preview := ""
	if input.Revision.PreviewText != nil {
		preview = *input.Revision.PreviewText
	}
	var (
		htmlBody, textBody string
		structured         json.RawMessage
		receipt            = Receipt{
			CompilerVersion: Version,
			SourceMode:      input.Revision.SourceMode,
			SourceHash:      input.Revision.SourceHash,
			ContentSchema:   input.Revision.ContentSchemaVersion,
			MIMEFormat:      mimecomposer.FormatVersion,
			MIMEContentHash: mimecomposer.ContentHashVersion,
		}
		plainOrigin string
	)

	switch input.Revision.SourceMode {
	case campaignartifact.SourceModeSemantic:
		document, documentHash, err := effectiveSemanticDocument(input.Revision, locale, input.SemanticDocument)
		if err != nil {
			return Result{}, err
		}
		projection, diagnostics := semanticemail.CompileV2(document, semanticemail.CompileOptions{
			Locale:           locale,
			Slots:            cloneSlots(input.Scenario.Slots),
			StructuredPolicy: input.StructuredPolicy,
			PollOptionLinks:  input.PollOptionLinks,
			HoneypotDecoys:   input.HoneypotDecoys,
		})
		if diagnostics.HasErrors() {
			return Result{}, fmt.Errorf("%w: semantic projection: %w", ErrInvalidInput, diagnostics)
		}
		htmlBody, textBody = projection.HTML, projection.Text
		structured = append(json.RawMessage(nil), projection.JSONLD...)
		receipt.SemanticCompiler = projection.CompilerVersion
		receipt.SemanticDocumentSHA256 = documentHash
		receipt.HTMLRenderer = projection.HTMLVersion
		receipt.TextRenderer = projection.TextVersion
		receipt.StructuredRegistry = projection.RegistryVersion
		receipt.IncludedNodeIDs = append([]semanticemail.NodeID(nil), projection.IncludedNodeIDs...)
		receipt.StructuredStatuses = append([]semanticemail.StructuredDataStatus(nil), projection.StructuredStatuses...)
		plainOrigin = "semantic_projection"
	case campaignartifact.SourceModeLegacyHTML:
		if input.SemanticDocument != nil {
			return Result{}, fmt.Errorf("%w: semantic document override is not valid for legacy HTML", ErrInvalidInput)
		}
		if input.Revision.LegacyHTML == nil || strings.TrimSpace(*input.Revision.LegacyHTML) == "" {
			return Result{}, fmt.Errorf("%w: legacy HTML is empty", ErrUnsupportedSource)
		}
		if input.Revision.ReviewedPlainText == nil || strings.TrimSpace(*input.Revision.ReviewedPlainText) == "" {
			return Result{}, ErrLegacyPlainTextRequired
		}
		htmlBody = *input.Revision.LegacyHTML
		textBody = *input.Revision.ReviewedPlainText
		plainOrigin = "reviewed_legacy_plain_text"
	default:
		return Result{}, ErrUnsupportedSource
	}

	// The materialized projection bytes and MIME part bytes share one exact
	// line-ending identity. Normalizing before transforms also makes the
	// transform receipt's output hash equal the stored HTML/artifact hash.
	htmlBody = normalizeCRLF(htmlBody)
	textBody = normalizeCRLF(textBody)
	transformed, err := campaigntransform.ApplyHTML(htmlBody, preview, input.TrackingSettings)
	if err != nil {
		return Result{}, err
	}
	htmlBody = transformed.HTML
	receipt.Transform = transformed.Receipt

	composed, err := mimecomposer.Compose(mimecomposer.Message{
		From:     input.Envelope.From,
		To:       append([]mail.Address(nil), input.Envelope.To...),
		Cc:       append([]mail.Address(nil), input.Envelope.Cc...),
		ReplyTo:  append([]mail.Address(nil), input.Envelope.ReplyTo...),
		Subject:  input.Revision.Subject,
		TextBody: textBody,
		HTMLBody: htmlBody,
		Headers:  cloneHeaders(input.Envelope.Headers),
	}, mimecomposer.Metadata{
		Date: input.Envelope.Date, MessageID: input.Envelope.MessageID,
		Boundary: input.Envelope.Boundary,
	})
	if err != nil {
		return Result{}, fmt.Errorf("%w: compose MIME: %v", ErrInvalidInput, err)
	}
	structureHash, err := digestJSON(mimeStructure{
		Version: mimecomposer.FormatVersion, MediaType: "multipart/alternative",
		Parts:    []string{"text/plain; charset=UTF-8", "text/html; charset=UTF-8"},
		Encoding: "quoted-printable",
	})
	if err != nil {
		return Result{}, err
	}
	manifest := RepresentationManifest{
		Version:                "postwave.representation-manifest.v1",
		SourceMode:             input.Revision.SourceMode,
		Locale:                 locale,
		PlainTextOrigin:        plainOrigin,
		AlternativeOrder:       []string{"text/plain", "text/html"},
		HTMLSHA256:             composed.Hashes.HTML,
		TextSHA256:             composed.Hashes.Text,
		SemanticDocumentSHA256: receipt.SemanticDocumentSHA256,
		MIMEStructureSHA256:    structureHash,
		OutboundMIMESHA256:     composed.Hashes.MIME,
		StructuredDataPresent:  len(structured) != 0,
	}
	if len(structured) != 0 {
		manifest.StructuredDataSHA256 = digestBytes(structured)
	}
	receiptJSON, err := canonicalObject(receipt)
	if err != nil {
		return Result{}, err
	}
	manifestJSON, err := canonicalObject(manifest)
	if err != nil {
		return Result{}, err
	}
	artifact := campaignartifact.ArtifactInput{
		ScenarioID:             strings.TrimSpace(input.Scenario.ID),
		VariantID:              strings.TrimSpace(input.Scenario.VariantID),
		Locale:                 locale,
		BranchKey:              normalizedDefault(input.Scenario.BranchKey),
		FixtureID:              strings.TrimSpace(input.Scenario.FixtureID),
		SourceHash:             input.Revision.SourceHash,
		HTMLHash:               composed.Hashes.HTML,
		TextHash:               composed.Hashes.Text,
		StructuredDataHash:     manifest.StructuredDataSHA256,
		MIMEStructureHash:      structureHash,
		OutboundMIMEHash:       composed.Hashes.MIME,
		CompilerReceipt:        receiptJSON,
		RepresentationManifest: manifestJSON,
	}
	return Result{
		Subject: input.Revision.Subject, HTML: htmlBody, Text: textBody,
		StructuredData: append(json.RawMessage(nil), structured...),
		RFC822:         append([]byte(nil), composed.Raw...), Receipt: receipt,
		RepresentationManifest: manifest, Artifact: artifact,
	}, nil
}

func validateInput(input Input) (string, error) {
	if strings.TrimSpace(input.Revision.ID) == "" || strings.TrimSpace(input.Revision.CampaignID) == "" {
		return "", fmt.Errorf("%w: immutable revision identity is required", ErrInvalidInput)
	}
	if !validSHA256(input.Revision.SourceHash) {
		return "", fmt.Errorf("%w: revision source hash is invalid", ErrInvalidInput)
	}
	if strings.TrimSpace(input.Revision.Subject) == "" {
		return "", fmt.Errorf("%w: subject is required", ErrInvalidInput)
	}
	if strings.TrimSpace(input.Scenario.ID) == "" || strings.TrimSpace(input.Scenario.Locale) == "" ||
		strings.TrimSpace(input.Scenario.FixtureID) == "" {
		return "", fmt.Errorf("%w: scenario id, locale, and fixture id are required", ErrInvalidInput)
	}
	locale, err := language.Parse(strings.TrimSpace(input.Scenario.Locale))
	if err != nil || locale == language.Und {
		return "", fmt.Errorf("%w: scenario locale is invalid", ErrInvalidInput)
	}
	return locale.String(), nil
}

func effectiveSemanticDocument(revision campaignartifact.Revision, scenarioLocale string, reviewed *semanticemail.DocumentV2) (semanticemail.DocumentV2, string, error) {
	if revision.ContentSchemaVersion != semanticemail.SchemaVersionV2 {
		return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: semantic schema version %d", ErrUnsupportedSource, revision.ContentSchemaVersion)
	}
	documentLanguage, err := factContractLanguage(revision.FactContract)
	if err != nil {
		return semanticemail.DocumentV2{}, "", err
	}
	if documentLanguage == "" && reviewed != nil {
		documentLanguage = strings.TrimSpace(reviewed.Language)
	}
	if documentLanguage == "" {
		documentLanguage, err = frozenBaseLanguage(revision.Locales)
		if err != nil {
			return semanticemail.DocumentV2{}, "", err
		}
	}
	if documentLanguage == "" {
		documentLanguage = strings.TrimSpace(scenarioLocale)
	}
	if documentLanguage == "" {
		documentLanguage = "en"
	}

	var document semanticemail.DocumentV2
	if reviewed != nil {
		document = *reviewed
	} else {
		if len(revision.SemanticTree) > semanticemail.MaxDocumentJSONBytes {
			return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: semantic nodes exceed %d bytes", ErrInvalidInput, semanticemail.MaxDocumentJSONBytes)
		}
		decoder := json.NewDecoder(bytes.NewReader(revision.SemanticTree))
		decoder.DisallowUnknownFields()
		var nodes []semanticemail.Node
		if err := decoder.Decode(&nodes); err != nil {
			return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: decode semantic nodes: %v", ErrInvalidInput, err)
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: trailing semantic node data", ErrInvalidInput)
		}
		document = semanticemail.DocumentV2{
			SchemaVersion: semanticemail.SchemaVersionV2,
			Language:      documentLanguage,
			Direction:     semanticemail.DirectionAuto,
			Nodes:         nodes,
		}
	}

	normalized, diagnostics := semanticemail.NormalizeAndValidateV2(document)
	if diagnostics.HasErrors() {
		return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: semantic document: %w", ErrInvalidInput, diagnostics)
	}
	if normalized.Language != documentLanguage {
		return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: semantic document language %q does not match frozen Fact Contract language %q", ErrInvalidInput, normalized.Language, documentLanguage)
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: encode semantic document: %v", ErrInvalidInput, err)
	}
	return normalized, digestBytes(encoded), nil
}

func frozenBaseLanguage(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	var locales []string
	if err := decoder.Decode(&locales); err != nil {
		return "", fmt.Errorf("%w: decode frozen locales: %v", ErrInvalidInput, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("%w: trailing frozen locale data", ErrInvalidInput)
	}
	canonical := make([]string, 0, len(locales))
	for _, rawLocale := range locales {
		tag, err := language.Parse(strings.TrimSpace(rawLocale))
		if err != nil || tag == language.Und {
			return "", fmt.Errorf("%w: invalid frozen locale %q", ErrInvalidInput, rawLocale)
		}
		canonical = append(canonical, tag.String())
	}
	if len(canonical) == 0 {
		return "", nil
	}
	sort.Strings(canonical)
	return canonical[0], nil
}

func factContractLanguage(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte(`{}`)) {
		return "", nil
	}
	if trimmed[0] != '{' {
		return "", fmt.Errorf("%w: fact contract must be an object", ErrInvalidInput)
	}
	var projection struct {
		Language string `json:"language"`
	}
	if err := json.Unmarshal(raw, &projection); err != nil {
		return "", fmt.Errorf("%w: decode fact contract: %v", ErrInvalidInput, err)
	}
	return strings.TrimSpace(projection.Language), nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func cloneSlots(input map[semanticemail.SlotID]string) map[semanticemail.SlotID]string {
	out := make(map[semanticemail.SlotID]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func cloneHeaders(input map[string]string) map[string]string {
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func normalizedDefault(value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return "default"
}

func normalizeCRLF(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.ReplaceAll(value, "\n", "\r\n")
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func digestJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return digestBytes(raw), nil
}

func canonicalObject(value any) (json.RawMessage, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return raw, nil
}
