// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignplanbuilder"
	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/mimecomposer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

type frozenTransformManifest struct {
	Version                string                         `json:"version"`
	BuilderVersion         string                         `json:"builder_version"`
	CompilerVersion        string                         `json:"compiler_version"`
	SemanticCompiler       string                         `json:"semantic_compiler_version"`
	HTMLRenderer           string                         `json:"html_renderer_version"`
	TextRenderer           string                         `json:"text_renderer_version"`
	TransformVersion       string                         `json:"transform_version"`
	MIMEFormatVersion      string                         `json:"mime_format_version"`
	EnvelopeFactoryVersion string                         `json:"envelope_factory_version"`
	PolicyVersion          string                         `json:"policy_version"`
	TrackingSettings       json.RawMessage                `json:"tracking_settings"`
	StructuredPolicy       semanticemail.StructuredPolicy `json:"structured_policy"`
}

type reviewedSemanticVariant struct {
	AdapterVersion string                   `json:"adapter_version"`
	ID             string                   `json:"id"`
	Subject        string                   `json:"subject"`
	Document       semanticemail.DocumentV2 `json:"document"`
}

type selectedSource struct {
	revision       campaignartifact.Revision
	document       semanticemail.DocumentV2
	variantID      string
	manifestID     string
	documentHash   string
	requestedSlots []semanticemail.SlotID
}

func decodeTransformManifest(plan campaignartifact.Plan) (frozenTransformManifest, error) {
	canonical, err := canonicalJSON(plan.TransformManifest, "object")
	if err != nil {
		return frozenTransformManifest{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	var manifest frozenTransformManifest
	if err := decoder.Decode(&manifest); err != nil {
		return frozenTransformManifest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return frozenTransformManifest{}, errors.New("transform manifest contains trailing JSON")
	}
	tracking, err := canonicalJSON(manifest.TrackingSettings, "object")
	if err != nil {
		return frozenTransformManifest{}, err
	}
	manifest.TrackingSettings = tracking
	if manifest.Version != campaignplanbuilder.TransformManifestVersion ||
		manifest.BuilderVersion != campaignplanbuilder.Version ||
		manifest.CompilerVersion != campaigncompiler.Version ||
		manifest.SemanticCompiler != semanticemail.CompilerVersion ||
		manifest.HTMLRenderer != semanticemail.HTMLRendererVersion ||
		manifest.TextRenderer != semanticemail.TextRendererVersion ||
		manifest.TransformVersion != campaigntransform.Version ||
		manifest.MIMEFormatVersion != mimecomposer.FormatVersion ||
		manifest.CompilerVersion != plan.CompilerVersion ||
		manifest.HTMLRenderer != plan.RendererVersion ||
		manifest.PolicyVersion != plan.PolicyVersion ||
		strings.TrimSpace(manifest.EnvelopeFactoryVersion) == "" {
		return frozenTransformManifest{}, errors.New("unsupported transform implementation identity")
	}
	return manifest, nil
}

func decodeCoverage(plan campaignartifact.Plan) (campaigncoverage.Manifest, error) {
	canonical, err := canonicalJSON(plan.CoverageManifest, "object")
	if err != nil {
		return campaigncoverage.Manifest{}, err
	}
	var manifest campaigncoverage.Manifest
	if err := strictDecode(canonical, &manifest); err != nil {
		return campaigncoverage.Manifest{}, err
	}
	diagnostics := campaigncoverage.ValidateManifest(manifest)
	if diagnostics.HasErrors() {
		return campaigncoverage.Manifest{}, diagnostics
	}
	return manifest, nil
}

func selectSource(revision campaignartifact.Revision, manifest campaigncoverage.Manifest, rowVariantID string) (selectedSource, error) {
	if revision.SourceMode != campaignartifact.SourceModeSemantic ||
		revision.ContentSchemaVersion != semanticemail.SchemaVersionV2 {
		return selectedSource{}, fmt.Errorf("semantic v2 source is required")
	}
	rowVariantID = strings.TrimSpace(rowVariantID)
	var (
		document   semanticemail.DocumentV2
		manifestID string
		subject    = revision.Subject
	)
	if len(manifest.Variants) == 1 && manifest.Variants[0].ID == "control" {
		if rowVariantID != "" {
			return selectedSource{}, fmt.Errorf("control plan cannot select variant %q", rowVariantID)
		}
		manifestID = "control"
		languageCode := factContractLanguage(revision.FactContract)
		if languageCode == "" && len(manifest.Locales) != 0 {
			languageCode = manifest.Locales[0]
		}
		if languageCode == "" {
			languageCode = "en"
		}
		var nodes []semanticemail.Node
		if err := strictDecode(revision.SemanticTree, &nodes); err != nil {
			return selectedSource{}, err
		}
		document = semanticemail.DocumentV2{
			SchemaVersion: semanticemail.SchemaVersionV2, Language: languageCode,
			Direction: semanticemail.DirectionAuto, Nodes: nodes,
		}
	} else {
		if rowVariantID == "" {
			return selectedSource{}, errors.New("variant plan requires an exact recipient variant id")
		}
		var variants []reviewedSemanticVariant
		if err := strictDecode(revision.Variants, &variants); err != nil {
			return selectedSource{}, err
		}
		found := false
		for _, variant := range variants {
			if variant.ID != rowVariantID {
				continue
			}
			if found || variant.AdapterVersion != campaignplanbuilder.ReviewedVariantAdapterVersion {
				return selectedSource{}, errors.New("variant identity is duplicated or uses an unsupported adapter")
			}
			found = true
			manifestID, subject, document = variant.ID, variant.Subject, variant.Document
		}
		if !found {
			return selectedSource{}, fmt.Errorf("variant %q is absent from frozen revision", rowVariantID)
		}
	}
	normalized, diagnostics := semanticemail.NormalizeAndValidateV2(document)
	if diagnostics.HasErrors() {
		return selectedSource{}, diagnostics
	}
	document = normalized
	encoded, err := json.Marshal(document)
	if err != nil {
		return selectedSource{}, err
	}
	documentHash := digestBytes(encoded)
	wantHash := ""
	for _, variant := range manifest.Variants {
		if variant.ID == manifestID {
			wantHash = variant.DocumentHash
			break
		}
	}
	if wantHash == "" || wantHash != documentHash {
		return selectedSource{}, errors.New("selected semantic document differs from coverage variant identity")
	}
	revision.Subject = subject
	return selectedSource{
		revision: revision, document: document, variantID: rowVariantID,
		manifestID: manifestID, documentHash: documentHash,
		requestedSlots: collectSlots(document),
	}, nil
}

func strictDecode(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing data")
	}
	return nil
}

func factContractLanguage(raw json.RawMessage) string {
	var value struct {
		Language string `json:"language"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value.Language)
}

func collectSlots(document semanticemail.DocumentV2) []semanticemail.SlotID {
	seen := make(map[semanticemail.SlotID]struct{})
	collectRich := func(rich semanticemail.RichText) {
		for _, run := range rich.Runs {
			if run.Kind == semanticemail.InlineSlot && run.Slot != nil {
				seen[run.Slot.ID] = struct{}{}
			}
		}
	}
	var collectContent func(semanticemail.NodeContent)
	collectContent = func(content semanticemail.NodeContent) {
		if content.Heading != nil {
			collectRich(content.Heading.Text)
		}
		if content.Paragraph != nil {
			collectRich(content.Paragraph.Text)
		}
		if content.List != nil {
			for _, item := range content.List.Items {
				collectRich(item)
			}
		}
		if content.Answer != nil {
			collectRich(content.Answer.Question)
			collectRich(content.Answer.Answer)
		}
		if content.Legal != nil {
			collectRich(content.Legal.Text)
		}
		if content.Offer != nil {
			collectRich(content.Offer.Description)
			collectRich(content.Offer.Terms)
		}
		if content.Personalization != nil {
			seen[content.Personalization.Slot.ID] = struct{}{}
		}
	}
	for _, node := range document.Nodes {
		for _, condition := range node.Conditions {
			seen[condition.SlotID] = struct{}{}
		}
		collectContent(node.Content)
		for _, localized := range node.Localizations {
			collectContent(localized)
		}
	}
	values := make([]string, 0, len(seen))
	byString := make(map[string]semanticemail.SlotID, len(seen))
	for value := range seen {
		values = append(values, string(value))
		byString[string(value)] = value
	}
	sort.Strings(values)
	out := make([]semanticemail.SlotID, len(values))
	for index, value := range values {
		out[index] = byString[value]
	}
	return out
}

func normalizeRecipientValues(input RecipientValues) (RecipientValues, error) {
	out := RecipientValues{Locale: strings.TrimSpace(input.Locale), Slots: make(map[semanticemail.SlotID]string, len(input.Slots))}
	for key, value := range input.Slots {
		normalizedKey := semanticemail.SlotID(strings.TrimSpace(string(key)))
		if normalizedKey == "" {
			return RecipientValues{}, errors.New("resolver returned an empty slot identity")
		}
		if _, duplicate := out.Slots[normalizedKey]; duplicate {
			return RecipientValues{}, fmt.Errorf("resolver returned duplicate normalized slot %q", normalizedKey)
		}
		out.Slots[normalizedKey] = normalizeSlotValue(value)
	}
	return out, nil
}

func normalizeSlotValue(value string) string {
	if !utf8.ValidString(value) {
		return value
	}
	return strings.Join(strings.FieldsFunc(norm.NFKC.String(value), unicode.IsSpace), " ")
}

func resolveLocale(raw string, manifest campaigncoverage.Manifest) (string, error) {
	if strings.TrimSpace(raw) == "" {
		if len(manifest.Locales) == 1 {
			return manifest.Locales[0], nil
		}
		return "", errors.New("recipient locale is required for a multi-locale plan")
	}
	tag, err := language.Parse(strings.TrimSpace(raw))
	if err != nil || tag == language.Und {
		return "", errors.New("recipient locale is invalid")
	}
	locale := tag.String()
	for _, candidate := range manifest.Locales {
		if candidate == locale {
			return locale, nil
		}
	}
	return "", fmt.Errorf("locale %q is outside frozen coverage", locale)
}

func branchForValues(document semanticemail.DocumentV2, variantID string, slots map[semanticemail.SlotID]string, manifest campaigncoverage.Manifest) (campaigncoverage.Branch, error) {
	outcomes := make([]campaigncoverage.NodeOutcome, 0)
	for _, node := range document.Nodes {
		if len(node.Conditions) == 0 {
			continue
		}
		outcome := campaigncoverage.NodeOutcome{NodeID: string(node.ID), Included: true, Conditions: make([]campaigncoverage.ConditionOutcome, 0, len(node.Conditions))}
		for _, condition := range node.Conditions {
			value, exists := slots[condition.SlotID]
			present, matched := exists && value != "", false
			switch condition.Operator {
			case semanticemail.ConditionPresent:
				matched = present
			case semanticemail.ConditionAbsent:
				matched = !present
			case semanticemail.ConditionEquals:
				if !exists {
					return campaigncoverage.Branch{}, errors.New("equality condition has no recipient value")
				}
				matched = value == condition.Value
			case semanticemail.ConditionNotEquals:
				if !exists {
					return campaigncoverage.Branch{}, errors.New("inequality condition has no recipient value")
				}
				matched = value != condition.Value
			default:
				return campaigncoverage.Branch{}, errors.New("unsupported semantic condition")
			}
			outcome.Conditions = append(outcome.Conditions, campaigncoverage.ConditionOutcome{ConditionID: string(condition.ID), Matched: matched})
			outcome.Included = outcome.Included && matched
		}
		outcomes = append(outcomes, outcome)
	}
	for _, branch := range manifest.Branches {
		if branch.VariantID == variantID && equalOutcomes(branch.Outcomes, outcomes) {
			return branch, nil
		}
	}
	if len(outcomes) == 0 {
		for _, branch := range manifest.Branches {
			if branch.VariantID == variantID && len(branch.Outcomes) == 0 {
				return branch, nil
			}
		}
	}
	return campaigncoverage.Branch{}, errors.New("recipient condition outcome has no frozen branch")
}

func equalOutcomes(left, right []campaigncoverage.NodeOutcome) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].NodeID != right[index].NodeID || left[index].Included != right[index].Included || len(left[index].Conditions) != len(right[index].Conditions) {
			return false
		}
		for condition := range left[index].Conditions {
			if left[index].Conditions[condition] != right[index].Conditions[condition] {
				return false
			}
		}
	}
	return true
}

func selectScenario(manifest campaigncoverage.Manifest, variantID, locale, branchKey string, requestedSlots []semanticemail.SlotID, slots map[semanticemail.SlotID]string) (campaigncoverage.Scenario, error) {
	fixtureByID := make(map[string]campaigncoverage.Fixture, len(manifest.Fixtures))
	for _, fixture := range manifest.Fixtures {
		fixtureByID[fixture.ID] = fixture
	}
	profile := recipientProfile(requestedSlots, slots)
	for _, scenario := range manifest.Scenarios {
		if scenario.VariantID != variantID || scenario.Locale != locale || scenario.BranchKey != branchKey {
			continue
		}
		fixture := fixtureByID[scenario.FixtureID]
		if fixtureMatches(fixture, slots, profile) {
			return scenario, nil
		}
	}
	return campaigncoverage.Scenario{}, fmt.Errorf("no %s fixture covers the recipient slot class", profile)
}

func fixtureMatches(fixture campaigncoverage.Fixture, slots map[semanticemail.SlotID]string, profile campaigncoverage.FixtureProfile) bool {
	for _, assignment := range fixture.Assignments {
		value, exists := slots[semanticemail.SlotID(assignment.SlotID)]
		state := campaigncoverage.AssignmentMissing
		if exists && value == "" {
			state = campaigncoverage.AssignmentEmpty
		} else if exists {
			state = campaigncoverage.AssignmentValue
		}
		if state != assignment.State {
			return false
		}
	}
	for _, candidate := range fixture.Profiles {
		if candidate == profile {
			return true
		}
		if candidate == campaigncoverage.FixtureBranchWitness && (profile == campaigncoverage.FixtureBaseline || profile == campaigncoverage.FixtureMissingOptional) {
			return true
		}
	}
	return false
}

func recipientProfile(requestedSlots []semanticemail.SlotID, slots map[semanticemail.SlotID]string) campaigncoverage.FixtureProfile {
	missing := false
	for _, slot := range requestedSlots {
		value, exists := slots[slot]
		runes := []rune(value)
		if !exists || value == "" {
			missing = true
		}
		if len(runes) >= 256 {
			return campaigncoverage.FixtureLong
		}
		for _, current := range runes {
			if unicode.In(current, unicode.Arabic, unicode.Hebrew) {
				return campaigncoverage.FixtureRTL
			}
		}
	}
	for _, slot := range requestedSlots {
		value := slots[slot]
		for _, current := range value {
			if current > unicode.MaxASCII {
				return campaigncoverage.FixtureUnicode
			}
		}
	}
	if missing {
		return campaigncoverage.FixtureMissingOptional
	}
	return campaigncoverage.FixtureBaseline
}
