// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"golang.org/x/text/language"
)

var languageTagPattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$`)

type preparedInput struct {
	revisionVariantsHash string
	factContractHash     string
	contract             *factcontract.ContractV1
	variants             []preparedVariant
	locales              []string
}

type preparedVariant struct {
	id           string
	document     semanticemail.DocumentV2
	documentHash string
	inputIndex   int
}

func prepareInput(input Input, sink *diagnosticSink) preparedInput {
	prepared := preparedInput{}
	if input.Revision.SourceMode != campaignartifact.SourceModeSemantic {
		sink.error(CodeUnsupportedSource, "/revision/source_mode", "scenario coverage requires a semantic source revision")
	}
	if input.Revision.ContentSchemaVersion != semanticemail.SchemaVersionV2 {
		sink.error(CodeUnsupportedVersion, "/revision/content_schema_version", "semantic scenario coverage requires content schema version 2")
	}
	if !hashPattern.MatchString(input.Revision.SourceHash) {
		sink.error(CodeInvalidInput, "/revision/source_hash", "source_hash must be a lowercase SHA-256 hex digest")
	}
	fixtureVersion := strings.TrimSpace(input.FixtureSetVersion)
	if fixtureVersion == "" {
		fixtureVersion = FixtureSetVersionV1
	}
	if fixtureVersion != FixtureSetVersionV1 {
		sink.error(CodeUnsupportedVersion, "/fixture_set_version", "only the pinned synthetic fixture set v1 is supported")
	}

	contract, contractJSON := decodeContract(input.Revision.FactContract, sink)
	prepared.contract = contract
	prepared.factContractHash = digestBytes(contractJSON)
	prepared.revisionVariantsHash = canonicalRawHash(input.Revision.Variants, "array", "/revision/variants", sink)

	revisionLocales := decodeRevisionLocales(input.Revision.Locales, sink)
	locales := input.Locales
	if len(locales) == 0 {
		locales = revisionLocales
	}
	baseLanguage := ""
	if contract != nil {
		baseLanguage = string(contract.Language)
	}
	if baseLanguage == "" && len(locales) > 0 {
		baseLanguage = locales[0]
	}
	if baseLanguage == "" {
		baseLanguage = "en"
	}
	prepared.locales = normalizeLocales(locales, baseLanguage, sink)

	revisionDocument, revisionDocumentOK := decodeRevisionDocument(input.Revision, baseLanguage, sink)
	if len(input.Variants) == 0 {
		if revisionDocumentOK {
			prepared.variants = append(prepared.variants, prepareVariant("control", revisionDocument, -1, contract, sink))
		}
	} else {
		// Even when an adapter supplies explicit active variants, the frozen
		// revision remains the source oracle and must independently be valid.
		if revisionDocumentOK {
			_ = prepareVariant("revision_source", revisionDocument, -1, contract, sink)
		}
		if len(input.Variants) > MaxVariants {
			sink.error(CodeLimitExceeded, "/variants", fmt.Sprintf("at most %d active variants are supported", MaxVariants))
		}
		variantLimit := min(len(input.Variants), MaxVariants)
		seen := make(map[string]int, variantLimit)
		for i, variant := range input.Variants[:variantLimit] {
			id := strings.TrimSpace(variant.ID)
			path := fmt.Sprintf("/variants/%d/id", i)
			if !validReference(id) {
				sink.error(CodeInvalidReference, path, "variant id is not a stable reference")
				continue
			}
			if first, duplicate := seen[id]; duplicate {
				sink.error(CodeDuplicate, path, fmt.Sprintf("variant id duplicates /variants/%d/id", first))
				continue
			}
			seen[id] = i
			prepared.variants = append(prepared.variants, prepareVariant(id, variant.Document, i, contract, sink))
		}
	}
	sort.Slice(prepared.variants, func(i, j int) bool { return prepared.variants[i].id < prepared.variants[j].id })
	if len(prepared.variants) == 0 {
		sink.error(CodeInvalidInput, "/variants", "at least one valid semantic variant is required")
	}
	return prepared
}

func decodeContract(raw json.RawMessage, sink *diagnosticSink) (*factcontract.ContractV1, []byte) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	canonical, ok := canonicalRaw(raw, "object", "/revision/fact_contract", sink)
	if !ok {
		return nil, []byte(`{}`)
	}
	if bytes.Equal(canonical, []byte(`{}`)) {
		sink.warning(CodeFactContractAbsent, "/revision/fact_contract", "Fact Contract is absent; only semantic role/type criticality can be proven")
		return nil, canonical
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	var contract factcontract.ContractV1
	if err := decoder.Decode(&contract); err != nil {
		sink.error(CodeFactContractInvalid, "/revision/fact_contract", "decode Fact Contract v1: "+err.Error())
		return nil, canonical
	}
	normalized, validation := factcontract.NormalizeAndValidateV1(contract)
	for _, issue := range validation {
		sink.add(Diagnostic{
			Severity: SeverityError, Code: CodeFactContractInvalid,
			Path:    "/revision/fact_contract" + issue.Path,
			Message: string(issue.Code) + ": " + issue.Message,
		})
	}
	if validation.HasErrors() {
		return nil, canonical
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		sink.error(CodeFactContractInvalid, "/revision/fact_contract", "encode normalized Fact Contract: "+err.Error())
		return nil, canonical
	}
	return &normalized, encoded
}

func decodeRevisionDocument(revision campaignartifact.Revision, languageTag string, sink *diagnosticSink) (semanticemail.DocumentV2, bool) {
	decoder := json.NewDecoder(bytes.NewReader(revision.SemanticTree))
	decoder.DisallowUnknownFields()
	var nodes []semanticemail.Node
	if err := decoder.Decode(&nodes); err != nil {
		sink.error(CodeSemanticDocumentInvalid, "/revision/semantic_tree", "decode semantic node array: "+err.Error())
		return semanticemail.DocumentV2{}, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		sink.error(CodeInvalidJSON, "/revision/semantic_tree", "semantic tree contains trailing JSON")
		return semanticemail.DocumentV2{}, false
	}
	document := semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2,
		Language:      languageTag,
		Direction:     semanticemail.DirectionAuto,
		Nodes:         nodes,
	}
	return document, true
}

func prepareVariant(id string, input semanticemail.DocumentV2, inputIndex int, contract *factcontract.ContractV1, sink *diagnosticSink) preparedVariant {
	normalized, validation := semanticemail.NormalizeAndValidateV2(input)
	prefix := "/revision/semantic_tree"
	if inputIndex >= 0 {
		prefix = fmt.Sprintf("/variants/%d/document", inputIndex)
	}
	for _, issue := range validation {
		severity := SeverityWarning
		if issue.Severity == semanticemail.SeverityError {
			severity = SeverityError
		}
		sink.add(Diagnostic{
			Severity: severity, Code: CodeSemanticDocumentInvalid,
			Path: prefix + issue.Path, VariantID: id, NodeID: string(issue.NodeID),
			Message: string(issue.Code) + ": " + issue.Message,
		})
	}
	if contract != nil && normalized.Language != string(contract.Language) {
		sink.add(Diagnostic{
			Severity: SeverityError, Code: CodeInvalidLocale, Path: prefix + "/language",
			VariantID: id, Message: "variant base language must match the frozen Fact Contract language",
		})
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		sink.add(Diagnostic{Severity: SeverityError, Code: CodeSemanticDocumentInvalid, Path: prefix, VariantID: id, Message: "encode normalized semantic document: " + err.Error()})
	}
	return preparedVariant{id: id, document: normalized, documentHash: digestBytes(encoded), inputIndex: inputIndex}
}

func decodeRevisionLocales(raw json.RawMessage, sink *diagnosticSink) []string {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var locales []string
	if err := decoder.Decode(&locales); err != nil {
		sink.error(CodeInvalidJSON, "/revision/locales", "revision locales must be a JSON array of BCP 47 strings: "+err.Error())
		return nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		sink.error(CodeInvalidJSON, "/revision/locales", "revision locales contain trailing JSON")
		return nil
	}
	return locales
}

func normalizeLocales(input []string, fallback string, sink *diagnosticSink) []string {
	if len(input) == 0 {
		input = []string{fallback}
	}
	if len(input) > MaxLocales {
		sink.error(CodeLimitExceeded, "/locales", fmt.Sprintf("at most %d locales are supported", MaxLocales))
	}
	localeLimit := min(len(input), MaxLocales)
	out := make([]string, 0, localeLimit)
	seen := make(map[string]int, localeLimit)
	for i, raw := range input[:localeLimit] {
		path := fmt.Sprintf("/locales/%d", i)
		canonical, ok := canonicalLocale(raw)
		if !ok {
			sink.error(CodeInvalidLocale, path, "locale must be a syntactically valid BCP 47 language tag")
			continue
		}
		if first, duplicate := seen[canonical]; duplicate {
			sink.error(CodeDuplicate, path, fmt.Sprintf("locale collides after canonicalization with /locales/%d", first))
			continue
		}
		seen[canonical] = i
		out = append(out, canonical)
	}
	sort.Strings(out)
	return out
}

func canonicalLocale(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 255 || !utf8.ValidString(raw) || !languageTagPattern.MatchString(raw) {
		return "", false
	}
	tag, err := language.Parse(raw)
	if err != nil {
		return "", false
	}
	base, confidence := tag.Base()
	if base.String() == "und" || confidence == language.No {
		return "", false
	}
	return tag.String(), true
}

func canonicalRawHash(raw json.RawMessage, kind, path string, sink *diagnosticSink) string {
	canonical, ok := canonicalRaw(raw, kind, path, sink)
	if !ok {
		if kind == "array" {
			return digestBytes([]byte(`[]`))
		}
		return digestBytes([]byte(`{}`))
	}
	return digestBytes(canonical)
}

func canonicalRaw(raw json.RawMessage, kind, path string, sink *diagnosticSink) ([]byte, bool) {
	if len(bytes.TrimSpace(raw)) == 0 {
		if kind == "array" {
			raw = json.RawMessage(`[]`)
		} else {
			raw = json.RawMessage(`{}`)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		sink.error(CodeInvalidJSON, path, "invalid JSON: "+err.Error())
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		sink.error(CodeInvalidJSON, path, "JSON contains trailing data")
		return nil, false
	}
	switch kind {
	case "array":
		if _, ok := value.([]any); !ok {
			sink.error(CodeInvalidJSON, path, "value must be a JSON array")
			return nil, false
		}
	case "object":
		if _, ok := value.(map[string]any); !ok {
			sink.error(CodeInvalidJSON, path, "value must be a JSON object")
			return nil, false
		}
	default:
		sink.error(CodeInvalidInput, path, "unsupported canonical JSON kind")
		return nil, false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		sink.error(CodeInvalidJSON, path, "canonicalize JSON: "+err.Error())
		return nil, false
	}
	return encoded, true
}
