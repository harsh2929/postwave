package verification

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestPublicProviderConfigReducesRawErrorsToSafeStatus(t *testing.T) {
	const canary = "Bearer private-token at https://upstream.internal"
	got := publicProviderConfig(ProviderConfig{
		Provider:      ProviderZeroBounce,
		CredentialRef: "zerobounce-primary",
		Enabled:       true,
		LastError:     canary,
	})
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(encoded), canary) || strings.Contains(string(encoded), "upstream.internal") {
		t.Fatalf("public provider response exposed raw upstream detail: %s", encoded)
	}
	if got.LastError != safeProviderHealthError {
		t.Fatalf("LastError = %q, want stable safe status", got.LastError)
	}
}

func TestPublicJobReducesRawWorkerErrorsToSafeStatus(t *testing.T) {
	const canary = "resolve credential vault/private/name: SQLSTATE 42501"
	got := publicJob(Job{Error: canary, SourceRef: "audience\u202eprivate"})
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(encoded), canary) || strings.Contains(string(encoded), "SQLSTATE") {
		t.Fatalf("public job response exposed raw worker detail: %s", encoded)
	}
	if got.Error != safeJobFailure {
		t.Fatalf("Error = %q, want stable safe status", got.Error)
	}
	if got.SourceRef != "" {
		t.Fatalf("unsafe legacy SourceRef = %q, want omission", got.SourceRef)
	}
}

func TestValidateCreateJobInputBoundsSourceSpecificFields(t *testing.T) {
	tests := []struct {
		name   string
		source string
		body   createJobRequest
		ok     bool
	}{
		{
			name:   "valid inline",
			source: JobSourceInline,
			body:   createJobRequest{Emails: []string{"reader@example.test"}},
			ok:     true,
		},
		{
			name:   "valid tag is trimmed",
			source: JobSourceTag,
			body:   createJobRequest{SourceRef: "  customers  "},
			ok:     true,
		},
		{
			name:   "multiline source reference",
			source: JobSourceTag,
			body:   createJobRequest{SourceRef: "customers\nprivate"},
		},
		{
			name:   "oversized address",
			source: JobSourceInline,
			body:   createJobRequest{Emails: []string{strings.Repeat("a", maxJobEmailBytes+1)}},
		},
		{
			name:   "tag mixed with inline addresses",
			source: JobSourceTag,
			body: createJobRequest{
				SourceRef: "customers",
				Emails:    []string{"reader@example.test"},
			},
		},
		{
			name:   "all subscribers with ignored reference",
			source: JobSourceAllSubscribers,
			body:   createJobRequest{SourceRef: "ignored"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, err := validateCreateJobInput(tt.source, tt.body)
			if tt.ok && err != nil {
				t.Fatalf("validateCreateJobInput: %v", err)
			}
			if !tt.ok && err == nil {
				t.Fatal("validateCreateJobInput unexpectedly accepted unsafe input")
			}
			if tt.name == "valid tag is trimmed" && ref != "customers" {
				t.Fatalf("source ref = %q, want trimmed value", ref)
			}
		})
	}
}

func TestValidateCreateJobInputRejectsRawUnicodeControls(t *testing.T) {
	for _, control := range []string{
		"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f",
		"\u200b", "\u202e", "\u2066", "\ue000",
	} {
		t.Run(fmt.Sprintf("email-U+%04X", []rune(control)[0]), func(t *testing.T) {
			_, err := validateCreateJobInput(JobSourceInline, createJobRequest{
				Emails: []string{"person@example.com" + control},
			})
			if err == nil {
				t.Fatalf("create-job input accepted email control %q", control)
			}
		})
		t.Run(fmt.Sprintf("source-ref-U+%04X", []rune(control)[0]), func(t *testing.T) {
			_, err := validateCreateJobInput(JobSourceTag, createJobRequest{
				SourceRef: "customers" + control,
			})
			if err == nil {
				t.Fatalf("create-job input accepted source_ref control %q", control)
			}
		})
	}
	ref, err := validateCreateJobInput(JobSourceTag, createJobRequest{SourceRef: "  Café 東京  "})
	if err != nil || ref != "Café 東京" {
		t.Fatalf("ordinary Unicode source_ref = %q, error=%v", ref, err)
	}
}

func TestNormalizeCreateJobSourceRejectsControlsBeforeTrimming(t *testing.T) {
	for _, control := range []string{"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f"} {
		t.Run(fmt.Sprintf("U+%04X", []rune(control)[0]), func(t *testing.T) {
			if source, err := normalizeCreateJobSource(JobSourceInline + control); err == nil {
				t.Fatalf("normalized source control into %q", source)
			}
		})
	}
	if source, err := normalizeCreateJobSource("  " + JobSourceInline + "  "); err != nil || source != JobSourceInline {
		t.Fatalf("ordinary surrounding spaces: source=%q err=%v", source, err)
	}
}
