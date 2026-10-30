// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
)

func TestInitializeEngagementClassificationRuntimeOffTouchesNoDatabase(t *testing.T) {
	runtime, err := initializeEngagementClassificationRuntime(
		t.Context(), nil, func(string) string { return "" },
	)
	if err != nil || runtime != nil {
		t.Fatalf("disabled runtime=%v err=%v", runtime, err)
	}
}

func TestInitializeEngagementClassificationRuntimeEnabledFailsClosed(t *testing.T) {
	values := map[string]string{
		"POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2":       "true",
		"POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY":          strings.Repeat("k", 32),
		"POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY_ID":       "engagement-hmac-2026-08",
		"POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION":      "8760h",
		"POSTWAVE_ENGAGEMENT_RECLASSIFICATION_LEASE_TTL": "2m",
	}
	_, err := initializeEngagementClassificationRuntime(
		t.Context(), nil, func(key string) string { return values[key] },
	)
	if err == nil || !strings.Contains(err.Error(), "database pool is required") {
		t.Fatalf("enabled runtime without database error=%v", err)
	}
}

// This intentionally source-level contract protects the production process
// boundary. Runtime unit tests cannot prove that main keeps the retention
// supervisor wired after startup refactors.
func TestMainSupervisesEngagementObservationRetention(t *testing.T) {
	mainSource, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main composition: %v", err)
	}
	source := string(mainSource)
	for _, marker := range []string{
		`engagementClassifierRuntime != nil && engagementClassifierRuntime.Enabled()`,
		`safego.Go(logger, "engagement-observation-retention"`,
		`engagementClassifierRuntime.RunRetention(outboxCtx, logger)`,
		`!errors.Is(err, context.Canceled)`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("main composition lost retention supervisor marker %q", marker)
		}
	}

	environmentExample, err := os.ReadFile(".env.example")
	if err != nil {
		t.Fatalf("read runtime environment example: %v", err)
	}
	if !strings.Contains(
		string(environmentExample),
		"POSTWAVE_ENGAGEMENT_RETENTION_SWEEP_INTERVAL=1m",
	) {
		t.Fatal("runtime environment example lost the bounded retention sweep interval")
	}
}
