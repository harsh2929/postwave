// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func transientRuntime(t *testing.T, entries ...RegistryEntry) *Runtime {
	t.Helper()
	return &Runtime{
		enabled: true,
		hook:    &IngestHook{Classifier: mustClassifier(t, DefaultConfig(), entries...)},
		now:     func() time.Time { return classifierTestNow },
	}
}

func TestClassifyTransientRequestUsesRuntimeRegistryWithoutPersistence(t *testing.T) {
	runtime := transientRuntime(t, registryEntry(
		"R_TEST_SCANNER_UA", MatchUASubstring, "scanner-agent",
		SubtypeSEGScanner, 1,
	))
	result, err := runtime.ClassifyTransientRequest(TransientRequestEvidence{
		UserAgent:       "Mozilla/5.0 scanner-agent/1.0",
		IP:              "203.0.113.10",
		HeaderNames:     []string{"Accept-Language", "User-Agent"},
		HeadersComplete: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Machine || result.MachineSubtype != SubtypeSEGScanner ||
		!result.ShadowMode || !hasRule(result, "R_TEST_SCANNER_UA") {
		t.Fatalf("transient result = %+v", result)
	}
}

func TestClassifyTransientRequestKeepsOrdinaryRequestUnknown(t *testing.T) {
	runtime := transientRuntime(t)
	result, err := runtime.ClassifyTransientRequest(TransientRequestEvidence{
		UserAgent:       "Mozilla/5.0",
		HeaderNames:     []string{"user-agent", "Accept-Language", "USER-AGENT"},
		HeadersComplete: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Unknown || result.StableReason != ReasonNoConfidentSignal {
		t.Fatalf("transient result = %+v, want explicit unknown", result)
	}
}

func TestClassifyTransientRequestFailsClosed(t *testing.T) {
	if _, err := (*Runtime)(nil).ClassifyTransientRequest(TransientRequestEvidence{}); !errors.Is(err, ErrRuntimeDisabled) {
		t.Fatalf("nil runtime error = %v, want ErrRuntimeDisabled", err)
	}
	runtime := transientRuntime(t)
	headers := make([]string, 129)
	for index := range headers {
		headers[index] = fmt.Sprintf("X-Evidence-%03d", index)
	}
	if _, err := runtime.ClassifyTransientRequest(TransientRequestEvidence{
		HeaderNames: headers,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("oversized evidence error = %v, want ErrInvalidInput", err)
	}
}
