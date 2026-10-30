// SPDX-License-Identifier: AGPL-3.0-only
package integration_egress_test

import (
	"reflect"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/integration_egress"
	"github.com/postwave/postwave/apps/api/internal/lead_integrations"
	"github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	"github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	"github.com/postwave/postwave/apps/api/internal/review_integrations"
	"github.com/postwave/postwave/apps/api/internal/subscription_integrations"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
)

func TestEveryNativeProviderAndURLSettingHasEgressPolicy(t *testing.T) {
	t.Parallel()

	catalogs := []struct {
		family string
		specs  any
	}{
		{integration_egress.FamilyCommerce, commerce.CommerceProviderSpecs()},
		{integration_egress.FamilyReviews, review_integrations.ProviderSpecs()},
		{integration_egress.FamilySupport, support_integrations.ProviderSpecs()},
		{integration_egress.FamilySubscription, subscription_integrations.ProviderSpecs()},
		{integration_egress.FamilyLoyalty, loyalty_integrations.ProviderSpecs()},
		{integration_egress.FamilyAnalytics, analytics_integrations.ProviderSpecs()},
		{integration_egress.FamilyCRM, crm_integrations.ProviderSpecs()},
		{integration_egress.FamilyMarketing, marketing_integrations.ProviderSpecs()},
		{integration_egress.FamilyLeads, lead_integrations.ProviderSpecs()},
	}
	for _, catalog := range catalogs {
		auditCatalog(t, catalog.family, catalog.specs)
	}
}

func auditCatalog(t *testing.T, family string, specs any) {
	t.Helper()
	value := reflect.ValueOf(specs)
	if value.Kind() != reflect.Slice {
		t.Fatalf("%s provider catalog is %s, want slice", family, value.Kind())
	}
	for i := 0; i < value.Len(); i++ {
		spec := value.Index(i)
		provider := spec.FieldByName("Provider").String()
		if !integration_egress.HasProviderPolicy(family, provider) {
			t.Errorf("%s/%s has no provider egress policy", family, provider)
		}
		for _, fieldName := range []string{"RequiredSettings", "OptionalSettings"} {
			fields := spec.FieldByName(fieldName)
			for j := 0; j < fields.Len(); j++ {
				setting := fields.Index(j).FieldByName("Key").String()
				if integration_egress.IsURLLikeSettingKey(setting) && !integration_egress.HasSettingPolicy(family, provider, setting) {
					t.Errorf("%s/%s setting %q has no egress policy", family, provider, setting)
				}
			}
		}
	}
}
