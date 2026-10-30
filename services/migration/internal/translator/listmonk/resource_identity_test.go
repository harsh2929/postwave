package listmonk

import (
	"context"
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestMailchimpSegmentSourceIdentityIsAudienceScoped(t *testing.T) {
	segmentA := canonical.Segment{
		Name:             "VIP customers",
		SourceDefinition: `{"id":42,"list_id":"audience-a","type":"saved"}`,
	}
	segmentB := segmentA
	segmentB.SourceDefinition = `{"id":42,"list_id":"audience-b","type":"saved"}`

	idA, err := migrationSegmentSourceIdentity(segmentA, canonical.SourceMailchimp)
	require.NoError(t, err)
	idB, err := migrationSegmentSourceIdentity(segmentB, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.Equal(t, "list:audience-a/segment:42", idA)
	require.Equal(t, "list:audience-b/segment:42", idB)
	require.NotEqual(t, idA, idB)
}

func TestMailchimpSourceIdentityFailsClosedWithoutProviderIDs(t *testing.T) {
	_, err := migrationSegmentSourceIdentity(canonical.Segment{
		Name:             "VIP customers",
		SourceDefinition: `{"id":42}`,
	}, canonical.SourceMailchimp)
	require.ErrorContains(t, err, "both id and list_id")

	_, err = migrationAutomationSourceIdentity(canonical.Automation{
		Name:             "Welcome",
		SourceDefinition: `{"automation":{"id":"workflow-1"}}`,
	}, canonical.SourceMailchimp)
	require.ErrorContains(t, err, "must contain source_id")

	_, err = migrationAutomationSourceIdentity(canonical.Automation{
		Name:             "Welcome",
		SourceDefinition: `{"source_id":"workflow-1"} {"source_id":"workflow-2"}`,
	}, canonical.SourceMailchimp)
	require.ErrorContains(t, err, "multiple JSON values")
}

func TestMailchimpAutomationSourceIdentityIgnoresDuplicateDisplayName(t *testing.T) {
	automationA := canonical.Automation{Name: "Welcome", SourceDefinition: `{"source_id":"workflow-a"}`}
	automationB := canonical.Automation{Name: "Welcome", SourceDefinition: `{"source_id":"workflow-b"}`}

	idA, err := migrationAutomationSourceIdentity(automationA, canonical.SourceMailchimp)
	require.NoError(t, err)
	idB, err := migrationAutomationSourceIdentity(automationB, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.Equal(t, "workflow-a", idA)
	require.Equal(t, "workflow-b", idB)
	require.NotEqual(t, idA, idB)
}

func TestBeehiivSegmentSourceIdentityIgnoresMutableSnapshotMetadata(t *testing.T) {
	segment := canonical.Segment{
		Name:             "Power users",
		SourceDefinition: `{"migration_mode":"static_membership_snapshot","source_id":"beehiiv:segment:seg_power","source":{"id":"seg_power","total_results":10,"status":"completed"}}`,
	}
	changed := segment
	changed.Name = "Renamed power users"
	changed.SourceDefinition = `{"migration_mode":"static_membership_snapshot","source_id":"beehiiv:segment:seg_power","source":{"id":"seg_power","total_results":42,"status":"completed"}}`
	newsletter := canonical.Segment{
		Name:             "Weekly",
		SourceDefinition: `{"migration_mode":"newsletter_list_membership","source_id":"beehiiv:newsletter-list:nl_list_weekly","source":{"id":"nl_list_weekly","subscriber_count":42}}`,
	}

	id, err := migrationSegmentSourceIdentity(segment, canonical.SourceBeehiiv)
	require.NoError(t, err)
	changedID, err := migrationSegmentSourceIdentity(changed, canonical.SourceBeehiiv)
	require.NoError(t, err)
	newsletterID, err := migrationSegmentSourceIdentity(newsletter, canonical.SourceBeehiiv)
	require.NoError(t, err)
	require.Equal(t, "beehiiv:segment:seg_power", id)
	require.Equal(t, id, changedID)
	require.Equal(t, "beehiiv:newsletter-list:nl_list_weekly", newsletterID)
	require.NotEqual(t, id, newsletterID)
}

func TestSubscriberTrackedSourceMatchesMergedBeehiivIdentityForStatusOnly(t *testing.T) {
	before := map[string]interface{}{
		"source_platform": "beehiiv",
		"source_id":       "sub-a",
	}
	metadata := map[string]interface{}{"source_ids": []interface{}{"sub-a", "sub-b"}}
	sub := canonical.Subscriber{SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b"}
	require.True(t, subscriberTrackedSourceMatches(before, metadata, sub))
	sub.SourceID = "sub-c"
	require.False(t, subscriberTrackedSourceMatches(before, metadata, sub))
	sub.SourceID = "sub-b"
	sub.SourcePlatform = canonical.SourceMailchimp
	require.False(t, subscriberTrackedSourceMatches(before, metadata, sub))
}

func TestDeterministicDestinationIdentitiesIncludeStableSourceID(t *testing.T) {
	const jobID = "123456789-job"

	segmentA := migrationScopedSourceName("VIP", jobID, "list:a/segment:42")
	segmentB := migrationScopedSourceName("VIP", jobID, "list:b/segment:42")
	formA := migrationScopedSourceName("Signup", jobID, "form-a")
	formB := migrationScopedSourceName("Signup", jobID, "form-b")
	slugA := migrationScopedSlug("sale", jobID, "landing-a")
	slugB := migrationScopedSlug("sale", jobID, "landing-b")
	domainA := migrationScopedDomain("shop.example", jobID, "store-a")
	domainB := migrationScopedDomain("shop.example", jobID, "store-b")

	require.NotEqual(t, segmentA, segmentB)
	require.NotEqual(t, formA, formB)
	require.NotEqual(t, slugA, slugB)
	require.NotEqual(t, domainA, domainB)
	require.Contains(t, slugA, "migration-12345678-source-")
	require.Contains(t, domainA, "migration-12345678-source-")
}

func TestAutomationRequiresSupportedRuntimeTriggerAndNode(t *testing.T) {
	executableNode := []canonical.AutomationNode{{
		ID:         "send",
		Type:       "send_email",
		TemplateID: "9001",
		Metadata: map[string]interface{}{
			MigrationSourceTemplateIDMetadataKey: "source-template-42",
		},
	}}

	tests := []struct {
		name     string
		triggers []canonical.AutomationTrigger
		nodes    []canonical.AutomationNode
		want     string
	}{
		{name: "no trigger", nodes: executableNode, want: "no supported runtime trigger"},
		{name: "unknown trigger", triggers: []canonical.AutomationTrigger{{Type: "mailchimp_runtime_guess"}}, nodes: executableNode, want: "no supported runtime trigger"},
		{name: "unresolved list trigger", triggers: []canonical.AutomationTrigger{{Type: "list_joined"}}, nodes: executableNode, want: "no supported runtime trigger"},
		{name: "supported trigger no nodes", triggers: []canonical.AutomationTrigger{{Type: "list_joined", ListID: "destination-list"}}, want: "no executable journey nodes"},
		{name: "numeric template id without verified remap metadata", triggers: []canonical.AutomationTrigger{{Type: "list_joined", ListID: "destination-list"}}, nodes: []canonical.AutomationNode{{ID: "send", Type: "send_email", TemplateID: "42"}}, want: "no tenant-verified source-to-destination template remap"},
		{name: "supported trigger malformed node", triggers: []canonical.AutomationTrigger{{Type: "list_joined", ListID: "destination-list"}}, nodes: []canonical.AutomationNode{{ID: "webhook", Type: "webhook"}}, want: "unsupported or incomplete"},
		{name: "one unknown node rejects whole graph", triggers: []canonical.AutomationTrigger{{Type: "list_joined", ListID: "destination-list"}}, nodes: append(executableNode, canonical.AutomationNode{ID: "guess", Type: "mailchimp_runtime_guess"}), want: "unsupported or incomplete"},
		{name: "supported trigger and node", triggers: []canonical.AutomationTrigger{{Type: "list_joined", ListID: "destination-list"}}, nodes: executableNode},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reason := automationUnsupportedReason(canonical.Automation{Triggers: tc.triggers, Nodes: tc.nodes})
			if tc.want == "" {
				require.Empty(t, reason)
				return
			}
			require.Contains(t, reason, tc.want)
		})
	}
}

func TestImportedAutomationPersistenceStatusIsReviewOnly(t *testing.T) {
	require.Equal(t, "draft", importedAutomationReviewStatus)
}

func TestMigrationResourceOwnershipFingerprintDoesNotDependOnDisplayName(t *testing.T) {
	a := migrationResourceOwnershipFingerprint("tenant", "job", ResourceSegment, canonical.SourceMailchimp, "list:a/segment:42")
	b := migrationResourceOwnershipFingerprint("tenant", "job", ResourceSegment, canonical.SourceMailchimp, "list:a/segment:42")
	c := migrationResourceOwnershipFingerprint("tenant", "job", ResourceSegment, canonical.SourceMailchimp, "list:b/segment:42")
	require.Equal(t, a, b)
	require.NotEqual(t, a, c)
}

func TestMailchimpCustomerJourneyArchiveIsNeverMaterialized(t *testing.T) {
	err := materializeSourceArchiveItemTx(context.Background(), nil, "tenant", "job", canonical.SourceArchiveItem{
		SourceID:       "journey-a",
		ResourceType:   "mailchimp_customer_journey",
		Name:           "Welcome journey",
		Status:         "active",
		SourcePlatform: canonical.SourceMailchimp,
		Payload: map[string]interface{}{
			"canonical_automation": map[string]interface{}{
				"triggers": []interface{}{map[string]interface{}{"type": "list_joined"}},
				"nodes":    []interface{}{map[string]interface{}{"type": "send_email"}},
			},
		},
	})
	require.NoError(t, err, "journey evidence must remain archive-only without touching a destination transaction")
}
