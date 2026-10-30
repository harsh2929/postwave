package orchestrator

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

// TestMigrationCompatibilityHarness_AllLaunchSources runs every launch source
// through the same dry-run orchestrator path used by the service. The fixture
// data intentionally includes the things customers notice during a switch:
// suppressions, custom fields, tags with punctuation/unicode, segments,
// automations, archive stats, and paid-reader references.
func TestMigrationCompatibilityHarness_AllLaunchSources(t *testing.T) {
	baseTime := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name             string
		source           canonical.SourcePlatform
		caps             canonical.AdapterCapabilities
		discovery        adapter.DiscoveryReport
		subscribers      [][]canonical.Subscriber
		segments         []canonical.Segment
		automations      []canonical.Automation
		archive          [][]canonical.CampaignArchive
		templates        [][]canonical.EmailTemplate
		sourceArchive    [][]canonical.SourceArchiveItem
		paidSubs         []canonical.PaidSub
		wantSuppressed   int
		wantSegments     int
		wantAutomations  int
		wantArchive      int
		wantPaidSubs     int
		wantMaxDataLoss  float64
		wantRowStatus    map[string]string
		wantSkippedCalls map[string]bool
	}{
		{
			name:        "mailchimp full compatibility",
			source:      canonical.SourceMailchimp,
			caps:        launchCaps(canonical.SourceMailchimp, true, true, true, true, false),
			discovery:   adapter.DiscoveryReport{SubscribersTotal: 5, SegmentsTotal: 1, AutomationsTotal: 1, ArchiveTotal: 1, CampaignsTotal: 1, ReportsTotal: 1, GroupsTotal: 2, FormsTotal: 1, TemplatesTotal: 2, LandingPagesTotal: 1, EcommerceTotal: 1},
			subscribers: [][]canonical.Subscriber{fixtureSubscribers(canonical.SourceMailchimp, baseTime)},
			segments:    []canonical.Segment{fixtureSegment("Mailchimp VIPs")},
			automations: []canonical.Automation{fixtureAutomation("Mailchimp Welcome")},
			archive:     [][]canonical.CampaignArchive{{fixtureCampaign(canonical.SourceMailchimp, baseTime)}},
			templates:   [][]canonical.EmailTemplate{{fixtureTemplate(canonical.SourceMailchimp, "tpl_1"), fixtureTemplate(canonical.SourceMailchimp, "tpl_2")}},
			sourceArchive: [][]canonical.SourceArchiveItem{{
				fixtureSourceArchive(canonical.SourceMailchimp, "parity_gap:customer_journeys", "journeys"),
				fixtureSourceArchive(canonical.SourceMailchimp, "mailchimp_form", "form_1"),
				fixtureSourceArchive(canonical.SourceMailchimp, "mailchimp_landing_page", "lp_1"),
				fixtureSourceArchive(canonical.SourceMailchimp, "mailchimp_ecommerce_store", "store_1"),
			}},
			wantSuppressed:  2,
			wantSegments:    1,
			wantAutomations: 1,
			wantArchive:     1,
			wantMaxDataLoss: 0,
			wantRowStatus: map[string]string{
				"campaigns":   "imported_runtime",
				"automations": "imported_runtime",
				"groups":      "imported_runtime",
				"forms":       "imported_runtime",
				"landing":     "imported_runtime",
				"ecommerce":   "imported_runtime",
				"templates":   "imported_runtime",
			},
		},
		{
			name:        "convertkit preserves tags and sequence rebuild evidence",
			source:      canonical.SourceConvertKit,
			caps:        launchCaps(canonical.SourceConvertKit, true, true, true, true, false),
			discovery:   adapter.DiscoveryReport{SubscribersTotal: 5, SegmentsTotal: 3, AutomationsTotal: 1, ArchiveTotal: 1, CampaignsTotal: 1, ReportsTotal: 1, GroupsTotal: 2, FormsTotal: 1, LandingPagesTotal: 1},
			subscribers: [][]canonical.Subscriber{fixtureSubscribers(canonical.SourceConvertKit, baseTime)},
			segments: []canonical.Segment{
				fixtureSegment("Tag: paid"),
				fixtureSegment("Tag: vip"),
				fixtureSegment("ConvertKit Segment"),
			},
			automations: []canonical.Automation{{
				Name: "Kit Sequence", Status: "draft",
				SourceDefinition: `{"migration_mode":"rebuild_review","source":{"id":123},"emails":[{"id":456,"content":"<p>Welcome</p>"}]}`,
			}},
			sourceArchive: [][]canonical.SourceArchiveItem{{
				fixtureSourceArchive(canonical.SourceConvertKit, "convertkit_sequence_rebuild", "123"),
			}},
			archive:         [][]canonical.CampaignArchive{{fixtureCampaign(canonical.SourceConvertKit, baseTime)}},
			wantSuppressed:  2,
			wantSegments:    3,
			wantAutomations: 0,
			wantArchive:     1,
			wantMaxDataLoss: 20,
			wantRowStatus: map[string]string{
				"campaigns":   "imported_runtime",
				"groups":      "imported_runtime",
				"forms":       "manual_rebuild_required",
				"automations": "preserved_for_rebuild",
			},
		},
		{
			name:        "beehiiv snapshots audiences and preserves automations for rebuild",
			source:      canonical.SourceBeehiiv,
			caps:        launchCaps(canonical.SourceBeehiiv, true, true, true, true, false),
			discovery:   adapter.DiscoveryReport{SubscribersTotal: 5, SegmentsTotal: 1, AutomationsTotal: 1, ArchiveTotal: 1, CampaignsTotal: 1, ReportsTotal: 1, PaidSubsTotal: 1, FormsTotal: 1, LandingPagesTotal: 1},
			subscribers: [][]canonical.Subscriber{fixtureBeehiivSubscribers(baseTime)},
			segments:    []canonical.Segment{fixtureSegment("beehiiv power users")},
			automations: []canonical.Automation{{
				Name:             "beehiiv Welcome",
				Status:           "draft",
				SourceDefinition: `{"migration_mode":"rebuild_review","source":{"id":"aut_welcome"}}`,
			}},
			archive: [][]canonical.CampaignArchive{{fixtureCampaign(canonical.SourceBeehiiv, baseTime)}},
			sourceArchive: [][]canonical.SourceArchiveItem{{
				fixtureSourceArchive(canonical.SourceBeehiiv, "beehiiv_automation", "aut_welcome"),
				fixtureSourceArchive(canonical.SourceBeehiiv, "beehiiv_segment", "seg_power"),
			}},
			wantSuppressed:  2,
			wantSegments:    1,
			wantAutomations: 0,
			wantArchive:     1,
			wantPaidSubs:    0,
			wantMaxDataLoss: 20,
			wantRowStatus: map[string]string{
				"subscribers":         "imported_runtime",
				"segments":            "imported_runtime",
				"campaigns":           "imported_runtime",
				"automations":         "preserved_for_rebuild",
				"premium_memberships": "imported_runtime",
				"paid_subs":           "manual_rebuild_required",
				"forms":               "manual_rebuild_required",
			},
		},
		{
			name:        "mailerlite imports groups and preserves provider-specific resources for rebuild",
			source:      canonical.SourceMailerLite,
			caps:        launchCaps(canonical.SourceMailerLite, true, true, true, true, false),
			discovery:   adapter.DiscoveryReport{SubscribersTotal: 5, SegmentsTotal: 3, AutomationsTotal: 1, ArchiveTotal: 1, CampaignsTotal: 1, ReportsTotal: 1, GroupsTotal: 2, FormsTotal: 1, EcommerceTotal: 1, SourceArchiveTotal: 3},
			subscribers: [][]canonical.Subscriber{fixtureSubscribers(canonical.SourceMailerLite, baseTime)},
			segments: []canonical.Segment{
				fixtureSegment("Group: VIP"),
				fixtureSegment("Group: Beta"),
				{
					Name:             "MailerLite Engaged",
					Description:      "MailerLite saved segment could not be translated automatically; metadata is preserved for rebuild/review.",
					QueryAST:         canonical.SegmentNode{Op: "mailerlite_saved_segment_review"},
					SourceDefinition: `{"migration_mode":"rebuild_review","source_id":"mailerlite:segment:engaged"}`,
				},
			},
			automations: []canonical.Automation{{
				Name:             "MailerLite Workflow",
				Status:           "draft",
				SourceDefinition: `{"migration_mode":"rebuild_review","source_id":"mailerlite:automation:welcome"}`,
			}},
			archive: [][]canonical.CampaignArchive{{fixtureCampaign(canonical.SourceMailerLite, baseTime)}},
			sourceArchive: [][]canonical.SourceArchiveItem{{
				fixtureSourceArchive(canonical.SourceMailerLite, "mailerlite_form", "form_1"),
				fixtureSourceArchive(canonical.SourceMailerLite, "mailerlite_ecommerce_shop", "shop_1"),
				fixtureSourceArchive(canonical.SourceMailerLite, "parity_gap:sites_landing_pages", "sites_landing_pages"),
			}},
			wantSuppressed:  2,
			wantSegments:    2,
			wantAutomations: 0,
			wantArchive:     1,
			wantMaxDataLoss: 50,
			wantRowStatus: map[string]string{
				"campaigns":   "partial_runtime",
				"groups":      "imported_runtime",
				"segments":    "manual_rebuild_required",
				"automations": "manual_rebuild_required",
				"templates":   "manual_rebuild_required",
				"forms":       "preserved_for_rebuild",
				"landing":     "manual_rebuild_required",
				"ecommerce":   "preserved_for_rebuild",
			},
		},
		{
			name:            "substack export stays honest about unsupported social surfaces",
			source:          canonical.SourceSubstack,
			caps:            launchCaps(canonical.SourceSubstack, true, false, false, true, false),
			discovery:       adapter.DiscoveryReport{SubscribersTotal: 5, ArchiveTotal: 1, CampaignsTotal: 1},
			subscribers:     [][]canonical.Subscriber{fixtureSubscribers(canonical.SourceSubstack, baseTime)},
			archive:         [][]canonical.CampaignArchive{{fixtureCampaign(canonical.SourceSubstack, baseTime)}},
			wantSuppressed:  2,
			wantArchive:     1,
			wantPaidSubs:    0,
			wantMaxDataLoss: 0,
			wantRowStatus: map[string]string{
				"campaigns": "imported_runtime",
				"paid_subs": "manual_rebuild_required",
				"comments":  "manual_rebuild_required",
				"assets":    "manual_rebuild_required",
			},
			wantSkippedCalls: map[string]bool{"segments": true, "automations": true, "paid_subs": true},
		},
		{
			name:            "csv universal fallback is contact-only",
			source:          canonical.SourceCSV,
			caps:            launchCaps(canonical.SourceCSV, true, false, false, false, false),
			discovery:       adapter.DiscoveryReport{SubscribersTotal: 5},
			subscribers:     [][]canonical.Subscriber{fixtureSubscribers(canonical.SourceCSV, baseTime)},
			wantSuppressed:  2,
			wantMaxDataLoss: 0,
			wantRowStatus: map[string]string{
				"subscribers": "imported_runtime",
				"segments":    "manual_rebuild_required",
				"campaigns":   "manual_rebuild_required",
				"paid_subs":   "manual_rebuild_required",
			},
			wantSkippedCalls: map[string]bool{"segments": true, "automations": true, "archive": true, "paid_subs": true},
		},
		{
			name:            "sendy csv export is contact-only with provenance",
			source:          canonical.SourceSendy,
			caps:            launchCaps(canonical.SourceSendy, true, false, false, false, false),
			discovery:       adapter.DiscoveryReport{SubscribersTotal: 5},
			subscribers:     [][]canonical.Subscriber{fixtureSubscribers(canonical.SourceSendy, baseTime)},
			wantSuppressed:  2,
			wantMaxDataLoss: 0,
			wantRowStatus: map[string]string{
				"subscribers": "imported_runtime",
				"segments":    "manual_rebuild_required",
				"campaigns":   "manual_rebuild_required",
				"paid_subs":   "manual_rebuild_required",
			},
			wantSkippedCalls: map[string]bool{"segments": true, "automations": true, "archive": true, "paid_subs": true},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ad := &fixtureAdapter{
				caps:          tc.caps,
				discovery:     tc.discovery,
				subscribers:   tc.subscribers,
				segments:      tc.segments,
				automations:   tc.automations,
				archive:       tc.archive,
				templates:     tc.templates,
				sourceArchive: tc.sourceArchive,
				paidSubs:      tc.paidSubs,
			}
			job := &canonical.MigrationJob{
				ID:       "job_" + string(tc.source),
				TenantID: "tenant_compat",
				Source:   tc.source,
				Status:   canonical.MigDryRun,
				Cursor:   map[string]*string{},
			}
			var progressSeen []canonical.MigrationProgress
			orch := &Orchestrator{DryRun: true}
			require.NoError(t, orch.Run(context.Background(), ad, adapter.Session{Source: tc.source}, job, func(p canonical.MigrationProgress) {
				progressSeen = append(progressSeen, p)
			}))
			require.NotEmpty(t, progressSeen, "dry-run should emit progress")
			require.NotNil(t, job.VerificationReport)
			report := *job.VerificationReport

			require.Equal(t, tc.discovery.SubscribersTotal, report.SubscribersImported)
			require.Equal(t, tc.wantSuppressed, report.SuppressionListSize)
			require.Equal(t, tc.wantSegments, report.SegmentsTranslated)
			require.Equal(t, tc.wantAutomations, report.AutomationsTranslated)
			require.Equal(t, tc.wantArchive, report.ArchiveImported)
			require.Equal(t, tc.wantPaidSubs, report.PaidSubsImported)
			require.LessOrEqual(t, report.DataLossEstimatePct, tc.wantMaxDataLoss)

			require.Contains(t, report.CustomFieldsMapped, canonical.CustomFieldMapping{Source: "first_name", Canonical: "first_name", Type: "string"})
			require.Contains(t, report.CustomFieldsMapped, canonical.CustomFieldMapping{Source: "tier", Canonical: "custom.tier", Type: "string"})
			require.Contains(t, report.CustomFieldsUnmapped, "source_specific_metric")

			rows := map[string]canonical.ResourceCompleteness{}
			for _, row := range report.ResourceCompleteness {
				rows[row.Resource] = row
			}
			for resource, wantStatus := range tc.wantRowStatus {
				require.Equalf(t, wantStatus, rows[resource].Status, "%s status", resource)
			}
			for call, wantSkipped := range tc.wantSkippedCalls {
				require.Equalf(t, wantSkipped, ad.calls[call] == 0, "%s call skip state", call)
			}
		})
	}
}

func TestMigrationCompatibilityHarness_SurfacesLossInsteadOfHidingIt(t *testing.T) {
	ad := &fixtureAdapter{
		caps:      launchCaps(canonical.SourceMailchimp, true, true, true, false, false),
		discovery: adapter.DiscoveryReport{SubscribersTotal: 2, SegmentsTotal: 2, AutomationsTotal: 2},
		subscribers: [][]canonical.Subscriber{{
			{Email: "good@example.com", Status: canonical.StatusEnabled, CustomFields: map[string]interface{}{"first_name": "Good"}, SourcePlatform: canonical.SourceMailchimp},
			{Email: "suppressed@example.com", Status: canonical.StatusBlocklisted, CustomFields: map[string]interface{}{"MMERGE9": "legacy"}, SourcePlatform: canonical.SourceMailchimp},
		}},
		segments: []canonical.Segment{
			fixtureSegment("good"),
			{Name: "bad comparator", QueryAST: canonical.SegmentNode{Op: "condition", Field: "email", Comparator: "regex", Value: ".*"}},
		},
		automations: []canonical.Automation{
			fixtureAutomation("good automation"),
			{Name: "unsupported goal-only automation", Nodes: []canonical.AutomationNode{{ID: "goal", Type: "action"}}},
		},
	}
	job := &canonical.MigrationJob{
		ID:       "job_loss",
		TenantID: "tenant_compat",
		Source:   canonical.SourceMailchimp,
		Status:   canonical.MigDryRun,
		Cursor:   map[string]*string{},
	}
	require.NoError(t, (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil))
	report := *job.VerificationReport
	require.Len(t, report.SegmentsWithWarnings, 1)
	require.Len(t, report.AutomationsUnsupported, 2)
	require.Contains(t, report.AutomationsUnsupported[0].Reason, "no tenant-verified imported destination template")
	require.Contains(t, report.CustomFieldsUnmapped, "MMERGE9")
	require.Greater(t, report.DataLossEstimatePct, 0.0)
	require.LessOrEqual(t, report.DataLossEstimatePct, 40.0)
}

func TestOrchestratorCommitFailsFastWhenWritersMissing(t *testing.T) {
	ad := &fixtureAdapter{
		caps:      launchCaps(canonical.SourceMailchimp, true, true, true, true, false),
		discovery: adapter.DiscoveryReport{SubscribersTotal: 1},
		subscribers: [][]canonical.Subscriber{{
			{Email: "a@example.com", Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceMailchimp},
		}},
	}
	job := &canonical.MigrationJob{
		ID:       "job_missing_writers",
		TenantID: "tenant_compat",
		Source:   canonical.SourceMailchimp,
		Status:   canonical.MigImporting,
		Cursor:   map[string]*string{},
	}
	err := (&Orchestrator{DryRun: false}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "Listmonk writer credentials")
	require.Zero(t, ad.calls["discover"], "commit preflight should fail before source reads")
	require.Zero(t, ad.calls["subscribers"], "commit preflight should fail before resource reads")
}

func TestOrchestratorBridgeSourcesRequireDiscoveryPreflight(t *testing.T) {
	for _, source := range []canonical.SourcePlatform{
		canonical.SourceActiveCampaign,
		canonical.SourceHubSpot,
	} {
		t.Run(string(source), func(t *testing.T) {
			ad := &fixtureAdapter{
				caps:         launchCaps(source, true, false, false, false, false),
				discoveryErr: fmt.Errorf("%s: discover contacts: upstream unavailable", source),
				subscribers: [][]canonical.Subscriber{{
					{Email: "ada@example.com", Status: canonical.StatusEnabled, SourcePlatform: source},
				}},
			}
			job := &canonical.MigrationJob{
				ID:       "job_" + string(source) + "_discovery_required",
				TenantID: "tenant_compat",
				Source:   source,
				Status:   canonical.MigDryRun,
				Cursor:   map[string]*string{},
			}

			err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: source}, job, nil)

			require.Error(t, err)
			require.Contains(t, err.Error(), "source discovery preflight")
			require.Contains(t, err.Error(), "discover contacts")
			require.Equal(t, 1, ad.calls["discover"])
			require.Zero(t, ad.calls["subscribers"], "%s should not read contacts after failed discovery", source)
			require.NotNil(t, job.VerificationReport)
			require.Equal(t, 0, job.VerificationReport.SubscribersImported)
		})
	}
}

func TestOrchestratorMailchimpDiscoveryFailureBlocksPartialInventory(t *testing.T) {
	ad := &fixtureAdapter{
		caps:         launchCaps(canonical.SourceMailchimp, true, false, false, false, false),
		discoveryErr: errors.New("mailchimp discovery timeout"),
		subscribers: [][]canonical.Subscriber{{
			{Email: "ada@example.com", Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceMailchimp},
		}},
	}
	job := &canonical.MigrationJob{
		ID:       "job_mailchimp_discovery_best_effort",
		TenantID: "tenant_compat",
		Source:   canonical.SourceMailchimp,
		Status:   canonical.MigDryRun,
		Cursor:   map[string]*string{},
	}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)

	require.Error(t, err)
	require.Contains(t, err.Error(), "source discovery preflight")
	require.Equal(t, 1, ad.calls["discover"])
	require.Equal(t, 0, ad.calls["subscribers"])
	require.NotNil(t, job.VerificationReport)
	require.Equal(t, 0, job.VerificationReport.SubscribersImported)
}

func TestOrchestratorSeedsProgressTotalsFromDiscovery(t *testing.T) {
	disc := adapter.DiscoveryReport{
		SubscribersTotal:  10,
		SegmentsTotal:     2,
		AutomationsTotal:  3,
		ArchiveTotal:      4,
		TemplatesTotal:    5,
		FormsTotal:        1,
		LandingPagesTotal: 1,
		EcommerceTotal:    1,
		Audiences: []adapter.DiscoveryAudience{
			{ID: "aud-1", Name: "One"},
			{ID: "aud-2", Name: "Two"},
		},
	}
	job := &canonical.MigrationJob{
		ID:     "job_seed_progress",
		Source: canonical.SourceMailchimp,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
	}
	seedProgressTotals(job, disc)
	require.Equal(t, 10, job.Progress.SubscribersTotal)
	require.Equal(t, 2, job.Progress.SegmentsTotal)
	require.Equal(t, 3, job.Progress.AutomationsTotal)
	require.Equal(t, 4, job.Progress.ArchiveTotal)
	require.Equal(t, 5, job.Progress.TemplatesTotal)
	require.Equal(t, 16, job.Progress.SourceArchiveTotal)
}

func TestMailchimpCommitIsolationFailsBeforeAnySourceOrDestinationMutation(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Templates = true
	caps.Supports.Automations = true
	ad := &fixtureAdapter{caps: caps}
	job := &canonical.MigrationJob{
		ID:     "job-no-mutations",
		Source: canonical.SourceMailchimp,
		Status: canonical.MigImporting,
		Cursor: map[string]*string{},
	}
	client := &listmonkx.Client{DedicatedTenant: false}

	err := (&Orchestrator{Listmonk: client, TenantID: "tenant-a"}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)
	require.ErrorContains(t, err, "tenant isolation")
	require.Empty(t, ad.calls, "preflight must fail before discovery or any resource read/write stage")
}

func TestAutomationProgressCountsManualReviewRecordsAsProcessed(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCSV}
	caps.Supports.Automations = true
	ad := &fixtureAdapter{caps: caps, automations: []canonical.Automation{{
		Name:     "Requires rebuild",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added", Tag: "vip"}},
		Nodes:    []canonical.AutomationNode{{ID: "unsupported", Type: "provider_only_action"}},
	}}}
	job := &canonical.MigrationJob{ID: "automation-progress", Source: canonical.SourceCSV, Cursor: map[string]*string{}}
	o := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}

	require.NoError(t, o.runAutomations(context.Background(), ad, adapter.Session{Source: canonical.SourceCSV}, job, func(canonical.MigrationProgress) {}))
	require.Equal(t, 1, job.Progress.AutomationsTotal)
	require.Equal(t, 1, job.Progress.AutomationsDone)
	require.Empty(t, o.verifier.Automations)
	require.Len(t, o.verifier.AutomationsUnsupported, 1)
}

func TestActiveCampaignSourceArchiveExpectedTotalIncludesPreservedSurfaces(t *testing.T) {
	disc := adapter.DiscoveryReport{
		DealsTotal:         2,
		PipelinesTotal:     1,
		FormsTotal:         3,
		TemplatesTotal:     4,
		CustomObjectsTotal: 5,
		EcommerceTotal:     6,
		SMSCampaignsTotal:  7,
	}
	job := &canonical.MigrationJob{
		ID:     "job_activecampaign_source_archive_total",
		Source: canonical.SourceActiveCampaign,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
	}

	seedProgressTotals(job, disc)

	require.Equal(t, 28, job.Progress.SourceArchiveTotal)
}

func TestOrchestratorSourceArchiveProgressTotalFollowsActualRows(t *testing.T) {
	ad := &fixtureAdapter{
		caps:      canonical.AdapterCapabilities{Source: canonical.SourceActiveCampaign, AuthMethod: "fixture"},
		discovery: adapter.DiscoveryReport{},
		sourceArchive: [][]canonical.SourceArchiveItem{{
			fixtureSourceArchive(canonical.SourceActiveCampaign, "crm_deal", "deal_1"),
			fixtureSourceArchive(canonical.SourceActiveCampaign, "activecampaign_form", "form_1"),
		}},
	}
	job := &canonical.MigrationJob{
		ID:     "job_activecampaign_source_archive_actual_rows",
		Source: canonical.SourceActiveCampaign,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
	}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceActiveCampaign}, job, nil)
	require.NoError(t, err)
	require.Equal(t, 2, job.Progress.SourceArchiveDone)
	require.Equal(t, 2, job.Progress.SourceArchiveTotal)
	require.NotNil(t, job.VerificationReport)
	require.Equal(t, 2, job.VerificationReport.SourceArchiveImported)
	require.Equal(t, map[string]int{
		"activecampaign_form": 1,
		"crm_deal":            1,
	}, job.VerificationReport.SourceArchiveByResource)
}

func TestOrchestratorSourceArchiveWarningRowsAdvanceProgressWithoutImport(t *testing.T) {
	ad := &fixtureAdapter{
		caps:      canonical.AdapterCapabilities{Source: canonical.SourceActiveCampaign, AuthMethod: "fixture"},
		discovery: adapter.DiscoveryReport{FormsTotal: 3},
		sourceArchive: [][]canonical.SourceArchiveItem{{
			fixtureSourceArchiveWarning(canonical.SourceActiveCampaign, "forms", "activecampaign_form", "forms source archive unavailable: activecampaign status 403"),
		}},
	}
	job := &canonical.MigrationJob{
		ID:     "job_activecampaign_source_archive_warning",
		Source: canonical.SourceActiveCampaign,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
	}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceActiveCampaign}, job, nil)
	require.NoError(t, err)
	require.Equal(t, 3, job.Progress.SourceArchiveDone)
	require.Equal(t, 3, job.Progress.SourceArchiveTotal)
	require.NotNil(t, job.VerificationReport)
	require.Zero(t, job.VerificationReport.SourceArchiveImported)
	require.Empty(t, job.VerificationReport.SourceArchiveByResource)
	require.Len(t, job.VerificationReport.SourceArchiveWarnings, 1)
	require.Equal(t, "activecampaign_form", job.VerificationReport.SourceArchiveWarnings[0].Resource)
}

func TestOrchestratorSourceArchiveSchemaWarningsAdvanceProgressWithoutImport(t *testing.T) {
	ad := &fixtureAdapter{
		caps: canonical.AdapterCapabilities{Source: canonical.SourceActiveCampaign, AuthMethod: "fixture"},
		discovery: adapter.DiscoveryReport{
			CustomFields: []string{"Plan", "Region"},
			GroupsTotal:  3,
		},
		sourceArchive: [][]canonical.SourceArchiveItem{{
			fixtureSourceArchiveWarning(canonical.SourceActiveCampaign, "fields", "activecampaign_custom_field", "fields source archive unavailable: activecampaign status 403"),
			fixtureSourceArchiveWarning(canonical.SourceActiveCampaign, "tags", "activecampaign_tag", "tags source archive unavailable: activecampaign status 403"),
		}},
	}
	job := &canonical.MigrationJob{
		ID:     "job_activecampaign_schema_source_archive_warning",
		Source: canonical.SourceActiveCampaign,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
	}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceActiveCampaign}, job, nil)
	require.NoError(t, err)
	require.Equal(t, 5, job.Progress.SourceArchiveDone)
	require.Equal(t, 5, job.Progress.SourceArchiveTotal)
	require.NotNil(t, job.VerificationReport)
	require.Zero(t, job.VerificationReport.SourceArchiveImported)
	require.Empty(t, job.VerificationReport.SourceArchiveByResource)
	require.Len(t, job.VerificationReport.SourceArchiveWarnings, 2)
	require.Equal(t, "activecampaign_custom_field", job.VerificationReport.SourceArchiveWarnings[0].Resource)
	require.Equal(t, "activecampaign_tag", job.VerificationReport.SourceArchiveWarnings[1].Resource)
}

func TestBeehiivArchiveTraversalsRejectCrossPageDuplicateIdentities(t *testing.T) {
	for _, resourceType := range []string{
		"beehiiv_segment",
		"beehiiv_newsletter_list_subscription",
		"beehiiv_automation_email",
		"beehiiv_poll_response",
	} {
		resourceType := resourceType
		t.Run(resourceType, func(t *testing.T) {
			ad := &fixtureAdapter{sourceArchive: [][]canonical.SourceArchiveItem{
				{fixtureSourceArchive(canonical.SourceBeehiiv, resourceType, "duplicate-id")},
				{fixtureSourceArchive(canonical.SourceBeehiiv, resourceType, "duplicate-id")},
			}}
			job := &canonical.MigrationJob{ID: "beehiiv-source-duplicate", Source: canonical.SourceBeehiiv, Cursor: map[string]*string{}}
			o := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}
			err := o.runSourceArchive(context.Background(), ad, adapter.Session{Source: canonical.SourceBeehiiv}, job, nil)
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.ErrorContains(t, err, "duplicate "+resourceType+" identity")
		})
	}

	t.Run("campaigns", func(t *testing.T) {
		campaign := fixtureCampaign(canonical.SourceBeehiiv, time.Now().UTC())
		caps := canonical.AdapterCapabilities{Source: canonical.SourceBeehiiv}
		caps.Supports.CampaignArchive = true
		ad := &fixtureAdapter{caps: caps, archive: [][]canonical.CampaignArchive{{campaign}, {campaign}}}
		job := &canonical.MigrationJob{ID: "beehiiv-campaign-duplicate", Source: canonical.SourceBeehiiv, Cursor: map[string]*string{}}
		o := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}
		err := o.runArchive(context.Background(), ad, adapter.Session{Source: canonical.SourceBeehiiv}, job, nil)
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		require.ErrorContains(t, err, "duplicate source identity")
	})
}

func TestBoundedIdentityTrackingFailsClosedWithoutUnboundedKeyRetention(t *testing.T) {
	seen := map[[sha256.Size]byte]struct{}{}
	duplicate, err := addBoundedIdentity(seen, "history", "first", 1)
	require.NoError(t, err)
	require.False(t, duplicate)

	duplicate, err = addBoundedIdentity(seen, "history", "first", 1)
	require.NoError(t, err)
	require.True(t, duplicate, "a duplicate must still be detected at the capacity boundary")

	_, err = addBoundedIdentity(seen, "history", "second", 1)
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	require.ErrorContains(t, err, "safe 1-row tracking limit")
}

type fixtureAdapter struct {
	caps                   canonical.AdapterCapabilities
	discovery              adapter.DiscoveryReport
	discoveryErr           error
	subscribers            [][]canonical.Subscriber
	subscriberFn           func(cursor string) ([]canonical.Subscriber, string, error)
	segments               []canonical.Segment
	automations            []canonical.Automation
	archive                [][]canonical.CampaignArchive
	templates              [][]canonical.EmailTemplate
	sourceArchive          [][]canonical.SourceArchiveItem
	nonEmailIdentityCount  int
	nonEmailIdentityDigest string
	paidSubs               []canonical.PaidSub
	calls                  map[string]int
}

func (f *fixtureAdapter) Capabilities() canonical.AdapterCapabilities { return f.caps }

func (f *fixtureAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: f.caps.Source}, nil
}

func (f *fixtureAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	f.call("discover")
	if f.discoveryErr != nil {
		return adapter.DiscoveryReport{}, f.discoveryErr
	}
	return f.discovery, nil
}

func (f *fixtureAdapter) ListSubscribers(_ context.Context, _ adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	f.call("subscribers")
	if f.subscriberFn != nil {
		return f.subscriberFn(cursor)
	}
	idx := cursorIndex(cursor)
	if idx >= len(f.subscribers) {
		return nil, "", nil
	}
	next := ""
	if idx+1 < len(f.subscribers) {
		next = string(rune('0' + idx + 1))
	}
	return f.subscribers[idx], next, nil
}

func (f *fixtureAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	f.call("segments")
	if !f.caps.Supports.Segments {
		return nil, adapter.ErrUnsupported
	}
	return f.segments, nil
}

func (f *fixtureAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	f.call("automations")
	if !f.caps.Supports.Automations {
		return nil, adapter.ErrUnsupported
	}
	return f.automations, nil
}

func (f *fixtureAdapter) ListCampaignArchive(_ context.Context, _ adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	f.call("archive")
	if !f.caps.Supports.CampaignArchive {
		return nil, "", adapter.ErrUnsupported
	}
	idx := cursorIndex(cursor)
	if idx >= len(f.archive) {
		return nil, "", nil
	}
	next := ""
	if idx+1 < len(f.archive) {
		next = string(rune('0' + idx + 1))
	}
	return f.archive[idx], next, nil
}

func (f *fixtureAdapter) ListTemplates(_ context.Context, _ adapter.Session, cursor string) ([]canonical.EmailTemplate, string, error) {
	f.call("templates")
	if !f.caps.Supports.Templates {
		return nil, "", adapter.ErrUnsupported
	}
	idx := cursorIndex(cursor)
	if idx >= len(f.templates) {
		return nil, "", nil
	}
	next := ""
	if idx+1 < len(f.templates) {
		next = string(rune('0' + idx + 1))
	}
	return f.templates[idx], next, nil
}

func (f *fixtureAdapter) ListSourceArchive(_ context.Context, _ adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	f.call("source_archive")
	idx := cursorIndex(cursor)
	if idx >= len(f.sourceArchive) {
		return nil, "", nil
	}
	next := ""
	if idx+1 < len(f.sourceArchive) {
		next = string(rune('0' + idx + 1))
	}
	return f.sourceArchive[idx], next, nil
}

func (f *fixtureAdapter) CustomerIONonEmailIdentityFingerprint(context.Context, adapter.Session) (int, string, error) {
	digest := f.nonEmailIdentityDigest
	if digest == "" {
		digest = fmt.Sprintf("%x", sha256.Sum256([]byte("fixture-customerio-non-email-identities")))
	}
	return f.nonEmailIdentityCount, digest, nil
}

func (f *fixtureAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	f.call("paid_subs")
	if !f.caps.Supports.PaidSubs {
		return nil, adapter.ErrUnsupported
	}
	return f.paidSubs, nil
}

func (f *fixtureAdapter) call(name string) {
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[name]++
}

func cursorIndex(cursor string) int {
	if cursor == "" {
		return 0
	}
	if cursor == "1" {
		return 1
	}
	if cursor == "2" {
		return 2
	}
	return 999
}

func launchCaps(source canonical.SourcePlatform, subscribers, segments, automations, archive, paid bool) canonical.AdapterCapabilities {
	caps := canonical.AdapterCapabilities{Source: source, AuthMethod: "fixture"}
	caps.Supports.Subscribers = subscribers
	caps.Supports.Segments = segments
	caps.Supports.Automations = automations
	caps.Supports.CampaignArchive = archive
	caps.Supports.PaidSubs = paid
	caps.Supports.ConsentTimestamps = true
	if source == canonical.SourceBeehiiv || source == canonical.SourceMailerLite {
		caps.Supports.AutomationMode = "rebuild_review"
	}
	if source == canonical.SourceBeehiiv {
		caps.Supports.ConsentTimestamps = false
	}
	if source == canonical.SourceMailchimp {
		caps.Supports.Templates = true
		caps.Supports.Forms = true
		caps.Supports.LandingPages = true
		caps.Supports.Ecommerce = true
	}
	return caps
}

func fixtureSubscribers(source canonical.SourcePlatform, t time.Time) []canonical.Subscriber {
	return []canonical.Subscriber{
		{
			Email:            "alice@example.com",
			Status:           canonical.StatusEnabled,
			ConsentTimestamp: &t,
			ConsentSource:    canonical.ConsentDoubleOptIn,
			CustomFields:     map[string]interface{}{"first_name": "Alice", "tier": "pro", "source_specific_metric": 91},
			Tags:             []string{"vip", "comma,tag"},
			SourceID:         "src_alice",
			SourcePlatform:   source,
		},
		{
			Email:            "bob@example.com",
			Status:           canonical.StatusDisabled,
			ConsentTimestamp: &t,
			ConsentSource:    canonical.ConsentSingleOptIn,
			CustomFields:     map[string]interface{}{"first_name": "Bob"},
			Tags:             []string{"unsubscribed"},
			SourceID:         "src_bob",
			SourcePlatform:   source,
		},
		{
			Email:            "carol@example.com",
			Status:           canonical.StatusBlocklisted,
			ConsentTimestamp: &t,
			ConsentSource:    canonical.ConsentImport,
			CustomFields:     map[string]interface{}{"first_name": "Carol"},
			Tags:             []string{"complaint"},
			SourceID:         "src_carol",
			SourcePlatform:   source,
		},
		{
			Email:            "dimitri@example.com",
			Status:           canonical.StatusEnabled,
			ConsentTimestamp: &t,
			ConsentSource:    canonical.ConsentImport,
			CustomFields:     map[string]interface{}{"first_name": "Дмитрий", "country": "UA"},
			Tags:             []string{"unicode"},
			SourceID:         "src_dimitri",
			SourcePlatform:   source,
		},
		{
			Email:            "erin@example.com",
			Status:           canonical.StatusUnconfirmed,
			ConsentTimestamp: &t,
			ConsentSource:    canonical.ConsentUnknown,
			CustomFields:     map[string]interface{}{"company": "Example Co"},
			Tags:             []string{"pending"},
			SourceID:         "src_erin",
			SourcePlatform:   source,
		},
	}
}

func fixtureBeehiivSubscribers(t time.Time) []canonical.Subscriber {
	subscribers := fixtureSubscribers(canonical.SourceBeehiiv, t)
	for i := range subscribers {
		tier := "free"
		if i == 0 {
			tier = "premium"
		}
		subscribers[i].CustomFields["beehiiv"] = map[string]interface{}{"subscription_tier": tier}
	}
	return subscribers
}

func fixtureSegment(name string) canonical.Segment {
	return canonical.Segment{
		Name: name,
		QueryAST: canonical.SegmentNode{Op: "and", Children: []canonical.SegmentNode{
			{Op: "condition", Field: "email", Comparator: "contains", Value: "@example.com"},
			{Op: "condition", Field: "tags", Comparator: "in", Value: []string{"vip", "paid"}},
		}},
	}
}

func fixtureAutomation(name string) canonical.Automation {
	return canonical.Automation{
		Name:   name,
		Status: "active",
		Triggers: []canonical.AutomationTrigger{
			{Type: "tag_added", Tag: "new"},
		},
		Nodes: []canonical.AutomationNode{
			{ID: "send_1", Type: "send_email", TemplateID: "tpl_1"},
			{ID: "wait_1", Type: "wait", DurationSeconds: 86400},
			{ID: "send_2", Type: "send_email", TemplateID: "tpl_2"},
		},
		Edges: []canonical.AutomationEdge{
			{From: "send_1", To: "wait_1"},
			{From: "wait_1", To: "send_2"},
		},
	}
}

func fixtureCampaign(source canonical.SourcePlatform, t time.Time) canonical.CampaignArchive {
	return canonical.CampaignArchive{
		SourceID:        "camp_1",
		Subject:         "Launch update",
		HTML:            "<p>Hello</p>",
		Text:            "Hello",
		SentAt:          t,
		RecipientsCount: 500,
		Opens:           250,
		Clicks:          75,
		SourcePlatform:  source,
	}
}

func fixtureTemplate(source canonical.SourcePlatform, id string) canonical.EmailTemplate {
	return canonical.EmailTemplate{
		SourceID:       id,
		Name:           "Template " + id,
		HTML:           "<p>Hello</p>",
		SourcePlatform: source,
	}
}

func fixtureSourceArchive(source canonical.SourcePlatform, resourceType, id string) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   resourceType,
		Name:           id,
		Status:         "preserved",
		Payload:        map[string]interface{}{"id": id},
		SourcePlatform: source,
	}
}

func fixtureSourceArchiveWarning(source canonical.SourcePlatform, resource, targetResourceType, warning string) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:       "source_archive_warning:" + resource,
		ResourceType:   targetResourceType,
		Name:           resource,
		Payload:        map[string]interface{}{"resource": resource, "target_resource_type": targetResourceType},
		Warnings:       []string{warning},
		SourcePlatform: source,
	}
}

func fixturePaidSub(source canonical.SourcePlatform, t time.Time) canonical.PaidSub {
	return canonical.PaidSub{
		StripeCustomerID:     "cus_123",
		StripeSubscriptionID: "sub_123",
		StripePriceID:        "price_123",
		Status:               "active",
		CurrentPeriodEnd:     t.Add(30 * 24 * time.Hour),
		Email:                "alice@example.com",
		SourcePlatform:       source,
	}
}

var _ adapter.Adapter = (*fixtureAdapter)(nil)
var _ adapter.SourceArchiveAdapter = (*fixtureAdapter)(nil)
