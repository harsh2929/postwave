// SPDX-License-Identifier: AGPL-3.0-only
package utm_tagging

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestPreviewCampaignTokensAndTenantIsolationDB(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID, otherTenantID, campaignID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, tenant := range []string{tenantID, otherTenantID} {
		tx, err := db.WithTenant(ctx, pool, tenant)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO tenants(id,name,slug,tier) VALUES ($1::uuid,'UTM QA',$2,'studio')`, tenant, "utm-qa-"+tenant); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if tenant == tenantID {
			if _, err := tx.Exec(ctx, `INSERT INTO campaigns(id,tenant_id,name,subject,status,archive_slug) VALUES($1::uuid,$2::uuid,'Product update','QA','draft','product-update')`, campaignID, tenant); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO utm_templates(tenant_id,campaign_id,utm_source,utm_campaign,utm_content) VALUES($1::uuid,$2::uuid,'newsletter','{{campaign_slug}}','{{campaign_name}}')`, tenant, campaignID); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, tenant := range []string{tenantID, otherTenantID} {
			tx, err := db.WithTenant(context.Background(), pool, tenant)
			if err != nil {
				t.Error(err)
				continue
			}
			if _, err := tx.Exec(context.Background(), `DELETE FROM campaigns WHERE tenant_id=$1::uuid`, tenant); err != nil {
				t.Error(err)
			}
			if _, err := tx.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, tenant); err != nil {
				t.Error(err)
			}
			if err := tx.Commit(context.Background()); err != nil {
				t.Error(err)
			}
		}
	}()
	preview := func(tenant string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"url": "https://moosewave.com/?utm_source=existing", "campaign_id": campaignID})
		request := httptest.NewRequest(http.MethodPost, "/api/v1/utm-templates/preview", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		request = request.WithContext(middleware.WithTenant(ctx, &middleware.Tenant{ID: tenant}))
		response := httptest.NewRecorder()
		(&Deps{Pool: pool}).Preview(response, request)
		return response
	}
	response := preview(tenantID)
	if response.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", response.Code, response.Body.String())
	}
	var result struct {
		Rewritten string `json:"rewritten"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	link, err := url.Parse(result.Rewritten)
	if err != nil {
		t.Fatal(err)
	}
	query := link.Query()
	if query.Get("utm_source") != "existing" || query.Get("utm_campaign") != "product-update" || query.Get("utm_content") != "Product update" {
		t.Fatalf("wrong preview: %s", result.Rewritten)
	}
	denied := preview(otherTenantID)
	if denied.Code != http.StatusNotFound || strings.Contains(denied.Body.String(), "Product update") {
		t.Fatalf("cross-tenant preview leaked: status=%d body=%s", denied.Code, denied.Body.String())
	}
}
