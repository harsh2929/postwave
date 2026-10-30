// SPDX-License-Identifier: AGPL-3.0-only

package compliance

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestComplianceLifecycleRejectsStaleWritesAndRetainsEvidence(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping compliance lifecycle operational test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(seed): %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'compliance-operational', 'compliance-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		tx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM compliance_program_events WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM compliance_programs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	deps := &Deps{Pool: pool}
	digest := strings.Repeat("a", 64)
	created := invokeCompliance(t, deps, tenantID, http.MethodPost,
		"/api/v1/compliance/programs/soc2/attest", FrameworkSOC2,
		map[string]any{
			"signedByEmail":  "owner@example.com",
			"documentPath":   "s3://private/evidence.pdf",
			"documentSha256": digest,
		})
	if created.Code != http.StatusOK {
		t.Fatalf("initial attest=%d body=%s", created.Code, created.Body.String())
	}
	firstRevision := receiptRevision(t, created)

	renewed := invokeCompliance(t, deps, tenantID, http.MethodPost,
		"/api/v1/compliance/programs/soc2/attest", FrameworkSOC2,
		map[string]any{
			"signedByEmail":     "owner@example.com",
			"notes":             "Annual review",
			"expectedUpdatedAt": firstRevision,
		})
	if renewed.Code != http.StatusOK {
		t.Fatalf("renew=%d body=%s", renewed.Code, renewed.Body.String())
	}
	secondRevision := receiptRevision(t, renewed)
	if secondRevision == firstRevision {
		t.Fatalf("renewal did not advance revision: %s", firstRevision)
	}

	stale := invokeCompliance(t, deps, tenantID, http.MethodPost,
		"/api/v1/compliance/programs/soc2/attest", FrameworkSOC2,
		map[string]any{
			"signedByEmail":     "stale@example.com",
			"expectedUpdatedAt": firstRevision,
		})
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "stale_program") {
		t.Fatalf("stale renewal=%d body=%s", stale.Code, stale.Body.String())
	}

	revoked := invokeCompliance(t, deps, tenantID, http.MethodPost,
		"/api/v1/compliance/programs/soc2/revoke", FrameworkSOC2,
		map[string]any{
			"reason":            "Evidence expired",
			"expectedUpdatedAt": secondRevision,
		})
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke=%d body=%s", revoked.Code, revoked.Body.String())
	}

	repeated := invokeCompliance(t, deps, tenantID, http.MethodPost,
		"/api/v1/compliance/programs/soc2/revoke", FrameworkSOC2,
		map[string]any{
			"reason":            "duplicate",
			"expectedUpdatedAt": secondRevision,
		})
	if repeated.Code != http.StatusConflict {
		t.Fatalf("repeated revoke=%d body=%s", repeated.Code, repeated.Body.String())
	}

	ledger := invokeCompliance(t, deps, tenantID, http.MethodGet,
		"/api/v1/compliance/programs/soc2/events", FrameworkSOC2, nil)
	if ledger.Code != http.StatusOK {
		t.Fatalf("ledger=%d body=%s", ledger.Code, ledger.Body.String())
	}
	var page struct {
		Events     []Event `json:"events"`
		HasMore    bool    `json:"hasMore"`
		Limit      int     `json:"limit"`
		NextCursor *string `json:"nextCursor"`
	}
	if err := json.Unmarshal(ledger.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode ledger: %v", err)
	}
	if len(page.Events) != 3 || page.HasMore || page.Limit != complianceEventPageLimit || page.NextCursor != nil {
		t.Fatalf("ledger envelope=%#v", page)
	}
	foundRenewal := false
	for _, event := range page.Events {
		if event.EventType == "renewed" {
			foundRenewal = true
			if event.DocumentSHA256 != digest || event.DocumentPath != "s3://private/evidence.pdf" {
				t.Fatalf("renewal did not retain effective evidence: %#v", event)
			}
		}
	}
	if !foundRenewal {
		t.Fatal("renewal event missing from ledger")
	}

	otherTenant := uuid.NewString()
	isolated := invokeCompliance(t, deps, otherTenant, http.MethodGet,
		"/api/v1/compliance/programs/soc2/events", FrameworkSOC2, nil)
	if isolated.Code != http.StatusOK || !strings.Contains(isolated.Body.String(), `"events":[]`) {
		t.Fatalf("cross-tenant ledger=%d body=%s", isolated.Code, isolated.Body.String())
	}
}

func invokeCompliance(
	t *testing.T,
	deps *Deps,
	tenantID, method, path, framework string,
	body any,
) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("framework", framework)
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeContext)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	request = request.WithContext(ctx)
	response := httptest.NewRecorder()
	switch {
	case method == http.MethodPost && strings.HasSuffix(path, "/attest"):
		deps.AttestProgram(response, request)
	case method == http.MethodPost && strings.HasSuffix(path, "/revoke"):
		deps.RevokeProgram(response, request)
	case method == http.MethodGet && strings.HasSuffix(path, "/events"):
		deps.ListEvents(response, request)
	default:
		t.Fatalf("unsupported test request %s %s", method, path)
	}
	return response
}

func receiptRevision(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var receipt struct {
		UpdatedAt string `json:"updatedAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatalf("decode receipt: %v", err)
	}
	if receipt.UpdatedAt == "" {
		t.Fatalf("receipt omitted updatedAt: %s", response.Body.String())
	}
	return receipt.UpdatedAt
}
