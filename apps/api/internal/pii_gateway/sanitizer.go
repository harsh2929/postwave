// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-072 — AI gateway / privacy firewall for prompts.
//
// sanitizer.go is the prompt sanitization layer. Given a set of sensitive
// subscriber field values (resolved from the tenant's pii_tokenization_config),
// it replaces every occurrence of those cleartext values inside a prompt with
// an opaque, reversible token from a per-request TokenRegistry. The model never
// sees the cleartext; the registry detokenizes the response on the way back.
//
// The substitution is value-based, not field-based: we know the actual
// sensitive values (e.g. "alice@example.com", "+15551234567") and replace them
// wherever they appear in the rendered prompt. This is robust to the prompt
// template interpolating a value in an unexpected place, because we match the
// value itself rather than trusting a template placeholder.

package pii_gateway

import (
	"sort"
	"strings"
)

// FieldSensitivity is one (field, sensitive?) flag from the tenant's
// pii_tokenization_config. BuiltIn marks the always-on identifier pseudo-fields
// (email / phone) the UI renders as locked.
type FieldSensitivity struct {
	FieldName string `json:"field_name"`
	Sensitive bool   `json:"sensitive"`
	BuiltIn   bool   `json:"built_in"`
}

// Sanitizer tokenizes sensitive values out of a prompt before a model call and
// detokenizes them back on the response. Implementations are request-scoped:
// one Sanitizer owns one TokenRegistry, so tokens never leak between requests.
type Sanitizer interface {
	// Sanitize replaces every registered sensitive value in prompt with a
	// reversible token and returns the redacted prompt.
	Sanitize(prompt string) string
	// Restore reverses the tokens in a model response back to cleartext.
	Restore(response string) string
}

// ValueSanitizer is the default Sanitizer. It holds the concrete sensitive
// values to redact and a per-request TokenRegistry. Build one per Generate call
// via NewValueSanitizer.
type ValueSanitizer struct {
	registry *TokenRegistry
	// values is the ordered, de-duplicated list of (kind, cleartext) pairs to
	// redact. Ordered longest-value-first so a value that is a substring of a
	// longer one is tokenized after the longer one.
	values []kindValue
}

type kindValue struct {
	kind  string
	value string
}

// NewValueSanitizer builds a sanitizer over the supplied sensitive values. salt
// scopes the token hashing (pass a per-request id). Empty values are dropped.
// Duplicate values keep the first kind seen.
func NewValueSanitizer(salt string, values []kindValue) *ValueSanitizer {
	seen := map[string]struct{}{}
	ordered := make([]kindValue, 0, len(values))
	for _, kv := range values {
		v := strings.TrimSpace(kv.value)
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		ordered = append(ordered, kindValue{kind: kv.kind, value: v})
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		return len(ordered[i].value) > len(ordered[j].value)
	})
	return &ValueSanitizer{
		registry: NewTokenRegistry(salt),
		values:   ordered,
	}
}

// KindValue is the exported constructor input for a single (kind, value) pair,
// used by the gateway when assembling the sensitive-value set from a subscriber.
type KindValue struct {
	Kind  string
	Value string
}

// NewSanitizerFromKindValues is the exported builder over []KindValue.
func NewSanitizerFromKindValues(salt string, kvs []KindValue) *ValueSanitizer {
	in := make([]kindValue, 0, len(kvs))
	for _, kv := range kvs {
		in = append(in, kindValue{kind: kv.Kind, value: kv.Value})
	}
	return NewValueSanitizer(salt, in)
}

// Sanitize replaces each registered cleartext value in prompt with its token.
func (s *ValueSanitizer) Sanitize(prompt string) string {
	if s == nil || prompt == "" || len(s.values) == 0 {
		return prompt
	}
	out := prompt
	for _, kv := range s.values {
		if !strings.Contains(out, kv.value) {
			continue
		}
		tok := s.registry.Tokenize(kv.kind, kv.value)
		out = strings.ReplaceAll(out, kv.value, tok)
	}
	return out
}

// Restore reverses the tokens in response back to their cleartext values.
func (s *ValueSanitizer) Restore(response string) string {
	if s == nil {
		return response
	}
	return s.registry.Detokenize(response)
}

// Registry exposes the underlying registry so the gateway can persist the
// ephemeral token mappings for async detokenization.
func (s *ValueSanitizer) Registry() *TokenRegistry {
	if s == nil {
		return nil
	}
	return s.registry
}

// SensitiveFieldSet is the resolved decision surface: which field names a
// tenant has marked sensitive. Built from pii_tokenization_config rows. The
// built-in identifier fields (email, phone) are always present.
type SensitiveFieldSet struct {
	fields map[string]struct{}
}

// BuiltInSensitiveFields are the identifier pseudo-fields that are always
// tokenized regardless of tenant config.
var BuiltInSensitiveFields = []string{"email", "phone"}

// NewSensitiveFieldSet builds the decision set from config rows. Only rows with
// Sensitive=true contribute. The built-in identifier fields are always added.
func NewSensitiveFieldSet(cfg []FieldSensitivity) *SensitiveFieldSet {
	s := &SensitiveFieldSet{fields: map[string]struct{}{}}
	for _, f := range BuiltInSensitiveFields {
		s.fields[f] = struct{}{}
	}
	for _, c := range cfg {
		name := strings.ToLower(strings.TrimSpace(c.FieldName))
		if name == "" {
			continue
		}
		if c.Sensitive {
			s.fields[name] = struct{}{}
		} else if !isBuiltIn(name) {
			// An explicit sensitive=false on a built-in does NOT unlock it —
			// email/phone are always sensitive. For a custom field it removes it.
			delete(s.fields, name)
		}
	}
	return s
}

// IsSensitive reports whether a field name (custom field key or identifier) is
// marked sensitive. Matching is case-insensitive.
func (s *SensitiveFieldSet) IsSensitive(fieldName string) bool {
	if s == nil {
		return false
	}
	_, ok := s.fields[strings.ToLower(strings.TrimSpace(fieldName))]
	return ok
}

func isBuiltIn(name string) bool {
	for _, b := range BuiltInSensitiveFields {
		if name == b {
			return true
		}
	}
	return false
}
