// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"fmt"
	"strconv"
	"strings"
)

func settingString(settings map[string]any, key string) string {
	if settings == nil {
		return ""
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return ""
	}
	switch typed := v.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

// settingStrings reads a []string-ish setting (JSON array or comma string).
func settingStrings(settings map[string]any, key string) []string {
	if settings == nil {
		return nil
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return nil
	}
	switch typed := v.(type) {
	case []string:
		return cleanStrings(typed)
	case []any:
		out := make([]string, 0, len(typed))
		for _, e := range typed {
			if s := strings.TrimSpace(fmt.Sprint(e)); s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		return cleanStrings(strings.Split(typed, ","))
	default:
		return nil
	}
}

// settingStringMap reads a map[string]string-ish setting (e.g. a field map).
func settingStringMap(settings map[string]any, key string) map[string]string {
	if settings == nil {
		return nil
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return nil
	}
	out := map[string]string{}
	switch typed := v.(type) {
	case map[string]string:
		for k, val := range typed {
			out[k] = val
		}
	case map[string]any:
		for k, val := range typed {
			if val == nil {
				continue
			}
			out[k] = strings.TrimSpace(fmt.Sprint(val))
		}
	}
	return out
}

// resolveMemberFields builds one subscriber's platform-field set. It starts from
// the static field_map (constant values applied to every member), then overlays
// trait_field_map — platformField -> traitKey — resolving each traitKey against
// THIS member's traits (custom_fields + reserved keys). Dynamic per-member values
// win over static defaults. This is the Klaviyo-class behaviour: the source
// platform record gets each person's own computed properties, not a constant.
func resolveMemberFields(staticFields, traitMap map[string]string, traits map[string]any) map[string]string {
	out := map[string]string{}
	for k, v := range staticFields {
		if k = strings.TrimSpace(k); k != "" {
			out[k] = v
		}
	}
	for platformField, traitKey := range traitMap {
		platformField = strings.TrimSpace(platformField)
		traitKey = strings.TrimSpace(traitKey)
		if platformField == "" || traitKey == "" {
			continue
		}
		raw, ok := traits[traitKey]
		if !ok || raw == nil {
			continue // missing trait: leave the static default (if any) untouched
		}
		if s := stringifyTrait(raw); s != "" {
			out[platformField] = s
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// stringifyTrait renders a JSON-decoded trait value as a platform field string.
// Whole-number floats (JSON numbers decode to float64) render without a trailing
// ".0" so an order count writes as "42", not "42.000000".
func stringifyTrait(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case bool:
		return strconv.FormatBool(t)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case nil:
		return ""
	default:
		return strings.TrimSpace(fmt.Sprint(t))
	}
}

// mergeProfileWrites folds two same-email profiles into one: fields union with
// the later profile winning on key conflicts, tags de-duplicated. Used by batch
// adapters so a chunk holding the same email twice never drops a profile's data.
func mergeProfileWrites(a, b ProfileWrite) ProfileWrite {
	fields := make(map[string]string, len(a.Fields)+len(b.Fields))
	for k, v := range a.Fields {
		fields[k] = v
	}
	for k, v := range b.Fields {
		fields[k] = v
	}
	seen := make(map[string]bool, len(a.Tags)+len(b.Tags))
	tags := make([]string, 0, len(a.Tags)+len(b.Tags))
	for _, t := range a.Tags {
		if !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	for _, t := range b.Tags {
		if !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	return ProfileWrite{Email: a.Email, Tags: tags, Fields: fields}
}

func cleanStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	return ""
}
