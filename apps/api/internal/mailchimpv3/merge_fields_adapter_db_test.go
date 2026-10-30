// SPDX-License-Identifier: AGPL-3.0-only

package mailchimpv3

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	canonicalmergefields "github.com/postwave/postwave/apps/api/internal/merge_fields"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMailchimpMergeFieldCanonicalDatabaseRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping Mailchimp canonical merge-field database test")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	slug := "mailchimp-schema-" + strings.ReplaceAll(tenantID, "-", "")
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'mailchimp-schema-test', $2, 'studio')`, tenantID, slug); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("cleanup scope: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `SELECT set_config('app.tenant_cascade_delete', 'on', true)`); cleanupErr != nil {
			t.Errorf("mark tenant cleanup: %v", cleanupErr)
			return
		}
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = cleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit cleanup: %v", cleanupErr)
		}
	})

	canonicalRepo := &canonicalmergefields.Repo{Pool: pool}
	tenant := &middleware.Tenant{ID: tenantID, Slug: slug, Name: "mailchimp-schema-test", Tier: "studio"}
	deps := &Deps{MergeFields: canonicalRepo}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(middleware.WithTenant(r.Context(), tenant)))
		})
	})
	router.Get("/lists/{list_id}/merge-fields", deps.ListMergeFields)
	router.Post("/lists/{list_id}/merge-fields", deps.CreateMergeField)
	router.Get("/lists/{list_id}/merge-fields/{merge_id}", deps.GetMergeField)
	router.Patch("/lists/{list_id}/merge-fields/{merge_id}", deps.UpdateMergeField)
	router.Delete("/lists/{list_id}/merge-fields/{merge_id}", deps.DeleteMergeField)

	create := mergeFieldRequest(t, router, http.MethodPost, "/lists/"+slug+"/merge-fields",
		`{"tag":"SCORE","name":"Lead score","type":"number","display_order":4,"default_value":1.5}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	mergeID := int(created["merge_id"].(float64))

	schema, err := canonicalRepo.ListSchema(ctx, tenantID)
	if err != nil {
		t.Fatalf("list canonical schema: %v", err)
	}
	if len(schema) != 1 || schema[0].Key != "SCORE" || schema[0].Type != canonicalmergefields.TypeNumber || schema[0].DefaultValue != "1.5" {
		t.Fatalf("canonical create = %+v", schema)
	}

	update := mergeFieldRequest(t, router, http.MethodPatch,
		fmt.Sprintf("/lists/%s/merge-fields/%d", slug, mergeID),
		`{"name":"Qualification score","required":true,"display_order":8,"default_value":2}`)
	if update.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", update.Code, update.Body.String())
	}
	schema, err = canonicalRepo.ListSchema(ctx, tenantID)
	if err != nil {
		t.Fatalf("list updated schema: %v", err)
	}
	if len(schema) != 1 || schema[0].Label != "Qualification score" || !schema[0].Required || schema[0].Position != 8 || schema[0].DefaultValue != "2" {
		t.Fatalf("canonical update = %+v", schema)
	}

	duplicate := mergeFieldRequest(t, router, http.MethodPost, "/lists/"+slug+"/merge-fields",
		`{"tag":"SCORE","name":"Duplicate","type":"number"}`)
	if duplicate.Code != http.StatusConflict || !strings.Contains(duplicate.Body.String(), "already exists") {
		t.Fatalf("duplicate status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}

	used := mergeFieldRequest(t, router, http.MethodPost, "/lists/"+slug+"/merge-fields",
		`{"tag":"USED","name":"Used field","type":"text"}`)
	if used.Code != http.StatusCreated {
		t.Fatalf("create used field status=%d body=%s", used.Code, used.Body.String())
	}
	valueTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber value scope: %v", err)
	}
	if _, err := valueTx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, merge_fields)
VALUES ($1::uuid, $2, 'unconfirmed', 'api', '{"USED":"yes"}'::jsonb)`,
		tenantID, "mailchimp-schema-"+tenantID[:8]+"@example.test"); err != nil {
		_ = valueTx.Rollback(ctx)
		t.Fatalf("seed stored value: %v", err)
	}
	if err := valueTx.Commit(ctx); err != nil {
		t.Fatalf("commit stored value: %v", err)
	}

	deleteUsed := mergeFieldRequest(t, router, http.MethodDelete, "/lists/"+slug+"/merge-fields/USED", "")
	if deleteUsed.Code != http.StatusConflict || !strings.Contains(deleteUsed.Body.String(), "stored subscriber values") {
		t.Fatalf("delete in-use status=%d body=%s", deleteUsed.Code, deleteUsed.Body.String())
	}
	typeUsed := mergeFieldRequest(t, router, http.MethodPatch, "/lists/"+slug+"/merge-fields/USED", `{"type":"number"}`)
	if typeUsed.Code != http.StatusConflict || !strings.Contains(typeUsed.Body.String(), "stored subscriber values") {
		t.Fatalf("type in-use status=%d body=%s", typeUsed.Code, typeUsed.Body.String())
	}

	wrongList := mergeFieldRequest(t, router, http.MethodGet, "/lists/not-this-tenant/merge-fields", "")
	if wrongList.Code != http.StatusNotFound {
		t.Fatalf("wrong-list status=%d body=%s", wrongList.Code, wrongList.Body.String())
	}
	deleted := mergeFieldRequest(t, router, http.MethodDelete, "/lists/"+slug+"/merge-fields/SCORE", "")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	missing := mergeFieldRequest(t, router, http.MethodGet, "/lists/"+slug+"/merge-fields/SCORE", "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status=%d body=%s", missing.Code, missing.Body.String())
	}
}
