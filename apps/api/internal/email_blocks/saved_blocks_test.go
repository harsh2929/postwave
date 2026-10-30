package email_blocks

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateSavedBlockValuesAcceptsBoundedStructuredContent(t *testing.T) {
	t.Parallel()

	body := json.RawMessage(`{"layout":{"columns":2},"enabled":true,"ratio":1.25}`)
	if err := validateSavedBlockValues("Hero", "section", "<p>Hello</p>", body); err != nil {
		t.Fatalf("validateSavedBlockValues() error = %v", err)
	}
}

func TestValidateSavedBlockValuesRejectsUnsafeJSON(t *testing.T) {
	t.Parallel()

	tests := map[string]json.RawMessage{
		"reserved key":   json.RawMessage(`{"__proto__":{"polluted":true}}`),
		"unsafe integer": json.RawMessage(`{"count":9007199254740992}`),
		"non-finite":     json.RawMessage(`{"count":1e400}`),
		"oversized text": json.RawMessage(`{"text":"` + strings.Repeat("x", 64*1024+1) + `"}`),
		"array root":     json.RawMessage(`[1,2,3]`),
	}
	for name, body := range tests {
		body := body
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := validateSavedBlockValues("Hero", "block", "", body); err == nil {
				t.Fatal("validateSavedBlockValues() error = nil, want invalid input")
			}
		})
	}
}
