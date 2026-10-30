package seedlist

import (
	"strings"
	"testing"
)

func TestRegistryResolvesSecretReferencesAndSnapshotsAreIsolated(t *testing.T) {
	t.Setenv("SEED_ADDRESS", "seed@example.test")
	t.Setenv("SEED_USER", "imap-user")
	t.Setenv("SEED_PASSWORD", "super-secret-value")
	registry := NewRegistry()
	err := registry.LoadJSON(`{"inboxes":[{
        "id":"gmail-001","provider":"gmail",
        "address_secret_ref":"env:SEED_ADDRESS",
        "imap_host":"imap.example.test","imap_port":993,
        "imap_user_secret_ref":"env://SEED_USER",
        "imap_password_secret_ref":"env:SEED_PASSWORD",
        "client":"gmail_web","device":"desktop","account_tier":"consumer",
        "region":"US","locale":"en-US","timezone":"America/New_York",
        "language":"en","smart_features":{"summaries":"enabled"},
        "warmup_state":"ready","health_state":"healthy"
    }]}`)
	if err != nil {
		t.Fatal(err)
	}
	first := registry.Snapshot()
	if len(first) != 1 || first[0].Address != "seed@example.test" ||
		first[0].IMAPUser != "imap-user" || first[0].Password() != "super-secret-value" {
		t.Fatalf("unexpected resolved snapshot: %+v", first)
	}
	first[0].Address = "mutated@example.test"
	first[0].SmartFeatures["summaries"] = "mutated"
	second := registry.Snapshot()
	if second[0].Address != "seed@example.test" || second[0].SmartFeatures["summaries"] != "enabled" {
		t.Fatalf("snapshot mutation escaped into registry: %+v", second[0])
	}
	if strings.Contains(second[0].AddressSecretRef, "seed@example.test") ||
		strings.Contains(second[0].IMAPPasswordSecretRef, "super-secret-value") {
		t.Fatal("secret reference contains a resolved secret")
	}
}

func TestRegistryLegacyDocumentRemainsCompatible(t *testing.T) {
	t.Setenv("LEGACY_SEED_PASSWORD", "legacy-password")
	registry := NewRegistry()
	if err := registry.LoadJSON(`{"inboxes":[{
        "id":"legacy-001","provider":"gmail","address":"legacy@example.test",
        "imap_host":"imap.example.test","imap_port":993,"imap_user":"legacy-user",
        "imap_password_env":"LEGACY_SEED_PASSWORD"
    }]}`); err != nil {
		t.Fatal(err)
	}
	inbox, ok := registry.Get("legacy-001")
	if !ok || inbox.Password() != "legacy-password" || inbox.Timezone != "UTC" ||
		inbox.WarmupState != "unknown" || inbox.IMAPPasswordSecretRef != "env:LEGACY_SEED_PASSWORD" {
		t.Fatalf("legacy document did not retain compatibility defaults: %+v", inbox)
	}
}
