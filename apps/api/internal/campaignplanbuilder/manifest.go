// SPDX-License-Identifier: AGPL-3.0-only

package campaignplanbuilder

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/mimecomposer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

type transformManifestV1 struct {
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

func buildTransformManifest(input CompileInput) (json.RawMessage, json.RawMessage, error) {
	if !validImplementationVersion(input.EnvelopeFactoryVersion) {
		return nil, nil, fmt.Errorf("%w: envelope_factory_version is required and must be a bounded implementation identity", ErrInvalidInput)
	}
	if !validImplementationVersion(input.PolicyVersion) {
		return nil, nil, fmt.Errorf("%w: policy_version is required and must be a bounded implementation identity", ErrInvalidInput)
	}
	tracking, err := canonicalJSONObject(input.TrackingSettings)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: tracking_settings: %v", ErrInvalidInput, err)
	}
	encoded, err := json.Marshal(transformManifestV1{
		Version: TransformManifestVersion, BuilderVersion: Version,
		CompilerVersion: campaigncompiler.Version, SemanticCompiler: semanticemail.CompilerVersion,
		HTMLRenderer: semanticemail.HTMLRendererVersion, TextRenderer: semanticemail.TextRendererVersion,
		TransformVersion: campaigntransform.Version, MIMEFormatVersion: mimecomposer.FormatVersion,
		EnvelopeFactoryVersion: strings.TrimSpace(input.EnvelopeFactoryVersion),
		PolicyVersion:          strings.TrimSpace(input.PolicyVersion),
		TrackingSettings:       tracking, StructuredPolicy: input.StructuredPolicy,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("%w: encode transform manifest: %v", ErrInvalidInput, err)
	}
	manifest, err := canonicalJSONObject(encoded)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: canonicalize transform manifest: %v", ErrInvalidInput, err)
	}
	return tracking, manifest, nil
}

func validateTransformManifest(raw json.RawMessage, bundle Bundle) error {
	canonical, err := canonicalJSONObject(raw)
	if err != nil || !bytes.Equal(canonical, raw) {
		return errors.New("transform manifest must be a canonical JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var manifest transformManifestV1
	if err := decoder.Decode(&manifest); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("transform manifest contains trailing JSON")
	}
	tracking, err := canonicalJSONObject(manifest.TrackingSettings)
	if err != nil {
		return fmt.Errorf("tracking settings: %w", err)
	}
	wantTracking, err := canonicalJSONObject(bundle.TrackingSettings)
	if err != nil {
		return fmt.Errorf("bundle tracking settings: %w", err)
	}
	if manifest.Version != TransformManifestVersion || manifest.BuilderVersion != Version ||
		manifest.CompilerVersion != campaigncompiler.Version || manifest.SemanticCompiler != semanticemail.CompilerVersion ||
		manifest.HTMLRenderer != semanticemail.HTMLRendererVersion || manifest.TextRenderer != semanticemail.TextRendererVersion ||
		manifest.TransformVersion != campaigntransform.Version || manifest.MIMEFormatVersion != mimecomposer.FormatVersion ||
		manifest.EnvelopeFactoryVersion != bundle.EnvelopeFactory || manifest.PolicyVersion != bundle.PolicyVersion ||
		!bytes.Equal(tracking, wantTracking) || manifest.StructuredPolicy != bundle.StructuredPolicy {
		return errors.New("transform manifest implementation or policy identity differs from the compiled bundle")
	}
	return nil
}

func canonicalJSONObject(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("contains trailing JSON")
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, errors.New("must be a JSON object")
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func validImplementationVersion(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 160 {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}
