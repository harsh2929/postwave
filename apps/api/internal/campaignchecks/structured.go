// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/structuredregistry"
)

const (
	maxStructuredDepth  = 64
	maxStructuredValues = 20_000
	maxStructuredString = 64 << 10
)

type jsonScalar struct {
	path  string
	value string
}

type boundedJSONDecoder struct {
	decoder *json.Decoder
	values  int
}

func analyzeStructuredScripts(a *analysis, result *htmlAnalysis) {
	compiled := a.input.Compilation.StructuredData
	if len(compiled) > MaxStructuredDataBytes {
		return
	}
	if len(compiled) == 0 {
		if len(result.jsonLDScripts) != 0 {
			a.add(findingSpec{
				code: "UNDECLARED_STRUCTURED_DATA", severity: SeverityCritical, blocking: true,
				overridable: true, dimension: DimensionStructuredData,
				evidence:    []EvidenceReference{{Representation: RepresentationHTMLSource, Location: "/head/script"}},
				expected:    map[string]any{"json_ld_script_count": 0},
				observed:    map[string]any{"json_ld_script_count": len(result.jsonLDScripts)},
				explanation: "HTML contains JSON-LD that is absent from the compiler's certified structured-data projection.",
				remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
			})
		}
		return
	}
	if len(result.jsonLDScripts) != 1 {
		a.add(findingSpec{
			code: "STRUCTURED_DATA_SCRIPT_COUNT_INVALID", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionStructuredData,
			evidence:    []EvidenceReference{{Representation: RepresentationHTMLSource, Location: "/head/script"}},
			expected:    map[string]any{"json_ld_script_count": 1},
			observed:    map[string]any{"json_ld_script_count": len(result.jsonLDScripts)},
			explanation: "Certified structured data must appear in exactly one compiler-authored JSON-LD script.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
		})
		return
	}
	embedded := []byte(result.jsonLDScripts[0])
	if !bytes.Equal(embedded, compiled) {
		a.add(findingSpec{
			code: "STRUCTURED_DATA_EMBEDDING_MISMATCH", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionParity,
			evidence: []EvidenceReference{
				{Representation: RepresentationStructuredData, Location: "/", SHA256: digestBytes(compiled)},
				{Representation: RepresentationHTMLSource, Location: "/head/script", SHA256: digestBytes(embedded)},
			},
			expected:    map[string]any{"sha256": digestBytes(compiled), "bytes": len(compiled)},
			observed:    map[string]any{"sha256": digestBytes(embedded), "bytes": len(embedded)},
			explanation: "The JSON-LD embedded in HTML is not byte-for-byte identical to the certified projection.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
		})
	}
	value, err := decodeBoundedJSON(compiled)
	if err != nil {
		a.add(findingSpec{
			code: "STRUCTURED_DATA_INVALID", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionStructuredData,
			evidence:    []EvidenceReference{{Representation: RepresentationStructuredData, Location: "/", SHA256: digestBytes(compiled)}},
			observed:    map[string]any{"error_class": structuredErrorClass(err)},
			explanation: "Structured data fails strict bounded JSON parsing or the provider type allowlist.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
		})
		return
	}
	if err := validateStructuredRootsForSurface(value,
		structuredregistry.Surface(a.input.DeclaredSendSurface)); err != nil {
		a.add(findingSpec{
			code: "STRUCTURED_DATA_TYPE_UNSUPPORTED", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionStructuredData,
			evidence:    []EvidenceReference{{Representation: RepresentationStructuredData, Location: "/", SHA256: digestBytes(compiled)}},
			observed:    map[string]any{"error_class": structuredErrorClass(err)},
			explanation: "Structured data uses a context or root type outside the frozen provider registry.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
		})
		return
	}
	// Analyze receives htmlAnalysis by value so update the retained result on
	// the owning analysis explicitly.
	result.structuredValid = true
	result.structuredValue = value
	result.structuredScalars = collectJSONScalars(value, "")
}

func decodeBoundedJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	state := boundedJSONDecoder{decoder: decoder}
	value, err := state.value(0)
	if err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("trailing JSON value")
		}
		return nil, err
	}
	return value, nil
}

func (state *boundedJSONDecoder) value(depth int) (any, error) {
	if depth > maxStructuredDepth {
		return nil, errors.New("structured depth limit exceeded")
	}
	state.values++
	if state.values > maxStructuredValues {
		return nil, errors.New("structured value limit exceeded")
	}
	token, err := state.decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token := token.(type) {
	case json.Delim:
		switch token {
		case '{':
			object := make(map[string]any)
			for state.decoder.More() {
				keyToken, keyErr := state.decoder.Token()
				if keyErr != nil {
					return nil, keyErr
				}
				key, ok := keyToken.(string)
				if !ok || len(key) > maxStructuredString {
					return nil, errors.New("invalid structured object key")
				}
				if _, duplicate := object[key]; duplicate {
					return nil, errors.New("duplicate structured object key")
				}
				value, valueErr := state.value(depth + 1)
				if valueErr != nil {
					return nil, valueErr
				}
				object[key] = value
			}
			closeToken, closeErr := state.decoder.Token()
			if closeErr != nil || closeToken != json.Delim('}') {
				return nil, errors.New("unterminated structured object")
			}
			return object, nil
		case '[':
			array := make([]any, 0)
			for state.decoder.More() {
				value, valueErr := state.value(depth + 1)
				if valueErr != nil {
					return nil, valueErr
				}
				array = append(array, value)
			}
			closeToken, closeErr := state.decoder.Token()
			if closeErr != nil || closeToken != json.Delim(']') {
				return nil, errors.New("unterminated structured array")
			}
			return array, nil
		default:
			return nil, errors.New("invalid structured delimiter")
		}
	case string:
		if len(token) > maxStructuredString {
			return nil, errors.New("structured string limit exceeded")
		}
		return token, nil
	case json.Number, bool, nil:
		return token, nil
	default:
		return nil, fmt.Errorf("unsupported structured token %T", token)
	}
}

// validateStructuredRoots keeps the surface-agnostic behaviour for callers that
// have no declaration to offer.
func validateStructuredRoots(value any) error {
	return validateStructuredRootsForSurface(value, "")
}

// validateStructuredRootsForSurface checks the roots against the surface the
// SENDER DECLARED they are sending to.
//
// It is a declaration, not an observation: Gmail decides which tab a message
// lands in, and we learn that only afterwards from controlled-mailbox
// placement. So this answers "is this markup coherent with what you said you
// were sending", which is a real error worth blocking — attaching a Promotions
// annotation to a receipt ships structured data Gmail will ignore — while
// making no claim about where the message actually landed.
func validateStructuredRootsForSurface(value any, surface structuredregistry.Surface) error {
	objects := []map[string]any{}
	switch typed := value.(type) {
	case map[string]any:
		objects = append(objects, typed)
	case []any:
		if len(typed) == 0 || len(typed) > 64 {
			return errors.New("structured root array count invalid")
		}
		for _, item := range typed {
			object, ok := item.(map[string]any)
			if !ok {
				return errors.New("structured root must contain objects")
			}
			objects = append(objects, object)
		}
	default:
		return errors.New("structured root must be object or array")
	}
	// Sourced from the provider/surface registry rather than a second literal
	// list, so the two cannot drift apart.
	//
	// With a DECLARED surface we ask the surface-specific question; without one
	// we fall back to the union across surfaces. The fallback widens only the
	// SURFACE question — an unregistered type is refused either way.
	allowedTypes := map[string]struct{}{}
	switch {
	case surface == "":
		for _, markupType := range structuredregistry.AllKnownTypes() {
			allowedTypes[markupType] = struct{}{}
		}
	default:
		// An unrecognised surface yields an empty set rather than the union.
		// Falling back on an unknown value would turn any invented surface name
		// into a way around the per-surface rule.
		for _, markupType := range structuredregistry.SupportedTypes(
			structuredregistry.ProviderGmail, surface) {
			allowedTypes[markupType] = struct{}{}
		}
	}
	for _, object := range objects {
		context, contextOK := object["@context"].(string)
		kind, kindOK := object["@type"].(string)
		if !contextOK || (context != "http://schema.org" && context != "https://schema.org") || !kindOK {
			return errors.New("structured root context or type invalid")
		}
		if _, allowed := allowedTypes[kind]; !allowed {
			return errors.New("structured root type unsupported")
		}
	}
	return nil
}

func collectJSONScalars(value any, path string) []jsonScalar {
	result := make([]jsonScalar, 0)
	var walk func(any, string)
	walk = func(current any, currentPath string) {
		switch typed := current.(type) {
		case map[string]any:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sortStrings(keys)
			for _, key := range keys {
				walk(typed[key], currentPath+"/"+escapePointer(key))
			}
		case []any:
			for index, item := range typed {
				walk(item, fmt.Sprintf("%s/%d", currentPath, index))
			}
		case string:
			result = append(result, jsonScalar{path: currentPath, value: typed})
		case json.Number:
			result = append(result, jsonScalar{path: currentPath, value: typed.String()})
		case bool:
			result = append(result, jsonScalar{path: currentPath, value: fmt.Sprintf("%t", typed)})
		}
	}
	walk(value, path)
	return result
}

func sortStrings(values []string) {
	for index := 1; index < len(values); index++ {
		for cursor := index; cursor > 0 && values[cursor] < values[cursor-1]; cursor-- {
			values[cursor], values[cursor-1] = values[cursor-1], values[cursor]
		}
	}
}

func escapePointer(value string) string {
	value = strings.ReplaceAll(value, "~", "~0")
	return strings.ReplaceAll(value, "/", "~1")
}

func structuredErrorClass(err error) string {
	if err == nil {
		return ""
	}
	message := strings.ToLower(err.Error())
	for _, class := range []string{
		"duplicate structured object key", "structured depth limit exceeded", "structured value limit exceeded",
		"structured string limit exceeded", "trailing json value", "structured root type unsupported",
		"structured root context or type invalid", "structured root must be object or array",
	} {
		if strings.Contains(message, class) {
			return strings.ReplaceAll(class, " ", "_")
		}
	}
	return "invalid_json"
}
