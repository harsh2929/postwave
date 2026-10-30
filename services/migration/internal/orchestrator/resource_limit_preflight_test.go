package orchestrator

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestMailchimpResourcePlanMatchesRuntimeMaterialization(t *testing.T) {
	disc := adapter.DiscoveryReport{
		AutomationsTotal:  4,
		FormsTotal:        99,
		LandingPagesTotal: 7,
		EcommerceTotal:    3,
		Audiences: []adapter.DiscoveryAudience{
			{ID: "aud-1"}, {ID: "aud-2"},
		},
	}
	got := plannedMigrationResourceIncrements(canonical.SourceMailchimp, disc)
	require.Equal(t, 4, got.Automations)
	require.Equal(t, 2, got.PopupForms, "one aggregate form configuration is emitted per selected audience")
	require.Zero(t, got.LandingPages, "account-wide landing pages are archive/manual-review only for audience-scoped imports")
	require.Zero(t, got.Ecommerce, "paused imported stores do not consume the canonical active-integration quota")

	disc.Audiences = nil
	got = plannedMigrationResourceIncrements(canonical.SourceMailchimp, disc)
	require.Equal(t, 99, got.PopupForms)
	require.Equal(t, 7, got.LandingPages)
}
