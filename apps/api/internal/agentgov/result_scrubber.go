// SPDX-License-Identifier: AGPL-3.0-only
package agentgov

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

const redactedLLMValue = "[redacted]"

var (
	resultEmailPattern = regexp.MustCompile(`(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b`)
	resultPhonePattern = regexp.MustCompile(`\+?[0-9][0-9 .()\-]{7,}[0-9]`)
)

// scrubLLMResult first normalizes structs/maps through JSON, then recursively
// removes keys and free-text patterns that can carry direct subscriber PII.
// Unknown custom/profile/event containers are redacted wholesale because their
// tenant-defined fields have no static sensitivity schema at this boundary.
func scrubLLMResult(result any) (any, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, errors.New("agentgov: result could not be encoded for privacy scrub")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, errors.New("agentgov: result could not be decoded for privacy scrub")
	}
	return scrubResultValue(normalized), nil
}

func scrubResultValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			if sensitiveResultContainer(key) || sensitiveResultKey(key) {
				out[key] = redactedLLMValue
				continue
			}
			out[key] = scrubResultValue(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = scrubResultValue(child)
		}
		return out
	case string:
		value := resultEmailPattern.ReplaceAllString(typed, redactedLLMValue)
		return resultPhonePattern.ReplaceAllString(value, redactedLLMValue)
	default:
		return value
	}
}

func sensitiveResultContainer(key string) bool {
	switch normalizedResultKey(key) {
	case "merge_fields", "custom_fields", "aliases", "computed_traits", "recent_events", "event_properties":
		return true
	default:
		return false
	}
}

func sensitiveResultKey(key string) bool {
	normalized := normalizedResultKey(key)
	for _, fragment := range []string{
		"email", "phone", "mobile", "address", "first_name", "last_name",
		"full_name", "external_id", "alias_value", "password", "secret",
		"token", "api_key", "remote_ip", "user_agent", "request_body",
	} {
		if normalized == fragment || strings.HasSuffix(normalized, "_"+fragment) {
			return true
		}
	}
	return normalized == "name"
}

func normalizedResultKey(key string) string {
	return strings.ToLower(strings.TrimSpace(strings.ReplaceAll(key, "-", "_")))
}
