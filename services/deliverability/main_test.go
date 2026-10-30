package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/deliverability/internal/config"
	"github.com/postwave/postwave/services/deliverability/internal/reportstore"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

func TestLegacyDMARCIMAPIsForbiddenOnlyInProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	t.Setenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION", "true")
	if !legacyDMARCIMAPForbiddenInProduction() {
		t.Fatal("expected production legacy IMAP ingestion to be forbidden")
	}

	t.Setenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION", "false")
	if legacyDMARCIMAPForbiddenInProduction() {
		t.Fatal("disabled legacy ingestion must not trigger the guard")
	}

	t.Setenv("POSTWAVE_ENV", "development")
	t.Setenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION", "true")
	if legacyDMARCIMAPForbiddenInProduction() {
		t.Fatal("the isolated-development escape hatch must remain distinguishable")
	}
}

func TestSeedMIMECaptureFlagControlsTheConstructedIMAPConnector(t *testing.T) {
	connector := &seedlist.IMAPConnector{}

	applySeedMIMECaptureFlag(connector, false)
	if !connector.DisableRawMIME {
		t.Fatal("disabled rollout left raw MIME acquisition enabled")
	}
	applySeedMIMECaptureFlag(connector, true)
	if connector.DisableRawMIME {
		t.Fatal("enabled rollout left raw MIME acquisition disabled")
	}
}

func TestDisabledSeedMIMECaptureProjectionHidesObservationWrites(t *testing.T) {
	projection := reportstore.NewProjectionOnlyStore(&reportstore.PostgresStore{})
	var reportSink seedlist.ReportSink = projection
	if _, exposed := reportSink.(seedlist.MessageObservationSink); exposed {
		t.Fatal("projection-only rollout exposed durable raw observation writes")
	}
}

func TestSeedMIMECaptureObjectStoreIsDefaultOffAndFailClosed(t *testing.T) {
	store, err := buildSeedObservationObjectStore(context.Background(), config.Config{})
	if err != nil || store != nil {
		t.Fatalf("disabled rollout returned store=%T err=%v", store, err)
	}

	_, err = buildSeedObservationObjectStore(context.Background(), config.Config{
		SeedMIMECaptureEnabled: true,
	})
	if err == nil || !strings.Contains(err.Error(), "AWS_REGION") {
		t.Fatalf("enabled rollout accepted missing durable object configuration: %v", err)
	}
}

func TestSeedMIMECaptureDatabaseReadinessRejectsMissingPool(t *testing.T) {
	err := verifySeedObservationDatabase(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "postgres pool") {
		t.Fatalf("enabled rollout accepted a missing database pool: %v", err)
	}
}

func TestSeedMIMECaptureDatabaseReadiness_DB(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("POSTWAVE_SEED_OBSERVATION_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_SEED_OBSERVATION_TEST_DATABASE_URL is required for composition DB proof")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := verifySeedObservationDatabase(t.Context(), pool); err != nil {
		t.Fatalf("seed observation database readiness: %v", err)
	}
}

// TestIsProductionEnvRecognisesEveryConfiguredSpelling guards the single
// predicate that thirteen fail-closed startup gates in main.go depend on.
//
// It was untested. Verified by mutation: making isProductionEnv always return
// false left the package green — and that one change disables EVERY production
// gate at once. The service would then start in production with MockRenderer,
// which serves placehold.co PNGs as cross-client previews to real customers,
// alongside twelve other safety checks quietly turning off.
//
// A predicate with that fan-out earns a test of its own precisely because a
// regression in it looks like nothing: no error, no log, every gate simply
// stops firing.
func TestIsProductionEnvRecognisesEveryConfiguredSpelling(t *testing.T) {
	// All three variables are read, and both spellings are accepted
	// case-insensitively. Each row is a way a real deployment sets this.
	for _, tc := range []struct{ key, value string }{
		{"POSTWAVE_ENV", "production"},
		{"POSTWAVE_ENV", "prod"},
		{"POSTWAVE_ENV", "Production"},
		{"POSTWAVE_ENV", "PROD"},
		{"POSTWAVE_ENV", "  production  "},
		{"ENVIRONMENT", "production"},
		{"ENVIRONMENT", "prod"},
		{"NODE_ENV", "production"},
		{"NODE_ENV", "prod"},
	} {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
				t.Setenv(key, "")
			}
			t.Setenv(tc.key, tc.value)
			if !isProductionEnv() {
				t.Fatalf("%s=%q was not recognised as production; every gate in main.go would be off", tc.key, tc.value)
			}
		})
	}
}

// TestIsProductionEnvDoesNotFireOnNonProduction is the guard-the-guard: a
// predicate returning true unconditionally satisfies every case above while
// making dev and CI unrunnable.
func TestIsProductionEnvDoesNotFireOnNonProduction(t *testing.T) {
	for _, value := range []string{"", "development", "dev", "staging", "test", "preproduction", "production-like"} {
		t.Run("value="+value, func(t *testing.T) {
			for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
				t.Setenv(key, "")
			}
			t.Setenv("POSTWAVE_ENV", value)
			if isProductionEnv() {
				t.Fatalf("%q was treated as production", value)
			}
		})
	}
}
