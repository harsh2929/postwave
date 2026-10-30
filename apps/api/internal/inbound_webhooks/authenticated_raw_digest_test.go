// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestInboundAuthenticatedRawDigestMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1794_inbound_webhook_authenticated_raw_digest.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1794: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1794_inbound_webhook_authenticated_raw_digest",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1794 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS authenticated_raw_body_sha256 bytea",
		"inbound_events_authenticated_raw_digest_length_check",
		"octet_length(authenticated_raw_body_sha256) = 32",
		"SHA-256 of the exact authenticated request bytes",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1794 missing contract %q", contract)
		}
	}

	handlerRaw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "handlers.go"))
	if err != nil {
		t.Fatalf("read handlers: %v", err)
	}
	handler := string(handlerRaw)
	if !strings.Contains(handler, "rawBodyDigest := sha256.Sum256(body)") ||
		!strings.Contains(handler, "AuthenticatedRawBodySHA256: rawBodyDigest[:]") {
		t.Fatal("ingest does not bind the replay check to authenticated raw bytes")
	}
}

func TestRecordEventWithActionsUsesAuthenticatedRawDigestAcrossTransforms(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping authenticated raw digest integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	// t.Cleanup, not defer: the tenant cleanup needs this pool, and deferred
	// calls run before t.Cleanup callbacks (see TestRepoList_QFilter).
	t.Cleanup(pool.Close)
	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool, Cipher: &recordingInboundEnvelopeCipher{}}
	created, err := repo.Create(ctx, tenantID, "raw digest transform identity")
	if err != nil {
		t.Fatalf("create endpoint: %v", err)
	}
	sourceEventID := inboundReplayKeyPrefix + strings.Repeat("a", sha256.Size*2)
	rawOne := sha256.Sum256([]byte(`{"customer":{"id":1},"volatile":"first"}`))
	rawTwo := sha256.Sum256([]byte(`{"customer":{"id":2},"volatile":"second"}`))
	firstProcessed := []byte(`{"customer_id":1}`)
	firstID, duplicate, _, err := repo.RecordEventWithActions(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		firstProcessed,
		true,
		sourceEventID,
		RecordEventOptions{AuthenticatedRawBodySHA256: rawOne[:]},
	)
	if err != nil {
		t.Fatalf("record event (migration 1794 may be absent): %v", err)
	}
	if duplicate {
		t.Fatal("first receipt marked duplicate")
	}

	secondID, duplicate, _, err := repo.RecordEventWithActions(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		[]byte(`{"transform":"edited after first receipt"}`),
		true,
		sourceEventID,
		RecordEventOptions{AuthenticatedRawBodySHA256: rawOne[:]},
	)
	if err != nil || !duplicate || secondID != firstID {
		t.Fatalf("exact raw retry after transform edit = id %d duplicate %v err %v", secondID, duplicate, err)
	}

	if _, _, _, err := repo.RecordEventWithActions(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		firstProcessed,
		true,
		sourceEventID,
		RecordEventOptions{AuthenticatedRawBodySHA256: rawTwo[:]},
	); !errors.Is(err, ErrReplayConflict) {
		t.Fatalf("distinct raw body collapsing to same transform error = %v, want ErrReplayConflict", err)
	}
}
