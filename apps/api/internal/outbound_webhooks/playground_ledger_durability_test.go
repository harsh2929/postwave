// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	playgroundTestTenantID  = "11111111-1111-4111-8111-111111111111"
	playgroundTestFireID    = "22222222-2222-4222-8222-222222222222"
	playgroundTestWebhookID = "33333333-3333-4333-8333-333333333333"
)

func reservedReceiptTestFixture() (playgroundReceiptBinding, *playgroundFireRecord) {
	requestHash := strings.Repeat("a", 64)
	keyHash := strings.Repeat("b", 64)
	response := playgroundFireResponse{
		FireID:      playgroundTestFireID,
		EventID:     playgroundEventID(playgroundTestFireID),
		DeliveryID:  "playground-" + playgroundTestFireID,
		URL:         "https://receiver.example.test/hook",
		Method:      http.MethodPost,
		Headers:     map[string]string{"Content-Type": "application/json"},
		BodyJSON:    json.RawMessage(`{"event":{"type":"campaign.sent"}}`),
		Signature:   "t=1,v1=frozen",
		RequestedAt: "2026-08-30T00:00:00Z",
	}
	binding := playgroundReceiptBinding{
		Phase:              playgroundReceiptPhaseReserved,
		TenantID:           playgroundTestTenantID,
		FireID:             playgroundTestFireID,
		WebhookID:          playgroundTestWebhookID,
		EventType:          "campaign.sent",
		RequestHash:        requestHash,
		IdempotencyKeyHash: keyHash,
		ConfigVersion:      7,
		Response:           response,
	}
	record := &playgroundFireRecord{
		FireID:             playgroundTestFireID,
		WebhookID:          playgroundTestWebhookID,
		EventType:          "campaign.sent",
		ConfigVersion:      7,
		State:              "pending",
		DeliveryID:         "playground-" + playgroundTestFireID,
		RequestHash:        requestHash,
		IdempotencyKeyHash: keyHash,
	}
	return binding, record
}

func TestPlaygroundReceiptV1BindsEveryImmutableRowDimension(t *testing.T) {
	t.Parallel()
	store := &Store{Cipher: xorAuthCipher{}}
	binding, record := reservedReceiptTestFixture()
	envelope, digest, _, err := store.encryptPlaygroundFireResponse(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := store.decryptPlaygroundFireResponse(
		context.Background(), playgroundTestTenantID, record, digest, envelope,
	)
	if err != nil || decoded.FireID != playgroundTestFireID {
		t.Fatalf("decode = %#v, err=%v", decoded, err)
	}

	tests := []struct {
		name     string
		tenantID string
		mutate   func(*playgroundFireRecord)
	}{
		{
			name:     "tenant",
			tenantID: "44444444-4444-4444-8444-444444444444",
		},
		{
			name: "fire",
			mutate: func(row *playgroundFireRecord) {
				row.FireID = "55555555-5555-4555-8555-555555555555"
				row.DeliveryID = "playground-" + row.FireID
			},
		},
		{
			name: "webhook",
			mutate: func(row *playgroundFireRecord) {
				row.WebhookID = "66666666-6666-4666-8666-666666666666"
			},
		},
		{
			name: "event",
			mutate: func(row *playgroundFireRecord) {
				row.EventType = "subscriber.added"
			},
		},
		{
			name: "request hash",
			mutate: func(row *playgroundFireRecord) {
				row.RequestHash = strings.Repeat("c", 64)
			},
		},
		{
			name: "key hash",
			mutate: func(row *playgroundFireRecord) {
				row.IdempotencyKeyHash = strings.Repeat("d", 64)
			},
		},
		{
			name: "config version",
			mutate: func(row *playgroundFireRecord) {
				row.ConfigVersion++
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tenantID := playgroundTestTenantID
			if test.tenantID != "" {
				tenantID = test.tenantID
			}
			tampered := *record
			if test.mutate != nil {
				test.mutate(&tampered)
			}
			if _, err := store.decryptPlaygroundFireResponse(
				context.Background(), tenantID, &tampered, digest, envelope,
			); err == nil {
				t.Fatal("swapped receipt binding was accepted")
			}
		})
	}
}

func TestPlaygroundReceiptRejectsV0AndRecoversStaleReservedSkeleton(t *testing.T) {
	t.Parallel()
	store := &Store{Cipher: xorAuthCipher{}}
	binding, record := reservedReceiptTestFixture()
	envelope, digest, _, err := store.encryptPlaygroundFireResponse(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	record.State = "ambiguous"
	record.Outcome = "transport_ambiguous"
	response, err := store.decryptPlaygroundFireResponse(
		context.Background(), playgroundTestTenantID, record, digest, envelope,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !response.Ambiguous || response.Outcome != "transport_ambiguous" ||
		response.StatusCode != 0 || response.Error == "" ||
		string(response.BodyJSON) != string(binding.Response.BodyJSON) {
		t.Fatalf("stale recovered response = %#v", response)
	}

	legacyRaw, err := json.Marshal(binding.Response)
	if err != nil {
		t.Fatal(err)
	}
	legacyEnvelope, err := store.Cipher.Encrypt(context.Background(), legacyRaw)
	if err != nil {
		t.Fatal(err)
	}
	legacySum := sha256.Sum256(legacyRaw)
	if _, err := store.decryptPlaygroundFireResponse(
		context.Background(), playgroundTestTenantID, record,
		hex.EncodeToString(legacySum[:]), legacyEnvelope,
	); err == nil {
		t.Fatal("v0 response-only receipt was accepted for the new ledger")
	}

	tooLarge := binding
	tooLarge.ConfigVersion = MaxWebhookConfigVersion + 1
	if validPlaygroundReceiptBinding(tooLarge) {
		t.Fatal("receipt accepted a config version that JSON clients cannot represent exactly")
	}
}

func TestTerminalPlaygroundReceiptWithholdsEveryTruncatedResponseBody(t *testing.T) {
	t.Parallel()
	binding, _ := reservedReceiptTestFixture()
	binding.Phase = playgroundReceiptPhaseTerminal
	binding.Response.StatusCode = http.StatusBadGateway
	binding.Response.Outcome = "receiver_responded"
	binding.Response.ResponseBodyTruncated = true
	binding.Response.ResponseBody = "unsafe partial receiver response"
	store := &Store{Cipher: xorAuthCipher{}}
	if _, _, _, err := store.encryptPlaygroundFireResponse(context.Background(), binding); err == nil {
		t.Fatal("terminal receipt encrypted a partial body marked truncated")
	}
	binding.Response.ResponseBody = ""
	if _, _, _, err := store.encryptPlaygroundFireResponse(context.Background(), binding); err != nil {
		t.Fatalf("terminal receipt rejected a withheld truncated body: %v", err)
	}
}

func TestPlaygroundReceiptSubjectLocatorIsNormalizedDeduplicatedAndBounded(t *testing.T) {
	t.Parallel()
	raw := []byte(`{
  "request":{"email":"Person@Example.COM","duplicate":"person@example.com"},
  "receiver":"accepted customer+tag@bücher.example",
  "email-shaped-key@example.test":"value"
}`)
	hashes, err := playgroundReceiptSubjectEmailHashes(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]string, 0, 3)
	for _, address := range []string{
		"person@example.com",
		"customer+tag@bücher.example",
		"email-shaped-key@example.test",
	} {
		sum := sha256.Sum256([]byte(address))
		want = append(want, hex.EncodeToString(sum[:]))
	}
	slices.Sort(want)
	if !slices.Equal(hashes, want) {
		t.Fatalf("subject hashes = %#v, want %#v", hashes, want)
	}

	var overLimit strings.Builder
	for i := 0; i <= maxPlaygroundReceiptSubjectEmails; i++ {
		fmt.Fprintf(&overLimit, "person-%d@example.test ", i)
	}
	if _, err := playgroundReceiptSubjectEmailHashes([]byte(overLimit.String())); !errors.Is(err, errPlaygroundSubjectLimit) {
		t.Fatalf("over-limit subject locator error = %v, want %v", err, errPlaygroundSubjectLimit)
	}
}

func TestPlaygroundReceiptSubjectLocatorMustMatchExactDecryptedPlaintext(t *testing.T) {
	t.Parallel()
	store := &Store{Cipher: xorAuthCipher{}}
	binding, record := reservedReceiptTestFixture()
	binding.Response.BodyJSON = json.RawMessage(`{"customer":{"email":"MiXeD.Case+route45@Example.TEST"}}`)
	envelope, digest, hashes, err := store.encryptPlaygroundFireResponse(
		context.Background(), binding,
	)
	if err != nil {
		t.Fatal(err)
	}
	digestFor := func(address string) string {
		sum := sha256.Sum256([]byte(strings.ToLower(address)))
		return hex.EncodeToString(sum[:])
	}
	genuineDigest := digestFor("mixed.case+route45@example.test")
	if !slices.Contains(hashes, genuineDigest) {
		t.Fatalf("encrypted receipt locators = %#v, want genuine mixed-case digest", hashes)
	}
	if _, err := store.decryptPlaygroundFireResponseForSubject(
		context.Background(), playgroundTestTenantID, record, digest, envelope, genuineDigest,
	); err != nil {
		t.Fatalf("genuine mixed-case locator rejected: %v", err)
	}
	for _, test := range []struct {
		name   string
		digest string
	}{
		{name: "foreign", digest: digestFor("foreign@example.test")},
		{name: "stale", digest: digestFor("previous-address@example.test")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := store.decryptPlaygroundFireResponseForSubject(
				context.Background(), playgroundTestTenantID, record, digest, envelope, test.digest,
			); !errors.Is(err, errPlaygroundSubjectLocatorMismatch) {
				t.Fatalf("locator validation error = %v, want %v", err, errPlaygroundSubjectLocatorMismatch)
			}
		})
	}
}

func TestPlaygroundMigrationUsesTenantCompositeIdentityAndPermanentTombstones(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	migration, err := os.ReadFile(filepath.Join(
		filepath.Dir(source), "..", "..", "..", "..", "infra", "migrations",
		"2007_webhook_playground_fire_receipts.sql",
	))
	if err != nil {
		t.Fatal(err)
	}
	text := string(migration)
	for _, contract := range []string{
		"PRIMARY KEY (tenant_id,fire_id)",
		"UNIQUE (tenant_id,idempotency_key_sha256)",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhooks_tenant_id_id_key",
		"UNIQUE USING INDEX outbound_webhooks_tenant_id_id_key",
		"guard_outbound_webhook_config_version",
		"capability mutation must increment config_version exactly once",
		"config_version changed without a capability mutation",
		"config_version BETWEEN 1 AND 9007199254740991",
		"FOREIGN KEY (tenant_id,webhook_ref_id)",
		"ON DELETE SET NULL (webhook_ref_id)",
		"outbound_webhook_playground_fires_webhook_ref_idx",
		"ON outbound_webhook_playground_fires (tenant_id,webhook_ref_id)",
		"WHERE webhook_ref_id IS NOT NULL",
		"webhook_ref_id IS NULL OR webhook_ref_id=webhook_id",
		"'receipt_expired'",
		"receipt_envelope IS NULL",
		"subject_email_sha256s      text[] NOT NULL",
		"outbound_webhook_playground_fires_subject_email_idx",
		"terminal locator is the exact set found",
		"cardinality(NEW.subject_email_sha256s)=0",
		"GRANT SELECT,INSERT,UPDATE ON outbound_webhook_playground_fires",
	} {
		if !strings.Contains(text, contract) {
			t.Errorf("migration missing %q", contract)
		}
	}
	if strings.Contains(text, "fire_id                    uuid PRIMARY KEY") {
		t.Fatal("migration retains a global fire_id primary key")
	}
	if strings.Contains(text, "OLD.subject_email_sha256s <@ NEW.subject_email_sha256s") {
		t.Fatal("migration retains stale reserved subject locators at completion")
	}
	if strings.Contains(text, "GRANT SELECT,INSERT,UPDATE,DELETE") ||
		strings.Contains(text, "DELETE FROM outbound_webhook_playground_fires") {
		t.Fatal("application retention can delete the permanent identity fence")
	}
}

func TestPlaygroundSubjectReceiptLocatorIntegrityDB(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	webhookID := uuid.NewString()
	store := &Store{Pool: pool, Cipher: xorAuthCipher{}}

	cleanup := func() {
		tx, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Errorf("begin locator-integrity cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, tenantID); err != nil {
			t.Errorf("delete locator-integrity tenant: %v", err)
			return
		}
		if err := tx.Commit(context.Background()); err != nil {
			t.Errorf("commit locator-integrity cleanup: %v", err)
		}
	}
	t.Cleanup(cleanup)

	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier)
VALUES ($1::uuid,'playground-locator-integrity',$2,'studio')`,
		tenantID, "playground-locator-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO outbound_webhooks (
    id,tenant_id,url,url_envelope,url_state,events,secret_envelope,
    active,auth_config_state
) VALUES (
    $1::uuid,$2::uuid,'https://locator.example.test/hook','\x01'::bytea,
    'ready',ARRAY['campaign.sent']::text[],'\x01'::bytea,true,'ready'
)`, webhookID, tenantID); err != nil {
		t.Fatal(err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	mixedAddress := "Route45.Mixed+Owner@Example.TEST"
	ownerFireID := uuid.NewString()
	ownerSkeleton := playgroundFireResponse{
		FireID:      ownerFireID,
		EventID:     playgroundEventID(ownerFireID),
		DeliveryID:  "playground-" + ownerFireID,
		URL:         "https://locator.example.test/…",
		Method:      http.MethodPost,
		Headers:     map[string]string{"Content-Type": "application/json"},
		BodyJSON:    json.RawMessage(`{"customer":{"email":"Route45.Mixed+Owner@Example.TEST"}}`),
		RequestedAt: "2026-08-30T00:00:00Z",
	}
	reservation, err := store.ReservePlaygroundFire(ctx, playgroundFireReservationInput{
		TenantID:      tenantID,
		StorageKey:    "scope-v1:" + strings.Repeat("1", 64),
		RequestHash:   strings.Repeat("1", 64),
		FireID:        ownerFireID,
		WebhookID:     webhookID,
		EventType:     "campaign.sent",
		ConfigVersion: 1,
		Skeleton:      ownerSkeleton,
		AuditMeta: db.AuditMeta{
			TenantID:   tenantID,
			ActorType:  "human",
			ActorLabel: "route45-locator-integrity-test",
		},
	})
	if err != nil || reservation == nil || !reservation.Created {
		t.Fatalf("reserve mixed-case subject receipt = %#v, err=%v", reservation, err)
	}

	load := func(subject string) ([]map[string]any, int64, bool, error) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return nil, 0, false, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		return store.LoadPlaygroundSubjectReceipts(ctx, tx, tenantID, subject)
	}
	receipts, total, truncated, err := load("  rOuTe45.MiXeD+OwNeR@example.test  ")
	if err != nil || total != 1 || truncated || len(receipts) != 1 {
		t.Fatalf("mixed-case subject export receipts=%d total=%d truncated=%v err=%v",
			len(receipts), total, truncated, err)
	}
	if receipts[0]["fire_id"] != ownerFireID {
		t.Fatalf("mixed-case subject export fire_id=%v, want %s", receipts[0]["fire_id"], ownerFireID)
	}

	terminal := ownerSkeleton
	terminal.BodyJSON = json.RawMessage(`{"event":{"type":"campaign.sent"}}`)
	terminal.StatusCode = http.StatusAccepted
	terminal.ResponseBody = "accepted"
	terminal.Outcome = "receiver_responded"
	if err := store.CompletePlaygroundFire(
		ctx, tenantID, ownerFireID, "receiver_responded", http.StatusAccepted, false, terminal,
	); err != nil {
		t.Fatalf("complete without reserved-only subject: %v", err)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var locatorCount int
	if err := verify.QueryRow(ctx, `
SELECT cardinality(subject_email_sha256s)
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, ownerFireID).Scan(&locatorCount); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatal(err)
	}
	_ = verify.Rollback(ctx)
	if locatorCount != 0 {
		t.Fatalf("terminal locator count=%d, want exact empty set", locatorCount)
	}
	if receipts, total, truncated, err = load(mixedAddress); err != nil || total != 0 || truncated || len(receipts) != 0 {
		t.Fatalf("omitted terminal subject export receipts=%d total=%d truncated=%v err=%v",
			len(receipts), total, truncated, err)
	}

	foreignFireID := uuid.NewString()
	foreignKeyHash := strings.Repeat("2", 64)
	foreignRequestHash := strings.Repeat("3", 64)
	foreignSkeleton := ownerSkeleton
	foreignSkeleton.FireID = foreignFireID
	foreignSkeleton.EventID = playgroundEventID(foreignFireID)
	foreignSkeleton.DeliveryID = "playground-" + foreignFireID
	foreignSkeleton.BodyJSON = json.RawMessage(`{"customer":{"email":"actual-owner@example.test"}}`)
	foreignEnvelope, foreignReceiptDigest, _, err := store.encryptPlaygroundFireResponse(
		ctx,
		playgroundReceiptBinding{
			Phase:              playgroundReceiptPhaseReserved,
			TenantID:           tenantID,
			FireID:             foreignFireID,
			WebhookID:          webhookID,
			EventType:          "campaign.sent",
			RequestHash:        foreignRequestHash,
			IdempotencyKeyHash: foreignKeyHash,
			ConfigVersion:      1,
			Response:           foreignSkeleton,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	staleAddress := "stale-foreign@example.test"
	staleSum := sha256.Sum256([]byte(staleAddress))
	staleDigest := hex.EncodeToString(staleSum[:])
	foreignInsert, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := foreignInsert.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256,subject_email_sha256s
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,1,$4,$5,'campaign.sent',$6,$7,ARRAY[$8]::text[]
)`, tenantID, foreignFireID, webhookID, foreignKeyHash, foreignRequestHash,
		foreignEnvelope, foreignReceiptDigest, staleDigest); err != nil {
		_ = foreignInsert.Rollback(ctx)
		t.Fatal(err)
	}
	if err := foreignInsert.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	receipts, total, truncated, err = load(staleAddress)
	if !errors.Is(err, errPlaygroundSubjectLocatorMismatch) || receipts != nil || total != 0 || truncated {
		t.Fatalf("foreign locator export receipts=%#v total=%d truncated=%v err=%v, want fail closed",
			receipts, total, truncated, err)
	}
}

func TestPlaygroundLedgerSQLAllowsCrossTenantFireIDsAndKeepsExpiredFence(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	var tableExists bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.outbound_webhook_playground_fires') IS NOT NULL`,
	).Scan(&tableExists); err != nil || !tableExists {
		t.Fatalf("playground ledger migration is not applied: exists=%v err=%v", tableExists, err)
	}
	var appCanDelete bool
	if err := pool.QueryRow(ctx, `
SELECT has_table_privilege(
    'postwave_app','public.outbound_webhook_playground_fires','DELETE'
)`).Scan(&appCanDelete); err != nil {
		t.Fatal(err)
	}
	if appCanDelete {
		t.Fatal("postwave_app can delete permanent playground identity fences")
	}
	var webhookReferenceIndex string
	if err := pool.QueryRow(ctx, `
SELECT COALESCE(pg_get_indexdef(to_regclass(
    'public.outbound_webhook_playground_fires_webhook_ref_idx'
)), '')`).Scan(&webhookReferenceIndex); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(webhookReferenceIndex, "(tenant_id, webhook_ref_id)") ||
		!strings.Contains(webhookReferenceIndex, "WHERE (webhook_ref_id IS NOT NULL)") {
		t.Fatalf("playground live-reference FK index is absent or malformed: %q", webhookReferenceIndex)
	}
	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	fireID := uuid.New().String()

	deleteTenant := func(tenantID string) error {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	defer func() {
		_ = deleteTenant(tenantA)
		_ = deleteTenant(tenantB)
	}()

	seed := func(tenantID, keyHash string) string {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier)
VALUES ($1::uuid,'playground-ledger-contract',$2,'studio')`,
			tenantID, "playground-ledger-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
			t.Fatal(err)
		}
		var webhookID string
		if err := tx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id,url,url_envelope,url_state,events,secret_envelope,
    active,auth_config_state
) VALUES (
    $1::uuid,'https://example.invalid/receipt','\x01'::bytea,'ready',
    ARRAY['campaign.sent']::text[],'\x01'::bytea,true,'ready'
)
RETURNING id::text`, tenantID).Scan(&webhookID); err != nil {
			t.Fatal(err)
		}
		skeleton := playgroundFireResponse{
			FireID:      fireID,
			EventID:     playgroundEventID(fireID),
			DeliveryID:  "playground-" + fireID,
			URL:         "https://example.invalid/receipt",
			Method:      http.MethodPost,
			Headers:     map[string]string{"Content-Type": "application/json"},
			BodyJSON:    json.RawMessage(`{"event":{"type":"campaign.sent"}}`),
			RequestedAt: "2026-08-30T00:00:00Z",
		}
		receiptStore := &Store{Cipher: xorAuthCipher{}}
		receiptEnvelope, receiptDigest, _, err := receiptStore.encryptPlaygroundFireResponse(
			ctx,
			playgroundReceiptBinding{
				Phase:              playgroundReceiptPhaseReserved,
				TenantID:           tenantID,
				FireID:             fireID,
				WebhookID:          webhookID,
				EventType:          "campaign.sent",
				RequestHash:        strings.Repeat("a", 64),
				IdempotencyKeyHash: keyHash,
				ConfigVersion:      1,
				Response:           skeleton,
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256,created_at
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,1,$4,$5,'campaign.sent',
    $6,$7,now()-interval '3 minutes'
)`, tenantID, fireID, webhookID, keyHash, strings.Repeat("a", 64),
			receiptEnvelope, receiptDigest); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return webhookID
	}
	storageKeyA := "scope-v1:" + strings.Repeat("5", 64)
	webhookA := seed(tenantA, playgroundStorageKeyHash(storageKeyA))
	storageKeyB := "scope-v1:" + strings.Repeat("6", 64)
	webhookB := seed(tenantB, playgroundStorageKeyHash(storageKeyB))

	for _, tenantID := range []string{tenantA, tenantB} {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		var count int
		err = tx.QueryRow(ctx, `
SELECT count(*) FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, fireID).Scan(&count)
		_ = tx.Rollback(ctx)
		if err != nil || count != 1 {
			t.Fatalf("tenant %s same-fire row count=%d err=%v", tenantID, count, err)
		}
	}

	// A read after the safe deadline atomically closes pending as ambiguous,
	// returns the encrypted safe skeleton, and never opens a redispatch path.
	store := &Store{Pool: pool, Cipher: xorAuthCipher{}}

	// A new external-effect identity and its precise operator audit must commit
	// together before dispatch; the terminal system evidence is likewise
	// atomic with completion and contains no destination or receipt material.
	auditedFireID := uuid.New().String()
	auditedSkeleton := playgroundFireResponse{
		FireID:      auditedFireID,
		EventID:     playgroundEventID(auditedFireID),
		DeliveryID:  "playground-" + auditedFireID,
		URL:         "https://example.invalid/…?…",
		Method:      http.MethodPost,
		Headers:     map[string]string{"Content-Type": "application/json"},
		BodyJSON:    json.RawMessage(`{"event":{"type":"campaign.sent"}}`),
		RequestedAt: "2026-08-30T00:00:00Z",
	}
	auditedReservation, err := store.ReservePlaygroundFire(ctx, playgroundFireReservationInput{
		TenantID:      tenantA,
		StorageKey:    "scope-v1:" + strings.Repeat("4", 64),
		RequestHash:   strings.Repeat("4", 64),
		FireID:        auditedFireID,
		WebhookID:     webhookA,
		EventType:     "campaign.sent",
		ConfigVersion: 1,
		Skeleton:      auditedSkeleton,
		AuditMeta: db.AuditMeta{
			TenantID:   tenantA,
			ActorType:  "human",
			ActorLabel: "route45-test",
		},
	})
	if err != nil || auditedReservation == nil || !auditedReservation.Created {
		t.Fatalf("audited reservation=%#v err=%v", auditedReservation, err)
	}
	auditedTerminal := auditedSkeleton
	auditedTerminal.StatusCode = http.StatusAccepted
	auditedTerminal.ResponseBody = "accepted"
	auditedTerminal.Outcome = "receiver_responded"
	if err := store.CompletePlaygroundFire(
		ctx,
		tenantA,
		auditedFireID,
		"receiver_responded",
		http.StatusAccepted,
		false,
		auditedTerminal,
	); err != nil {
		t.Fatalf("audited completion: %v", err)
	}
	auditTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	var reservedAuditCount, terminalAuditCount int
	var auditEvidence string
	if err := auditTx.QueryRow(ctx, `
SELECT
    count(*) FILTER (
        WHERE action='outbound_webhook.playground_fire'
          AND metadata->>'fire_id'=$2
          AND actor_type='human'
    ),
    count(*) FILTER (
        WHERE action='outbound_webhook.playground_fire.outcome'
          AND resource_id=$2
          AND actor_type='system'
    ),
    COALESCE(string_agg(metadata::text, ' '), '')
  FROM audit_log
 WHERE tenant_id=$1::uuid
   AND (
       (action='outbound_webhook.playground_fire' AND metadata->>'fire_id'=$2)
       OR (action='outbound_webhook.playground_fire.outcome' AND resource_id=$2)
   )`, tenantA, auditedFireID).Scan(
		&reservedAuditCount,
		&terminalAuditCount,
		&auditEvidence,
	); err != nil {
		_ = auditTx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = auditTx.Rollback(ctx)
	if reservedAuditCount != 1 || terminalAuditCount != 1 {
		t.Fatalf("playground audit counts reserved=%d terminal=%d", reservedAuditCount, terminalAuditCount)
	}
	for _, forbidden := range []string{
		"example.invalid",
		"receipt_envelope",
		"request_sha",
		"idempotency",
		"accepted",
	} {
		if strings.Contains(auditEvidence, forbidden) {
			t.Fatalf("playground audit evidence leaked %q: %s", forbidden, auditEvidence)
		}
	}

	auditEmissionFireID := uuid.New().String()
	auditEmissionSkeleton := auditedSkeleton
	auditEmissionSkeleton.FireID = auditEmissionFireID
	auditEmissionSkeleton.EventID = playgroundEventID(auditEmissionFireID)
	auditEmissionSkeleton.DeliveryID = "playground-" + auditEmissionFireID
	transactionalEmissionCalls := 0
	realtimeEmissionCalls := 0
	db.SetAuditTransactionalEmitter(func(
		context.Context,
		pgx.Tx,
		string,
		string,
		string,
		string,
		string,
		time.Time,
	) error {
		transactionalEmissionCalls++
		return errors.New("route45 record-only audit unexpectedly emitted")
	})
	db.SetAuditEventEmitter(func(string, string, string, string) {
		realtimeEmissionCalls++
	})
	auditEmissionReservation, auditEmissionErr := store.ReservePlaygroundFire(ctx, playgroundFireReservationInput{
		TenantID:      tenantA,
		StorageKey:    "scope-v1:" + strings.Repeat("3", 64),
		RequestHash:   strings.Repeat("3", 64),
		FireID:        auditEmissionFireID,
		WebhookID:     webhookA,
		EventType:     "campaign.sent",
		ConfigVersion: 1,
		Skeleton:      auditEmissionSkeleton,
		AuditMeta: db.AuditMeta{
			TenantID:   tenantA,
			ActorType:  "human",
			ActorLabel: "route45-test",
		},
	})
	if auditEmissionErr == nil {
		auditEmissionTerminal := auditEmissionSkeleton
		auditEmissionTerminal.StatusCode = http.StatusNoContent
		auditEmissionTerminal.Outcome = "receiver_responded"
		auditEmissionErr = store.CompletePlaygroundFire(
			ctx,
			tenantA,
			auditEmissionFireID,
			"receiver_responded",
			http.StatusNoContent,
			false,
			auditEmissionTerminal,
		)
	}
	db.SetAuditTransactionalEmitter(nil)
	db.SetAuditEventEmitter(nil)
	if auditEmissionErr != nil || auditEmissionReservation == nil || !auditEmissionReservation.Created {
		t.Fatalf("record-only audited lifecycle reservation=%#v err=%v", auditEmissionReservation, auditEmissionErr)
	}
	if transactionalEmissionCalls != 0 || realtimeEmissionCalls != 0 {
		t.Fatalf(
			"record-only playground audit emitter calls transactional=%d realtime=%d, want zero",
			transactionalEmissionCalls,
			realtimeEmissionCalls,
		)
	}
	auditEmissionTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	var emittedReceiptCount, emittedAuditCount int
	if err := auditEmissionTx.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM outbound_webhook_playground_fires
      WHERE tenant_id=$1::uuid AND fire_id=$2::uuid),
	    (SELECT count(*) FROM audit_log
	      WHERE tenant_id=$1::uuid
	        AND ((action='outbound_webhook.playground_fire' AND metadata->>'fire_id'=$2::text)
	          OR (action='outbound_webhook.playground_fire.outcome' AND resource_id=$2::text)))`,
		tenantA,
		auditEmissionFireID,
	).Scan(&emittedReceiptCount, &emittedAuditCount); err != nil {
		_ = auditEmissionTx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = auditEmissionTx.Rollback(ctx)
	if emittedReceiptCount != 1 || emittedAuditCount != 2 {
		t.Fatalf("record-only audit lifecycle receipt=%d audits=%d, want 1 and 2", emittedReceiptCount, emittedAuditCount)
	}

	// Reservation is the linearization fence for the previously prepared
	// destination snapshot. A capability mutation that commits between prepare
	// and reserve must make reservation fail without leaving an identity row;
	// the HTTP handler therefore has no path to the receiver transport.
	raceWebhookID := uuid.New().String()
	raceFireID := uuid.New().String()
	raceStorageKey := "scope-v1:" + strings.Repeat("7", 64)
	rawURL := "https://example.invalid/linearization"
	urlEnvelope, encryptErr := store.Cipher.Encrypt(ctx, []byte(rawURL))
	if encryptErr != nil {
		t.Fatal(encryptErr)
	}
	secretEnvelope, encryptErr := store.Cipher.Encrypt(ctx, []byte("route45-secret"))
	if encryptErr != nil {
		t.Fatal(encryptErr)
	}
	raceTx, raceErr := db.WithTenant(ctx, pool, tenantA)
	if raceErr != nil {
		t.Fatal(raceErr)
	}
	if _, raceErr = raceTx.Exec(ctx, `
INSERT INTO outbound_webhooks (
    id,tenant_id,url,url_envelope,url_state,events,secret_envelope,
    active,auth_config_state
) VALUES (
    $1::uuid,$2::uuid,$3,$4,'ready',ARRAY['campaign.sent']::text[],$5,
    true,'ready'
)`, raceWebhookID, tenantA, rawURL, urlEnvelope, secretEnvelope); raceErr != nil {
		_ = raceTx.Rollback(ctx)
		t.Fatal(raceErr)
	}
	if raceErr = raceTx.Commit(ctx); raceErr != nil {
		t.Fatal(raceErr)
	}
	prepared, raceErr := store.PreparePlaygroundFire(
		ctx, tenantA, raceWebhookID, 1, time.Now().UTC(),
	)
	if raceErr != nil || prepared == nil || prepared.ConfigVersion != 1 || prepared.Destination != rawURL {
		t.Fatalf("prepared linearization target=%#v err=%v", prepared, raceErr)
	}
	raceTx, raceErr = db.WithTenant(ctx, pool, tenantA)
	if raceErr != nil {
		t.Fatal(raceErr)
	}
	if _, raceErr = raceTx.Exec(ctx, `
UPDATE outbound_webhooks
   SET events=ARRAY['audit.created']::text[],config_version=config_version+1
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, raceWebhookID); raceErr != nil {
		_ = raceTx.Rollback(ctx)
		t.Fatal(raceErr)
	}
	if raceErr = raceTx.Commit(ctx); raceErr != nil {
		t.Fatal(raceErr)
	}
	raceSkeleton := playgroundFireResponse{
		FireID:      raceFireID,
		EventID:     playgroundEventID(raceFireID),
		DeliveryID:  "playground-" + raceFireID,
		URL:         prepared.DisplayURL,
		Method:      http.MethodPost,
		BodyJSON:    json.RawMessage(`{}`),
		RequestedAt: "2026-08-30T00:00:00Z",
	}
	if _, raceErr = store.ReservePlaygroundFire(ctx, playgroundFireReservationInput{
		TenantID:      tenantA,
		StorageKey:    raceStorageKey,
		RequestHash:   strings.Repeat("7", 64),
		FireID:        raceFireID,
		WebhookID:     raceWebhookID,
		EventType:     "campaign.sent",
		ConfigVersion: prepared.ConfigVersion,
		Skeleton:      raceSkeleton,
		AuditMeta:     db.AuditMeta{TenantID: tenantA, ActorType: "human", ActorLabel: "route45-test"},
	}); !errors.Is(raceErr, errPlaygroundWebhookChanged) {
		t.Fatalf("reserve after capability race error=%v, want webhook changed", raceErr)
	}
	raceTx, raceErr = db.WithTenant(ctx, pool, tenantA)
	if raceErr != nil {
		t.Fatal(raceErr)
	}
	var orphanCount int
	if raceErr = raceTx.QueryRow(ctx, `
SELECT count(*) FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantA, raceFireID).Scan(&orphanCount); raceErr != nil {
		_ = raceTx.Rollback(ctx)
		t.Fatal(raceErr)
	}
	_ = raceTx.Rollback(ctx)
	if orphanCount != 0 {
		t.Fatalf("stale snapshot left %d orphan reservation rows", orphanCount)
	}

	deletedPrepared, raceErr := store.PreparePlaygroundFire(
		ctx, tenantA, raceWebhookID, 2, time.Now().UTC(),
	)
	if raceErr != nil || deletedPrepared == nil || deletedPrepared.ConfigVersion != 2 {
		t.Fatalf("prepared pre-delete target=%#v err=%v", deletedPrepared, raceErr)
	}
	raceTx, raceErr = db.WithTenant(ctx, pool, tenantA)
	if raceErr != nil {
		t.Fatal(raceErr)
	}
	if _, raceErr = raceTx.Exec(ctx, `
DELETE FROM outbound_webhooks
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, raceWebhookID); raceErr != nil {
		_ = raceTx.Rollback(ctx)
		t.Fatal(raceErr)
	}
	if raceErr = raceTx.Commit(ctx); raceErr != nil {
		t.Fatal(raceErr)
	}
	deletedFireID := uuid.New().String()
	deletedSkeleton := raceSkeleton
	deletedSkeleton.FireID = deletedFireID
	deletedSkeleton.EventID = playgroundEventID(deletedFireID)
	deletedSkeleton.DeliveryID = "playground-" + deletedFireID
	if _, raceErr = store.ReservePlaygroundFire(ctx, playgroundFireReservationInput{
		TenantID:      tenantA,
		StorageKey:    "scope-v1:" + strings.Repeat("8", 64),
		RequestHash:   strings.Repeat("8", 64),
		FireID:        deletedFireID,
		WebhookID:     raceWebhookID,
		EventType:     "audit.created",
		ConfigVersion: deletedPrepared.ConfigVersion,
		Skeleton:      deletedSkeleton,
		AuditMeta:     db.AuditMeta{TenantID: tenantA, ActorType: "human", ActorLabel: "route45-test"},
	}); !errors.Is(raceErr, errPlaygroundWebhookChanged) {
		t.Fatalf("reserve after endpoint delete error=%v, want webhook changed", raceErr)
	}
	raceTx, raceErr = db.WithTenant(ctx, pool, tenantA)
	if raceErr != nil {
		t.Fatal(raceErr)
	}
	if raceErr = raceTx.QueryRow(ctx, `
SELECT count(*) FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantA, deletedFireID).Scan(&orphanCount); raceErr != nil {
		_ = raceTx.Rollback(ctx)
		t.Fatal(raceErr)
	}
	_ = raceTx.Rollback(ctx)
	if orphanCount != 0 {
		t.Fatalf("deleted endpoint left %d orphan reservation rows", orphanCount)
	}

	stale, err := store.RecoverPlaygroundFire(
		ctx, tenantB, storageKeyB, strings.Repeat("a", 64),
	)
	if err != nil || stale.State != "ambiguous" || stale.Response == nil ||
		!stale.Response.Ambiguous || stale.Response.Outcome != "transport_ambiguous" {
		t.Fatalf("stale recovery = %#v, err=%v", stale, err)
	}

	// Even a changed-body retry must commit the overdue ambiguity transition
	// before returning the idempotency conflict. Otherwise an attacker could
	// keep durable reconciliation misleadingly pending forever.
	if _, mismatchErr := store.RecoverPlaygroundFire(
		ctx, tenantA, storageKeyA, strings.Repeat("f", 64),
	); !errors.Is(mismatchErr, errPlaygroundIdempotencyConflict) {
		t.Fatalf("stale mismatched recovery error=%v, want idempotency conflict", mismatchErr)
	}
	verifyTx, verifyErr := db.WithTenant(ctx, pool, tenantA)
	if verifyErr != nil {
		t.Fatal(verifyErr)
	}
	var reconciledState string
	if verifyErr = verifyTx.QueryRow(ctx, `
SELECT state FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantA, fireID).Scan(&reconciledState); verifyErr != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatal(verifyErr)
	}
	_ = verifyTx.Rollback(ctx)
	if reconciledState != "ambiguous" {
		t.Fatalf("stale mismatched recovery state=%q, want ambiguous", reconciledState)
	}

	// Operational/description writes leave the public confirmation revision
	// stable. During the rolling-deploy bridge a legacy capability writer that
	// omits config_version is advanced by the trigger, while a current writer's
	// explicit single-step bump remains valid.
	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE outbound_webhooks SET description='operator label',updated_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, webhookA); err != nil {
		t.Fatal(err)
	}
	var configVersion int64
	if err := tx.QueryRow(ctx, `
SELECT config_version FROM outbound_webhooks
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, webhookA).Scan(&configVersion); err != nil || configVersion != 1 {
		t.Fatalf("description config version=%d err=%v, want 1", configVersion, err)
	}
	if err := tx.QueryRow(ctx, `
UPDATE outbound_webhooks SET active=false
	 WHERE tenant_id=$1::uuid AND id=$2::uuid
RETURNING config_version`, tenantA, webhookA).Scan(&configVersion); err != nil || configVersion != 2 {
		t.Fatalf("legacy writer config version=%d err=%v, want 2", configVersion, err)
	}
	if err := tx.QueryRow(ctx, `
UPDATE outbound_webhooks SET active=true,config_version=config_version+1
	 WHERE tenant_id=$1::uuid AND id=$2::uuid
RETURNING config_version`, tenantA, webhookA).Scan(&configVersion); err != nil || configVersion != 3 {
		t.Fatalf("current writer config version=%d err=%v, want 3", configVersion, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Historical and live ids must agree, and the live composite edge must
	// resolve inside tenant A rather than accepting tenant B's webhook id.
	tx, err = db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	_, crossTenantErr := tx.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,1,$4,$5,'campaign.sent','\x01'::bytea,$6
)`, tenantA, uuid.New().String(), webhookB, strings.Repeat("d", 64),
		strings.Repeat("f", 64), strings.Repeat("e", 64))
	_ = tx.Rollback(ctx)
	var pgErr *pgconn.PgError
	if !errors.As(crossTenantErr, &pgErr) ||
		pgErr.ConstraintName != "outbound_webhook_playground_fire_webhook_tenant_fkey" {
		t.Fatalf("cross-tenant webhook insert error=%v, want composite FK", crossTenantErr)
	}

	// Expiring the receipt payload leaves both uniqueness fences in place.
	tx, err = db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='receipt_expired',receipt_envelope=NULL,receipt_sha256=NULL,
       receipt_expired_at=now()
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantA, fireID); err != nil {
		t.Fatal(err)
	}
	for _, attempt := range []struct {
		fireID  string
		keyHash string
	}{
		{fireID: fireID, keyHash: strings.Repeat("9", 64)},
		{fireID: uuid.New().String(), keyHash: playgroundStorageKeyHash(storageKeyA)},
	} {
		tag, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,1,$4,$5,'campaign.sent','\x01'::bytea,$6
)
ON CONFLICT DO NOTHING`, tenantA, attempt.fireID, webhookA, attempt.keyHash,
			strings.Repeat("8", 64), strings.Repeat("7", 64))
		if err != nil || tag.RowsAffected() != 0 {
			t.Fatalf("expired receipt fence insertion rows=%d err=%v", tag.RowsAffected(), err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// A privileged endpoint purge must preserve the permanent receipt while
	// the composite FK clears only its live reference. This exercises the FK's
	// internal SET NULL update against the immutability trigger's parent-exists
	// guard; historical webhook_id must never be erased with the parent row.
	tx, err = db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM outbound_webhooks
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, webhookA); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("purge endpoint with permanent receipt: %v", err)
	}
	var historicalWebhookID string
	var liveWebhookID *string
	if err := tx.QueryRow(ctx, `
SELECT webhook_id::text,webhook_ref_id::text
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantA, fireID).Scan(
		&historicalWebhookID, &liveWebhookID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if historicalWebhookID != webhookA || liveWebhookID != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("endpoint purge receipt ids historical=%q live=%v", historicalWebhookID, liveWebhookID)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Workspace erasure must remove the child without fighting the webhook's
	// composite ON DELETE SET NULL action.
	if err := deleteTenant(tenantA); err != nil {
		t.Fatalf("tenant cascade: %v", err)
	}
	tx, err = db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var remaining int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid`, tenantA).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("tenant cascade left %d receipts: %v", remaining, err)
	}
}
