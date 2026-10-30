package orchestrator

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestSubstackResourceCompletenessSeparatesMembershipFromBillingRuntime(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:   4,
		PaidSubsTotal:      2,
		ArchiveTotal:       2,
		CampaignsTotal:     2,
		ReportsTotal:       1,
		SourceArchiveTotal: 16,
	}
	report := canonical.VerificationReport{
		SubscribersImported:        4,
		ConsentKnown:               0,
		PremiumMembershipsObserved: 2,
		ArchiveImported:            2,
		SourceArchiveImported:      16,
		SourceArchiveByResource: map[string]int{
			"substack_export_inventory":            1,
			"parity_gap:consent_exclusions":        1,
			"parity_gap:paid_billing_handoff":      1,
			"parity_gap:non_email_posts":           1,
			"parity_gap:audience_variants":         1,
			"parity_gap:comments_reactions":        1,
			"parity_gap:notes_restacks":            1,
			"parity_gap:chat":                      1,
			"parity_gap:recommendations_referrals": 1,
			"parity_gap:welcome_automations":       1,
			"parity_gap:surveys":                   1,
			"parity_gap:podcast_video_live":        1,
			"parity_gap:assets":                    1,
			"parity_gap:publication_settings":      1,
			"parity_gap:engagement_history":        1,
			"parity_gap:integrations":              1,
		},
	}
	rows := ResourceCompletenessForSource(canonical.SourceSubstack, discovery, report)
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rows {
		byResource[row.Resource] = row
	}
	require.Equal(t, "imported_runtime", byResource["subscribers"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["consent_exclusions"].Status)
	require.Equal(t, "imported_runtime", byResource["premium_memberships"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["paid_subs"].Status)
	require.False(t, byResource["paid_subs"].Supported)
	require.Equal(t, 0, byResource["paid_subs"].Imported)
	require.Equal(t, "imported_runtime", byResource["campaigns"].Status)
	require.Equal(t, "imported_runtime", byResource["reports"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["comments"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["assets"].Status)
	require.Equal(t, "imported_runtime", byResource["source_archive"].Status)
}
