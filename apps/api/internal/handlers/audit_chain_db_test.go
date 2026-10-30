// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// "What happened when I clicked send?"
//
// One request writes audit rows across several of the 35 audit tables — the
// mutation, an approval decision, an entitlement check, an outbox dispatch —
// and nothing said they belonged together. Reconstructing the moment meant
// eyeballing timestamps and hoping no two operators acted in the same second.

func seedAuditChain(t *testing.T, pool *db.Pool, correlation string, actions ...string) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'chain', 'studio')`,
		tenantID, "chain-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	for i, action := range actions {
		meta := map[string]any{"context": map[string]any{"correlation_id": correlation}}
		if correlation == "" {
			meta = map[string]any{"context": map[string]any{}}
		}
		raw, _ := json.Marshal(meta)
		if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, actor_type, metadata, at)
VALUES ($1::uuid, $2, 'campaign', 'camp-1', 'human', $3::jsonb, now() + make_interval(secs => $4))`,
			tenantID, action, string(raw), float64(i)); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed audit row: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		// audit_log is append-only — audit_log_immutability_guard() rejects
		// DELETE, which is the correct design for an audit trail. The rows stay;
		// each test uses a fresh tenant so they cannot affect another run.
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID
}

func chainRequest(tenantID, requestID string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/chain/"+requestID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("requestId", requestID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: tenantID, Slug: "acme", Tier: "studio",
	}))
}

func decodeChain(t *testing.T, rec *httptest.ResponseRecorder) struct {
	RequestID string           `json:"requestId"`
	Rows      []map[string]any `json:"rows"`
	Truncated bool             `json:"truncated"`
} {
	t.Helper()
	// Check the status FIRST. Without this a 500 decodes to an empty `rows`
	// slice and every assertion below reads it as "no rows matched" — the
	// failure and the expected-empty case become indistinguishable.
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		RequestID string           `json:"requestId"`
		Rows      []map[string]any `json:"rows"`
		Truncated bool             `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not the chain envelope: %s", rec.Body.String())
	}
	return out
}

func TestTheChainAssemblesOneRequestsRows(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "req-abc",
		"campaign.updated", "approval.decided", "campaign.queued")

	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).AuditChain(rec, chainRequest(tenantID, "req-abc"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	got := decodeChain(t, rec)
	if len(got.Rows) != 3 {
		t.Fatalf("got %d rows, want the 3 this request produced", len(got.Rows))
	}
	// Ascending: a causal chain read backwards is not a narrative.
	if got.Rows[0]["action"] != "campaign.updated" ||
		got.Rows[2]["action"] != "campaign.queued" {
		t.Fatalf("chain is not in causal order: %v %v",
			got.Rows[0]["action"], got.Rows[2]["action"])
	}
}

func TestTheChainIgnoresOtherRequests(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "req-mine", "campaign.updated")
	// A second request in the SAME tenant, seconds apart — the case timestamp
	// eyeballing gets wrong.
	other := seedAuditChain(t, pool, "req-theirs", "campaign.updated")
	_ = other

	rec := httptest.NewRecorder()
	h := &AuditHandlers{Pool: pool, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	h.AuditChain(rec, chainRequest(tenantID, "req-mine"))
	got := decodeChain(t, rec)
	if len(got.Rows) != 1 {
		t.Fatalf("got %d rows, want only this request's", len(got.Rows))
	}
}

func TestARequestIdCannotReadAnotherWorkspace(t *testing.T) {
	// A request id is not a secret — it appears in logs and error responses —
	// so it must never work as a capability across tenants.
	pool := auditExportDB(t)
	victim := seedAuditChain(t, pool, "req-shared", "campaign.updated", "approval.decided")
	attacker := seedAuditChain(t, pool, "req-unrelated", "campaign.updated")
	_ = victim

	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).AuditChain(rec, chainRequest(attacker, "req-shared"))
	got := decodeChain(t, rec)
	if len(got.Rows) != 0 {
		t.Fatalf("read %d rows from another workspace using its request id", len(got.Rows))
	}
}

func TestAnUnknownRequestIdIsEmptyNotAnError(t *testing.T) {
	// The engineer pasted an id from a log line for a request that wrote no
	// audit rows. "Nothing happened" is the answer, not a failure.
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "req-real", "campaign.updated")

	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).AuditChain(rec, chainRequest(tenantID, "req-nothing"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200 with an empty chain", rec.Code)
	}
	if got := decodeChain(t, rec); len(got.Rows) != 0 {
		t.Fatalf("got %d rows for an unknown id", len(got.Rows))
	}
}

func TestRowsWithNoCorrelationAreNotGroupedTogether(t *testing.T) {
	// Background work writes no correlation_id. If an absent field matched an
	// empty query, every unrelated worker row would appear as one chain.
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "", "worker.pruned", "worker.swept")

	rec := httptest.NewRecorder()
	(&AuditHandlers{Pool: pool}).AuditChain(rec, chainRequest(tenantID, "-"))
	if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want a validation refusal for a placeholder id", rec.Code)
	}
	_ = time.Now
}

// A real chi router, because the helper above cannot see the bug this catches.
//
// `chainRequest` injects `rctx.URLParams.Add("requestId", ...)` directly, which
// skips chi's routing and therefore skips URL decoding entirely. Every existing
// test in this file also uses slash-free ids like "req-abc". Between them, the
// suite was structurally incapable of noticing that the handler received the
// param still percent-encoded — so it passed for the whole life of the defect.
//
// Real correlation ids are not slash-free. chi's own generator builds
// `hostname/b64prefix-000001` (middleware/request_id.go), so the slash is in
// every id the system actually mints, and a client has to encode it to keep the
// id inside one path segment. Before the decode in AuditChain, the handler
// compared "host%2Fb64-000001" against the stored "host/b64-000001" and
// returned an empty chain — telling the operator this request touched nothing.
func TestTheChainDecodesAnEncodedRequestIdThroughARealRouter(t *testing.T) {
	pool := auditExportDB(t)

	// Shaped exactly like chi's: hostname, a slash, a base62 prefix, a counter.
	const realWorldID = "postwave-api-7c9f/lF3kQ2xTvB-000042"
	tenantID := seedAuditChain(t, pool, realWorldID,
		"campaign.updated", "approval.decided", "campaign.queued")

	handlers := &AuditHandlers{Pool: pool}
	router := chi.NewRouter()
	router.Get("/api/v1/audit/chain/{requestId}", func(w http.ResponseWriter, r *http.Request) {
		handlers.AuditChain(w, r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{
			ID: tenantID, Slug: "acme", Tier: "studio",
		})))
	})

	// What a browser sends: the slash encoded so the id stays one segment.
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/audit/chain/"+url.PathEscape(realWorldID), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	got := decodeChain(t, rec)
	if len(got.Rows) != 3 {
		t.Fatalf("got %d rows for an encoded real-world request id, want the 3 it produced. "+
			"An empty chain here is the silent failure: the operator is told this request "+
			"touched nothing.", len(got.Rows))
	}
	if got.RequestID != realWorldID {
		t.Fatalf("echoed requestId = %q, want the decoded %q", got.RequestID, realWorldID)
	}
}

// The unencoded case must keep working, because chi only consults RawPath when
// the URL actually contained an escape — so the decode must be a no-op here.
func TestASlashFreeRequestIdStillWorksThroughARealRouter(t *testing.T) {
	pool := auditExportDB(t)
	tenantID := seedAuditChain(t, pool, "req-plain", "campaign.updated")

	handlers := &AuditHandlers{Pool: pool}
	router := chi.NewRouter()
	router.Get("/api/v1/audit/chain/{requestId}", func(w http.ResponseWriter, r *http.Request) {
		handlers.AuditChain(w, r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{
			ID: tenantID, Slug: "acme", Tier: "studio",
		})))
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/chain/req-plain", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	got := decodeChain(t, rec)
	if len(got.Rows) != 1 {
		t.Fatalf("got %d rows for an unencoded id, want 1", len(got.Rows))
	}
}
