package orchestrator

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestMailerLiteResourceCompletenessSeparatesRuntimeAndRebuildSurfaces(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:   10,
		SegmentsTotal:      5,
		GroupsTotal:        3,
		AutomationsTotal:   2,
		ArchiveTotal:       4,
		CampaignsTotal:     7,
		ReportsTotal:       4,
		FormsTotal:         6,
		EcommerceTotal:     1,
		SourceArchiveTotal: 13,
		CustomFields:       []string{"company", "score"},
	}
	report := canonical.VerificationReport{
		SubscribersImported: 10,
		SegmentsTranslated:  3,
		ArchiveImported:     4,
		SourceArchiveByResource: map[string]int{
			"mailerlite_custom_field":        2,
			"mailerlite_campaign_rebuild":    3,
			"mailerlite_form":                6,
			"mailerlite_ecommerce_shop":      1,
			"parity_gap:sites_landing_pages": 1,
		},
	}

	rows := ResourceCompletenessForSource(canonical.SourceMailerLite, discovery, report)
	byName := make(map[string]canonical.ResourceCompleteness, len(rows))
	for _, row := range rows {
		byName[row.Resource] = row
	}

	require.Equal(t, 3, byName["groups"].SourceTotal)
	require.Equal(t, 3, byName["groups"].Imported)
	require.Equal(t, "imported_runtime", byName["groups"].Status)

	require.Equal(t, 2, byName["segments"].SourceTotal)
	require.Zero(t, byName["segments"].Imported)
	require.Equal(t, "manual_rebuild_required", byName["segments"].Status)
	require.Contains(t, strings.Join(byName["segments"].Notes, " "), "not dynamic predicate definitions")

	require.Equal(t, 2, byName["automations"].SourceTotal)
	require.Zero(t, byName["automations"].Imported)
	require.Equal(t, "manual_rebuild_required", byName["automations"].Status)
	require.Contains(t, strings.Join(byName["automations"].Notes, " "), "never activated automatically")

	require.Equal(t, 3, byName["campaign_rebuilds"].Imported)
	require.Equal(t, "preserved_for_rebuild", byName["campaign_rebuilds"].Status)
	require.Equal(t, 2, byName["custom_field_definitions"].Imported)
	require.Equal(t, "preserved_for_rebuild", byName["custom_field_definitions"].Status)
	require.Equal(t, 6, byName["forms"].Imported)
	require.Equal(t, 1, byName["ecommerce"].Imported)
	require.Equal(t, 1, byName["landing"].Imported)
	require.Contains(t, strings.Join(byName["campaigns"].Notes, " "), "does not expose rendered HTML")
}

func TestMailerLiteDiscoveryCompletenessDoesNotClaimExecutableSegmentsOrAutomations(t *testing.T) {
	rows := DiscoveryCompletenessForSource(canonical.SourceMailerLite, adapter.DiscoveryReport{
		SegmentsTotal:      7,
		GroupsTotal:        4,
		AutomationsTotal:   3,
		ArchiveTotal:       4,
		CampaignsTotal:     6,
		FormsTotal:         2,
		EcommerceTotal:     1,
		SourceArchiveTotal: 8,
		CustomFields:       []string{"company"},
	})
	byName := make(map[string]canonical.ResourceCompleteness, len(rows))
	for _, row := range rows {
		byName[row.Resource] = row
	}

	require.Equal(t, 4, byName["groups"].Imported)
	require.Zero(t, byName["segments"].Imported)
	require.Zero(t, byName["automations"].Imported)
	require.Equal(t, 2, byName["campaign_rebuilds"].Imported)
	require.Equal(t, 1, byName["custom_field_definitions"].Imported)
	require.Equal(t, 2, byName["forms"].Imported)
	require.Equal(t, 1, byName["ecommerce"].Imported)
	require.Equal(t, 1, byName["landing"].Imported)
}

func TestMailerLiteSubscriberSnapshotIsAuthoritative(t *testing.T) {
	require.True(t, exactSubscriberSnapshotSource(canonical.SourceMailerLite))
	require.True(t, subscriberFieldsAndTagsAuthoritativeSource(canonical.SourceMailerLite))
	require.True(t, subscriberStatusAuthoritativeSource(canonical.SourceMailerLite))
}
