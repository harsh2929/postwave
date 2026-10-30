// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

// The list names in the pre-send checklist and the send review come from the
// engine through newCampaignListNamer, the adapter main.go wires onto the
// campaigns repository. The engine is shared by every tenant, so the adapter
// must prove ownership before it asks.

func campaignLabelsDB(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping campaign audience label proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedLabelTenant creates a tenant and maps engine list engineID to it.
func seedLabelTenant(t *testing.T, pool *db.Pool, engineID int64) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'campaign list labels', $2, 'studio')`, tenantID, "campaign-list-labels-"+tenantID[:8]); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if engineID > 0 {
		if _, err := tx.Exec(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES (gen_random_uuid(), $2, $1::uuid)`, tenantID, engineID); err != nil {
			t.Fatalf("insert list identity: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupTx, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Errorf("cleanup tx: %v", err)
			return
		}
		defer func() { _ = cleanupTx.Rollback(context.Background()) }()
		if _, err := cleanupTx.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
			t.Errorf("cleanup tenant: %v", err)
			return
		}
		_ = cleanupTx.Commit(context.Background())
	})
	return tenantID
}

// recordedEngine serves Listmonk v6.1.0's recorded GET /api/lists/1 body
// (internal/listmonk/testdata) and counts every request it receives.
func recordedEngine(t *testing.T, requests *atomic.Int32) *listmonk.Client {
	t.Helper()
	body, err := os.ReadFile("internal/listmonk/testdata/v6.1.0_get_list_200.json")
	if err != nil {
		t.Fatalf("read recorded engine response: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/api/lists/1" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"message":"List not found"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return listmonk.New(listmonk.Config{BaseURL: server.URL, Username: "api", Password: "token"})
}

func TestCampaignListNamerReadsTheNameOfTheTenantsList(t *testing.T) {
	pool := campaignLabelsDB(t)
	tenantID := seedLabelTenant(t, pool, 1)
	var requests atomic.Int32

	name, err := newCampaignListNamer(pool, recordedEngine(t, &requests)).
		ListName(context.Background(), tenantID, "1")
	if err != nil {
		t.Fatalf("ListName: %v", err)
	}
	if name != "Default list" {
		t.Fatalf("name = %q, want the engine's \"Default list\"", name)
	}
}

// Engine list ids are global. A tenant naming another tenant's list id must
// learn nothing — and the engine must not even be asked.
func TestCampaignListNamerNeverAsksTheEngineAboutAnotherTenantsList(t *testing.T) {
	pool := campaignLabelsDB(t)
	_ = seedLabelTenant(t, pool, 1) // the owner
	stranger := seedLabelTenant(t, pool, 0)
	var requests atomic.Int32

	name, err := newCampaignListNamer(pool, recordedEngine(t, &requests)).
		ListName(context.Background(), stranger, "1")
	if err == nil || name != "" {
		t.Fatalf("ListName for a foreign list = %q, %v; want an error and no name", name, err)
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("the engine was asked %d time(s) about a list the tenant does not own", n)
	}
}

// The production audience counter sizes a list the way a send resolves it, so
// a list the workspace does not have is the campaigns package's typed
// not-found — which the count endpoint answers as 422 list_not_found — rather
// than the lists package's identity error, which it could only report as 500.
func TestProductionAudienceCounterReportsAnUnknownListAsNotFound(t *testing.T) {
	pool := campaignLabelsDB(t)
	tenantID := seedLabelTenant(t, pool, 0)

	_, err := newAudienceCounter(pool).CountListAudience(context.Background(), tenantID, "4242")
	if !errors.Is(err, campaigns.ErrAudienceListNotFound) {
		t.Fatalf("CountListAudience(unknown) err = %v, want campaigns.ErrAudienceListNotFound", err)
	}
}
