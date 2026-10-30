// SPDX-License-Identifier: AGPL-3.0-only

package campaignplanbuilder

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"golang.org/x/text/language"
)

var frozenLocalePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$`)

// reviewedSemanticVariantV1 is the only non-control frozen variant shape that
// can enter v1 coverage. Historical campaign_variants objects containing
// body_html/body_mjml are deliberately rejected instead of being guessed into
// a semantic document. Subject is the effective (already inherited) subject,
// so every compiled variant is self-contained.
type reviewedSemanticVariantV1 struct {
	AdapterVersion string                   `json:"adapter_version"`
	ID             string                   `json:"id"`
	Subject        string                   `json:"subject"`
	Document       semanticemail.DocumentV2 `json:"document"`
}

type adaptedVariantSet struct {
	coverage []campaigncoverage.Variant
	byID     map[string]reviewedSemanticVariantV1
	control  bool
}

func adaptFrozenVariants(revision campaignartifact.Revision) (adaptedVariantSet, error) {
	raw := bytes.TrimSpace(revision.Variants)
	if len(raw) == 0 || raw[0] != '[' {
		return adaptedVariantSet{}, adapterError(ErrVariantAdapter, "/revision/variants", "variants must be a JSON array")
	}
	if len(raw) > maxFrozenVariantBytes {
		return adaptedVariantSet{}, adapterError(ErrVariantAdapter, "/revision/variants", fmt.Sprintf("variants exceed %d bytes", maxFrozenVariantBytes))
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var entries []reviewedSemanticVariantV1
	if err := decoder.Decode(&entries); err != nil {
		return adaptedVariantSet{}, adapterError(ErrVariantAdapter, "/revision/variants", "strict decode: "+err.Error())
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return adaptedVariantSet{}, adapterError(ErrVariantAdapter, "/revision/variants", "trailing JSON is not allowed")
	}
	if len(entries) == 0 {
		return adaptedVariantSet{byID: map[string]reviewedSemanticVariantV1{}, control: true}, nil
	}
	if len(entries) > campaigncoverage.MaxVariants {
		return adaptedVariantSet{}, adapterError(ErrVariantAdapter, "/revision/variants", fmt.Sprintf("at most %d reviewed variants are supported", campaigncoverage.MaxVariants))
	}

	result := adaptedVariantSet{
		coverage: make([]campaigncoverage.Variant, 0, len(entries)),
		byID:     make(map[string]reviewedSemanticVariantV1, len(entries)),
	}
	for index, entry := range entries {
		path := fmt.Sprintf("/revision/variants/%d", index)
		if entry.AdapterVersion != ReviewedVariantAdapterVersion {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/adapter_version", "unsupported or missing reviewed adapter version")
		}
		entry.ID = strings.TrimSpace(entry.ID)
		parsedID, err := uuid.Parse(entry.ID)
		if err != nil || parsedID.String() != entry.ID {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/id", "reviewed semantic variant id must be a UUID")
		}
		if _, duplicate := result.byID[entry.ID]; duplicate {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/id", "duplicate reviewed semantic variant id")
		}
		if err := validateFrozenSubject(entry.Subject); err != nil {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/subject", err.Error())
		}
		normalized, diagnostics := semanticemail.NormalizeAndValidateV2(entry.Document)
		if diagnostics.HasErrors() {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/document", diagnostics.Error())
		}
		encodedInput, inputErr := json.Marshal(entry.Document)
		encodedNormalized, normalizedErr := json.Marshal(normalized)
		if inputErr != nil || normalizedErr != nil {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/document", "document cannot be encoded canonically")
		}
		if len(encodedNormalized) > semanticemail.MaxDocumentJSONBytes {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/document", fmt.Sprintf("document exceeds %d bytes", semanticemail.MaxDocumentJSONBytes))
		}
		if !bytes.Equal(encodedInput, encodedNormalized) {
			return adaptedVariantSet{}, adapterError(ErrVariantAdapter, path+"/document", "reviewed semantic document must already be normalized")
		}
		entry.Document = normalized
		result.byID[entry.ID] = entry
		result.coverage = append(result.coverage, campaigncoverage.Variant{ID: entry.ID, Document: normalized})
	}
	sort.Slice(result.coverage, func(left, right int) bool { return result.coverage[left].ID < result.coverage[right].ID })
	return result, nil
}

func adaptFrozenLocales(raw json.RawMessage) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, adapterError(ErrLocaleAdapter, "/revision/locales", "locales must be a JSON array")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var values []string
	if err := decoder.Decode(&values); err != nil {
		return nil, adapterError(ErrLocaleAdapter, "/revision/locales", "strict decode: "+err.Error())
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, adapterError(ErrLocaleAdapter, "/revision/locales", "trailing JSON is not allowed")
	}
	if len(values) > campaigncoverage.MaxLocales {
		return nil, adapterError(ErrLocaleAdapter, "/revision/locales", fmt.Sprintf("at most %d locales are supported", campaigncoverage.MaxLocales))
	}
	seen := make(map[string]int, len(values))
	canonical := make([]string, 0, len(values))
	for index, rawLocale := range values {
		path := fmt.Sprintf("/revision/locales/%d", index)
		value := strings.TrimSpace(rawLocale)
		if value == "" || value != rawLocale || len(value) > 255 || !utf8.ValidString(value) || !frozenLocalePattern.MatchString(value) {
			return nil, adapterError(ErrLocaleAdapter, path, "locale must be an unpadded syntactically valid BCP 47 tag")
		}
		tag, err := language.Parse(value)
		if err != nil || tag == language.Und {
			return nil, adapterError(ErrLocaleAdapter, path, "locale must be a syntactically valid BCP 47 tag")
		}
		normalized := tag.String()
		if first, duplicate := seen[normalized]; duplicate {
			return nil, adapterError(ErrLocaleAdapter, path, fmt.Sprintf("locale duplicates /revision/locales/%d after canonicalization", first))
		}
		seen[normalized] = index
		canonical = append(canonical, normalized)
	}
	sort.Strings(canonical)
	return canonical, nil
}

func validateFrozenSubject(subject string) error {
	if subject == "" || strings.TrimSpace(subject) != subject || !utf8.ValidString(subject) || len(subject) > 998 {
		return errors.New("effective subject must be non-empty, unpadded UTF-8 and at most 998 bytes")
	}
	for _, current := range subject {
		if unicode.IsControl(current) {
			return errors.New("effective subject must not contain control characters")
		}
	}
	return nil
}

func adapterError(kind error, path, message string) error {
	return fmt.Errorf("%w: %s: %s", kind, path, message)
}
