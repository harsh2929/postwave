package orchestrator

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestCustomerIOResourceCompletenessEnumeratesRuntimeArchiveAndManualSurfaces(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:          3,
		ProfilesWithoutEmailTotal: 1,
		SegmentsTotal:             4,
		AutomationsTotal:          3,
		ArchiveTotal:              2,
		TemplatesTotal:            1,
		CustomObjectsTotal:        1,
		SubscriptionChannelsTotal: 1,
		SMSCampaignsTotal:         1,
		PushCampaignsTotal:        1,
		SourceArchiveTotal:        22,
		Audiences: []adapter.DiscoveryAudience{
			{ID: "customerio:segment:vip"},
			{ID: "customerio:topic:product"},
			{ID: "customerio:topic:weekly"},
		},
	}
	report := canonical.VerificationReport{
		SubscribersImported:   3,
		SegmentsTranslated:    4,
		TemplatesImported:     1,
		ArchiveImported:       2,
		SourceArchiveImported: 22,
		SourceArchiveByResource: map[string]int{
			"customerio_campaign_workflow":     2,
			"customerio_broadcast_workflow":    1,
			"customerio_newsletter":            3,
			"customerio_transactional_message": 1,
			"customerio_design_email_rebuild":  1,
			"customerio_subscription_topic":    2,
			"customerio_subscription_channel":  1,
			"customerio_esp_suppression":       1,
			"customerio_channel_optout":        1,
			"customerio_object_type":           1,
			"customerio_migration_checklist":   8,
		},
	}

	rows := ResourceCompletenessForSource(canonical.SourceCustomerIO, discovery, report)
	require.NotEmpty(t, rows)
	byName := make(map[string]canonical.ResourceCompleteness, len(rows))
	for _, row := range rows {
		byName[row.Resource] = row
	}
	for _, resource := range []string{
		"subscribers", "non_email_profiles", "segments", "subscription_topics",
		"campaigns", "source_archive", "workflow_definitions", "transactional",
		"templates", "structured_templates", "consent_exclusions",
		"channel_dependencies", "custom_objects", "deliverability", "ecosystem",
	} {
		require.Contains(t, byName, resource)
	}
	require.Equal(t, 22, byName["source_archive"].SourceTotal)
	require.Equal(t, 22, byName["source_archive"].Imported)
	require.Equal(t, "preserved_for_rebuild", byName["source_archive"].Status)
	require.Equal(t, 3, byName["workflow_definitions"].SourceTotal)
	require.Equal(t, "preserved_for_rebuild", byName["workflow_definitions"].Status)
	require.Equal(t, "manual_rebuild_required", byName["non_email_profiles"].Status)
	require.Equal(t, "manual_rebuild_required", byName["channel_dependencies"].Status)
	require.Equal(t, 1, byName["templates"].Imported)
	require.Equal(t, "imported_runtime", byName["templates"].Status)
	require.Contains(t, strings.Join(byName["templates"].Notes, "\n"), "exact source HTML")
	require.Contains(t, strings.Join(byName["templates"].Notes, "\n"), "not provider-rendered output")
	require.Contains(t, strings.Join(byName["templates"].Notes, "\n"), "Liquid")
	require.NotContains(t, strings.Join(byName["templates"].Notes, "\n"), "with rendered HTML import")
	require.Contains(t, strings.Join(byName["structured_templates"].Notes, "\n"), "without non-empty default source HTML")
	require.Contains(t, strings.Join(byName["structured_templates"].Notes, "\n"), "does not synthesize provider-rendered output")
	require.Contains(t, strings.Join(byName["campaigns"].Notes, "\n"), "lowest stable content ID")
	require.Contains(t, strings.Join(byName["campaigns"].Notes, "\n"), "every variant remains evidence")
	require.Equal(t, "Subscription-topic and channel definitions", byName["subscription_topics"].Label)
	require.Equal(t, 3, byName["subscription_topics"].SourceTotal)
	require.Equal(t, 3, byName["subscription_topics"].Imported)
	require.Contains(t, strings.Join(byName["subscribers"].Notes, "\n"), "email-channel subscribed/default")
	require.Equal(t, "ESP suppressions and SMS/WhatsApp sender opt-outs", byName["consent_exclusions"].Label)
	require.Contains(t, strings.Join(byName["consent_exclusions"].Notes, "\n"), "separate sender-specific SMS/WhatsApp evidence")
	require.Contains(t, strings.Join(byName["consent_exclusions"].Notes, "\n"), "not subscription-center channel preferences")
	require.Equal(t, 1, byName["deliverability"].SourceTotal)
	require.Equal(t, 1, byName["deliverability"].Imported)
	require.Equal(t, 7, byName["ecosystem"].SourceTotal)
	require.Equal(t, 7, byName["ecosystem"].Imported)
}

func TestCustomerIOResourceCompletenessDoesNotShrinkDiscoveryBoundsToPartialArchive(t *testing.T) {
	rows := ResourceCompletenessForSource(canonical.SourceCustomerIO, adapter.DiscoveryReport{
		AutomationsTotal:          3,
		SubscriptionChannelsTotal: 2,
		SourceArchiveTotal:        14,
		Audiences: []adapter.DiscoveryAudience{
			{ID: "customerio:segment:vip"},
			{ID: "customerio:topic:product"},
			{ID: "customerio:topic:weekly"},
		},
	}, canonical.VerificationReport{
		SourceArchiveImported: 11,
		SourceArchiveByResource: map[string]int{
			"customerio_campaign_workflow":    1,
			"customerio_broadcast_workflow":   1,
			"customerio_subscription_topic":   1,
			"customerio_subscription_channel": 1,
			"customerio_migration_checklist":  7,
		},
	})
	byName := make(map[string]canonical.ResourceCompleteness, len(rows))
	for _, row := range rows {
		byName[row.Resource] = row
	}
	require.Equal(t, 3, byName["workflow_definitions"].SourceTotal)
	require.Equal(t, 2, byName["workflow_definitions"].Imported)
	require.Equal(t, "manual_rebuild_required", byName["workflow_definitions"].Status)
	require.Equal(t, 4, byName["subscription_topics"].SourceTotal)
	require.Equal(t, 2, byName["subscription_topics"].Imported)
	require.Equal(t, "manual_rebuild_required", byName["subscription_topics"].Status)
	require.Equal(t, customerIODeliverabilityChecklistCount, byName["deliverability"].SourceTotal)
	require.Zero(t, byName["deliverability"].Imported)
	require.Equal(t, "manual_rebuild_required", byName["deliverability"].Status)
	require.Equal(t, customerIOEcosystemChecklistCount, byName["ecosystem"].SourceTotal)
	require.Zero(t, byName["ecosystem"].Imported)
	require.Equal(t, "manual_rebuild_required", byName["ecosystem"].Status)
}

func TestCustomerIODiscoveryCompletenessIsExplicitBeforeImport(t *testing.T) {
	rows := DiscoveryCompletenessForSource(canonical.SourceCustomerIO, adapter.DiscoveryReport{
		SubscribersTotal:          2,
		ProfilesWithoutEmailTotal: 1,
		SegmentsTotal:             3,
		ArchiveTotal:              1,
		TemplatesTotal:            1,
		SubscriptionChannelsTotal: 2,
		SourceArchiveTotal:        8,
	})
	require.NotEmpty(t, rows)
	resources := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		resources[row.Resource] = struct{}{}
	}
	for _, resource := range []string{"subscribers", "non_email_profiles", "segments", "campaigns", "templates", "source_archive", "deliverability", "ecosystem"} {
		require.Contains(t, resources, resource)
	}
	for _, row := range rows {
		if row.Resource == "subscription_topics" {
			require.Equal(t, 2, row.SourceTotal)
			require.Equal(t, 2, row.Imported)
		}
	}
}

func TestCustomerIOVerifierCountsExactSegmentAndTopicMembership(t *testing.T) {
	verifier := NewVerifierInput()
	verifier.Discovery = adapter.DiscoveryReport{
		SubscribersTotal: 1,
		SnapshotMembershipCounts: map[string]int{
			"customerio:segment:vip":  1,
			"customerio:topic:weekly": 1,
		},
	}
	verifier.ObserveSubscriber(canonical.Subscriber{
		Email: "reader@example.com", SourceID: "cio-one", SourcePlatform: canonical.SourceCustomerIO,
		Tags: []string{"customerio:segment:vip", "customerio:topic:weekly"},
	})
	require.NoError(t, validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceCustomerIO))
	require.Equal(t, 2, verifier.StaticSegmentMemberships)
}

func TestCustomerIOVerifierBoundsRepeatedCategoryWarningsWithoutLosingArchiveCounts(t *testing.T) {
	verifier := NewVerifierInput()
	for _, sourceID := range []string{"customerio:campaign:1", "customerio:campaign:2"} {
		verifier.ObserveSourceArchiveItem(canonical.SourceArchiveItem{
			SourceID:       sourceID,
			ResourceType:   "customerio_campaign_workflow",
			Warnings:       []string{"Workflow metadata is rebuild-only evidence."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	require.Equal(t, 2, verifier.SourceArchiveByType["customerio_campaign_workflow"])
	require.Len(t, verifier.SourceArchiveWarnings, 1)

	// A distinct limitation in the same category remains visible.
	verifier.ObserveSourceArchiveItem(canonical.SourceArchiveItem{
		SourceID:       "customerio:campaign:3",
		ResourceType:   "customerio_campaign_workflow",
		Warnings:       []string{"A second distinct limitation."},
		SourcePlatform: canonical.SourceCustomerIO,
	})
	require.Equal(t, 3, verifier.SourceArchiveByType["customerio_campaign_workflow"])
	require.Len(t, verifier.SourceArchiveWarnings, 2)
}
