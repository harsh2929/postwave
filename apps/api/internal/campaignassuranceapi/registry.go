// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

const (
	maxSuiteConfigurations = 64
	maxConfigurationBytes  = 64 << 10
)

var (
	// ErrInvalidSuiteRegistry is returned when deployment-owned methodology is
	// incomplete or unsafe to freeze at startup.
	ErrInvalidSuiteRegistry = errors.New("campaign assurance api: invalid suite registry")
	configurationIDPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)
	hashPattern             = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// SuiteDefinition is deployment-owned methodology configuration. It is never
// decoded from a public request. A deployment constructs all three profiles at
// startup and the registry takes defensive copies of every byte slice.
type SuiteDefinition struct {
	Profile              string
	AnalyzerSuiteVersion string
	ModelSuiteVersion    string
	PromptSuiteVersion   string
	PromptSuiteHash      string
	NormalizationVersion string
	ScoringVersion       string
	GatePolicyVersion    string
	MethodologyVersion   string
	Configurations       []campaignassurance.ConfigurationInput
	MaxAttempts          int
}

// SuiteRegistry is an immutable, closed registry of the fast, full, and
// calibration analyzer suites. Resolve always returns a defensive copy, so a
// handler, worker, or caller cannot mutate the deployment's methodology after
// startup.
type SuiteRegistry struct {
	byProfile map[string]SuiteDefinition
}

// NewSuiteRegistry validates and freezes one definition for every public
// profile. There is deliberately no permissive/default registry: production
// composition must name exact analyzer, model, prompt, scoring, and gate
// versions before the write route can be mounted.
func NewSuiteRegistry(definitions []SuiteDefinition) (*SuiteRegistry, error) {
	if len(definitions) != 3 {
		return nil, fmt.Errorf("%w: fast, full, and calibration definitions are required", ErrInvalidSuiteRegistry)
	}
	registry := &SuiteRegistry{byProfile: make(map[string]SuiteDefinition, 3)}
	for _, raw := range definitions {
		definition, err := normalizeSuiteDefinition(raw)
		if err != nil {
			return nil, err
		}
		if _, duplicate := registry.byProfile[definition.Profile]; duplicate {
			return nil, fmt.Errorf("%w: duplicate profile %q", ErrInvalidSuiteRegistry, definition.Profile)
		}
		registry.byProfile[definition.Profile] = definition
	}
	for _, profile := range []string{
		campaignassurance.ProfileFast,
		campaignassurance.ProfileFull,
		campaignassurance.ProfileCalibration,
	} {
		if _, exists := registry.byProfile[profile]; !exists {
			return nil, fmt.Errorf("%w: profile %q is required", ErrInvalidSuiteRegistry, profile)
		}
	}
	return registry, nil
}

// Resolve returns the exact server-owned definition for profile. Public
// callers can select a profile name, but cannot supply or amend its contents.
func (r *SuiteRegistry) Resolve(profile string) (SuiteDefinition, bool) {
	if r == nil {
		return SuiteDefinition{}, false
	}
	definition, ok := r.byProfile[strings.TrimSpace(profile)]
	if !ok {
		return SuiteDefinition{}, false
	}
	return cloneSuiteDefinition(definition), true
}

func normalizeSuiteDefinition(input SuiteDefinition) (SuiteDefinition, error) {
	input.Profile = strings.TrimSpace(input.Profile)
	switch input.Profile {
	case campaignassurance.ProfileFast, campaignassurance.ProfileFull, campaignassurance.ProfileCalibration:
	default:
		return SuiteDefinition{}, fmt.Errorf("%w: unsupported profile", ErrInvalidSuiteRegistry)
	}
	versions := []struct {
		name  string
		value *string
		max   int
	}{
		{"analyzer suite version", &input.AnalyzerSuiteVersion, 160},
		{"model suite version", &input.ModelSuiteVersion, 200},
		{"prompt suite version", &input.PromptSuiteVersion, 160},
		{"normalization version", &input.NormalizationVersion, 160},
		{"scoring version", &input.ScoringVersion, 160},
		{"gate policy version", &input.GatePolicyVersion, 160},
		{"methodology version", &input.MethodologyVersion, 160},
	}
	for _, version := range versions {
		*version.value = strings.TrimSpace(*version.value)
		if !validSuiteText(*version.value, version.max) {
			return SuiteDefinition{}, fmt.Errorf("%w: invalid %s", ErrInvalidSuiteRegistry, version.name)
		}
	}
	input.PromptSuiteHash = strings.TrimSpace(input.PromptSuiteHash)
	if !hashPattern.MatchString(input.PromptSuiteHash) {
		return SuiteDefinition{}, fmt.Errorf("%w: prompt suite hash must be lowercase SHA-256", ErrInvalidSuiteRegistry)
	}
	if input.MaxAttempts < 1 || input.MaxAttempts > 20 {
		return SuiteDefinition{}, fmt.Errorf("%w: max attempts must be 1..20", ErrInvalidSuiteRegistry)
	}
	if len(input.Configurations) < 1 || len(input.Configurations) > maxSuiteConfigurations {
		return SuiteDefinition{}, fmt.Errorf("%w: configurations must contain 1..%d items", ErrInvalidSuiteRegistry, maxSuiteConfigurations)
	}
	seen := make(map[string]struct{}, len(input.Configurations))
	configurations := make([]campaignassurance.ConfigurationInput, len(input.Configurations))
	for index, configuration := range input.Configurations {
		configuration.ID = strings.TrimSpace(configuration.ID)
		configuration.SourceClass = strings.TrimSpace(configuration.SourceClass)
		if !configurationIDPattern.MatchString(configuration.ID) {
			return SuiteDefinition{}, fmt.Errorf("%w: invalid configuration id", ErrInvalidSuiteRegistry)
		}
		if _, duplicate := seen[configuration.ID]; duplicate {
			return SuiteDefinition{}, fmt.Errorf("%w: duplicate configuration id", ErrInvalidSuiteRegistry)
		}
		seen[configuration.ID] = struct{}{}
		switch configuration.SourceClass {
		case campaignassurance.SourceDeterministic,
			campaignassurance.SourceModeled,
			campaignassurance.SourceControlledObservation:
		default:
			return SuiteDefinition{}, fmt.Errorf("%w: invalid source class", ErrInvalidSuiteRegistry)
		}
		canonical, err := canonicalJSONObject(configuration.Configuration)
		if err != nil {
			return SuiteDefinition{}, fmt.Errorf("%w: configuration %q: %v", ErrInvalidSuiteRegistry, configuration.ID, err)
		}
		configuration.Configuration = canonical
		configurations[index] = configuration
	}
	input.Configurations = configurations
	return cloneSuiteDefinition(input), nil
}

func canonicalJSONObject(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 || len(raw) > maxConfigurationBytes {
		return nil, errors.New("configuration must be a bounded JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("configuration must be valid JSON")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, errors.New("configuration must contain one JSON value")
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, errors.New("configuration must be a JSON object")
	}
	canonical, err := json.Marshal(value)
	if err != nil || len(canonical) > maxConfigurationBytes {
		return nil, errors.New("configuration exceeds its encoded limit")
	}
	return canonical, nil
}

func cloneSuiteDefinition(input SuiteDefinition) SuiteDefinition {
	input.Configurations = append([]campaignassurance.ConfigurationInput(nil), input.Configurations...)
	for index := range input.Configurations {
		input.Configurations[index].Configuration = append(
			json.RawMessage(nil), input.Configurations[index].Configuration...,
		)
	}
	return input
}

func validSuiteText(value string, maximumRunes int) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximumRunes {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}
