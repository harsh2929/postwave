package orchestrator

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func TestBeehiivSubscriberTraversalEvidenceReconcilesPremiumAndAudienceMemberships(t *testing.T) {
	newInput := func() *VerifierInput {
		in := NewVerifierInput()
		in.Discovery = adapter.DiscoveryReport{
			SubscribersTotal: 2,
			PaidSubsTotal:    1,
			SnapshotMembershipCounts: map[string]int{
				"beehiiv:newsletter-list:nl_list_weekly": 1,
				"beehiiv:segment:seg_power":              1,
			},
		}
		in.ObserveSubscriber(canonical.Subscriber{
			SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub_one", Email: "one@example.com",
			Tags:         []string{"beehiiv:newsletter-list:nl_list_weekly", "beehiiv:segment:seg_power"},
			CustomFields: map[string]interface{}{"beehiiv": map[string]interface{}{"subscription_tier": "premium"}},
		})
		in.ObserveSubscriber(canonical.Subscriber{
			SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub_two", Email: "two@example.com",
			CustomFields: map[string]interface{}{"beehiiv": map[string]interface{}{"subscription_tier": "free"}},
		})
		return in
	}

	require.NoError(t, validateBeehiivSubscriberTraversalEvidence(newInput()))

	premiumDrift := newInput()
	premiumDrift.Discovery.PaidSubsTotal = 0
	err := validateBeehiivSubscriberTraversalEvidence(premiumDrift)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "observed 1 premium memberships, but discovery bound 0")

	truncatedList := newInput()
	truncatedList.SubscriberTagCounts["beehiiv:newsletter-list:nl_list_weekly"] = 0
	err = validateBeehiivSubscriberTraversalEvidence(truncatedList)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "applied 0 of 1 memberships")

	orphanedSegmentMember := newInput()
	orphanedSegmentMember.SubscriberTagCounts["beehiiv:segment:seg_power"] = 0
	err = validateBeehiivSubscriberTraversalEvidence(orphanedSegmentMember)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "beehiiv:segment:seg_power")
}

// TestBuildReport_TableCases exercises the verifier across the three
// signature scenarios from plan.md Phase 3:
//
//  1. Clean migration — every subscriber, every segment, every automation
//     translates without warning. data_loss_estimate_pct == 0.
//  2. Partial loss — known custom fields land cleanly, an unknown one
//     becomes "unmapped", and one segment carries a warning.
//  3. Full unsupported automation — every automation in the source bounces
//     into AutomationsUnsupported. automation_loss == 1.0.
func TestBuildReport_TableCases(t *testing.T) {
	cases := []struct {
		name         string
		populate     func(in *VerifierInput)
		wantSubs     int
		wantUnmapped []string
		wantSegWarn  int
		wantUnsup    int
		wantLossMin  float64 // inclusive
		wantLossMax  float64 // inclusive
	}{
		{
			name: "clean_migration_no_loss",
			populate: func(in *VerifierInput) {
				in.ObserveSubscriber(canonical.Subscriber{
					Email:        "a@b.com",
					Status:       canonical.StatusEnabled,
					CustomFields: map[string]interface{}{"first_name": "Ada"},
				})
				in.ObserveSubscriber(canonical.Subscriber{
					Email:        "b@b.com",
					Status:       canonical.StatusEnabled,
					CustomFields: map[string]interface{}{"first_name": "Bea"},
				})
				in.ObserveSegment(canonical.Segment{Name: "all"}, nil)
				in.ObserveAutomation(canonical.Automation{
					Name: "welcome",
					Nodes: []canonical.AutomationNode{
						{ID: "s1", Type: "send_email", TemplateID: "destination-template-1"},
					},
				}, "")
			},
			wantSubs:     2,
			wantUnmapped: []string{},
			wantSegWarn:  0,
			wantUnsup:    0,
			wantLossMin:  0,
			wantLossMax:  0,
		},
		{
			name: "partial_loss_unmapped_field_and_segment_warning",
			populate: func(in *VerifierInput) {
				in.ObserveSubscriber(canonical.Subscriber{
					Email:        "a@b.com",
					Status:       canonical.StatusEnabled,
					CustomFields: map[string]interface{}{"first_name": "Ada", "MMERGE7": "x"},
				})
				in.SubscribersErrored = 1 // pretend one row failed to write
				in.SubscribersSeen = 5    // out of 5 observed total — manual top-up
				in.ObserveSegment(canonical.Segment{Name: "good"}, nil)
				in.ObserveSegment(canonical.Segment{Name: "bad"}, errors.New("unsupported comparator"))
				in.ObserveAutomation(canonical.Automation{
					Name:  "welcome",
					Nodes: []canonical.AutomationNode{{ID: "s1", Type: "send_email", TemplateID: "destination-template-1"}},
				}, "")
			},
			wantSubs:     4, // 5 seen - 1 errored
			wantUnmapped: []string{"MMERGE7"},
			wantSegWarn:  1,
			wantUnsup:    0,
			wantLossMin:  10, // 0.6 * (1/5) * 100 + 0.2 * (1/2) * 100 = 12 + 10 = 22; allow tolerance
			wantLossMax:  25,
		},
		{
			name: "all_automations_unsupported",
			populate: func(in *VerifierInput) {
				in.ObserveSubscriber(canonical.Subscriber{
					Email:        "a@b.com",
					Status:       canonical.StatusEnabled,
					CustomFields: map[string]interface{}{"first_name": "Ada"},
				})
				in.ObserveAutomation(canonical.Automation{Name: "goal-tracking-1"}, "Goal tracking unsupported")
				in.ObserveAutomation(canonical.Automation{Name: "goal-tracking-2"}, "Goal tracking unsupported")
			},
			wantSubs:     1,
			wantUnmapped: []string{},
			wantSegWarn:  0,
			wantUnsup:    2,
			wantLossMin:  20, // 0.2 * 1.0 * 100 = 20
			wantLossMax:  20,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := NewVerifierInput()
			tc.populate(in)
			job := &canonical.MigrationJob{}
			rep := BuildReport(in, job)

			require.Equal(t, tc.wantSubs, rep.SubscribersImported, "subscribers_imported")
			require.Equal(t, tc.wantSegWarn, len(rep.SegmentsWithWarnings), "segments_with_warnings")
			require.Equal(t, tc.wantUnsup, len(rep.AutomationsUnsupported), "automations_unsupported")
			require.GreaterOrEqual(t, rep.DataLossEstimatePct, tc.wantLossMin, "data_loss lower bound")
			require.LessOrEqual(t, rep.DataLossEstimatePct, tc.wantLossMax, "data_loss upper bound")

			gotUnmapped := map[string]bool{}
			for _, u := range rep.CustomFieldsUnmapped {
				gotUnmapped[u] = true
			}
			for _, want := range tc.wantUnmapped {
				require.Truef(t, gotUnmapped[want], "expected %q in unmapped list, got %v", want, rep.CustomFieldsUnmapped)
			}
		})
	}
}

func TestObserveSubscriberCountsTimestampedModeUnknownConsentAsKnown(t *testing.T) {
	consentAt := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	in := NewVerifierInput()
	in.ObserveSubscriber(canonical.Subscriber{
		Email:            "mailchimp@example.com",
		Status:           canonical.StatusEnabled,
		ConsentTimestamp: &consentAt,
		ConsentSource:    canonical.ConsentUnknown,
		SourcePlatform:   canonical.SourceMailchimp,
	})
	require.Equal(t, 1, in.ConsentKnown)
	require.Zero(t, in.ConsentUnknown)
}

func TestBuildReport_NilInputReturnsEmpty(t *testing.T) {
	rep := BuildReport(nil, &canonical.MigrationJob{})
	require.Equal(t, 0, rep.SubscribersImported)
	require.Equal(t, 0.0, rep.DataLossEstimatePct)
}

func TestInferTypeClassifiesStructuredCustomFieldValues(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   interface{}
		want string
	}{
		{
			name: "activecampaign preserved malformed relationship evidence",
			in: []map[string]string{{
				"id":      "fv_99",
				"contact": "42",
				"reason":  "missing_custom_field_id",
			}},
			want: "array",
		},
		{
			name: "string map",
			in:   map[string]string{"id": "ct_11", "reason": "missing_tag_id"},
			want: "object",
		},
		{
			name: "string slice",
			in:   []string{"activecampaign_tag:999"},
			want: "array",
		},
		{
			name: "scalar fallback",
			in:   struct{ ID string }{ID: "custom"},
			want: "string",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, inferType(tc.in))
		})
	}
}

func TestBuildReport_ConsentCoverage(t *testing.T) {
	in := NewVerifierInput()
	knownAt := time.Now().UTC()
	in.ObserveSubscriber(canonical.Subscriber{
		Email:            "known@example.com",
		ConsentTimestamp: &knownAt,
		ConsentSource:    canonical.ConsentDoubleOptIn,
	})
	in.ObserveSubscriber(canonical.Subscriber{
		Email:         "unknown@example.com",
		ConsentSource: canonical.ConsentUnknown,
	})

	rep := BuildReport(in, &canonical.MigrationJob{})
	require.Equal(t, 1, rep.ConsentKnown)
	require.Equal(t, 1, rep.ConsentUnknown)
}

func TestObserveAutomationClassifiesNodeLessAutomationAsUnsupported(t *testing.T) {
	in := NewVerifierInput()
	in.ObserveAutomation(canonical.Automation{
		Name:             "ActiveCampaign welcome",
		Status:           "paused",
		Triggers:         []canonical.AutomationTrigger{{Type: "custom_event", EventName: "activecampaign.automation.12"}},
		SourceDefinition: `{"id":"12","status":"active"}`,
	}, "")

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	require.Equal(t, 0, rep.AutomationsTranslated)
	require.Len(t, rep.AutomationsUnsupported, 1)
	require.Contains(t, rep.AutomationsUnsupported[0].Reason, "no executable journey nodes")
}

func TestBuildReport_DuplicateSubscribersAreMergedAndReported(t *testing.T) {
	in := NewVerifierInput()
	in.ObserveSubscriber(canonical.Subscriber{
		Email:          "shared@example.com",
		Status:         canonical.StatusEnabled,
		SourceID:       "list:list_a:member:m1",
		SourcePlatform: canonical.SourceMailchimp,
		Tags:           []string{"mailchimp:list:list_a", "vip"},
		CustomFields:   map[string]interface{}{"FNAME": "Alice", "PLAN": "basic"},
	})
	in.ObserveSubscriber(canonical.Subscriber{
		Email:          "shared@example.com",
		Status:         canonical.StatusEnabled,
		SourceID:       "list:list_b:member:m9",
		SourcePlatform: canonical.SourceMailchimp,
		Tags:           []string{"mailchimp:list:list_b", "interest:abc"},
		CustomFields:   map[string]interface{}{"FNAME": "Alice", "PLAN": "pro"},
	})
	in.ObserveSubscriber(canonical.Subscriber{
		Email:          "solo@example.com",
		Status:         canonical.StatusEnabled,
		SourceID:       "list:list_a:member:m2",
		SourcePlatform: canonical.SourceMailchimp,
		Tags:           []string{"mailchimp:list:list_a"},
		CustomFields:   map[string]interface{}{"FNAME": "Solo"},
	})

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceMailchimp})
	require.Equal(t, 2, rep.SubscribersImported, "duplicate email should count as one destination subscriber")
	require.Equal(t, 1, rep.DuplicateSubscribersMerged)
	require.Len(t, rep.SubscriberMergeConflicts, 1)
	merge := rep.SubscriberMergeConflicts[0]
	require.Equal(t, "shared@example.com", merge.Email)
	require.ElementsMatch(t, []string{"list:list_a:member:m1", "list:list_b:member:m9"}, merge.SourceIDs)
	require.ElementsMatch(t, []string{"mailchimp:list:list_a", "mailchimp:list:list_b", "interest:abc", "vip"}, merge.Tags)
	require.Equal(t, []string{"PLAN"}, merge.ConflictFields)
}

func TestBuildReport_SampleSubscribersBoundedDeterministicAndMasked(t *testing.T) {
	in := NewVerifierInput()
	// Observe more than the sample limit so we exercise truncation. Emails are
	// intentionally out of order to prove deterministic email-sorted selection.
	for _, e := range []string{"zoe", "mia", "amy", "bob", "cara", "dan", "eve", "finn"} {
		in.ObserveSubscriber(canonical.Subscriber{
			Email:          e + "@example.com",
			Status:         canonical.StatusEnabled,
			SourceID:       "src:" + e,
			SourcePlatform: canonical.SourceMailchimp,
			Tags:           []string{"vip", "beta"},
			CustomFields: map[string]interface{}{
				"f5": 5, "f1": 1, "f2": 2, "f3": 3, "f4": 4,
			},
		})
	}

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceMailchimp})

	require.Len(t, rep.SampleSubscribers, sampleSubscriberLimit, "sample must be capped")
	// Deterministic: the first six emails alphabetically are amy..finn.
	got := make([]string, 0, len(rep.SampleSubscribers))
	for _, s := range rep.SampleSubscribers {
		got = append(got, s.Email)
	}
	require.Equal(t, []string{
		"a***@example.com", "b***@example.com", "c***@example.com",
		"d***@example.com", "e***@example.com", "f***@example.com",
	}, got, "sample must be email-sorted and local-part masked")

	first := rep.SampleSubscribers[0]
	require.Equal(t, canonical.StatusEnabled, first.Status)
	require.Equal(t, "src:amy", first.SourceID)
	require.Equal(t, []string{"beta", "vip"}, first.Tags, "tags sorted")
	require.Len(t, first.CustomFields, sampleCustomFieldLimit, "custom fields capped")
}

func TestBuildReport_ResourceWarnings(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.Warnings = []string{"activecampaign forms count unavailable"}
	in.ObserveCampaignArchive(canonical.CampaignArchive{
		SourceID: "camp_1",
		Subject:  "Launch",
		Warnings: []string{"email_activity fetch failed"},
	})
	in.ObserveTemplate(canonical.EmailTemplate{
		SourceID: "tpl_1",
		Name:     "Digest",
		Warnings: []string{"template HTML was absent"},
	})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{
		SourceID:     "source_archive_warning:forms",
		ResourceType: "activecampaign_form",
		Name:         "forms",
		Payload: map[string]interface{}{
			"target_resource_type": "activecampaign_form",
		},
		Warnings: []string{"forms source archive unavailable: activecampaign status 403"},
	})

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceMailchimp})
	require.Equal(t, []string{"activecampaign forms count unavailable"}, rep.DiscoveryWarnings)
	require.Equal(t, []canonical.ResourceWarning{{
		Resource: "campaign_archive",
		SourceID: "camp_1",
		Name:     "Launch",
		Warning:  "email_activity fetch failed",
	}}, rep.CampaignArchiveWarnings)
	require.Equal(t, []canonical.ResourceWarning{{
		Resource: "template",
		SourceID: "tpl_1",
		Name:     "Digest",
		Warning:  "template HTML was absent",
	}}, rep.TemplateWarnings)
	require.Equal(t, []canonical.ResourceWarning{{
		Resource: "activecampaign_form",
		SourceID: "source_archive_warning:forms",
		Name:     "forms",
		Warning:  "forms source archive unavailable: activecampaign status 403",
	}}, rep.SourceArchiveWarnings)
	require.Empty(t, rep.SourceArchiveByResource)
}

func TestBuildReport_MailchimpResourceCompleteness(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.SubscribersTotal = 5
	in.Discovery.TemplatesTotal = 4
	in.Discovery.CampaignsTotal = 10
	in.Discovery.ArchiveTotal = 7
	in.Discovery.AutomationsTotal = 3
	in.Discovery.ReportsTotal = 7
	in.Discovery.GroupsTotal = 2
	in.Discovery.SegmentsTotal = 1
	in.Discovery.FormsTotal = 1
	in.Discovery.LandingPagesTotal = 1
	in.Discovery.EcommerceTotal = 1
	in.ArchiveImported = 7
	in.TemplatesImported = 4
	in.SourceArchiveImported = 13
	for _, email := range []string{"a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"} {
		in.ObserveSubscriber(canonical.Subscriber{Email: email, Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceMailchimp})
	}
	in.ObserveSegment(canonical.Segment{
		Name:     "VIPs",
		QueryAST: canonical.SegmentNode{Op: "condition", Field: "email", Comparator: "contains", Value: "@example.com"},
	}, nil)
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "mailchimp_audience_schema"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "mailchimp_form"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "mailchimp_landing_page"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "mailchimp_ecommerce_store"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "mailchimp_customer_journey"})
	for _, resourceType := range []string{
		"mailchimp_content_studio",
		"mailchimp_survey_poll",
		"mailchimp_sms_program",
		"mailchimp_connected_site",
		"mailchimp_verified_domain",
		"mailchimp_social_ad",
		"mailchimp_developer_platform",
		"mailchimp_transactional",
		"mailchimp_marketplace",
	} {
		in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: resourceType})
	}
	in.ObserveAutomation(canonical.Automation{
		Name:  "welcome",
		Nodes: []canonical.AutomationNode{{ID: "send", Type: "send_email", TemplateID: "destination-template-1"}},
	}, "")
	in.ObserveAutomation(canonical.Automation{Name: "goal"}, "Goal tracking unsupported")

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceMailchimp})
	require.Len(t, rep.ResourceCompleteness, 20)

	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, "imported_runtime", byResource["subscribers"].Status)
	require.Equal(t, "partial_runtime", byResource["segments"].Status)
	require.Equal(t, "imported_runtime", byResource["audience_schema"].Status)
	require.Equal(t, "imported_runtime", byResource["templates"].Status)
	require.True(t, byResource["templates"].Supported)
	require.Equal(t, 4, byResource["templates"].Imported)
	require.Equal(t, "partial_runtime", byResource["campaigns"].Status)
	require.Equal(t, 7, byResource["campaigns"].Imported)
	require.Equal(t, "partial_runtime", byResource["automations"].Status)
	require.Equal(t, 1, byResource["automations"].Imported)
	require.Equal(t, "Classic Automations", byResource["automations"].Label)
	require.Contains(t, strings.Join(byResource["automations"].Notes, " "), "not exportable")
	require.Equal(t, "imported_runtime", byResource["groups"].Status)
	require.Equal(t, "imported_runtime", byResource["forms"].Status)
	require.Equal(t, "imported_runtime", byResource["landing"].Status)
	require.Equal(t, "imported_runtime", byResource["ecommerce"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["content"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["surveys"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["sms"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["connected_sites"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["deliverability"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["ads"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["developer_platform"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["transactional"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["marketplace"].Status)
}

func TestBuildReport_NonMailchimpResourceCompleteness(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.CampaignsTotal = 5
	in.Discovery.ArchiveTotal = 5
	in.Discovery.AutomationsTotal = 2
	in.Discovery.ReportsTotal = 5
	in.Discovery.GroupsTotal = 3
	in.Discovery.FormsTotal = 2
	in.ArchiveImported = 5
	in.ObserveAutomation(canonical.Automation{
		Name:  "welcome",
		Nodes: []canonical.AutomationNode{{ID: "send", Type: "send_email", TemplateID: "destination-template-1"}},
	}, "")

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceConvertKit})
	require.NotEmpty(t, rep.ResourceCompleteness)

	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, "imported_runtime", byResource["campaigns"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["automations"].Status)
	require.Equal(t, "imported_runtime", byResource["groups"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["forms"].Status)
	require.Equal(t, "not_detected", byResource["paid_subs"].Status)
}

func TestBuildReport_ActiveCampaignSavedSegmentReviewFailsClosed(t *testing.T) {
	in := NewVerifierInput()
	seg := canonical.Segment{
		Name: "High intent",
		Description: "ActiveCampaign saved segment could not be translated automatically; " +
			"full filter logic is preserved as source definition for rebuild/review.",
		QueryAST:         canonical.SegmentNode{Op: "activecampaign_saved_segment_review"},
		SourceDefinition: `{"id":"seg_1","name":"High intent"}`,
	}

	compiled, _, err := listmonkx.CompileSegment(seg.QueryAST)
	require.Error(t, err)
	require.Empty(t, compiled)
	require.Contains(t, err.Error(), `unknown op "activecampaign_saved_segment_review"`)

	in.ObserveSegment(seg, err)
	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	require.Zero(t, rep.SegmentsTranslated)
	require.Len(t, rep.SegmentsWithWarnings, 1)
	require.Equal(t, "High intent", rep.SegmentsWithWarnings[0].Name)
	require.Contains(t, rep.SegmentsWithWarnings[0].Warning, "activecampaign_saved_segment_review")
}

func TestBuildReport_KlaviyoResourceCompleteness(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.SubscribersTotal = 20
	in.Discovery.SegmentsTotal = 4
	in.Discovery.AutomationsTotal = 2
	in.Discovery.CampaignsTotal = 3
	in.Discovery.ArchiveTotal = 3
	in.Discovery.TemplatesTotal = 1
	in.Discovery.FormsTotal = 1
	in.Discovery.SourceArchiveTotal = 8
	in.Discovery.SMSCampaignsTotal = 1
	for i := 0; i < 20; i++ {
		in.ObserveSubscriber(canonical.Subscriber{Email: "user@example.com", Status: canonical.StatusEnabled})
	}
	for i := 0; i < 3; i++ {
		in.ObserveSegment(canonical.Segment{Name: "segment"}, nil)
	}
	in.TemplatesImported = 1
	in.ArchiveImported = 3
	for _, typ := range []string{
		"klaviyo_form",
		"klaviyo_commerce",
		"klaviyo_reviews",
		"klaviyo_service",
		"klaviyo_cdp",
		"klaviyo_omni_channel",
		"klaviyo_deliverability",
		"klaviyo_marketplace",
	} {
		in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: typ})
	}

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceKlaviyo})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, "imported_runtime", byResource["subscribers"].Status)
	require.Equal(t, "imported_runtime", byResource["templates"].Status)
	require.Equal(t, "partial_runtime", byResource["segments"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["forms"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["reviews"].Status)
	require.False(t, byResource["marketplace"].Supported)
	require.Equal(t, "manual_rebuild_required", byResource["reports"].Status)
}

func TestBuildReport_ActiveCampaignPreservedSurfacesAreMarkedForRebuild(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.SubscribersTotal = 10
	in.Discovery.TemplatesTotal = 2
	in.Discovery.FormsTotal = 1
	in.Discovery.GroupsTotal = 2
	in.Discovery.CustomFields = []string{"Plan", "Region"}
	in.Discovery.DealsTotal = 2
	in.Discovery.PipelinesTotal = 1
	in.Discovery.CRMTotal = 3
	in.Discovery.CustomObjectsTotal = 1
	in.Discovery.EcommerceTotal = 1
	in.Discovery.SMSCampaignsTotal = 1
	for _, typ := range []string{
		"activecampaign_message",
		"activecampaign_message",
		"activecampaign_custom_field",
		"activecampaign_custom_field",
		"activecampaign_tag",
		"activecampaign_tag",
		"activecampaign_form",
		"crm_deal",
		"crm_deal",
		"crm_pipeline",
		"activecampaign_custom_object_schema",
		"activecampaign_custom_object_record",
		"activecampaign_ecommerce_order",
		"activecampaign_ecommerce_order_product",
		"activecampaign_sms_broadcast",
		"activecampaign_sms_broadcast_recipient",
		"activecampaign_non_email_contact",
	} {
		in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: typ})
	}

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, "preserved_for_rebuild", byResource["templates"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["audience_schema"].Status)
	require.Equal(t, 4, byResource["audience_schema"].SourceTotal)
	require.Equal(t, 4, byResource["audience_schema"].Imported)
	require.Equal(t, "preserved_for_rebuild", byResource["forms"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["crm"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["custom_objects"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["ecommerce"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["sms"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["non_email_contacts"].Status)
	require.Equal(t, 1, byResource["non_email_contacts"].SourceTotal)
	require.Equal(t, 9, byResource["subscribers"].SourceTotal)
	require.Equal(t, "manual_rebuild_required", byResource["consent_exclusions"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["automations"].Status)
}

func TestBuildReport_HubSpotContactPropertiesUseObservedImportedFields(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.SubscribersTotal = 1
	in.Discovery.GroupsTotal = 4
	in.Discovery.CustomFields = []string{"first_name", "hubspot_lifecycle_stage", "company", "phone"}
	in.Discovery.SegmentsTotal = 1
	in.Discovery.CRMTotal = 1
	in.ObserveSubscriber(canonical.Subscriber{
		Email:          "ada@example.com",
		SourcePlatform: canonical.SourceHubSpot,
		SourceID:       "42",
		CustomFields: map[string]interface{}{
			"first_name":              "Ada",
			"hubspot_lifecycle_stage": "customer",
		},
	})
	in.ObserveSegment(canonical.Segment{Name: "HubSpot: Customers"}, nil)

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceHubSpot})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, 4, byResource["groups"].SourceTotal)
	require.Equal(t, 2, byResource["groups"].Imported)
	require.Equal(t, "partial_runtime", byResource["groups"].Status)
	require.Contains(t, byResource["groups"].Notes[0], "distinct keys observed")
	require.Equal(t, "imported_runtime", byResource["lists"].Status)
}

func TestBuildReport_ActiveCampaignPartialPreservedSurfacesRequireRebuild(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.TemplatesTotal = 2
	in.Discovery.GroupsTotal = 2
	in.Discovery.CustomFields = []string{"Plan"}
	in.Discovery.CRMTotal = 2
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "activecampaign_message"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "activecampaign_custom_field"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "crm_deal"})

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, 2, byResource["templates"].SourceTotal)
	require.Equal(t, 1, byResource["templates"].Imported)
	require.Equal(t, "manual_rebuild_required", byResource["templates"].Status)
	require.Equal(t, 3, byResource["audience_schema"].SourceTotal)
	require.Equal(t, 1, byResource["audience_schema"].Imported)
	require.Equal(t, "manual_rebuild_required", byResource["audience_schema"].Status)
	require.Equal(t, 2, byResource["crm"].SourceTotal)
	require.Equal(t, 1, byResource["crm"].Imported)
	require.Equal(t, "manual_rebuild_required", byResource["crm"].Status)
}

func TestBuildReport_ActiveCampaignRuntimeTagsCountUniqueAssignedTags(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.GroupsTotal = 3
	in.Discovery.CustomFields = []string{"Plan"}
	for _, typ := range []string{
		"activecampaign_custom_field",
		"activecampaign_tag",
		"activecampaign_tag",
		"activecampaign_tag",
	} {
		in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: typ})
	}
	in.ObserveSubscriber(canonical.Subscriber{
		Email:          "ada@example.com",
		SourcePlatform: canonical.SourceActiveCampaign,
		SourceID:       "42",
		Tags:           []string{"VIP", "Customer", "VIP"},
	})
	in.ObserveSubscriber(canonical.Subscriber{
		Email:          "grace@example.com",
		SourcePlatform: canonical.SourceActiveCampaign,
		SourceID:       "43",
		Tags:           []string{"Customer"},
	})

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, 2, rep.SubscriberTagsImported)
	require.Equal(t, 2, byResource["groups"].SourceTotal)
	require.Equal(t, 2, byResource["groups"].Imported)
	require.Equal(t, "imported_runtime", byResource["groups"].Status)
	require.Equal(t, "preserved_for_rebuild", byResource["audience_schema"].Status)
	require.Equal(t, 4, byResource["audience_schema"].Imported)
}

func TestBuildReport_ActiveCampaignChildArchivesCannotConcealMissingParents(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.CustomObjectsTotal = 2
	in.Discovery.EcommerceTotal = 2
	in.Discovery.SMSCampaignsTotal = 2
	for _, typ := range []string{
		"activecampaign_custom_object_schema",
		"activecampaign_custom_object_record",
		"activecampaign_custom_object_record",
		"activecampaign_ecommerce_order",
		"activecampaign_ecommerce_order_product",
		"activecampaign_ecommerce_order_product",
		"activecampaign_sms_broadcast",
		"activecampaign_sms_broadcast_recipient",
		"activecampaign_sms_broadcast_recipient",
	} {
		in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: typ})
	}

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	for _, resource := range []string{"custom_objects", "ecommerce", "sms"} {
		row := byResource[resource]
		require.Equal(t, 2, row.SourceTotal, resource)
		require.Equal(t, 1, row.Imported, resource)
		require.Equal(t, "manual_rebuild_required", row.Status, resource)
	}
}

func TestBeehiivResourceCompletenessAccountsForDefinitionArchives(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		SegmentsTotal:    3,
		GroupsTotal:      1,
		AutomationsTotal: 1,
		CustomFields:     []string{"Company", "Plan"},
	}
	report := canonical.VerificationReport{
		SourceArchiveByResource: map[string]int{
			"beehiiv_segment":                             2,
			"beehiiv_custom_field":                        2,
			"beehiiv_newsletter_list":                     1,
			"beehiiv_newsletter_list_history_manifest":    1,
			"beehiiv_automation":                          1,
			"beehiiv_automation_email_inventory_manifest": 1,
		},
	}
	rows := ResourceCompletenessForSource(canonical.SourceBeehiiv, discovery, report)
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rows {
		byResource[row.Resource] = row
	}
	for _, resource := range []string{"segment_definitions", "custom_field_schema", "newsletter_list_definitions", "newsletter_list_history", "automations", "automation_email_inventory"} {
		row := byResource[resource]
		require.Equal(t, row.SourceTotal, row.Imported, resource)
		if resource == "automations" {
			require.Equal(t, "preserved_for_rebuild", row.Status, resource)
		} else {
			require.Equal(t, "imported_runtime", row.Status, resource)
		}
	}
	for _, resource := range []string{"forms", "landing", "beehiiv_website_capture_rebuild", "beehiiv_boosts_recommendations_rebuild", "beehiiv_ad_network_rebuild"} {
		require.Equal(t, 1, byResource[resource].SourceTotal, resource)
	}
}

func TestBuildReport_ActiveCampaignCRMFallsBackToDealsAndPipelines(t *testing.T) {
	in := NewVerifierInput()
	in.Discovery.DealsTotal = 2
	in.Discovery.PipelinesTotal = 1
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "crm_deal"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "crm_pipeline"})
	in.ObserveSourceArchiveItem(canonical.SourceArchiveItem{ResourceType: "crm_deal"})

	rep := BuildReport(in, &canonical.MigrationJob{Source: canonical.SourceActiveCampaign})
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rep.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	require.Equal(t, 3, byResource["crm"].SourceTotal)
	require.Equal(t, 3, byResource["crm"].Imported)
	require.Equal(t, "preserved_for_rebuild", byResource["crm"].Status)
}

func TestDiscoveryCompleteness_ActiveCampaignDoesNotAdvertiseRuntimeAutomations(t *testing.T) {
	rows := DiscoveryCompletenessForSource(canonical.SourceActiveCampaign, adapter.DiscoveryReport{
		SubscribersTotal: 10,
		AutomationsTotal: 3,
		TemplatesTotal:   2,
		FormsTotal:       1,
	})

	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rows {
		byResource[row.Resource] = row
	}
	require.Equal(t, "manual_rebuild_required", byResource["automations"].Status)
	require.Equal(t, 0, byResource["automations"].Imported)
	require.Equal(t, "manual_rebuild_required", byResource["templates"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["forms"].Status)
}

func TestDiscoveryCompletenessKlaviyoSeparatesFlowsFormsCampaignsAndStructuredTemplates(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		AutomationsTotal:   2,
		FormsTotal:         3,
		ArchiveTotal:       4,
		CampaignsTotal:     5,
		SourceArchiveTotal: klaviyoStaticRebuildTaskCount + 2 + 3 + 1 + 6,
	}
	rows := DiscoveryCompletenessForSource(canonical.SourceKlaviyo, discovery)
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rows {
		byResource[row.Resource] = row
	}
	for resource, want := range map[string]int{
		"automations":          2,
		"forms":                3,
		"campaign_rebuilds":    1,
		"structured_templates": 6,
	} {
		row := byResource[resource]
		require.Equal(t, want, row.SourceTotal, resource+" source total")
		require.Equal(t, want, row.Imported, resource+" preserved total")
	}
}

func TestDiscoveryCompleteness_CSVDoesNotHideMissingResources(t *testing.T) {
	rows := DiscoveryCompletenessForSource(canonical.SourceCSV, adapter.DiscoveryReport{
		SubscribersTotal: 10,
	})

	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range rows {
		byResource[row.Resource] = row
	}
	require.Equal(t, "imported_runtime", byResource["subscribers"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["segments"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["campaigns"].Status)
	require.Equal(t, "manual_rebuild_required", byResource["forms"].Status)
}

func TestClassifyCustomField_KnownAndUnknown(t *testing.T) {
	cases := []struct {
		raw       string
		wantCanon string
		wantOK    bool
	}{
		{"FNAME", "first_name", true},
		{"LNAME", "last_name", true},
		{"city", "custom.city", true},
		{"MMERGE7", "", false},
		{"custom.foo", "custom.foo", true},
	}
	for _, c := range cases {
		t.Run(c.raw, func(t *testing.T) {
			canon, ok := classifyCustomField(c.raw)
			require.Equal(t, c.wantOK, ok)
			if ok {
				require.Equal(t, c.wantCanon, canon)
			}
		})
	}
}

func TestSubscriberStatusAuthoritativeSourceIncludesSnapshotSources(t *testing.T) {
	require.True(t, subscriberStatusAuthoritativeSource(canonical.SourceActiveCampaign))
	require.True(t, subscriberStatusAuthoritativeSource(canonical.SourceHubSpot))
	require.True(t, subscriberStatusAuthoritativeSource(canonical.SourceBeehiiv))
	require.False(t, subscriberStatusAuthoritativeSource(canonical.SourceMailchimp))
}
