// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRuntimeConfigurationDisabledDoesNotInspectStagedSecrets(t *testing.T) {
	values := map[string]string{
		RuntimeFeatureEnvironmentKey:                     "false",
		"POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY":          "short",
		"POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION":      "not-a-duration",
		"POSTWAVE_ENGAGEMENT_RECLASSIFICATION_LEASE_TTL": "not-a-duration",
	}
	configuration, err := RuntimeConfigurationFromEnvironment(func(key string) string {
		return values[key]
	})
	if err != nil || configuration.Enabled {
		t.Fatalf("disabled configuration = %+v, err=%v", configuration, err)
	}
	runtime, err := BuildRuntime(t.Context(), configuration, nil)
	if err != nil || runtime == nil || runtime.Enabled() {
		t.Fatalf("disabled runtime = %+v, err=%v", runtime, err)
	}
}

func TestRuntimeConfigurationEnabledFailsClosed(t *testing.T) {
	base := map[string]string{
		RuntimeFeatureEnvironmentKey:                     "true",
		"POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY":          strings.Repeat("k", 32),
		"POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY_ID":       "engagement-hmac-2026-08",
		"POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION":      "8760h",
		"POSTWAVE_ENGAGEMENT_RECLASSIFICATION_LEASE_TTL": "2m",
	}
	get := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	configuration, err := RuntimeConfigurationFromEnvironment(get(base))
	if err != nil || !configuration.Enabled || configuration.ObservationRetention != 365*24*time.Hour ||
		configuration.RetentionSweepInterval != time.Minute {
		t.Fatalf("valid configuration = %+v, err=%v", configuration, err)
	}
	configuredCadence := make(map[string]string, len(base)+1)
	for key, value := range base {
		configuredCadence[key] = value
	}
	configuredCadence["POSTWAVE_ENGAGEMENT_RETENTION_SWEEP_INTERVAL"] = "15m"
	configuration, err = RuntimeConfigurationFromEnvironment(get(configuredCadence))
	if err != nil || configuration.RetentionSweepInterval != 15*time.Minute {
		t.Fatalf("explicit retention sweep cadence = %s, err=%v", configuration.RetentionSweepInterval, err)
	}
	if _, err := BuildRuntime(t.Context(), configuration, nil); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("enabled runtime without database error=%v, want ErrRuntimeNotReady", err)
	}

	for name, mutate := range map[string]func(map[string]string){
		"ambiguous feature flag": func(values map[string]string) {
			values[RuntimeFeatureEnvironmentKey] = "1"
		},
		"short identity key": func(values map[string]string) {
			values["POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY"] = "short"
		},
		"missing key id": func(values map[string]string) {
			values["POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY_ID"] = ""
		},
		"retention erases before degraded tier": func(values map[string]string) {
			values["POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION"] = "2160h"
		},
		"unbounded retention": func(values map[string]string) {
			values["POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION"] = "87601h"
		},
		"unsafe sweep cadence": func(values map[string]string) {
			values["POSTWAVE_ENGAGEMENT_RETENTION_SWEEP_INTERVAL"] = "1s"
		},
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(base))
			for key, value := range base {
				values[key] = value
			}
			mutate(values)
			if _, err := RuntimeConfigurationFromEnvironment(get(values)); err == nil {
				t.Fatal("invalid configuration was accepted")
			}
		})
	}
}

func TestProviderObservationUsesTenantSeparatedHMACAndNoRecipientPlaintext(t *testing.T) {
	fixedNow := time.Date(2026, 8, 10, 1, 2, 3, 0, time.UTC)
	runtime := &Runtime{
		enabled:              true,
		hook:                 &IngestHook{Repo: &Repo{}, Classifier: &Classifier{}},
		identityKey:          []byte(strings.Repeat("identity-key-material-", 2)),
		identityKeyID:        "engagement-hmac-2026-08",
		observationRetention: 365 * 24 * time.Hour,
		now:                  func() time.Time { return fixedNow },
	}
	input := ProviderEventInput{
		EventRef: EventRef{ID: 42, At: fixedNow.Add(-time.Minute)},
		Source:   "listmonk", SourceEventID: "provider-event-42",
		IdempotencyKey: "subscriber-event:42", EventSchemaVersion: ObservationSchemaV1,
		EventType: "opened", OccurredAt: fixedNow.Add(-time.Minute),
		RecipientAddress: " Reader@Example.Test ",
		MessageIdentity:  "<message-42@example.test>",
		LinkIdentity:     "https://example.test/offer", ProviderMessageID: "message-42",
		OrderedHeaders: []Header{}, OrderedHeadersComplete: false,
		ProviderSignals: map[string]any{"wire_type": "subscriber.opened"},
	}
	first, err := runtime.providerObservation("00000000-0000-0000-0000-000000000001", input)
	if err != nil {
		t.Fatalf("build provider observation: %v", err)
	}
	replay, err := runtime.providerObservation("00000000-0000-0000-0000-000000000001", input)
	if err != nil {
		t.Fatalf("rebuild provider observation: %v", err)
	}
	foreign, err := runtime.providerObservation("00000000-0000-0000-0000-000000000002", input)
	if err != nil {
		t.Fatalf("build foreign provider observation: %v", err)
	}
	if first.RecipientIdentityHMAC == "" || len(first.RecipientIdentityHMAC) != 64 ||
		first.RecipientIdentityHMAC != replay.RecipientIdentityHMAC ||
		first.RecipientIdentityHMAC == foreign.RecipientIdentityHMAC {
		t.Fatalf("recipient commitments first=%q replay=%q foreign=%q",
			first.RecipientIdentityHMAC, replay.RecipientIdentityHMAC,
			foreign.RecipientIdentityHMAC)
	}
	if first.MessageIdentityHash == first.LinkIdentityHash ||
		first.RecipientIdentityHMAC == first.MessageIdentityHash {
		t.Fatal("identity purposes were not domain-separated")
	}
	if first.OrderedHeadersComplete || len(first.OrderedHeaders) != 0 {
		t.Fatalf("unsupported header evidence was claimed: %+v", first.OrderedHeaders)
	}
	if first.PrivacyExpiryAt != fixedNow.Add(365*24*time.Hour) {
		t.Fatalf("privacy expiry=%v, want %v", first.PrivacyExpiryAt, fixedNow.Add(365*24*time.Hour))
	}
	raw, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(raw)), "reader@example.test") {
		t.Fatalf("recipient plaintext leaked: %s", raw)
	}

	leaking := input
	leaking.ProviderSignals = map[string]any{"recipient": "reader@example.test"}
	if _, err := runtime.providerObservation("00000000-0000-0000-0000-000000000001", leaking); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("plaintext provider signal error=%v, want ErrInvalidInput", err)
	}
	objectBacked := input
	objectBacked.RawObjectRef = "s3://private-bucket/evidence"
	objectBacked.RawObjectVersionID = "exact-version"
	if _, err := runtime.providerObservation("00000000-0000-0000-0000-000000000001", objectBacked); !errors.Is(err, ErrObjectDeletionRequired) {
		t.Fatalf("object-backed provider observation error=%v, want ErrObjectDeletionRequired", err)
	}
}

func TestRetentionWorkerRejectsUnboundedConfiguration(t *testing.T) {
	worker := &RetentionWorker{
		Repo: &Repo{}, Interval: time.Second,
		TenantBatchSize: 1001, ObservationBatchSize: 0,
	}
	if err := worker.validate(); err == nil {
		t.Fatal("unsafe retention worker configuration was accepted")
	}
}
