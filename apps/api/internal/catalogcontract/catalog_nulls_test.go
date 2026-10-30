// SPDX-License-Identifier: AGPL-3.0-only

// Package catalogcontract_test guards the static catalogue responses the
// dashboards decode strictly.
//
// A Go nil slice marshals to JSON null. Every list in these catalogues is
// documented (or decoded) as an array, and the web decoders are right to
// reject null — so a single spec literal that leaves a list out breaks a whole
// page. On staging that took out the block editor section of
// /app/workspace-ops ("blocks[16].fields must be an array": the divider block
// declares no fields) and connection setup on /app/warehouse
// (streaming_export declares no required_settings).
//
// These responses are static: no tenant data, no database. So instead of
// pinning individual fields, this serves each catalogue through its package's
// real router and walks the JSON generically — any null anywhere fails, with
// its path. A new provider or block that forgets a list fails here, in CI,
// rather than on a dashboard.
package catalogcontract_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/developer_marketplace"
	"github.com/postwave/postwave/apps/api/internal/email_blocks"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/integrations"
	"github.com/postwave/postwave/apps/api/internal/lead_integrations"
	"github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	"github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/omnichannel"
	"github.com/postwave/postwave/apps/api/internal/onsite_growth"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/review_integrations"
	"github.com/postwave/postwave/apps/api/internal/reviews"
	"github.com/postwave/postwave/apps/api/internal/service_suite"
	"github.com/postwave/postwave/apps/api/internal/social_capture"
	"github.com/postwave/postwave/apps/api/internal/sto_predictive_clv"
	"github.com/postwave/postwave/apps/api/internal/subscription_integrations"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
	"github.com/postwave/postwave/apps/api/internal/warehouse"
)

// The provider catalogues are served without touching their store, but their
// MountRoutes refuse a nil one. Each of these satisfies a package's Store
// interface with a nil embedded value: any real store call would panic, and
// the catalogue handlers make none.
type (
	analyticsStore    struct{ analytics_integrations.Store }
	commerceStore     struct{ commerce.Store }
	crmStore          struct{ crm_integrations.Store }
	leadStore         struct{ lead_integrations.Store }
	loyaltyStore      struct{ loyalty_integrations.Store }
	marketingStore    struct{ marketing_integrations.Store }
	reviewIntStore    struct{ review_integrations.Store }
	subscriptionStore struct {
		subscription_integrations.Store
	}
	supportStore struct{ support_integrations.Store }
)

type catalogue struct {
	path  string
	mount func(chi.Router)
}

func catalogues() []catalogue {
	return []catalogue{
		{"/api/v1/email-blocks/catalog", func(r chi.Router) { email_blocks.MountRoutes(r, &email_blocks.Deps{}) }},
		{"/api/v1/warehouse/providers", func(r chi.Router) { warehouse.MountRoutes(r, &warehouse.Deps{Repo: &warehouse.Repo{}}) }},
		{"/api/v1/warehouse/catalog", func(r chi.Router) { warehouse.MountRoutes(r, &warehouse.Deps{Repo: &warehouse.Repo{}}) }},
		{"/api/v1/integrations/catalog", func(r chi.Router) { integrations.MountRoutes(r, nil) }},
		{"/api/v1/lead-integrations/providers", func(r chi.Router) { lead_integrations.MountRoutes(r, &lead_integrations.Deps{Repo: leadStore{}}) }},
		{"/api/v1/review-integrations/providers", func(r chi.Router) {
			review_integrations.MountRoutes(r, &review_integrations.Deps{Repo: reviewIntStore{}})
		}},
		{"/api/v1/review-integrations/webhook-ingest/providers", func(r chi.Router) {
			review_integrations.MountRoutes(r, &review_integrations.Deps{Repo: reviewIntStore{}})
		}},
		{"/api/v1/loyalty-integrations/providers", func(r chi.Router) {
			loyalty_integrations.MountRoutes(r, &loyalty_integrations.Deps{Repo: loyaltyStore{}})
		}},
		{"/api/v1/loyalty-integrations/webhook-ingest/providers", func(r chi.Router) {
			loyalty_integrations.MountRoutes(r, &loyalty_integrations.Deps{Repo: loyaltyStore{}})
		}},
		{"/api/v1/subscription-integrations/providers", func(r chi.Router) {
			subscription_integrations.MountRoutes(r, &subscription_integrations.Deps{Repo: subscriptionStore{}})
		}},
		{"/api/v1/subscription-integrations/webhook-ingest/providers", func(r chi.Router) {
			subscription_integrations.MountRoutes(r, &subscription_integrations.Deps{Repo: subscriptionStore{}})
		}},
		{"/api/v1/analytics-integrations/providers", func(r chi.Router) {
			analytics_integrations.MountRoutes(r, &analytics_integrations.Deps{Repo: analyticsStore{}})
		}},
		{"/api/v1/analytics-integrations/webhook-ingest/providers", func(r chi.Router) {
			analytics_integrations.MountRoutes(r, &analytics_integrations.Deps{Repo: analyticsStore{}})
		}},
		{"/api/v1/support-integrations/providers", func(r chi.Router) {
			support_integrations.MountRoutes(r, &support_integrations.Deps{Repo: supportStore{}})
		}},
		{"/api/v1/crm/providers", func(r chi.Router) { crm_integrations.MountRoutes(r, &crm_integrations.Deps{Repo: crmStore{}}) }},
		{"/api/v1/marketing-integrations/providers", func(r chi.Router) {
			marketing_integrations.MountRoutes(r, &marketing_integrations.Deps{Repo: marketingStore{}})
		}},
		{"/api/v1/commerce/providers", func(r chi.Router) { commerce.Mount(r, &commerce.Deps{Repo: commerceStore{}}) }},
		{"/api/v1/deliverability-control/catalog", func(r chi.Router) {
			deliverability_control.MountRoutes(r, &deliverability_control.Deps{Repo: &deliverability_control.Repo{}})
		}},
		{"/api/v1/predictive/catalog", func(r chi.Router) { predictive.MountRoutes(r, &predictive.Deps{}) }},
		{"/api/v1/onsite-growth/catalog", func(r chi.Router) { onsite_growth.MountRoutes(r, &onsite_growth.Deps{}) }},
		{"/api/v1/flow-builder/catalog", func(r chi.Router) { flowbuilder.MountRoutes(r, &flowbuilder.Deps{}) }},
		{"/api/v1/developer-marketplace/catalog", func(r chi.Router) {
			developer_marketplace.MountRoutes(r, &developer_marketplace.Deps{Repo: &developer_marketplace.Repo{}})
		}},
		{"/api/v1/social-capture/catalog", func(r chi.Router) {
			social_capture.MountRoutes(r, &social_capture.Deps{Repo: &social_capture.Repo{}})
		}},
		{"/api/v1/predictions/catalog", func(r chi.Router) { sto_predictive_clv.MountRoutes(r, &sto_predictive_clv.Deps{}) }},
		{"/api/v1/omnichannel/catalog", func(r chi.Router) { omnichannel.MountRoutes(r, &omnichannel.Deps{}) }},
		{"/api/v1/service-suite/catalog", func(r chi.Router) {
			service_suite.MountRoutes(r, &service_suite.Deps{Repo: &service_suite.Repo{}})
		}},
		{"/api/v1/reviews/catalog", func(r chi.Router) { reviews.MountRoutes(r, &reviews.Deps{Repo: &reviews.Repo{}}) }},
	}
}

func TestStaticCataloguesContainNoJSONNull(t *testing.T) {
	for _, c := range catalogues() {
		t.Run(c.path, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"})
					ctx = middleware.WithUser(ctx, &middleware.User{ID: "owner-1", TenantID: "00000000-0000-4000-8000-000000000001", Role: "owner"})
					next.ServeHTTP(w, req.WithContext(ctx))
				})
			})
			c.mount(router)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%.300s", rec.Code, rec.Body.String())
			}
			var body any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			var found []string
			nullPaths(body, "$", &found)
			if len(found) > 0 {
				t.Fatalf("%d JSON null value(s); a list or object left nil in Go: %v", len(found), found)
			}
		})
	}
}

// nullPaths appends the JSONPath of every null under v, in a stable order.
func nullPaths(v any, path string, out *[]string) {
	switch x := v.(type) {
	case nil:
		*out = append(*out, path)
	case map[string]any:
		keys := make([]string, 0, len(x))
		for key := range x {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			nullPaths(x[key], path+"."+key, out)
		}
	case []any:
		for i, item := range x {
			nullPaths(item, fmt.Sprintf("%s[%d]", path, i), out)
		}
	}
}

// TestNullPathsFindsNestedNulls keeps the walker honest: a guard that could
// not see a null would pass every catalogue.
func TestNullPathsFindsNestedNulls(t *testing.T) {
	var body any
	if err := json.Unmarshal([]byte(`{"blocks":[{"fields":[]},{"fields":null,"defaults":{"x":null}}],"ok":1}`), &body); err != nil {
		t.Fatal(err)
	}
	var found []string
	nullPaths(body, "$", &found)
	want := []string{"$.blocks[1].defaults.x", "$.blocks[1].fields"}
	if fmt.Sprint(found) != fmt.Sprint(want) {
		t.Fatalf("nullPaths=%v, want %v", found, want)
	}
}
