package seedlist

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func controlledSeedRegistryDBPools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_CONTROLLED_SEED_REGISTRY_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_CONTROLLED_SEED_REGISTRY_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("controlled seed registry database URLs are required")
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Close(); admin.Close() })
	return admin, app
}

func TestPostgresRegistryLedgerVersionsRetirementRLSAndSecretContainmentDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := controlledSeedRegistryDBPools(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	mailboxID := "registry-" + suffix
	addressVar := "REGISTRY_ADDRESS_" + suffix
	userVar := "REGISTRY_USER_" + suffix
	passwordVar := "REGISTRY_PASSWORD_" + suffix
	t.Setenv(addressVar, "resolved-"+suffix+"@example.test")
	t.Setenv(userVar, "resolved-user-"+suffix)
	t.Setenv(passwordVar, "resolved-password-"+suffix)

	document := func(region string) string {
		return `{"inboxes":[{"id":"` + mailboxID + `","provider":"gmail",` +
			`"address_secret_ref":"env:` + addressVar + `","imap_host":"imap.example.test","imap_port":993,` +
			`"imap_user_secret_ref":"env:` + userVar + `","imap_password_secret_ref":"env:` + passwordVar + `",` +
			`"client":"gmail_web","device":"desktop","account_tier":"consumer","region":"` + region + `",` +
			`"locale":"en-US","timezone":"America/New_York","language":"en",` +
			`"warmup_state":"ready","health_state":"healthy"}]}`
	}
	registry := NewRegistry()
	if err := registry.LoadJSON(document("US")); err != nil {
		t.Fatal(err)
	}
	ledger := NewPostgresRegistryLedger(app)
	capabilities := ConnectorCapabilities{
		Headers: CapabilityAvailable, RawMIME: CapabilityAvailable, BodyParts: CapabilityAvailable,
		Placement: CapabilityAvailable, ObservedSurface: CapabilityUnavailable,
	}
	first, err := ledger.PublishSnapshot(ctx, registry, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ledger.PublishSnapshot(ctx, registry, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	if first[mailboxID] == "" || first[mailboxID] != second[mailboxID] {
		t.Fatalf("idempotent publication drifted: first=%v second=%v", first, second)
	}
	if err := registry.LoadJSON(document("CA")); err != nil {
		t.Fatal(err)
	}
	third, err := ledger.PublishSnapshot(ctx, registry, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	if third[mailboxID] == first[mailboxID] {
		t.Fatal("changed registry metadata did not append a version")
	}
	if err := registry.LoadJSON(`{"inboxes":[]}`); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.PublishSnapshot(ctx, registry, capabilities); err != nil {
		t.Fatal(err)
	}
	if err := registry.LoadJSON(document("CA")); err != nil {
		t.Fatal(err)
	}
	fourth, err := ledger.PublishSnapshot(ctx, registry, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	if fourth[mailboxID] == third[mailboxID] {
		t.Fatal("reactivation did not preserve retirement as a separate revision")
	}

	var count int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM controlled_seed_registry_versions WHERE mailbox_id=$1`, mailboxID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("revision count=%d, want 4", count)
	}
	var leaked int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM controlled_seed_registry_versions
WHERE mailbox_id=$1 AND to_jsonb(controlled_seed_registry_versions)::text LIKE $2`,
		mailboxID, "%resolved-%").Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatal("durable registry leaked a resolved address or credential")
	}
	if err := app.QueryRow(ctx, `SELECT count(*) FROM controlled_seed_registry_versions WHERE mailbox_id=$1`, mailboxID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("unscoped app role saw %d registry revisions", count)
	}
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker','true',true)`); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM controlled_seed_registry_versions WHERE mailbox_id=$1`, mailboxID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("generic worker scope alone exposed registry revisions")
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_registry_writer','true',true)`); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM controlled_seed_registry_versions WHERE mailbox_id=$1`, mailboxID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("two-factor scope saw %d revisions, want 4", count)
	}
	if _, err := tx.Exec(ctx, `UPDATE controlled_seed_registry_versions SET region='GB' WHERE mailbox_id=$1`, mailboxID); err == nil {
		t.Fatal("postwave_app unexpectedly updated immutable registry history")
	}
	_ = tx.Rollback(ctx)
	if _, err := admin.Exec(ctx, `UPDATE controlled_seed_registry_versions SET region='GB' WHERE mailbox_id=$1`, mailboxID); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("admin immutability guard error=%v", err)
	}
}
