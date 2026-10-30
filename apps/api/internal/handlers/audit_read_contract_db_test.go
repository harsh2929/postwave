// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func auditReadRequest(method, target, body, tenantID string, counter *atomic.Int64) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: tenantID, Slug: "audit-contract", Tier: "studio",
	})
	ctx = middleware.WithRowCounter(ctx, counter)
	return req.WithContext(ctx)
}

func TestAuditListCursorRequiresAnActualLookaheadRow_DB(t *testing.T) {
	pool := auditExportDB(t)
	h := &AuditHandlers{Pool: pool}

	t.Run("exactly full terminal page", func(t *testing.T) {
		tenantID := seedAuditChain(t, pool, "list-terminal",
			"campaign.first", "campaign.second")
		counter := new(atomic.Int64)
		rec := httptest.NewRecorder()
		h.List(rec, auditReadRequest(http.MethodGet,
			"/api/v1/audit?limit=2&action=campaign.", "", tenantID, counter))

		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var got struct {
			Rows       []AuditRow `json:"rows"`
			NextCursor *string    `json:"nextCursor"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Rows) != 2 || got.NextCursor != nil {
			t.Fatalf("rows=%d nextCursor=%v, want 2 rows and no cursor", len(got.Rows), got.NextCursor)
		}
		if counter.Load() != 2 {
			t.Fatalf("meta row count=%d, want 2 visible rows", counter.Load())
		}
	})

	t.Run("extra row proves continuation", func(t *testing.T) {
		tenantID := seedAuditChain(t, pool, "list-more",
			"campaign.first", "campaign.second", "campaign.third")
		counter := new(atomic.Int64)
		rec := httptest.NewRecorder()
		h.List(rec, auditReadRequest(http.MethodGet,
			"/api/v1/audit?limit=2&action=campaign.", "", tenantID, counter))

		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var got struct {
			Rows       []AuditRow `json:"rows"`
			NextCursor *string    `json:"nextCursor"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Rows) != 2 || got.NextCursor == nil || *got.NextCursor == "" {
			t.Fatalf("rows=%d nextCursor=%v, want 2 rows and a cursor", len(got.Rows), got.NextCursor)
		}
		if counter.Load() != 2 {
			t.Fatalf("meta row count=%d, want only the 2 visible rows", counter.Load())
		}
	})
}

func TestAuditStatsAndCountShareTheDefaultMetaReadExclusion_DB(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "aggregate-default",
		"campaign.updated", "audit.read.list", "audit.read.stats")
	h := &AuditHandlers{Pool: pool}

	statsCounter := new(atomic.Int64)
	statsRec := httptest.NewRecorder()
	h.Stats(statsRec, auditReadRequest(http.MethodGet,
		"/api/v1/audit/stats", "", tenantID, statsCounter))
	if statsRec.Code != http.StatusOK {
		t.Fatalf("stats status=%d body=%s", statsRec.Code, statsRec.Body.String())
	}
	var stats AuditStatsResponse
	if err := json.Unmarshal(statsRec.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.TotalEvents != 1 || statsCounter.Load() != 1 {
		t.Fatalf("stats total=%d meta row count=%d, want 1/1", stats.TotalEvents, statsCounter.Load())
	}

	countRec := httptest.NewRecorder()
	h.Count(countRec, auditReadRequest(http.MethodGet,
		"/api/v1/audit/count", "", tenantID, new(atomic.Int64)))
	if countRec.Code != http.StatusOK {
		t.Fatalf("count status=%d body=%s", countRec.Code, countRec.Body.String())
	}
	var count AuditCountResponse
	if err := json.Unmarshal(countRec.Body.Bytes(), &count); err != nil {
		t.Fatal(err)
	}
	if count.Confidence != "exact" || count.TotalEstimate != stats.TotalEvents {
		t.Fatalf("count=%+v stats total=%d; companion reads disagree", count, stats.TotalEvents)
	}

	metaRec := httptest.NewRecorder()
	h.Stats(metaRec, auditReadRequest(http.MethodGet,
		"/api/v1/audit/stats?action=audit.read", "", tenantID, new(atomic.Int64)))
	var metaStats AuditStatsResponse
	if err := json.Unmarshal(metaRec.Body.Bytes(), &metaStats); err != nil {
		t.Fatal(err)
	}
	if metaStats.TotalEvents != 2 {
		t.Fatalf("explicit audit.read filter total=%d, want the 2 meta-read rows", metaStats.TotalEvents)
	}
}

func TestAuditChainHandlesNullableResourceAndReportsVisibleRows_DB(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "chain-seed", "campaign.seed")
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, resource_type, actor_type, metadata)
VALUES ($1::uuid, 'system.null_resource', NULL, 'system',
        '{"context":{"correlation_id":"chain-null"}}'::jsonb)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	counter := new(atomic.Int64)
	req := chainRequest(tenantID, "chain-null")
	req = req.WithContext(middleware.WithRowCounter(req.Context(), counter))
	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).AuditChain(rec, req)
	got := decodeChain(t, rec)
	if len(got.Rows) != 1 || got.Rows[0]["resourceType"] != "" {
		t.Fatalf("nullable resource chain=%v, want one row with empty resourceType", got.Rows)
	}
	if counter.Load() != 1 {
		t.Fatalf("meta row count=%d, want 1", counter.Load())
	}
}

func TestAuditChainTruncationRequiresThe501stRow_DB(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "chain-seed", "campaign.seed")
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, actor_type, metadata)
SELECT $1::uuid, 'chain.step', 'system',
       jsonb_build_object('context', jsonb_build_object('correlation_id', 'chain-large'))
  FROM generate_series(1, 501)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	counter := new(atomic.Int64)
	req := chainRequest(tenantID, "chain-large")
	req = req.WithContext(middleware.WithRowCounter(req.Context(), counter))
	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).AuditChain(rec, req)
	got := decodeChain(t, rec)
	if len(got.Rows) != auditChainLimit || !got.Truncated {
		t.Fatalf("rows=%d truncated=%v, want %d/true", len(got.Rows), got.Truncated, auditChainLimit)
	}
	if counter.Load() != auditChainLimit {
		t.Fatalf("meta row count=%d, want %d visible rows", counter.Load(), auditChainLimit)
	}
}

func TestUpdateSavedViewValidatesAnEmptyPatchBeforeLookingUpTheTarget_DB(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "saved-view-seed", "campaign.seed")
	id := uuid.NewString()
	req := auditReadRequest(http.MethodPatch,
		"/api/v1/audit/saved-views/"+id, `{}`, tenantID, new(atomic.Int64))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).UpdateSavedView(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"empty_patch"`) {
		t.Fatalf("status=%d body=%s, want typed 400", rec.Code, rec.Body.String())
	}
}
