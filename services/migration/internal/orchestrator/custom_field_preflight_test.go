package orchestrator

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestMailchimpCustomFieldPlanDefersNullAndRejectsCrossAudienceConflict(t *testing.T) {
	plan := map[string]string{}
	require.NoError(t, mergeSubscriberCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": nil},
		},
	}))
	require.Equal(t, "unknown", plan["SCORE"])
	require.NoError(t, mergeSubscriberCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": 42},
		},
	}))
	require.Equal(t, "number", plan["SCORE"])
	err := mergeSubscriberCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": "high"},
		},
	})
	require.ErrorContains(t, err, "incompatible cross-audience types")
}

func TestMailchimpDryRunRecoveryRetainsEarlierPagePlan(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps:      caps,
		discovery: adapter.DiscoveryReport{SubscribersTotal: 2},
		subscribers: [][]canonical.Subscriber{
			{{Email: "first@example.com", SourcePlatform: canonical.SourceMailchimp}},
			{{Email: "second@example.com", SourcePlatform: canonical.SourceMailchimp, CustomFields: map[string]interface{}{
				"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": "now-a-string"},
			}}},
		},
	}
	cursor := "1"
	job := &canonical.MigrationJob{ID: "dry-plan-resume", Source: canonical.SourceMailchimp, Status: canonical.MigDryRun, Cursor: map[string]*string{stageSubscribers: &cursor}}
	require.NoError(t, persistMailchimpCustomFieldPlan(job, map[string]string{"SCORE": "number"}, false))

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)
	require.ErrorContains(t, err, "incompatible cross-audience types")
	require.Equal(t, map[string]string{"SCORE": "number"}, loadMailchimpCustomFieldPlan(job), "recovery must not reset page-one observations")
}

func TestMailchimpCommitFullSchemaPreflightRejectsLateDrift(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps: caps,
		subscribers: [][]canonical.Subscriber{
			{{Email: "first@example.com", SourcePlatform: canonical.SourceMailchimp, CustomFields: map[string]interface{}{
				"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": 42},
			}}},
			{{Email: "second@example.com", SourcePlatform: canonical.SourceMailchimp, CustomFields: map[string]interface{}{
				"postwave_mailchimp_merge_fields": map[string]interface{}{"NEW_FIELD": "unreviewed"},
			}}},
		},
	}
	err := preflightMailchimpCommitSubscribers(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, map[string]string{"SCORE": "number"}, 2, 0)
	require.ErrorContains(t, err, "appeared after the completed source-schema preflight")
	require.Equal(t, 2, ad.calls["subscribers"], "the complete source schema is checked before the write traversal starts")
}

func TestMailchimpCommitPreflightAllowsBoundedEmptyAudiencePages(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps: caps,
		subscribers: [][]canonical.Subscriber{
			{},
			{{Email: "member@example.com", SourcePlatform: canonical.SourceMailchimp}},
		},
	}

	err := preflightMailchimpCommitSubscribers(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, map[string]string{}, 1, 2)
	require.NoError(t, err)
	require.Equal(t, 2, ad.calls["subscribers"])
}

func TestBeehiivCommitBuildsCompleteCustomFieldPlanBeforeWrites(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceBeehiiv}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps: caps,
		subscribers: [][]canonical.Subscriber{
			{{Email: "first@example.com", SourceID: "sub_first", SourcePlatform: canonical.SourceBeehiiv, CustomFields: map[string]interface{}{
				"city":    "Delhi",
				"beehiiv": map[string]interface{}{"publication_id": "pub_main", "status": "active"},
			}}},
			{{Email: "second@example.com", SourceID: "sub_second", SourcePlatform: canonical.SourceBeehiiv, CustomFields: map[string]interface{}{
				"interests": []string{"product", "growth"},
			}}},
		},
	}
	plan, err := preflightBeehiivCommitCustomFields(context.Background(), ad, adapter.Session{Source: canonical.SourceBeehiiv}, 2)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"city": "string", "interests": "array"}, plan)
	require.Equal(t, 2, ad.calls["subscribers"], "all cursor pages are schema-checked before the write traversal")
}

func TestBeehiivCommitCustomFieldPreflightRejectsCrossSubscriberTypeDrift(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceBeehiiv}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps: caps,
		subscribers: [][]canonical.Subscriber{{
			{Email: "first@example.com", SourceID: "sub_first", SourcePlatform: canonical.SourceBeehiiv, CustomFields: map[string]interface{}{"score": 42}},
			{Email: "second@example.com", SourceID: "sub_second", SourcePlatform: canonical.SourceBeehiiv, CustomFields: map[string]interface{}{"score": "high"}},
		}},
	}
	_, err := preflightBeehiivCommitCustomFields(context.Background(), ad, adapter.Session{Source: canonical.SourceBeehiiv}, 2)
	require.ErrorContains(t, err, "incompatible cross-subscriber types")
}

func TestBeehiivCommitCustomFieldPreflightRejectsNovelCursorsBeyondDiscovery(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceBeehiiv}
	caps.Supports.Subscribers = true
	calls := 0
	ad := &fixtureAdapter{
		caps: caps,
		subscriberFn: func(string) ([]canonical.Subscriber, string, error) {
			calls++
			return []canonical.Subscriber{{
				Email:          fmt.Sprintf("subscriber-%d@example.com", calls),
				SourceID:       fmt.Sprintf("sub_%d", calls),
				SourcePlatform: canonical.SourceBeehiiv,
			}}, fmt.Sprintf("cursor-%d", calls), nil
		},
	}

	_, err := preflightBeehiivCommitCustomFields(context.Background(), ad, adapter.Session{Source: canonical.SourceBeehiiv}, 2)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "reported more pages after reaching the discovery total")
	require.Equal(t, 2, calls, "the preflight must terminate at the discovery bound even when every cursor is novel")
}

func TestSubscriberTraversalPageLimitSaturatesUntrustedDiscoveryTotals(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	limit, err := subscriberTraversalPageLimit(maxInt, maxInt)
	require.NoError(t, err)
	require.Equal(t, maxSubscriberTraversalPageCalls, limit)
}

func TestBeehiivWritePassRejectsSchemaDriftAgainstPreflightPlan(t *testing.T) {
	plan := map[string]string{"score": "number"}
	err := validateImportedSubscriberAgainstCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceBeehiiv,
		CustomFields:   map[string]interface{}{"score": "high"},
	}, "Beehiiv custom field")
	require.ErrorContains(t, err, "changed type after the completed source-schema preflight")

	err = validateImportedSubscriberAgainstCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceBeehiiv,
		CustomFields:   map[string]interface{}{"unreviewed": true},
	}, "Beehiiv custom field")
	require.ErrorContains(t, err, "appeared after the completed source-schema preflight")
}

func TestKlaviyoCommitBuildsCompleteCustomFieldPlanAcrossFilteredEmptyPage(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceKlaviyo}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps: caps,
		subscribers: [][]canonical.Subscriber{
			{},
			{
				{Email: "first@example.com", SourceID: "profile_first", SourcePlatform: canonical.SourceKlaviyo, CustomFields: map[string]interface{}{
					"klaviyo": map[string]interface{}{"profile_id": "profile_first", "properties": map[string]interface{}{"plan": "pro"}},
					"phone":   "+15550000001",
				}},
				{Email: "second@example.com", SourceID: "profile_second", SourcePlatform: canonical.SourceKlaviyo, CustomFields: map[string]interface{}{
					"klaviyo": map[string]interface{}{"profile_id": "profile_second", "predictive_analytics": map[string]interface{}{"historic_clv": 42}},
				}},
			},
		},
	}
	plan, err := preflightSnapshotCommitCustomFields(context.Background(), ad, adapter.Session{Source: canonical.SourceKlaviyo}, canonical.SourceKlaviyo, "Klaviyo", 2, 1)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"klaviyo": "object", "phone": "string"}, plan)
	require.Equal(t, 2, ad.calls["subscribers"])
}

func TestKlaviyoCommitCustomFieldPreflightRejectsCrossProfileTypeDrift(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceKlaviyo}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps: caps,
		subscribers: [][]canonical.Subscriber{{
			{Email: "first@example.com", SourceID: "profile_first", SourcePlatform: canonical.SourceKlaviyo, CustomFields: map[string]interface{}{"score": 42}},
			{Email: "second@example.com", SourceID: "profile_second", SourcePlatform: canonical.SourceKlaviyo, CustomFields: map[string]interface{}{"score": "high"}},
		}},
	}
	_, err := preflightSnapshotCommitCustomFields(context.Background(), ad, adapter.Session{Source: canonical.SourceKlaviyo}, canonical.SourceKlaviyo, "Klaviyo", 2, 0)
	require.ErrorContains(t, err, "incompatible cross-subscriber types")
}

func TestResetExecutionStatePreservesCompletedMailchimpCustomFieldPlan(t *testing.T) {
	job := &canonical.MigrationJob{Cursor: map[string]*string{}}
	require.NoError(t, persistMailchimpCustomFieldPlan(job, map[string]string{"SCORE": "number"}, true))
	ResetExecutionState(job)
	require.True(t, mailchimpCustomFieldPlanComplete(job))
	require.Equal(t, map[string]string{"SCORE": "number"}, loadMailchimpCustomFieldPlan(job))
}

func TestMailchimpCommitCustomFieldPlanIsImmutableAndFailClosed(t *testing.T) {
	plan := map[string]string{"SCORE": "number", "NOTE": "string"}
	job := &canonical.MigrationJob{Cursor: map[string]*string{}}
	require.NoError(t, persistMailchimpCustomFieldPlan(job, plan, true))

	require.NoError(t, validateSubscriberAgainstCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": 42, "NOTE": "kept"},
		},
	}))
	require.True(t, mailchimpCustomFieldPlanComplete(job), "commit validation must not clear the reviewed-plan sentinel")
	require.Equal(t, map[string]string{"SCORE": "number", "NOTE": "string"}, plan)

	err := validateSubscriberAgainstCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_merge_fields": map[string]interface{}{"NEW_FIELD": "unreviewed"},
		},
	})
	require.ErrorContains(t, err, "appeared after the completed source-schema preflight")
	err = validateSubscriberAgainstCustomFieldPlan(plan, canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_merge_fields": map[string]interface{}{"SCORE": "forty-two"},
		},
	})
	require.ErrorContains(t, err, "changed type after the completed source-schema preflight")
}

func TestResetMailchimpCustomFieldPlanStartsNewDryRunReview(t *testing.T) {
	job := &canonical.MigrationJob{Cursor: map[string]*string{}}
	require.NoError(t, persistMailchimpCustomFieldPlan(job, map[string]string{"SCORE": "number"}, true))
	ResetMailchimpCustomFieldPlan(job)
	require.False(t, mailchimpCustomFieldPlanComplete(job))
	require.Empty(t, loadMailchimpCustomFieldPlan(job))
}
