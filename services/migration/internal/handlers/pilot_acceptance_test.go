package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func TestAutomationRebuildLedger(t *testing.T) {
	report := &canonical.VerificationReport{
		AutomationsUnsupported: []canonical.AutomationUnsupported{
			{Name: "Welcome flow", Reason: "manual rebuild"},
			{Name: "Winback", Reason: "manual rebuild"},
		},
	}
	items := ensureAutomationRebuilds(report)
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if automationRebuildsPassed(report) {
		t.Fatalf("new rebuild ledger should not pass")
	}
	legacy := &canonical.VerificationReport{
		AutomationRebuilds: []canonical.AutomationRebuildItem{{
			Rank:   1,
			Name:   "Legacy pass without evidence",
			Status: "test_passed",
		}},
	}
	if automationRebuildsPassed(legacy) {
		t.Fatalf("legacy pass rows without test evidence should not pass")
	}
	if _, err := updateAutomationRebuild(report, canonical.AutomationRebuildItem{
		Rank:   1,
		Status: "test_passed",
		Owner:  "ops",
	}); err == nil || !strings.Contains(err.Error(), "test_evidence") {
		t.Fatalf("empty test-passed evidence err = %v, want test_evidence requirement", err)
	}
	if _, err := updateAutomationRebuild(report, canonical.AutomationRebuildItem{
		Rank:   2,
		Status: "approved_not_needed",
		Owner:  "ops",
	}); err == nil || !strings.Contains(err.Error(), "test_evidence") {
		t.Fatalf("empty waiver evidence err = %v, want test_evidence requirement", err)
	}
	if _, err := updateAutomationRebuild(report, canonical.AutomationRebuildItem{
		Rank:         1,
		Status:       "test_passed",
		Owner:        "ops",
		TestEvidence: "dry run screenshot",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := updateAutomationRebuild(report, canonical.AutomationRebuildItem{
		Rank:         2,
		Status:       "approved_not_needed",
		Owner:        "ops",
		TestEvidence: "automation intentionally retired for cutover",
	}); err != nil {
		t.Fatal(err)
	}
	if !automationRebuildsPassed(report) {
		t.Fatalf("ledger should pass after all top rebuilds pass")
	}
}

func TestKlaviyoPilotAcceptanceRequiresFinalDeltaAndPostDeltaReviewEvidence(t *testing.T) {
	completedAt := time.Now().UTC().Add(-time.Minute)
	mode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:          "job_klaviyo_acceptance",
		TenantID:    "tenant_a",
		Source:      canonical.SourceKlaviyo,
		Status:      canonical.MigCompleted,
		StartedAt:   completedAt.Add(-time.Hour),
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
		VerificationReport: &canonical.VerificationReport{
			ConsentKnown:        2,
			SuppressionListSize: 1,
			SubscribersImported: 2,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Profiles", SourceTotal: 2, Imported: 2, Supported: true, Status: "imported_runtime"},
				{Resource: "segments", Label: "Audiences", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "automations", Label: "Flows", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "omni_channels", Label: "Channels", SourceTotal: 1, Imported: 1, Supported: false, Status: "manual_rebuild_required"},
				{Resource: "deliverability", Label: "Deliverability", SourceTotal: 1, Imported: 1, Supported: false, Status: "manual_rebuild_required"},
				{Resource: "reports", Label: "Reports", SourceTotal: 1, Imported: 0, Supported: false, Status: "manual_rebuild_required"},
			},
		},
	}
	report := BuildPilotAcceptanceReport(job)
	items := map[string]PilotAcceptanceItem{}
	for _, item := range report.Items {
		items[item.Key] = item
	}
	for _, key := range []string{
		"klaviyo_final_delta_import",
		klaviyoConsentSuppressionReviewKey,
		klaviyoAudienceSnapshotReviewKey,
		klaviyoChannelIdentityReviewKey,
		klaviyoDeliverabilityReviewKey,
		klaviyoEcosystemDependenciesReviewKey,
	} {
		if _, ok := items[key]; !ok {
			t.Fatalf("Klaviyo pilot acceptance missing %q: %+v", key, report.Items)
		}
	}
	if items["klaviyo_final_delta_import"].Status != "pass" {
		t.Fatalf("final delta status = %q, want pass", items["klaviyo_final_delta_import"].Status)
	}
	if items[klaviyoAudienceSnapshotReviewKey].Status != "blocker" {
		t.Fatalf("audience review status = %q, want blocker before evidence", items[klaviyoAudienceSnapshotReviewKey].Status)
	}

	reviewedAt := time.Now().UTC().Format(time.RFC3339Nano)
	detail := "reviewed after the exact final delta"
	evidenceJSON := `["cutover-ticket-42"]`
	for _, key := range []string{
		klaviyoConsentSuppressionReviewKey,
		klaviyoAudienceSnapshotReviewKey,
		klaviyoChannelIdentityReviewKey,
		klaviyoDeliverabilityReviewKey,
		klaviyoEcosystemDependenciesReviewKey,
	} {
		status := "pass"
		statusKey, atKey, detailKey, evidenceKey := klaviyoCutoverEvidenceCursorKeys(key)
		job.Cursor[statusKey] = &status
		job.Cursor[atKey] = &reviewedAt
		job.Cursor[detailKey] = &detail
		job.Cursor[evidenceKey] = &evidenceJSON
		item := applyKlaviyoCutoverEvidence(job, PilotAcceptanceItem{Key: key, Status: "blocker"})
		if item.Status != "pass" {
			t.Fatalf("post-delta evidence %q status = %q: %s", key, item.Status, item.Detail)
		}
	}
}

func TestAutomationRebuildEndpointsRedactActiveCampaignEvidence(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	raw := "review source https://tenant.activehosted.com/api/3 with Api-Token=secret-token"
	job := &canonical.MigrationJob{
		ID:        "job_ac_rebuild",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now().Add(-time.Hour),
		Cursor:    map[string]*string{},
		VerificationReport: &canonical.VerificationReport{
			AutomationsUnsupported: []canonical.AutomationUnsupported{{
				Name:   "Welcome journey",
				Reason: raw,
			}},
		},
	}
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID+"/automation-rebuilds", nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, body=%s", rec.Code, rec.Body.String())
	}
	assertActiveCampaignSensitiveTextRedacted(t, rec.Body.String())

	patch := canonical.AutomationRebuildItem{
		Rank:         1,
		Status:       "test_passed",
		Notes:        raw,
		TestEvidence: raw,
	}
	payload, err := json.Marshal(patch)
	if err != nil {
		t.Fatalf("marshal patch: %v", err)
	}
	req = httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/automation-rebuilds", bytes.NewReader(payload))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body=%s", rec.Code, rec.Body.String())
	}
	assertActiveCampaignSensitiveTextRedacted(t, rec.Body.String())

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	encoded, err := json.Marshal(stored.VerificationReport)
	if err != nil {
		t.Fatalf("marshal stored report: %v", err)
	}
	assertActiveCampaignSensitiveTextRedacted(t, string(encoded))
}

func TestRedactCutoverEvidenceTextRedactsConfiguredActiveCampaignHost(t *testing.T) {
	t.Setenv("ACTIVECAMPAIGN_ALLOWED_API_HOSTS", "tenant.eu.provider.example")
	raw := "request https://tenant.eu.provider.example/api/3 failed; retry tenant.eu.provider.example/api/3 with status 503"
	redacted := redactCutoverEvidenceText(raw)
	if strings.Contains(redacted, "tenant.eu.provider.example") {
		t.Fatalf("configured ActiveCampaign host leaked: %q", redacted)
	}
	if !strings.Contains(redacted, "status 503") {
		t.Fatalf("non-URL diagnostic text was lost: %q", redacted)
	}
}

func assertActiveCampaignSensitiveTextRedacted(t *testing.T, body string) {
	t.Helper()
	if strings.Contains(body, "tenant.activehosted.com") || strings.Contains(body, "secret-token") {
		t.Fatalf("body = %s, want ActiveCampaign host/token redacted", body)
	}
	if !strings.Contains(body, "[redacted-activecampaign-api-url]") || !strings.Contains(body, "Api-Token=[redacted]") {
		t.Fatalf("body = %s, want redaction markers", body)
	}
}

func TestBuildPilotAcceptanceReportBlocksOnMissingAutomationRebuilds(t *testing.T) {
	job := &canonical.MigrationJob{
		ID:     "job-1",
		Source: canonical.SourceActiveCampaign,
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported"},
			},
			AutomationsUnsupported: []canonical.AutomationUnsupported{
				{Name: "Revenue journey", Reason: "deal trigger"},
			},
		},
	}
	report := BuildPilotAcceptanceReport(job)
	if report.Status != "blocker" {
		t.Fatalf("status = %q, want blocker", report.Status)
	}
	found := false
	for _, item := range report.Items {
		if item.Key == "top_automations" {
			found = true
			if item.Status != "blocker" {
				t.Fatalf("top_automations status = %q, want blocker", item.Status)
			}
		}
	}
	if !found {
		t.Fatalf("missing top_automations item")
	}
}

func TestBuildPilotAcceptanceReportWarnsAfterRebuildsUntilDeliverabilityReviewed(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-1",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor: map[string]*string{
			runModeCursorKey: &deltaMode,
		},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			ArchiveDone:     5,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported"},
				{Resource: "automations", Label: "Automations", SourceTotal: 1, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
			},
			AutomationRebuilds: []canonical.AutomationRebuildItem{
				{Rank: 1, Name: "Revenue journey", Status: "test_passed", TestEvidence: "test send and trigger replay captured"},
			},
		},
	}
	markRollbackRehearsalPassed(job, job.CompletedAt.Add(time.Minute))
	markActiveCampaignConsentExclusionReviewed(job, job.CompletedAt.Add(time.Minute))
	report := BuildPilotAcceptanceReport(job)
	if report.Status != "warning" {
		t.Fatalf("status = %q, want warning: %#v", report.Status, report.Items)
	}
	if item := pilotItemByKey(report, "activecampaign_deliverability_review"); item.Status != "warning" {
		t.Fatalf("deliverability item = %+v, want warning", item)
	}
	if item := pilotItemByKey(report, "activecampaign_automation_rebuild_review"); item.Status != "pass" {
		t.Fatalf("automation review item = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignCutoverGates(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "job-ac",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone:    10,
			ArchiveDone:        5,
			SegmentsDone:       3,
			SourceArchiveDone:  1,
			SourceArchiveTotal: 3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentUnknown:      10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "non_email_contacts", Label: "Email-less contacts", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "consent_exclusions", Label: "Email consent and exclusions", SourceTotal: 10, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "templates", Label: "Templates and messages", SourceTotal: 2, Imported: 2, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "forms", Label: "Forms", SourceTotal: 1, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
				{Resource: "crm", Label: "CRM deals and pipelines", SourceTotal: 2, Imported: 2, Supported: true, Status: "preserved_for_rebuild"},
			},
		},
	}
	report := BuildPilotAcceptanceReport(job)
	if report.Status != "blocker" {
		t.Fatalf("status = %q, want blocker: %#v", report.Status, report.Items)
	}
	byKey := map[string]PilotAcceptanceItem{}
	for _, item := range report.Items {
		byKey[item.Key] = item
	}
	if byKey["activecampaign_templates_review"].Status != "warning" {
		t.Fatalf("templates status = %q, want warning", byKey["activecampaign_templates_review"].Status)
	}
	if byKey["activecampaign_forms_review"].Status != "blocker" {
		t.Fatalf("forms status = %q, want blocker", byKey["activecampaign_forms_review"].Status)
	}
	if byKey["activecampaign_crm_archive_review"].Status != "warning" {
		t.Fatalf("crm status = %q, want warning", byKey["activecampaign_crm_archive_review"].Status)
	}
	if byKey[activeCampaignConsentExclusionReviewKey].Status != "blocker" {
		t.Fatalf("consent/exclusion status = %q, want blocker", byKey[activeCampaignConsentExclusionReviewKey].Status)
	}
	if !strings.Contains(byKey[activeCampaignConsentExclusionReviewKey].Detail, "List status or subscription date alone is not consent proof") {
		t.Fatalf("consent/exclusion detail = %q, want fail-closed consent guidance", byKey[activeCampaignConsentExclusionReviewKey].Detail)
	}
	if byKey["activecampaign_deliverability_review"].Status != "warning" {
		t.Fatalf("deliverability status = %q, want warning", byKey["activecampaign_deliverability_review"].Status)
	}
	if byKey["activecampaign_final_delta_import"].Status != "blocker" {
		t.Fatalf("final delta status = %q, want blocker", byKey["activecampaign_final_delta_import"].Status)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPhoneOnlyContactsRequireConsentReview(t *testing.T) {
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-phone-only-consent-review", completedAt)
	job.VerificationReport.SubscribersImported = 0
	job.VerificationReport.ConsentUnknown = 0
	job.VerificationReport.ResourceCompleteness = []canonical.ResourceCompleteness{
		{Resource: "subscribers", Label: "Email-addressable contacts", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
		{Resource: "non_email_contacts", Label: "Email-less contacts", SourceTotal: 3, Imported: 3, Supported: true, Status: "preserved_for_rebuild"},
		{Resource: "consent_exclusions", Label: "Email consent and exclusions", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, activeCampaignConsentExclusionReviewKey)
	if item.Status != "blocker" || item.Expected != 3 {
		t.Fatalf("phone-only consent item = %+v, want blocker for all 3 contacts", item)
	}
	if pilotItemByKey(report, "consent_reconciliation").Key != "" {
		t.Fatalf("generic consent item must be subsumed by ActiveCampaign channel review: %#v", report.Items)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignEmptySourceRequiresRemovedContactReview(t *testing.T) {
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-empty-source-review", completedAt)
	markFinalDeltaCompleted(job, completedAt)
	job.VerificationReport.SubscribersImported = 0
	job.VerificationReport.ConsentKnown = 0
	job.VerificationReport.ResourceCompleteness = []canonical.ResourceCompleteness{
		{Resource: "subscribers", Label: "Email-addressable contacts", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
		{Resource: "non_email_contacts", Label: "Email-less contacts", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
		{Resource: "consent_exclusions", Label: "Email consent and exclusions", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
	}

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), activeCampaignConsentExclusionReviewKey)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "intentionally empty") || !strings.Contains(strings.Join(item.Evidence, "\n"), "hard-deleted") {
		t.Fatalf("empty-source review item = %+v, want fail-closed removed-contact blocker", item)
	}

	markActiveCampaignConsentExclusionReviewed(job, completedAt.Add(time.Minute))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), activeCampaignConsentExclusionReviewKey)
	if item.Status != "pass" {
		t.Fatalf("reviewed empty-source item = %+v, want explicit post-delta evidence to clear", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignMissingContactCoverageFailsClosed(t *testing.T) {
	job := activeCampaignAcceptedJob("ac-missing-contact-coverage", time.Now().UTC())
	job.VerificationReport.ResourceCompleteness = []canonical.ResourceCompleteness{{
		Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime",
	}}
	item := pilotItemByKey(BuildPilotAcceptanceReport(job), activeCampaignConsentExclusionReviewKey)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "coverage is missing") {
		t.Fatalf("missing coverage item = %+v, want fail-closed rerun blocker", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignCampaignWarningsRequireReview(t *testing.T) {
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-campaign-fidelity", completedAt)
	deltaMode := runModeDeltaImport
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.CampaignArchiveWarnings = []canonical.ResourceWarning{{
		Resource: "campaign_archive", SourceID: "42", Name: "Launch", Warning: "campaign body was unavailable",
	}}

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), activeCampaignCampaignFidelityReviewKey)
	if item.Status != "blocker" || item.Expected != 5 || item.Actual != 5 || !strings.Contains(strings.Join(item.Evidence, "\n"), "Launch") {
		t.Fatalf("campaign fidelity item = %+v, want exact-count warning blocker", item)
	}
	markActiveCampaignCutoverEvidence(job, activeCampaignCampaignFidelityReviewKey, completedAt.Add(time.Minute))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), activeCampaignCampaignFidelityReviewKey)
	if item.Status != "pass" {
		t.Fatalf("signed-off campaign fidelity item = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignSMSReadinessEvidenceClearsBlocker(t *testing.T) {
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-sms-readiness", completedAt)
	deltaMode := runModeDeltaImport
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource: "sms", Label: "SMS broadcasts and consent", SourceTotal: 2, Imported: 2, Supported: true, Status: "preserved_for_rebuild",
	})

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), "sms_readiness")
	if item.Status != "blocker" {
		t.Fatalf("SMS readiness item = %+v, want blocker", item)
	}
	markActiveCampaignCutoverEvidence(job, "sms_readiness", completedAt.Add(time.Minute))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), "sms_readiness")
	if item.Status != "pass" {
		t.Fatalf("signed-off SMS readiness item = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignAudienceSchemaHasDedicatedReview(t *testing.T) {
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-audience-schema-review", completedAt)
	deltaMode := runModeDeltaImport
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource: "audience_schema", Label: "Audience field and tag schema", SourceTotal: 4, Imported: 4, Supported: true, Status: "preserved_for_rebuild",
	})

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), "activecampaign_audience_schema_review")
	if item.Status != "warning" || item.Expected != 4 || item.Actual != 4 {
		t.Fatalf("audience-schema item = %+v, want dedicated preserved-surface warning", item)
	}
	markActiveCampaignCutoverEvidence(job, "activecampaign_audience_schema_review", completedAt.Add(time.Minute))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), "activecampaign_audience_schema_review")
	if item.Status != "pass" {
		t.Fatalf("signed-off audience-schema item = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnSavedSegmentWarnings(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("job-ac-saved-segments", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness,
		canonical.ResourceCompleteness{
			Resource:    "lists",
			Label:       "Lists",
			SourceTotal: 3,
			Imported:    2,
			Supported:   true,
			Status:      "partial_runtime",
			Notes:       []string{"ActiveCampaign saved segment logic was preserved as source definition."},
		},
	)
	job.VerificationReport.SegmentsWithWarnings = []canonical.SegmentWarning{{
		Name:    "High intent",
		Warning: "listmonk segment compiler: unknown op \"activecampaign_saved_segment_review\"",
	}}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_segments_review")
	if item.Status != "blocker" {
		t.Fatalf("segment review item = %+v, want blocker", item)
	}
	if item.Expected != 3 || item.Actual != 2 {
		t.Fatalf("segment review counts = actual %d expected %d, want 2/3", item.Actual, item.Expected)
	}
	joined := strings.Join(item.Evidence, "\n")
	if !strings.Contains(joined, "High intent") || !strings.Contains(joined, "saved segment logic") {
		t.Fatalf("segment review evidence = %#v, want source note and warning", item.Evidence)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignSegmentSignoffClearsWarning(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("job-ac-saved-segments-signed-off", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness,
		canonical.ResourceCompleteness{
			Resource:    "lists",
			Label:       "Lists",
			SourceTotal: 3,
			Imported:    2,
			Supported:   true,
			Status:      "partial_runtime",
		},
	)
	job.VerificationReport.SegmentsWithWarnings = []canonical.SegmentWarning{{
		Name:    "High intent",
		Warning: "listmonk segment compiler: unknown op \"activecampaign_saved_segment_review\"",
	}}
	markActiveCampaignCutoverEvidence(job, "activecampaign_segments_review", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_segments_review")
	if item.Status != "pass" {
		t.Fatalf("segment review item = %+v, want pass after explicit sign-off", item)
	}
	if !strings.Contains(strings.Join(item.Evidence, "\n"), "status=pass") {
		t.Fatalf("segment review evidence = %#v, want recorded sign-off", item.Evidence)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnPartialRebuildSurfaceArchive(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-ac-partial-rebuild-surface",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		Progress: canonical.MigrationProgress{
			SubscribersDone:   10,
			ArchiveDone:       5,
			SegmentsDone:      3,
			SourceArchiveDone: 1,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentUnknown:      10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "non_email_contacts", Label: "Email-less contacts", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "consent_exclusions", Label: "Email consent and exclusions", SourceTotal: 10, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "templates", Label: "Templates and messages", SourceTotal: 2, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
			},
		},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_templates_review")
	if item.Status != "blocker" {
		t.Fatalf("templates item = %+v, want blocker", item)
	}
	if item.Expected != 2 || item.Actual != 1 {
		t.Fatalf("templates counts = actual %d expected %d, want 1/2", item.Actual, item.Expected)
	}
	if item.Detail != "Only some source records were preserved for rebuild/review. Re-run after fixing source archive access or explicitly export/sign off the missing records before cutover." {
		t.Fatalf("templates detail = %q", item.Detail)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnMissingCRMArchive(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-ac-crm-missing",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			ArchiveDone:     5,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "crm", Label: "CRM deals and pipelines", SourceTotal: 2, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
			},
		},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_crm_archive_review")
	if item.Status != "blocker" {
		t.Fatalf("crm item = %+v, want blocker", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnPartialCRMArchive(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-ac-crm-partial",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		Progress: canonical.MigrationProgress{
			SubscribersDone:   10,
			ArchiveDone:       5,
			SegmentsDone:      3,
			SourceArchiveDone: 1,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "crm", Label: "CRM deals and pipelines", SourceTotal: 2, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
			},
		},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_crm_archive_review")
	if item.Status != "blocker" {
		t.Fatalf("crm item = %+v, want blocker", item)
	}
	if item.Expected != 2 || item.Actual != 1 {
		t.Fatalf("crm counts = actual %d expected %d, want 1/2", item.Actual, item.Expected)
	}
	if item.Detail != "Some ActiveCampaign CRM records were not preserved. Fix source archive access, export/sign off the missing CRM records, or document the external CRM system of record before email/SMS cutover." {
		t.Fatalf("crm detail = %q", item.Detail)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPassesPartialCRMArchiveAfterReview(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-partial-reviewed-crm-archive", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignConsentExclusionReviewed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "crm",
		Label:       "CRM deals and pipelines",
		SourceTotal: 2,
		Imported:    1,
		Supported:   true,
		Status:      "preserved_for_rebuild",
	})
	markActiveCampaignCutoverEvidence(job, "activecampaign_crm_archive_review", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_crm_archive_review")
	if item.Status != "pass" {
		t.Fatalf("crm item = %+v, want pass", item)
	}
	if !strings.Contains(strings.Join(item.Evidence, "\n"), "status=pass") {
		t.Fatalf("crm evidence = %#v, want recorded sign-off", item.Evidence)
	}
	if report.Status != "pass" {
		t.Fatalf("report status = %q, want pass: %#v", report.Status, report.Items)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnAutomationRowWithoutRebuildLedger(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-ac-automation-row",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			ArchiveDone:     5,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "automations", Label: "Automations", SourceTotal: 2, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
			},
		},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_automation_rebuild_review")
	if item.Status != "blocker" {
		t.Fatalf("automation review item = %+v, want blocker", item)
	}
	if top := pilotItemByKey(report, "top_automations"); top.Status != "pass" {
		t.Fatalf("top automations item = %+v, want legacy pass while AC-specific item blocks", top)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignWarnsWhenAutomationTailExceedsRebuildLedger(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-ac-automation-tail",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			ArchiveDone:     5,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "automations", Label: "Automations", SourceTotal: 3, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
			},
			AutomationRebuilds: []canonical.AutomationRebuildItem{
				{Rank: 1, Name: "Revenue journey", Status: "test_passed", TestEvidence: "test send and trigger replay captured"},
				{Rank: 2, Name: "Winback", Status: "approved_not_needed", TestEvidence: "owner approved retirement for cutover"},
			},
		},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_automation_rebuild_review")
	if item.Status != "warning" {
		t.Fatalf("automation review item = %+v, want warning", item)
	}
	if item.Actual != 2 || item.Expected != 3 {
		t.Fatalf("automation review counts = actual %d expected %d, want 2/3", item.Actual, item.Expected)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksPassingAutomationRowsWithoutEvidence(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            "job-ac-automation-empty-evidence",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		CompletedAt:   ptrTime(time.Now().UTC()),
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				{Resource: "automations", Label: "Automations", SourceTotal: 2, Imported: 0, Supported: true, Status: "manual_rebuild_required"},
			},
			AutomationRebuilds: []canonical.AutomationRebuildItem{
				{Rank: 1, Name: "Revenue journey", Status: "test_passed"},
				{Rank: 2, Name: "Winback", Status: "approved_not_needed", TestEvidence: "owner approved retirement for cutover"},
			},
		},
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_automation_rebuild_review")
	if item.Status != "blocker" {
		t.Fatalf("automation review item = %+v, want blocker", item)
	}
	if !strings.Contains(strings.Join(item.Evidence, "\n"), "missing test evidence") {
		t.Fatalf("automation evidence = %#v, want missing test evidence detail", item.Evidence)
	}
	top := pilotItemByKey(report, "top_automations")
	if top.Status != "blocker" {
		t.Fatalf("top automations item = %+v, want blocker", top)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignFinalDeltaGates(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	baseJob := func() *canonical.MigrationJob {
		return &canonical.MigrationJob{
			ID:            "job-ac-delta",
			Source:        canonical.SourceActiveCampaign,
			Status:        canonical.MigCompleted,
			RollbackUntil: &rollbackUntil,
			CompletedAt:   ptrTime(time.Now().UTC()),
			Progress: canonical.MigrationProgress{
				SubscribersDone: 10,
				ArchiveDone:     5,
				SegmentsDone:    3,
			},
			VerificationReport: &canonical.VerificationReport{
				SubscribersImported: 10,
				ConsentKnown:        10,
				ResourceCompleteness: []canonical.ResourceCompleteness{
					{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
					{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
					{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
				},
			},
		}
	}

	missing := BuildPilotAcceptanceReport(baseJob())
	if item := pilotItemByKey(missing, "activecampaign_final_delta_import"); item.Status != "blocker" {
		t.Fatalf("missing final delta status = %q, want blocker", item.Status)
	}

	failedJob := baseJob()
	lastErr := "delta import failed; previous completed migration preserved: subscribers: boom"
	failedJob.Cursor = map[string]*string{deltaImportLastErrorKey: &lastErr}
	failed := BuildPilotAcceptanceReport(failedJob)
	if item := pilotItemByKey(failed, "activecampaign_final_delta_import"); item.Status != "blocker" || len(item.Evidence) != 1 {
		t.Fatalf("failed final delta item = %+v, want blocker with evidence", item)
	}

	missingCompletedAtJob := baseJob()
	deltaMode := runModeDeltaImport
	missingCompletedAtJob.CompletedAt = nil
	missingCompletedAtJob.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	missingCompletedAt := BuildPilotAcceptanceReport(missingCompletedAtJob)
	if item := pilotItemByKey(missingCompletedAt, "activecampaign_final_delta_import"); item.Status != "blocker" || !strings.Contains(item.Detail, "completion time is missing") {
		t.Fatalf("missing completed_at final delta item = %+v, want blocker with timestamp guidance", item)
	}

	passedJob := baseJob()
	passedJob.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	passed := BuildPilotAcceptanceReport(passedJob)
	if item := pilotItemByKey(passed, "activecampaign_final_delta_import"); item.Status != "pass" {
		t.Fatalf("passed final delta item = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignRedactsFinalDeltaFailureEvidence(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	rawErr := `delta import failed against https://tenant.activehosted.com/api/3 with Api-Token: secret-token; replay activecampaign:contact:42 cursor last_id=42; contact ada@example.com missing stable timestamp`
	job := activeCampaignAcceptedJob("ac-final-delta-redaction", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:        &deltaMode,
		deltaImportLastErrorKey: &rawErr,
	}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_final_delta_import")
	if item.Status != "blocker" || len(item.Evidence) != 1 {
		t.Fatalf("final delta item = %+v, want blocker with one evidence row", item)
	}
	assertActiveCampaignEvidenceRedacted(t, item.Evidence)
}

func TestBuildPilotAcceptanceReportActiveCampaignRedactsInvalidStoredEvidence(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	rollbackStatus := "pass"
	countSource := "imported_resource_ledger"
	totalResources := "1"
	preDeltaSyncedAt := completedAt.Format(time.RFC3339Nano)
	raw := `https://tenant.activehosted.com/api/3 Api-Token: secret-token activecampaign:contact:42 last_id=42 contact ada@example.com missing stable timestamp`
	job := activeCampaignAcceptedJob("ac-invalid-evidence-redaction", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:             &deltaMode,
		rollbackRehearsalStatusKey:   &rollbackStatus,
		rollbackRehearsalAtKey:       &raw,
		rollbackRehearsalSourceKey:   &countSource,
		rollbackRehearsalTotalKey:    &totalResources,
		sourceEventPreDeltaSyncedKey: &preDeltaSyncedAt,
	}

	report := BuildPilotAcceptanceReport(job)
	rollback := pilotItemByKey(report, "rollback_rehearsal")
	if rollback.Status != "blocker" || len(rollback.Evidence) < 2 {
		t.Fatalf("rollback item = %+v, want blocker with parse evidence", rollback)
	}
	assertActiveCampaignEvidenceRedacted(t, rollback.Evidence)

	job.Cursor[deltaImportStartedAtKey] = &raw
	monitor := &jobstore.SourceEventMonitorRecord{
		Enabled:       true,
		CreatedAt:     completedAt.Add(-time.Hour),
		LastSyncedAt:  ptrTime(completedAt.Add(-time.Minute)),
		EventsSeen:    1,
		EventsApplied: 1,
	}
	sourceEvents := activeCampaignSourceEventReplayAcceptanceItem(job, monitor, nil, nil, true)
	if sourceEvents.Status != "blocker" || !strings.Contains(sourceEvents.Detail, "Final delta start evidence is invalid") {
		t.Fatalf("source-event item = %+v, want invalid final-delta evidence blocker", sourceEvents)
	}
	assertActiveCampaignEvidenceRedacted(t, sourceEvents.Evidence)

	shadow := activeCampaignShadowCheckAcceptanceItem(job, nil, fmt.Errorf("shadow load failed: %s", raw), true)
	if shadow.Status != "blocker" || !strings.Contains(shadow.Detail, "could not be loaded") {
		t.Fatalf("shadow item = %+v, want load-error blocker", shadow)
	}
	assertActiveCampaignEvidenceRedacted(t, shadow.Evidence)
}

func TestBuildPilotAcceptanceReportActiveCampaignRedactsVerificationEvidence(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	raw := `review https://tenant.activehosted.com/api/3 with Api-Token: secret-token after activecampaign:contact:42 cursor last_id=42 contact ada@example.com missing stable timestamp`
	job := activeCampaignAcceptedJob("ac-report-evidence-redaction", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.DiscoveryWarnings = []string{raw}
	job.VerificationReport.SegmentsWithWarnings = []canonical.SegmentWarning{{
		Name:    "VIP",
		Warning: raw,
	}}
	job.VerificationReport.SourceArchiveWarnings = []canonical.ResourceWarning{{
		Resource: "forms",
		Warning:  raw,
	}}
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "templates",
		Label:       "Templates and messages",
		SourceTotal: 1,
		Imported:    1,
		Supported:   true,
		Status:      "preserved_for_rebuild",
		Notes:       []string{raw},
	})

	report := BuildPilotAcceptanceReport(job)
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	assertActiveCampaignEvidenceRedacted(t, []string{string(encoded)})

	original, err := json.Marshal(job.VerificationReport)
	if err != nil {
		t.Fatalf("marshal original report: %v", err)
	}
	if !strings.Contains(string(original), "tenant.activehosted.com") || !strings.Contains(string(original), "secret-token") {
		t.Fatalf("original report = %s, want raw internal evidence preserved", original)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksUntilRollbackRehearsalRecorded(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-no-rollback-rehearsal", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "rollback_rehearsal")
	if item.Status != "blocker" {
		t.Fatalf("rollback item = %+v, want blocker", item)
	}
	if report.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", report.Status)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnStaleRollbackRehearsal(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-stale-rollback-rehearsal", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(-time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "rollback_rehearsal")
	if item.Status != "blocker" {
		t.Fatalf("rollback item = %+v, want blocker", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPassesAfterDeliverabilityReviewed(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-deliverability-reviewed", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, activeCampaignDeliverabilityReviewKey)
	if item.Status != "pass" {
		t.Fatalf("deliverability item = %+v, want pass", item)
	}
	if report.Status != "pass" {
		t.Fatalf("report status = %q, want pass: %#v", report.Status, report.Items)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnStaleDeliverabilityEvidence(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-stale-deliverability", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(-time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, activeCampaignDeliverabilityReviewKey)
	if item.Status != "blocker" {
		t.Fatalf("deliverability item = %+v, want blocker", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksDeliverabilityAfterFailedLatestDelta(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-failed-latest-delta-deliverability", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	lastErr := "delta import failed; previous completed migration preserved: subscribers: boom"
	job.Cursor[deltaImportLastErrorKey] = &lastErr
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, activeCampaignDeliverabilityReviewKey)
	if item.Status != "blocker" {
		t.Fatalf("deliverability item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "latest final delta import to succeed") {
		t.Fatalf("deliverability detail = %q, want latest-delta failure detail", item.Detail)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksPassingEvidenceUntilFinalDeltaCompleted(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-incomplete-final-delta-evidence", completedAt)
	job.Status = canonical.MigImporting
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "templates",
		Label:       "Templates and messages",
		SourceTotal: 2,
		Imported:    1,
		Supported:   true,
		Status:      "preserved_for_rebuild",
	})
	markActiveCampaignCutoverEvidence(job, "activecampaign_templates_review", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	if item := pilotItemByKey(report, "activecampaign_final_delta_import"); item.Status != "blocker" {
		t.Fatalf("final delta item = %+v, want blocker", item)
	}
	deliverability := pilotItemByKey(report, activeCampaignDeliverabilityReviewKey)
	if deliverability.Status != "blocker" || !strings.Contains(deliverability.Detail, "completed final delta import") {
		t.Fatalf("deliverability item = %+v, want completed-final-delta blocker", deliverability)
	}
	templates := pilotItemByKey(report, "activecampaign_templates_review")
	if templates.Status != "blocker" || !strings.Contains(templates.Detail, "completed final delta import") {
		t.Fatalf("templates item = %+v, want completed-final-delta blocker", templates)
	}
	if report.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", report.Status)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPassesReviewedManualSurface(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-reviewed-manual-surface", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "templates",
		Label:       "Templates and messages",
		SourceTotal: 2,
		Imported:    2,
		Supported:   true,
		Status:      "preserved_for_rebuild",
	})
	markActiveCampaignCutoverEvidence(job, "activecampaign_templates_review", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_templates_review")
	if item.Status != "pass" {
		t.Fatalf("templates item = %+v, want pass", item)
	}
	if report.Status != "pass" {
		t.Fatalf("report status = %q, want pass: %#v", report.Status, report.Items)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksPartialManualSurfaceUntilReview(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-partial-manual-surface", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "templates",
		Label:       "Templates and messages",
		SourceTotal: 2,
		Imported:    1,
		Supported:   true,
		Status:      "preserved_for_rebuild",
	})

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_templates_review")
	if item.Status != "blocker" {
		t.Fatalf("templates item = %+v, want blocker", item)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPassesPartialManualSurfaceAfterReview(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-partial-reviewed-manual-surface", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "templates",
		Label:       "Templates and messages",
		SourceTotal: 2,
		Imported:    1,
		Supported:   true,
		Status:      "preserved_for_rebuild",
	})
	markActiveCampaignCutoverEvidence(job, "activecampaign_templates_review", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "activecampaign_templates_review")
	if item.Status != "pass" {
		t.Fatalf("templates item = %+v, want pass", item)
	}
	if !strings.Contains(item.Detail, "Owner reviewed") {
		t.Fatalf("templates detail = %q, want recorded review detail", item.Detail)
	}
	if report.Status != "pass" {
		t.Fatalf("report status = %q, want pass: %#v", report.Status, report.Items)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPassesReviewedDiscoveryWarnings(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-reviewed-discovery-warnings", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.DiscoveryWarnings = []string{"activecampaign forms count unavailable"}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	markActiveCampaignCutoverEvidence(job, "source_discovery_warnings", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "source_discovery_warnings")
	if item.Status != "pass" {
		t.Fatalf("discovery warnings item = %+v, want pass", item)
	}
	if report.Status != "pass" {
		t.Fatalf("report status = %q, want pass: %#v", report.Status, report.Items)
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignPassesReviewedSourceArchiveWarnings(t *testing.T) {
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-reviewed-source-archive-warnings", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.SourceArchiveWarnings = []canonical.ResourceWarning{{
		Resource: "activecampaign_form",
		SourceID: "source_archive_warning:forms",
		Name:     "forms",
		Warning:  "forms source archive unavailable: activecampaign status 403",
	}}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	markActiveCampaignCutoverEvidence(job, "source_archive_warnings", completedAt.Add(3*time.Minute))

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "source_archive_warnings")
	if item.Status != "pass" {
		t.Fatalf("source archive warnings item = %+v, want pass", item)
	}
	if report.Status != "pass" {
		t.Fatalf("report status = %q, want pass: %#v", report.Status, report.Items)
	}
}

func TestUpdateCutoverEvidencePersistsActiveCampaignDeliverabilityReview(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-deliverability-route", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"activecampaign_deliverability_review","status":"pass","detail":"Domains, tracking links, suppressions, forms, and webhooks reviewed after final delta.","evidence":["SPF/DKIM aligned","tracking link verified"]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var got PilotAcceptanceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if item := pilotItemByKey(got, activeCampaignDeliverabilityReviewKey); item.Status != "pass" {
		t.Fatalf("deliverability item = %+v, want pass", item)
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	if status, ok := cursorString(stored.Cursor, acDeliverabilityStatusKey); !ok || status != "pass" {
		t.Fatalf("deliverability status cursor = %q/%v, want pass/true", status, ok)
	}
	if reviewedAt, ok := cursorString(stored.Cursor, acDeliverabilityAtKey); !ok || reviewedAt == "" {
		t.Fatalf("deliverability reviewed_at cursor = %q/%v, want value/true", reviewedAt, ok)
	}
	if evidence, ok := cursorString(stored.Cursor, acDeliverabilityEvidenceKey); !ok || !strings.Contains(evidence, "tracking link verified") {
		t.Fatalf("deliverability evidence cursor = %q/%v, want tracking evidence", evidence, ok)
	}
}

func TestUpdateCutoverEvidencePersistsActiveCampaignConsentExclusionReview(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-consent-exclusion-route", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"activecampaign_consent_exclusion_review","status":"pass","detail":"Email and SMS consent, exclusions, and phone-only contacts reconciled after final delta.","evidence":["CONSENT-123","unknown contacts remain unconfirmed"]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var got PilotAcceptanceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	item := pilotItemByKey(got, activeCampaignConsentExclusionReviewKey)
	if item.Status != "pass" {
		t.Fatalf("consent/exclusion item = %+v, want pass", item)
	}
	if !strings.Contains(strings.Join(item.Evidence, "\n"), "CONSENT-123") {
		t.Fatalf("consent/exclusion evidence = %#v, want reference", item.Evidence)
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	statusKey, _, _, evidenceKey := activeCampaignCutoverEvidenceCursorKeys(activeCampaignConsentExclusionReviewKey)
	if status, ok := cursorString(stored.Cursor, statusKey); !ok || status != "pass" {
		t.Fatalf("consent/exclusion status cursor = %q/%v, want pass/true", status, ok)
	}
	if evidence, ok := cursorString(stored.Cursor, evidenceKey); !ok || !strings.Contains(evidence, "CONSENT-123") {
		t.Fatalf("consent/exclusion evidence cursor = %q/%v, want reference", evidence, ok)
	}
}

func TestUpdateCutoverEvidenceRedactsSecretsAndActiveCampaignHosts(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-redacted-cutover-evidence", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"activecampaign_deliverability_review","status":"pass","detail":"Reviewed tenant.api-us1.com/api/3 with Api-Token: secret-token","evidence":["callback https://tenant.activehosted.com/api/3/forms Authorization: Bearer super-secret"]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var got PilotAcceptanceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	item := pilotItemByKey(got, activeCampaignDeliverabilityReviewKey)
	if item.Detail != "Reviewed [redacted-activecampaign-api-url] with Api-Token=[redacted]" {
		t.Fatalf("detail = %q, want redacted detail", item.Detail)
	}
	if len(item.Evidence) < 3 || item.Evidence[2] != "callback [redacted-activecampaign-api-url] Authorization=[redacted]" {
		t.Fatalf("evidence = %#v, want redacted evidence", item.Evidence)
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	detail, _ := cursorString(stored.Cursor, acDeliverabilityDetailKey)
	evidence, _ := cursorString(stored.Cursor, acDeliverabilityEvidenceKey)
	for _, leaked := range []string{"tenant.api-us1.com", "tenant.activehosted.com", "secret-token", "super-secret"} {
		if strings.Contains(detail, leaked) || strings.Contains(evidence, leaked) {
			t.Fatalf("stored cutover evidence leaked %q: detail=%q evidence=%q", leaked, detail, evidence)
		}
	}
}

func TestUpdateCutoverEvidencePersistsActiveCampaignSourceArchiveWarningSignoff(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-source-archive-signoff-route", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	job.VerificationReport.SourceArchiveWarnings = []canonical.ResourceWarning{{
		Resource: "activecampaign_form",
		SourceID: "source_archive_warning:forms",
		Name:     "forms",
		Warning:  "forms source archive unavailable: activecampaign status 403",
	}}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(2*time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"source_archive_warnings","status":"pass","detail":"Forms endpoint warning reviewed after final delta.","evidence":["forms are out of cutover scope"]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var got PilotAcceptanceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if item := pilotItemByKey(got, "source_archive_warnings"); item.Status != "pass" {
		t.Fatalf("source archive warnings item = %+v, want pass", item)
	}
}

func TestUpdateCutoverEvidenceRejectsBlankReviewEvidence(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-blank-cutover-evidence", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"source_archive_warnings","status":"pass","detail":"   ","evidence":["  "]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "cutover evidence requires detail or evidence") {
		t.Fatalf("body = %s, want detail/evidence error", rec.Body.String())
	}
}

func TestUpdateCutoverEvidenceRejectsPassAfterFailedLatestDelta(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-failed-latest-delta-evidence", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	lastErr := "delta import failed; previous completed migration preserved: subscribers: boom"
	job.Cursor[deltaImportLastErrorKey] = &lastErr
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"source_archive_warnings","status":"pass","detail":"Reviewed after final delta.","evidence":["operator sign-off"]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "latest final delta import succeeds") {
		t.Fatalf("body = %s, want latest-delta failure error", rec.Body.String())
	}
}

func TestUpdateCutoverEvidenceRejectsPassUntilFinalDeltaCompleted(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-incomplete-final-delta-evidence-route", completedAt)
	job.Status = canonical.MigImporting
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"source_archive_warnings","status":"pass","detail":"Reviewed after final delta.","evidence":["operator sign-off"]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "final delta import completes") {
		t.Fatalf("body = %s, want final-delta completion error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	statusKey, _, _, _ := activeCampaignCutoverEvidenceCursorKeys("source_archive_warnings")
	if status, ok := cursorString(stored.Cursor, statusKey); ok || status != "" {
		t.Fatalf("source archive evidence status cursor = %q/%v, want absent", status, ok)
	}
}

func TestGetRollbackRehearsalPersistsEvidence(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	staleValidation := rollbackRehearsalValidationV1
	job := activeCampaignAcceptedJob("ac-rollback-rehearsal", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:               &deltaMode,
		rollbackRehearsalValidationKey: &staleValidation,
	}
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID+"/rollback-rehearsal", nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	if status, ok := cursorString(stored.Cursor, rollbackRehearsalStatusKey); !ok || status != "blocker" {
		t.Fatalf("rollback rehearsal status cursor = %q/%v, want blocker/true", status, ok)
	}
	if generatedAt, ok := cursorString(stored.Cursor, rollbackRehearsalAtKey); !ok || generatedAt == "" {
		t.Fatalf("rollback rehearsal generated_at cursor = %q/%v, want value/true", generatedAt, ok)
	}
	if total, ok := cursorString(stored.Cursor, rollbackRehearsalTotalKey); !ok || total == "" {
		t.Fatalf("rollback rehearsal total cursor = %q/%v, want value/true", total, ok)
	}
	if source, ok := cursorString(stored.Cursor, rollbackRehearsalSourceKey); !ok || source != "progress" {
		t.Fatalf("rollback rehearsal count source cursor = %q/%v, want progress/true", source, ok)
	}
	if validation, ok := cursorString(stored.Cursor, rollbackRehearsalValidationKey); ok || validation != "" {
		t.Fatalf("rollback rehearsal destination validation = %q/%v, want stale proof removed", validation, ok)
	}
}

func TestGetPilotAcceptanceRejectsConcurrentJobExecution(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:       "pilot-acceptance-execution-lease",
		TenantID: "tenant_a",
		Source:   canonical.SourceCustomerIO,
		Status:   canonical.MigCompleted,
	}
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create: %v", err)
	}
	lease, err := orchestrator.AcquireMigrationExecutionLease(context.Background(), nil, job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("acquire competing execution lease: %v", err)
	}
	defer func() { _ = lease.Release() }()

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID+"/pilot-acceptance", nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "execution is already owned") {
		t.Fatalf("pilot acceptance status/body = %d/%s, want execution-lease conflict", rec.Code, rec.Body.String())
	}
}

func TestBuildRollbackRehearsalReportIncludesTemplates(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	rollbackUntil := now.Add(time.Hour)
	job := &canonical.MigrationJob{
		ID:            "ac-rollback-templates",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone:   2,
			SegmentsDone:      1,
			ArchiveDone:       3,
			TemplatesDone:     4,
			SourceArchiveDone: 5,
		},
	}
	report := BuildRollbackRehearsalReport(job, now)
	item := rollbackItemByKey(report, "templates")
	if item.Count != 4 || item.Order != 2 {
		t.Fatalf("templates item = count %d order %d, want 4/2", item.Count, item.Order)
	}
	if report.TotalResources != 15 {
		t.Fatalf("total resources = %d, want 15", report.TotalResources)
	}
}

func TestBuildRollbackRehearsalReportLabelsActiveCampaignRuntimeAutomations(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	rollbackUntil := now.Add(time.Hour)
	job := &canonical.MigrationJob{
		ID:            "ac-rollback-automations",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			AutomationsDone: 2,
		},
	}
	report := BuildRollbackRehearsalReport(job, now)
	item := rollbackItemByKey(report, "automations")
	if item.Label != "Runtime automations" || item.Count != 2 {
		t.Fatalf("automation rollback item = label %q count %d, want Runtime automations/2", item.Label, item.Count)
	}

	job.Source = canonical.SourceMailchimp
	report = BuildRollbackRehearsalReport(job, now)
	item = rollbackItemByKey(report, "automations")
	if item.Label != "Automations" {
		t.Fatalf("mailchimp automation rollback label = %q, want Automations", item.Label)
	}
}

func TestBuildRollbackRehearsalReportUsesLedgerCounts(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	rollbackUntil := now.Add(time.Hour)
	job := &canonical.MigrationJob{
		ID:            "ac-rollback-ledger",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone: 100,
			ArchiveDone:     10,
			TemplatesDone:   3,
		},
	}
	report := buildRollbackRehearsalReport(job, now, map[string]int{
		"subscribers":         98,
		"campaign_archive":    31,
		"templates":           3,
		"source_materialized": 2,
		"lists":               2,
	}, "imported_resource_ledger")
	if report.CountSource != "imported_resource_ledger" {
		t.Fatalf("count source = %q, want imported_resource_ledger", report.CountSource)
	}
	if got := rollbackItemByKey(report, "campaign_archive").Count; got != 31 {
		t.Fatalf("campaign archive count = %d, want 31", got)
	}
	if got := rollbackItemByKey(report, "source_materialized").Count; got != 2 {
		t.Fatalf("source materialized count = %d, want 2", got)
	}
	if got := rollbackItemByKey(report, "lists"); got.Count != 2 || got.Order != 9 {
		t.Fatalf("list rollback item = count %d order %d, want 2/9", got.Count, got.Order)
	}
	if report.TotalResources != 136 {
		t.Fatalf("total resources = %d, want 136", report.TotalResources)
	}
}

func TestBuildPilotAcceptanceBlocksActiveCampaignRollbackWithoutLedgerCountSource(t *testing.T) {
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-rollback-progress-only", completedAt)
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	delete(job.Cursor, rollbackRehearsalSourceKey)
	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "rollback_rehearsal")
	if item.Status != "blocker" {
		t.Fatalf("rollback rehearsal status = %q, want blocker", item.Status)
	}
	if !strings.Contains(item.Detail, "durable imported-resource ledger") {
		t.Fatalf("detail = %q, want ledger blocker", item.Detail)
	}
}

func TestGetPilotAcceptanceBlocksOnLatestActiveCampaignShadowDelta(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-shadow-delta", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	shadow := shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		NeedsDeltaImport:  true,
		RecommendedAction: "run_delta_import_before_cutover",
		Deltas: []shadowResourceDelta{{
			Resource:    "subscribers",
			Label:       "Contacts",
			SourceTotal: 11,
			Imported:    10,
			Delta:       1,
			CutoverRisk: "delta_import",
		}},
	}
	saveShadowAcceptanceFixture(t, store, job, shadow)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_shadow_check")
	if item.Status != "blocker" {
		t.Fatalf("shadow item = %+v, want blocker", item)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceBlocksOnMissingActiveCampaignShadowRecommendation(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-shadow-missing-recommendation", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:       job.ID,
		Source:      canonical.SourceActiveCampaign,
		GeneratedAt: completedAt.Add(time.Minute),
	})

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_shadow_check")
	if item.Status != "blocker" {
		t.Fatalf("shadow item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "missing a cutover recommendation") {
		t.Fatalf("shadow detail = %q, want missing recommendation guidance", item.Detail)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceIncludesSanitizedActiveCampaignShadowError(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-shadow-error", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	shadow := shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		CurrentDiscovery:  map[string]int{},
		RecommendedAction: "check_failed",
		Deltas:            []shadowResourceDelta{},
	}
	snapshot, err := json.Marshal(shadow)
	if err != nil {
		t.Fatalf("marshal shadow: %v", err)
	}
	rawErr := "shadow failed at https://tenant.activehosted.com/api/3 with Api-Token=secret-token"
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.ShadowCheckRecord{
		JobID:             job.ID,
		TenantID:          job.TenantID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       shadow.GeneratedAt,
		RecommendedAction: shadow.RecommendedAction,
		Error:             rawErr,
		Snapshot:          snapshot,
	}); err != nil {
		t.Fatalf("save shadow check: %v", err)
	}

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_shadow_check")
	if item.Status != "blocker" {
		t.Fatalf("shadow item = %+v, want blocker", item)
	}
	joinedEvidence := strings.Join(item.Evidence, "\n")
	for _, leaked := range []string{"tenant.activehosted.com", "secret-token"} {
		if strings.Contains(joinedEvidence, leaked) {
			t.Fatalf("shadow evidence leaked %q: %#v", leaked, item.Evidence)
		}
	}
	if !strings.Contains(joinedEvidence, "[redacted-activecampaign-api-url]") || !strings.Contains(joinedEvidence, "Api-Token=[redacted]") {
		t.Fatalf("shadow evidence = %#v, want sanitized shadow error", item.Evidence)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceKeepsDeliverabilityWarningWithCleanPostDeltaActiveCampaignShadowCheck(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-shadow-clean", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignConsentExclusionReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	saveSourceEventAcceptanceFixture(t, store, job, completedAt.Add(time.Minute), false, 0, 0)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_shadow_check")
	if item.Status != "pass" {
		t.Fatalf("shadow item = %+v, want pass", item)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want fail-closed blocker without a live Postgres ledger: %#v", got.Status, got.Items)
	}
	if item := pilotItemByKey(got, "activecampaign_deliverability_review"); item.Status != "warning" {
		t.Fatalf("deliverability item = %+v, want warning", item)
	}
	if item := pilotItemByKey(got, "rollback_rehearsal"); item.Status != "blocker" || !strings.Contains(item.Detail, "Postgres imported-resource ledger") {
		t.Fatalf("rollback rehearsal item = %+v, want live-ledger blocker", item)
	}
}

func TestGetPilotAcceptanceIncludesHubSpotBridgeMonitorGates(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("hubspot-bridge-clean", completedAt)
	markFinalDeltaCompleted(job, completedAt)
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	baselineFingerprint, importEpoch := bindHubSpotPilotShadowBaseline(t, job)
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:               job.ID,
		Source:              canonical.SourceHubSpot,
		GeneratedAt:         completedAt.Add(time.Minute),
		ImportEpoch:         importEpoch,
		BaselineFingerprint: baselineFingerprint,
		RecommendedAction:   "ready_for_cutover_review",
	})
	store.SetClock(func() time.Time { return completedAt.Add(-2 * time.Minute) })
	saveSourceEventAcceptanceFixture(t, store, job, completedAt.Add(-2*time.Minute), true, 1, 1)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	if item := pilotItemByKey(got, "hubspot_shadow_check"); item.Status != "pass" {
		t.Fatalf("hubspot shadow item = %+v, want pass", item)
	}
	if item := pilotItemByKey(got, "hubspot_final_delta_import"); item.Status != "pass" {
		t.Fatalf("hubspot final delta item = %+v, want pass", item)
	}
	if item := pilotItemByKey(got, "hubspot_source_event_replay"); item.Status != "pass" {
		t.Fatalf("hubspot source-event item = %+v, want pass", item)
	}
}

func TestGetPilotAcceptanceRequiresHubSpotFinalDeltaEvidence(t *testing.T) {
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("hubspot-bridge-missing-delta", completedAt)
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))

	got := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(got, "hubspot_final_delta_import")
	if item.Status != "blocker" {
		t.Fatalf("hubspot final delta item = %+v, want blocker", item)
	}

	markFinalDeltaCompleted(job, completedAt.Add(time.Minute))
	got = BuildPilotAcceptanceReport(job)
	item = pilotItemByKey(got, "hubspot_final_delta_import")
	if item.Status != "pass" {
		t.Fatalf("hubspot final delta item after marker = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportHubSpotBlocksOnDiscoveryWarnings(t *testing.T) {
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("hubspot-bridge-discovery-warning", completedAt)
	job.VerificationReport.DiscoveryWarnings = []string{
		"hubspot:contact:42 access_token=secret-token contact ada@example.com missing list scope",
	}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))

	got := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(got, "source_discovery_warnings")
	if item.Status != "blocker" {
		t.Fatalf("discovery warnings item = %+v, want blocker", item)
	}
	if len(item.Evidence) != 1 {
		t.Fatalf("evidence = %#v, want one sanitized warning", item.Evidence)
	}
	for _, leaked := range []string{"hubspot:contact:42", "secret-token", "ada@example.com"} {
		if strings.Contains(item.Evidence[0], leaked) {
			t.Fatalf("evidence = %q, leaked %q", item.Evidence[0], leaked)
		}
	}
	if !strings.Contains(item.Evidence[0], "[redacted-hubspot-source-event-id]") {
		t.Fatalf("evidence = %q, want HubSpot source-event redaction", item.Evidence[0])
	}
}

func TestGetPilotAcceptanceRequiresHubSpotRollbackRehearsalEvidence(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("hubspot-bridge-no-rollback", completedAt)
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceHubSpot,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	saveSourceEventAcceptanceFixture(t, store, job, completedAt.Add(time.Minute), true, 1, 1)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "rollback_rehearsal")
	if item.Status != "blocker" || !strings.Contains(item.Detail, "HubSpot bridge import") {
		t.Fatalf("rollback item = %+v, want HubSpot bridge rollback blocker", item)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceBlocksOnFailedActiveCampaignSourceEventReplay(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-source-event-failed", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	lastSync := completedAt.Add(2 * time.Minute)
	nextSync := completedAt.Add(7 * time.Minute)
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
	}); err != nil {
		t.Fatalf("upsert source-event monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		&lastSync,
		lastSync,
		nextSync,
		1,
		0,
		"activecampaign https://tenant.api-us1.com/api/3 failed with Api-Token: secret",
	); err != nil {
		t.Fatalf("update source-event monitor: %v", err)
	}
	if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventRecord{
		ID:            "ser_1",
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        canonical.SourceActiveCampaign,
		SourceEventID: "activecampaign:contact:42",
		ResourceType:  "subscriber",
		Action:        "upsert",
		OccurredAt:    &lastSync,
		Applied:       false,
		Error:         "callback tenant.activehosted.com/api/3 Authorization: Bearer token",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	joinedEvidence := strings.Join(item.Evidence, "\n")
	for _, leaked := range []string{"tenant.api-us1.com", "tenant.activehosted.com", "secret", "Bearer token"} {
		if strings.Contains(joinedEvidence, leaked) {
			t.Fatalf("source-event evidence leaked %q: %#v", leaked, item.Evidence)
		}
	}
	if !strings.Contains(joinedEvidence, "[redacted-activecampaign-api-url]") || !strings.Contains(joinedEvidence, "Api-Token=[redacted]") {
		t.Fatalf("source-event evidence = %#v, want redacted host/token", item.Evidence)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceRedactsFailedActiveCampaignSourceEventIDs(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-source-event-id-redaction", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	lastSync := completedAt.Add(2 * time.Minute)
	nextSync := completedAt.Add(7 * time.Minute)
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
	}); err != nil {
		t.Fatalf("upsert source-event monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		&lastSync,
		lastSync,
		nextSync,
		1,
		0,
		"",
	); err != nil {
		t.Fatalf("update source-event monitor: %v", err)
	}
	if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventRecord{
		ID:            "ser_1",
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        canonical.SourceActiveCampaign,
		SourceEventID: "activecampaign:contact:42",
		ResourceType:  "subscriber",
		Action:        "upsert",
		OccurredAt:    &lastSync,
		Applied:       false,
		Error:         "callback tenant.activehosted.com/api/3 Authorization: Bearer token",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	joinedEvidence := strings.Join(item.Evidence, "\n")
	for _, leaked := range []string{"tenant.activehosted.com", "Bearer token", "activecampaign:contact:42", "ser_1"} {
		if strings.Contains(joinedEvidence, leaked) {
			t.Fatalf("source-event evidence leaked %q: %#v", leaked, item.Evidence)
		}
	}
	if !strings.Contains(joinedEvidence, "[redacted-activecampaign-api-url]") || !strings.Contains(joinedEvidence, "Authorization=[redacted]") {
		t.Fatalf("source-event evidence = %#v, want redacted host/token", item.Evidence)
	}
	if !strings.Contains(joinedEvidence, "subscriber upsert occurred_at=") {
		t.Fatalf("source-event evidence = %#v, want resource/action/timestamp label", item.Evidence)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceBlocksOnOlderFailedActiveCampaignSourceEventReplay(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-source-event-older-failure", completedAt)
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	lastSync := completedAt.Add(2 * time.Minute)
	nextSync := completedAt.Add(7 * time.Minute)
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
	}); err != nil {
		t.Fatalf("upsert source-event monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		&lastSync,
		lastSync,
		nextSync,
		21,
		20,
		"",
	); err != nil {
		t.Fatalf("update source-event monitor: %v", err)
	}
	oldOccurredAt := completedAt.Add(-time.Minute)
	if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventRecord{
		ID:            "ser_old_failure",
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        canonical.SourceActiveCampaign,
		SourceEventID: "activecampaign:contact:old-failure",
		ResourceType:  "subscriber",
		Action:        "upsert",
		OccurredAt:    &oldOccurredAt,
		Applied:       false,
		Error:         "destination write failed",
	}); err != nil {
		t.Fatalf("save old failed source-event result: %v", err)
	}
	for i := 0; i < 20; i++ {
		occurredAt := completedAt.Add(time.Duration(i) * time.Second)
		if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventRecord{
			ID:            fmt.Sprintf("ser_clean_%02d", i),
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        canonical.SourceActiveCampaign,
			SourceEventID: fmt.Sprintf("activecampaign:contact:clean-%02d", i),
			ResourceType:  "subscriber",
			Action:        "upsert",
			OccurredAt:    &occurredAt,
			Applied:       true,
		}); err != nil {
			t.Fatalf("save clean source-event result %d: %v", i, err)
		}
	}

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "Persisted source-event replay results") {
		t.Fatalf("source-event detail = %q, want persisted failure guidance", item.Detail)
	}
	joinedEvidence := strings.Join(item.Evidence, "\n")
	if !strings.Contains(joinedEvidence, "destination write failed") {
		t.Fatalf("source-event evidence = %#v, want older unresolved failure", item.Evidence)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestActiveCampaignSanitizerRedactsSourceEventIdentifiers(t *testing.T) {
	input := `source-event replay failed for activecampaign:contact:42:2026-05-12T11:00:00Z:abcdef: destination unavailable; activecampaign: bad source-event cursor "last_at=2026-05-12T11%3A00%3A00Z&last_id=42&offset=1"; activecampaign: contact ada@example.com missing stable timestamp for source event; activecampaign: contact 42 source-event order moved backwards`
	got := sanitizeMigrationText(canonical.SourceActiveCampaign, input)
	for _, leaked := range []string{
		"activecampaign:contact:42",
		"last_id=42",
		"contact ada@example.com",
		"contact 42",
	} {
		if strings.Contains(got, leaked) {
			t.Fatalf("sanitized text leaked %q: %q", leaked, got)
		}
	}
	for _, want := range []string{
		"[redacted-activecampaign-source-event-id]",
		"last_id=[redacted]",
		"contact [redacted-activecampaign-contact]",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("sanitized text = %q, want %q", got, want)
		}
	}
}

func TestGetPilotAcceptanceBlocksWhenActiveCampaignSourceEventReplayStartsAfterFinalDelta(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	sourceSyncedAt := time.Now().UTC()
	deltaStartedAt := sourceSyncedAt.Add(5 * time.Minute)
	completedAt := deltaStartedAt.Add(2 * time.Minute)
	deltaMode := runModeDeltaImport
	job := activeCampaignAcceptedJob("ac-source-event-late-start", completedAt)
	job.StartedAt = deltaStartedAt
	job.Cursor = map[string]*string{runModeCursorKey: &deltaMode}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	lateMonitorCreatedAt := completedAt.Add(time.Minute)
	store.SetClock(func() time.Time { return lateMonitorCreatedAt })
	saveSourceEventAcceptanceFixture(t, store, job, lateMonitorCreatedAt, false, 1, 1)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "enabled after the final delta import began") {
		t.Fatalf("source-event detail = %q, want final-delta ordering guidance", item.Detail)
	}
	joinedEvidence := strings.Join(item.Evidence, "\n")
	if !strings.Contains(joinedEvidence, "monitor_created_at=") || !strings.Contains(joinedEvidence, "final_delta_started_at=") {
		t.Fatalf("source-event evidence = %#v, want monitor/final-delta timestamps", item.Evidence)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceBlocksOnStaleActiveCampaignSourceEventReplayBeforeFinalDelta(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	sourceSyncedAt := time.Now().UTC()
	deltaStartedAt := sourceSyncedAt.Add(30 * time.Minute)
	completedAt := deltaStartedAt.Add(2 * time.Minute)
	deltaMode := runModeDeltaImport
	deltaStartedAtValue := deltaStartedAt.Format(time.RFC3339Nano)
	sourceSyncedAtValue := sourceSyncedAt.Format(time.RFC3339Nano)
	job := activeCampaignAcceptedJob("ac-source-event-stale-before-delta", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:             &deltaMode,
		deltaImportStartedAtKey:      &deltaStartedAtValue,
		sourceEventPreDeltaSyncedKey: &sourceSyncedAtValue,
	}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	saveSourceEventAcceptanceFixture(t, store, job, sourceSyncedAt, false, 2, 2)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "stale for the final delta import") {
		t.Fatalf("source-event detail = %q, want stale replay guidance", item.Detail)
	}
	joinedEvidence := strings.Join(item.Evidence, "\n")
	if !strings.Contains(joinedEvidence, "last_synced_at=") ||
		!strings.Contains(joinedEvidence, "final_delta_started_at=") ||
		!strings.Contains(joinedEvidence, "max_source_event_staleness=5m0s") {
		t.Fatalf("source-event evidence = %#v, want stale replay timestamps", item.Evidence)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceBlocksWhenActiveCampaignSourceEventReplayLacksPreDeltaSnapshot(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	sourceSyncedAt := time.Now().UTC()
	deltaStartedAt := sourceSyncedAt.Add(5 * time.Minute)
	completedAt := deltaStartedAt.Add(2 * time.Minute)
	deltaMode := runModeDeltaImport
	deltaStartedAtValue := deltaStartedAt.Format(time.RFC3339Nano)
	job := activeCampaignAcceptedJob("ac-source-event-no-pre-delta-snapshot", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:        &deltaMode,
		deltaImportStartedAtKey: &deltaStartedAtValue,
	}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	saveSourceEventAcceptanceFixture(t, store, job, sourceSyncedAt.Add(10*time.Minute), false, 2, 2)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "missing a clean pre-delta sync snapshot") {
		t.Fatalf("source-event detail = %q, want missing snapshot guidance", item.Detail)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestPostPilotCleanupAuthorizationCannotBypassStrictAcceptance(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("ac-cleanup-authorization-blocked", completedAt)
	markFinalDeltaCompleted(job, completedAt)
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	err := h.persistCutoverEvidence(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job,
		cutoverEvidenceRequest{
			Key:    activeCampaignPostPilotCleanupEvidenceKey,
			Status: "pass",
			Detail: "operator attempted cleanup authorization",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "requires strict passing pilot acceptance with no blockers") {
		t.Fatalf("persist cleanup authorization error = %v, want strict acceptance rejection", err)
	}
}

func TestGetPilotAcceptanceBlocksWhenHubSpotSourceEventReplayLacksPreDeltaSnapshot(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	sourceSyncedAt := time.Now().UTC()
	deltaStartedAt := sourceSyncedAt.Add(5 * time.Minute)
	completedAt := deltaStartedAt.Add(2 * time.Minute)
	deltaMode := runModeDeltaImport
	deltaStartedAtValue := deltaStartedAt.Format(time.RFC3339Nano)
	job := hubSpotAcceptedJob("hubspot-source-event-no-pre-delta-snapshot", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:        &deltaMode,
		deltaImportStartedAtKey: &deltaStartedAtValue,
	}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceHubSpot,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	store.SetClock(func() time.Time { return sourceSyncedAt })
	saveSourceEventAcceptanceFixture(t, store, job, sourceSyncedAt.Add(10*time.Minute), false, 2, 2)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "hubspot_source_event_replay")
	if item.Status != "blocker" {
		t.Fatalf("source-event item = %+v, want blocker", item)
	}
	if !strings.Contains(item.Detail, "missing a clean pre-delta sync snapshot") {
		t.Fatalf("source-event detail = %q, want missing snapshot guidance", item.Detail)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want blocker", got.Status)
	}
}

func TestGetPilotAcceptanceAllowsCleanContinuousSourceEventReplayBeforeFinalDelta(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	sourceSyncedAt := time.Now().UTC()
	deltaStartedAt := sourceSyncedAt.Add(5 * time.Minute)
	completedAt := deltaStartedAt.Add(2 * time.Minute)
	deltaMode := runModeDeltaImport
	deltaStartedAtValue := deltaStartedAt.Format(time.RFC3339Nano)
	sourceSyncedAtValue := sourceSyncedAt.Format(time.RFC3339Nano)
	job := activeCampaignAcceptedJob("ac-source-event-clean-before-delta", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:             &deltaMode,
		deltaImportStartedAtKey:      &deltaStartedAtValue,
		sourceEventPreDeltaSyncedKey: &sourceSyncedAtValue,
	}
	markRollbackRehearsalPassed(job, completedAt.Add(time.Minute))
	markActiveCampaignDeliverabilityReviewed(job, completedAt.Add(time.Minute))
	overlapStartedAt := deltaStartedAt.Add(-activeCampaignMinimumSourceEventOverlap - time.Minute)
	markSourceEventOverlapSnapshot(job, sourceEventOverlapSnapshotV1{
		Version:             1,
		EnabledSince:        overlapStartedAt,
		FirstSuccessfulSync: overlapStartedAt.Add(time.Minute),
		PreDeltaSyncedAt:    sourceSyncedAt,
		IntervalSeconds:     300,
		SuccessfulSyncs:     2017,
		MaxSyncGapSeconds:   300,
		CapturedAt:          deltaStartedAt,
	})
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
	})
	store.SetClock(func() time.Time { return overlapStartedAt })
	saveSourceEventAcceptanceFixture(t, store, job, sourceSyncedAt, true, 2, 2)

	got := getPilotAcceptanceFixture(t, store, job.ID)
	item := pilotItemByKey(got, "activecampaign_source_event_replay")
	if item.Status != "pass" {
		t.Fatalf("source-event item = %+v, want pass", item)
	}
	if !strings.Contains(item.Detail, "required continuous overlap") {
		t.Fatalf("source-event detail = %q, want continuous overlap evidence", item.Detail)
	}
	if got.Status != "blocker" {
		t.Fatalf("report status = %q, want fail-closed blocker without a live Postgres ledger: %#v", got.Status, got.Items)
	}
	if item := pilotItemByKey(got, "rollback_rehearsal"); item.Status != "blocker" || !strings.Contains(item.Detail, "Postgres imported-resource ledger") {
		t.Fatalf("rollback rehearsal item = %+v, want live-ledger blocker", item)
	}
}

func TestActiveCampaignSourceEventReplayRequiresContinuousEnabledOverlap(t *testing.T) {
	sourceSyncedAt := time.Now().UTC()
	deltaStartedAt := sourceSyncedAt.Add(5 * time.Minute)
	completedAt := deltaStartedAt.Add(2 * time.Minute)
	deltaMode := runModeDeltaImport
	deltaStartedAtValue := deltaStartedAt.Format(time.RFC3339Nano)
	sourceSyncedAtValue := sourceSyncedAt.Format(time.RFC3339Nano)
	job := activeCampaignAcceptedJob("ac-source-event-continuous-overlap", completedAt)
	job.Cursor = map[string]*string{
		runModeCursorKey:             &deltaMode,
		deltaImportStartedAtKey:      &deltaStartedAtValue,
		sourceEventPreDeltaSyncedKey: &sourceSyncedAtValue,
	}

	for _, tc := range []struct {
		name     string
		enabled  bool
		snapshot *sourceEventOverlapSnapshotV1
		want     string
	}{
		{
			name:    "disabled before final delta has no snapshot",
			enabled: false,
			want:    "did not capture durable continuous source-event overlap evidence",
		},
		{
			name:    "enabled for only one immediate sync",
			enabled: true,
			snapshot: &sourceEventOverlapSnapshotV1{
				Version:             1,
				EnabledSince:        deltaStartedAt.Add(-7 * time.Minute),
				FirstSuccessfulSync: deltaStartedAt.Add(-6 * time.Minute),
				PreDeltaSyncedAt:    sourceSyncedAt,
				IntervalSeconds:     300,
				SuccessfulSyncs:     1,
				CapturedAt:          deltaStartedAt,
			},
			want: "required seven-day continuous successful overlap",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			monitor := &jobstore.SourceEventMonitorRecord{
				Enabled:         tc.enabled,
				IntervalSeconds: 300,
				LastSyncedAt:    &sourceSyncedAt,
			}
			if tc.snapshot != nil {
				markSourceEventOverlapSnapshot(job, *tc.snapshot)
			} else {
				delete(job.Cursor, sourceEventOverlapSnapshotKey)
			}
			item := activeCampaignSourceEventReplayAcceptanceItem(job, monitor, nil, nil, true)
			if item.Status != "blocker" || !strings.Contains(item.Detail, tc.want) {
				t.Fatalf("source-event item = %+v, want blocker containing %q", item, tc.want)
			}
		})
	}
}

func TestBuildPilotAcceptanceReportActiveCampaignBlocksOnDiscoveryWarnings(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "job-ac-warnings",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			ArchiveDone:     5,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			DiscoveryWarnings: []string{
				"activecampaign forms count unavailable",
			},
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
			},
		},
	}
	report := BuildPilotAcceptanceReport(job)
	if report.Status != "blocker" {
		t.Fatalf("status = %q, want blocker: %#v", report.Status, report.Items)
	}
	byKey := map[string]PilotAcceptanceItem{}
	for _, item := range report.Items {
		byKey[item.Key] = item
	}
	item, ok := byKey["source_discovery_warnings"]
	if !ok {
		t.Fatalf("missing source_discovery_warnings item")
	}
	if item.Status != "blocker" {
		t.Fatalf("discovery warning status = %q, want blocker", item.Status)
	}
	if len(item.Evidence) != 1 || item.Evidence[0] != "activecampaign forms count unavailable" {
		t.Fatalf("evidence = %#v, want discovery warning", item.Evidence)
	}
}

func TestBuildPilotAcceptanceReportBlocksOnSourceArchiveWarnings(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "job-ac-archive-warnings",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 1,
			ConsentKnown:        1,
			SourceArchiveWarnings: []canonical.ResourceWarning{{
				Resource: "activecampaign_form",
				SourceID: "source_archive_warning:forms",
				Name:     "forms",
				Warning:  "forms source archive unavailable: activecampaign status 403",
			}, {
				Resource: "activecampaign_custom_field",
				SourceID: "source_archive_warning:fields",
				Name:     "fields",
				Warning:  "fields source archive unavailable: activecampaign status 403",
			}, {
				Resource: "activecampaign_tag",
				SourceID: "source_archive_warning:tags",
				Name:     "tags",
				Warning:  "tags source archive unavailable: activecampaign status 403",
			}},
		},
	}
	report := BuildPilotAcceptanceReport(job)
	if report.Status != "blocker" {
		t.Fatalf("status = %q, want blocker: %#v", report.Status, report.Items)
	}
	byKey := map[string]PilotAcceptanceItem{}
	for _, item := range report.Items {
		byKey[item.Key] = item
	}
	item, ok := byKey["source_archive_warnings"]
	if !ok {
		t.Fatalf("missing source_archive_warnings item")
	}
	if item.Status != "blocker" {
		t.Fatalf("source archive warning status = %q, want blocker", item.Status)
	}
	wantEvidence := []string{
		"forms: forms source archive unavailable: activecampaign status 403",
		"fields: fields source archive unavailable: activecampaign status 403",
		"tags: tags source archive unavailable: activecampaign status 403",
	}
	if !reflect.DeepEqual(item.Evidence, wantEvidence) {
		t.Fatalf("evidence = %#v, want source archive warning", item.Evidence)
	}
}

func TestBuildPilotAcceptanceReportMailchimpCutoverGates(t *testing.T) {
	rollbackUntil := time.Now().UTC().Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "job-mailchimp",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone: 2,
			ArchiveDone:     1,
			SegmentsDone:    1,
			TemplatesDone:   1,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported:        2,
			ConsentKnown:               2,
			DuplicateSubscribersMerged: 1,
			SubscriberMergeConflicts: []canonical.SubscriberMergeConflict{{
				Email:          "shared@example.com",
				SourceIDs:      []string{"list:a:member:1", "list:b:member:9"},
				ConflictFields: []string{"PLAN"},
			}},
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 2, Imported: 2, Supported: true, Status: "imported"},
				{Resource: "groups", Label: "Groups", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported"},
				{Resource: "segments", Label: "Segments", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported"},
				{Resource: "templates", Label: "Templates", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported"},
				{Resource: "automations", Label: "Automations", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported"},
			},
			TemplateWarnings: []canonical.ResourceWarning{{
				Resource: "template",
				SourceID: "tpl_1",
				Name:     "Digest",
				Warning:  "template HTML was absent",
			}},
			CampaignArchiveWarnings: []canonical.ResourceWarning{{
				Resource: "campaign_archive",
				SourceID: "camp_1",
				Name:     "Launch",
				Warning:  "email_activity fetch failed",
			}},
		},
	}
	report := BuildPilotAcceptanceReport(job)
	if report.Status != "blocker" {
		t.Fatalf("status = %q, want blocker: %#v", report.Status, report.Items)
	}
	byKey := map[string]PilotAcceptanceItem{}
	for _, item := range report.Items {
		byKey[item.Key] = item
	}
	if byKey["mailchimp_audience_merges"].Status != "warning" {
		t.Fatalf("audience merge status = %q, want warning", byKey["mailchimp_audience_merges"].Status)
	}
	if byKey["mailchimp_template_render_review"].Status != "blocker" {
		t.Fatalf("template status = %q, want blocker", byKey["mailchimp_template_render_review"].Status)
	}
	if byKey["mailchimp_campaign_report_fidelity"].Status != "warning" {
		t.Fatalf("campaign status = %q, want warning", byKey["mailchimp_campaign_report_fidelity"].Status)
	}
	if byKey["mailchimp_paused_surface_review"].Status != "warning" {
		t.Fatalf("paused surface status = %q, want warning", byKey["mailchimp_paused_surface_review"].Status)
	}
	if byKey["mailchimp_deliverability_review"].Status != "warning" {
		t.Fatalf("deliverability status = %q, want warning", byKey["mailchimp_deliverability_review"].Status)
	}
}

func ptrTime(t time.Time) *time.Time {
	return &t
}

func activeCampaignAcceptedJob(id string, completedAt time.Time) *canonical.MigrationJob {
	rollbackUntil := completedAt.Add(24 * time.Hour)
	return &canonical.MigrationJob{
		ID:            id,
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			ArchiveDone:     5,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Lists and tags", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 5, Imported: 5, Supported: true, Status: "imported_runtime"},
			},
		},
	}
}

func hubSpotAcceptedJob(id string, completedAt time.Time) *canonical.MigrationJob {
	rollbackUntil := completedAt.Add(24 * time.Hour)
	return &canonical.MigrationJob{
		ID:            id,
		TenantID:      "tenant_a",
		Source:        canonical.SourceHubSpot,
		Status:        canonical.MigCompleted,
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Progress: canonical.MigrationProgress{
			SubscribersDone: 10,
			SegmentsDone:    3,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 10,
			ConsentKnown:        10,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "HubSpot contacts", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "groups", Label: "Contact properties", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "communication_preferences", Label: "HubSpot email communication preferences", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "email_eligibility", Label: "HubSpot current-primary-email eligibility", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
				{Resource: "lists", Label: "HubSpot lists/segments", SourceTotal: 3, Imported: 3, Supported: true, Status: "imported_runtime"},
				{Resource: "crm", Label: "HubSpot CRM", SourceTotal: 10, Imported: 10, Supported: true, Status: "imported_runtime"},
			},
		},
	}
}

func bindHubSpotPilotShadowBaseline(t *testing.T, job *canonical.MigrationJob) (string, string) {
	t.Helper()
	components := map[string]orchestrator.HubSpotSourceFingerprintComponent{
		"subscribers":                 {Count: 10},
		"profiles_without_email":      {Count: 0},
		"additional_email_identities": {Count: 0},
		"segments":                    {Count: 3},
		"contact_properties":          {Count: 3},
	}
	for name, component := range components {
		digest := sha256.Sum256([]byte("hubspot-pilot-component-v1\x00" + name + "\x00" + job.ID))
		component.Digest = hex.EncodeToString(digest[:])
		components[name] = component
	}
	componentJSON, err := json.Marshal(components)
	if err != nil {
		t.Fatalf("marshal HubSpot pilot fingerprint components: %v", err)
	}
	digest := sha256.Sum256(append([]byte("postwave-hubspot-source-v1\x00"), componentJSON...))
	fingerprint := orchestrator.HubSpotSourceFingerprint{
		Version:    1,
		Digest:     hex.EncodeToString(digest[:]),
		Components: components,
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		t.Fatalf("marshal HubSpot pilot fingerprint: %v", err)
	}
	epochDigest := sha256.Sum256([]byte("hubspot-pilot-import-epoch-v1\x00" + job.ID))
	epoch := hex.EncodeToString(epochDigest[:])
	value := string(raw)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	job.Cursor["__postwave_hubspot_source_fingerprint"] = &value
	job.Cursor["__postwave_hubspot_import_epoch"] = &epoch
	return fingerprint.Digest, epoch
}

func markRollbackRehearsalPassed(job *canonical.MigrationJob, generatedAt time.Time) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	status := "pass"
	at := generatedAt.UTC().Format(time.RFC3339Nano)
	total := "18"
	job.Cursor[rollbackRehearsalStatusKey] = &status
	job.Cursor[rollbackRehearsalAtKey] = &at
	job.Cursor[rollbackRehearsalTotalKey] = &total
	countSource := "imported_resource_ledger"
	job.Cursor[rollbackRehearsalSourceKey] = &countSource
	validation := rollbackRehearsalValidationV1
	job.Cursor[rollbackRehearsalValidationKey] = &validation
}

func TestBuildPilotAcceptanceReportBeehiivRequiresReviewedCutoverEvidence(t *testing.T) {
	commitAt := time.Now().UTC().Add(-10 * time.Minute)
	job := beehiivPilotJob("beehiiv-cutover-gates", commitAt)
	job.VerificationReport.DiscoveryWarnings = []string{"optional publication metadata was unavailable"}
	job.VerificationReport.SourceArchiveWarnings = []canonical.ResourceWarning{{
		Resource: "beehiiv_poll",
		Name:     "polls",
		Warning:  "poll endpoint returned 403",
	}}

	initial := BuildPilotAcceptanceReport(job)
	for _, key := range []string{
		"beehiiv_consent_reconciliation",
		"beehiiv_segment_rules_review",
		beehiivAutomationRetirementReviewKey,
		beehiivWebsiteCaptureReviewKey,
		beehiivBoostsRecommendationsReviewKey,
		beehiivAdNetworkReviewKey,
		"top_automations",
		"beehiiv_final_delta_import",
		"source_archive_warnings",
		"rollback_rehearsal",
	} {
		item := pilotItemByKey(initial, key)
		if item.Status == "pass" {
			t.Fatalf("initial %s item = %+v, want a cutover gate", key, item)
		}
	}

	deltaAt := commitAt.Add(5 * time.Minute)
	markFinalDeltaCompleted(job, deltaAt)
	job.VerificationReport.AutomationRebuilds[0].Status = "test_passed"
	job.VerificationReport.AutomationRebuilds[0].TestEvidence = "trigger replay and test send captured"
	for _, key := range []string{
		"beehiiv_consent_reconciliation",
		"beehiiv_segment_rules_review",
		beehiivAutomationRetirementReviewKey,
		beehiivWebsiteCaptureReviewKey,
		beehiivBoostsRecommendationsReviewKey,
		beehiivAdNetworkReviewKey,
		"source_discovery_warnings",
		"source_archive_warnings",
	} {
		markBeehiivCutoverEvidence(job, key, deltaAt.Add(time.Minute))
	}
	markRollbackRehearsalPassed(job, deltaAt.Add(2*time.Minute))

	accepted := BuildPilotAcceptanceReport(job)
	if accepted.Status != "pass" || accepted.Blockers != 0 || accepted.Warnings != 0 {
		t.Fatalf("accepted Beehiiv report = status %q blockers=%d warnings=%d items=%#v", accepted.Status, accepted.Blockers, accepted.Warnings, accepted.Items)
	}
}

func TestBuildPilotAcceptanceReportBeehiivBillingContinuityRemainsBlocked(t *testing.T) {
	completedAt := time.Now().UTC().Add(-5 * time.Minute)
	job := beehiivPilotJob("beehiiv-paid-blocker", completedAt)
	markFinalDeltaCompleted(job, completedAt.Add(time.Minute))
	job.VerificationReport.AutomationRebuilds[0].Status = "test_passed"
	job.VerificationReport.AutomationRebuilds[0].TestEvidence = "test send captured"
	markBeehiivCutoverEvidence(job, "beehiiv_consent_reconciliation", completedAt.Add(2*time.Minute))
	markBeehiivCutoverEvidence(job, "beehiiv_segment_rules_review", completedAt.Add(2*time.Minute))
	markRollbackRehearsalPassed(job, completedAt.Add(3*time.Minute))
	job.VerificationReport.ResourceCompleteness = append(job.VerificationReport.ResourceCompleteness, canonical.ResourceCompleteness{
		Resource:    "paid_subs",
		Label:       "Stripe billing continuity",
		SourceTotal: 1,
		Imported:    0,
		Supported:   false,
		Status:      "manual_rebuild_required",
	})

	report := BuildPilotAcceptanceReport(job)
	item := pilotItemByKey(report, "unsupported_paid_subs")
	if item.Status != "blocker" || report.Status != "blocker" {
		t.Fatalf("paid continuity item = %+v, report status=%q; want blocker", item, report.Status)
	}
}

func TestBuildPilotAcceptanceReportBeehiivBlocksMissingCampaignHTMLUntilReviewed(t *testing.T) {
	completedAt := time.Now().UTC().Add(-5 * time.Minute)
	job := beehiivPilotJob("beehiiv-campaign-fidelity", completedAt)
	markFinalDeltaCompleted(job, completedAt.Add(time.Minute))
	job.VerificationReport.CampaignArchiveWarnings = []canonical.ResourceWarning{
		{Resource: "campaign_archive", SourceID: "post_ok", Name: "Plain text unavailable", Warning: "Beehiiv does not expose a plain-text rendering for posts; the archived text body is empty."},
		{Resource: "campaign_archive", SourceID: "post_blank", Name: "Blank post", Warning: "No expanded post HTML was returned by Beehiiv."},
	}

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), "beehiiv_campaign_archive_fidelity")
	if item.Status != "blocker" || item.Actual != 1 || !strings.Contains(strings.Join(item.Evidence, "\n"), "No expanded post HTML") {
		t.Fatalf("campaign fidelity item = %+v, want one material HTML blocker", item)
	}
	markBeehiivCutoverEvidence(job, "beehiiv_campaign_archive_fidelity", completedAt.Add(2*time.Minute))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), "beehiiv_campaign_archive_fidelity")
	if item.Status != "pass" {
		t.Fatalf("reviewed campaign fidelity item = %+v, want pass", item)
	}
}

func TestBuildPilotAcceptanceReportBeehiivBlocksIncompleteDefinitionArchives(t *testing.T) {
	job := beehiivPilotJob("beehiiv-definition-coverage", time.Now().UTC().Add(-5*time.Minute))
	incomplete := map[string]canonical.ResourceCompleteness{
		"segment_definitions":         {Resource: "segment_definitions", Label: "Segments", SourceTotal: 3, Imported: 2, Supported: true, Status: "preserved_for_rebuild"},
		"custom_field_schema":         {Resource: "custom_field_schema", Label: "Fields", SourceTotal: 2, Imported: 1, Supported: true, Status: "partial"},
		"newsletter_list_definitions": {Resource: "newsletter_list_definitions", Label: "List definitions", SourceTotal: 4, Imported: 3, Supported: true, Status: "partial"},
		"newsletter_list_history":     {Resource: "newsletter_list_history", Label: "Lists", SourceTotal: 4, Imported: 3, Supported: true, Status: "partial"},
		"automation_email_inventory":  {Resource: "automation_email_inventory", Label: "Automation emails", SourceTotal: 1, Imported: 0, Supported: true, Status: "partial"},
	}
	for i, row := range job.VerificationReport.ResourceCompleteness {
		if replacement, ok := incomplete[row.Resource]; ok {
			job.VerificationReport.ResourceCompleteness[i] = replacement
		}
	}
	report := BuildPilotAcceptanceReport(job)
	for _, key := range []string{
		"beehiiv_segment_definitions_coverage",
		"beehiiv_custom_field_schema_coverage",
		"beehiiv_newsletter_list_definitions_coverage",
		"beehiiv_newsletter_list_history_coverage",
		"beehiiv_automation_email_inventory_coverage",
	} {
		item := pilotItemByKey(report, key)
		if item.Status != "blocker" || item.Expected-item.Actual != 1 {
			t.Fatalf("%s item = %+v, want exact-coverage blocker", key, item)
		}
	}
}

func TestBuildPilotAcceptanceReportBeehiivParityGapsRequirePostDeltaEvidenceAndDurableMarker(t *testing.T) {
	completedAt := time.Now().UTC().Add(-5 * time.Minute)
	job := beehiivPilotJob("beehiiv-parity-reviews", completedAt)
	markFinalDeltaCompleted(job, completedAt.Add(time.Minute))

	for _, key := range []string{beehiivWebsiteCaptureReviewKey, beehiivBoostsRecommendationsReviewKey, beehiivAdNetworkReviewKey} {
		item := pilotItemByKey(BuildPilotAcceptanceReport(job), key)
		if item.Status != "blocker" {
			t.Fatalf("unreviewed %s item = %+v, want blocker", key, item)
		}
		markBeehiivCutoverEvidence(job, key, completedAt.Add(2*time.Minute))
		item = pilotItemByKey(BuildPilotAcceptanceReport(job), key)
		if item.Status != "pass" {
			t.Fatalf("reviewed %s item = %+v, want pass", key, item)
		}
	}

	for i := range job.VerificationReport.ResourceCompleteness {
		if job.VerificationReport.ResourceCompleteness[i].Resource == "beehiiv_ad_network_rebuild" {
			job.VerificationReport.ResourceCompleteness[i].Imported = 0
			break
		}
	}
	item := pilotItemByKey(BuildPilotAcceptanceReport(job), beehiivAdNetworkReviewKey)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "parity-gap record") {
		t.Fatalf("reviewed item without durable marker = %+v, want unwaivable archive blocker", item)
	}
}

func TestBuildPilotAcceptanceReportBeehiivMissingRequiredArchiveCoverageFailsClosed(t *testing.T) {
	job := beehiivPilotJob("beehiiv-legacy-coverage", time.Now().UTC().Add(-5*time.Minute))
	filtered := make([]canonical.ResourceCompleteness, 0, len(job.VerificationReport.ResourceCompleteness))
	for _, row := range job.VerificationReport.ResourceCompleteness {
		if row.Resource != "automation_email_inventory" {
			filtered = append(filtered, row)
		}
	}
	job.VerificationReport.ResourceCompleteness = filtered
	item := pilotItemByKey(BuildPilotAcceptanceReport(job), "beehiiv_automation_email_inventory_coverage")
	if item.Status != "blocker" || !strings.Contains(item.Detail, "predates required Beehiiv archive coverage") {
		t.Fatalf("missing required coverage item = %+v, want legacy-report blocker", item)
	}
}

func TestBuildPilotAcceptanceReportBeehiivInvalidatesEvidenceAfterNewFinalDelta(t *testing.T) {
	commitAt := time.Now().UTC().Add(-10 * time.Minute)
	job := beehiivPilotJob("beehiiv-stale-evidence", commitAt)
	firstDeltaAt := commitAt.Add(2 * time.Minute)
	markFinalDeltaCompleted(job, firstDeltaAt)
	markBeehiivCutoverEvidence(job, "beehiiv_consent_reconciliation", firstDeltaAt.Add(time.Minute))
	markFinalDeltaCompleted(job, firstDeltaAt.Add(2*time.Minute))

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), "beehiiv_consent_reconciliation")
	if item.Status != "blocker" || !strings.Contains(item.Detail, "after the latest successful final delta") {
		t.Fatalf("stale Beehiiv evidence item = %+v, want latest-delta blocker", item)
	}
}

func TestUpdateCutoverEvidencePersistsBeehiivReviewAndRejectsPreDeltaPass(t *testing.T) {
	for _, test := range []struct {
		name       string
		finalDelta bool
		wantStatus int
	}{
		{name: "after final delta", finalDelta: true, wantStatus: http.StatusOK},
		{name: "before final delta", finalDelta: false, wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := jobstore.NewMemoryJobStore()
			completedAt := time.Now().UTC().Add(-5 * time.Minute)
			job := beehiivPilotJob("beehiiv-review-"+strings.ReplaceAll(test.name, " ", "-"), completedAt)
			if test.finalDelta {
				markFinalDeltaCompleted(job, completedAt.Add(time.Minute))
			}
			if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
				t.Fatalf("create: %v", err)
			}
			h := NewMigration("", store)
			router := chi.NewRouter()
			h.Mount(router)
			body := bytes.NewBufferString(`{"key":"beehiiv_consent_reconciliation","status":"pass","detail":"Consent and suppressions reviewed after final delta.","evidence":["CONSENT-42"]}`)
			req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", body)
			req.Header.Set("X-Tenant-ID", job.TenantID)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, test.wantStatus, rec.Body.String())
			}
			stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
			if err != nil {
				t.Fatalf("get stored job: %v", err)
			}
			statusKey, _, _, evidenceKey := beehiivCutoverEvidenceCursorKeys("beehiiv_consent_reconciliation")
			status, present := cursorString(stored.Cursor, statusKey)
			if !test.finalDelta {
				if present {
					t.Fatalf("pre-delta evidence was persisted with status %q", status)
				}
				return
			}
			if !present || status != "pass" {
				t.Fatalf("stored Beehiiv evidence status = %q/%t, want pass/true", status, present)
			}
			if evidence, ok := cursorString(stored.Cursor, evidenceKey); !ok || !strings.Contains(evidence, "CONSENT-42") {
				t.Fatalf("stored Beehiiv evidence = %q/%t, want review reference", evidence, ok)
			}
		})
	}
}

func beehiivPilotJob(id string, completedAt time.Time) *canonical.MigrationJob {
	rollbackUntil := completedAt.Add(24 * time.Hour)
	return &canonical.MigrationJob{
		ID:            id,
		TenantID:      "tenant_beehiiv",
		Source:        canonical.SourceBeehiiv,
		Status:        canonical.MigCompleted,
		CompletedAt:   ptrTime(completedAt),
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 2,
			SegmentsDone:    1,
			ArchiveDone:     1,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 2,
			ConsentUnknown:      2,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Subscribers", SourceTotal: 2, Imported: 2, Supported: true, Status: "imported_runtime"},
				{Resource: "segments", Label: "Segments", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "segment_definitions", Label: "Segment definitions", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "condition_set_archive", Label: "Condition-set archive", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "condition_set_rules", Label: "Condition-set rules", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "custom_field_schema", Label: "Custom fields", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "newsletter_list_definitions", Label: "Newsletter lists", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "newsletter_list_history", Label: "Newsletter history", SourceTotal: 0, Imported: 0, Supported: true, Status: "not_detected"},
				{Resource: "campaigns", Label: "Campaigns", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "automations", Label: "Automations", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "automation_email_inventory", Label: "Automation emails", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "automation_journey_inventory", Label: "Automation journeys", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "beehiiv_website_capture_rebuild", Label: "Website", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "beehiiv_boosts_recommendations_rebuild", Label: "Boosts", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "beehiiv_ad_network_rebuild", Label: "Ad Network", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
			},
			AutomationsUnsupported: []canonical.AutomationUnsupported{{Name: "Welcome series", Reason: "Beehiiv does not expose the executable graph"}},
			AutomationRebuilds:     []canonical.AutomationRebuildItem{{Rank: 1, Name: "Welcome series", Status: "pending"}},
		},
	}
}

func markBeehiivCutoverEvidence(job *canonical.MigrationJob, key string, reviewedAt time.Time) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	status := "pass"
	at := reviewedAt.UTC().Format(time.RFC3339Nano)
	detail := "Owner reviewed this Beehiiv cutover surface after final delta."
	rawEvidence, _ := json.Marshal([]string{"review recorded"})
	evidence := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := beehiivCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &at
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidence
}

func markFinalDeltaCompleted(job *canonical.MigrationJob, completedAt time.Time) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	mode := runModeDeltaImport
	startedAt := completedAt.Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	preDeltaSyncedAt := completedAt.Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
	job.Cursor[runModeCursorKey] = &mode
	job.Cursor[deltaImportStartedAtKey] = &startedAt
	job.Cursor[sourceEventPreDeltaSyncedKey] = &preDeltaSyncedAt
	completed := completedAt.UTC()
	job.CompletedAt = &completed
	job.Status = canonical.MigCompleted
}

func markSourceEventOverlapSnapshot(job *canonical.MigrationJob, snapshot sourceEventOverlapSnapshotV1) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	raw, _ := json.Marshal(snapshot)
	encoded := string(raw)
	job.Cursor[sourceEventOverlapSnapshotKey] = &encoded
}

func markPostPilotCleanupAuthorized(job *canonical.MigrationJob, reviewedAt time.Time) {
	if job == nil || job.CompletedAt == nil {
		return
	}
	markFinalDeltaCompleted(job, *job.CompletedAt)
	markSourceEventOverlapSnapshot(job, sourceEventOverlapSnapshotV1{
		Version:             1,
		EnabledSince:        job.CompletedAt.Add(-8 * 24 * time.Hour),
		FirstSuccessfulSync: job.CompletedAt.Add(-8 * 24 * time.Hour),
		PreDeltaSyncedAt:    job.CompletedAt.Add(-2 * time.Minute),
		IntervalSeconds:     300,
		SuccessfulSyncs:     100,
		MaxSyncGapSeconds:   300,
		CapturedAt:          job.CompletedAt.Add(-time.Minute),
	})
	markActiveCampaignCutoverEvidence(job, activeCampaignPostPilotCleanupEvidenceKey, reviewedAt)
}

func rollbackItemByKey(report RollbackRehearsalReport, key string) RollbackRehearsalItem {
	for _, item := range report.Items {
		if item.Key == key {
			return item
		}
	}
	return RollbackRehearsalItem{}
}

func markActiveCampaignDeliverabilityReviewed(job *canonical.MigrationJob, generatedAt time.Time) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	markActiveCampaignConsentExclusionReviewed(job, generatedAt)
	markActiveCampaignCutoverEvidence(job, activeCampaignDeliverabilityReviewKey, generatedAt)
	status := "pass"
	at := generatedAt.UTC().Format(time.RFC3339Nano)
	detail := "Domains, tracking links, suppression policy, forms, and webhooks reviewed after final delta."
	rawEvidence, _ := json.Marshal([]string{"domains verified", "tracking links verified"})
	evidence := string(rawEvidence)
	job.Cursor[acDeliverabilityStatusKey] = &status
	job.Cursor[acDeliverabilityAtKey] = &at
	job.Cursor[acDeliverabilityDetailKey] = &detail
	job.Cursor[acDeliverabilityEvidenceKey] = &evidence
}

func markActiveCampaignConsentExclusionReviewed(job *canonical.MigrationJob, generatedAt time.Time) {
	markActiveCampaignCutoverEvidence(job, activeCampaignConsentExclusionReviewKey, generatedAt)
}

func markActiveCampaignCutoverEvidence(job *canonical.MigrationJob, key string, generatedAt time.Time) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	status := "pass"
	at := generatedAt.UTC().Format(time.RFC3339Nano)
	detail := "Owner reviewed this ActiveCampaign cutover surface after final delta."
	rawEvidence, _ := json.Marshal([]string{"review recorded"})
	evidence := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := activeCampaignCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &at
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidence
}

func saveShadowAcceptanceFixture(t *testing.T, store *jobstore.MemoryJobStore, job *canonical.MigrationJob, shadow shadowCheckResponse) {
	t.Helper()
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	token, found, tokenErr := shadowAttemptTokenFromJob(job)
	if tokenErr != nil {
		t.Fatalf("load shadow attempt fixture token: %v", tokenErr)
	}
	if !found {
		digest := sha256.Sum256([]byte("shadow-attempt-fixture\x00" + job.ID))
		token = hex.EncodeToString(digest[:])
		job.Cursor[shadowAttemptTokenCursorKey] = &token
	}
	if shadow.AttemptToken == "" {
		shadow.AttemptToken = token
	}
	if err := store.Update(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("persist shadow attempt fixture token: %v", err)
	}
	if shadow.CurrentDiscovery == nil {
		shadow.CurrentDiscovery = map[string]int{}
	}
	if shadow.Deltas == nil {
		shadow.Deltas = []shadowResourceDelta{}
	}
	snapshot, err := json.Marshal(shadow)
	if err != nil {
		t.Fatalf("marshal shadow: %v", err)
	}
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.ShadowCheckRecord{
		JobID:             job.ID,
		TenantID:          job.TenantID,
		Source:            job.Source,
		GeneratedAt:       shadow.GeneratedAt,
		NeedsDeltaImport:  shadow.NeedsDeltaImport,
		RecommendedAction: shadow.RecommendedAction,
		Snapshot:          snapshot,
	}); err != nil {
		t.Fatalf("save shadow check: %v", err)
	}
}

func saveSourceEventAcceptanceFixture(t *testing.T, store *jobstore.MemoryJobStore, job *canonical.MigrationJob, syncedAt time.Time, enabled bool, seen, applied int) {
	t.Helper()
	nextSync := syncedAt.Add(5 * time.Minute)
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          job.Source,
		Enabled:         true,
		IntervalSeconds: 300,
	}); err != nil {
		t.Fatalf("upsert source-event monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		&syncedAt,
		syncedAt,
		nextSync,
		seen,
		applied,
		"",
	); err != nil {
		t.Fatalf("update source-event monitor: %v", err)
	}
	if !enabled {
		if err := store.DisableSourceEventMonitor(
			jobstore.WithTenantID(context.Background(), job.TenantID),
			job.TenantID,
			job.ID,
		); err != nil {
			t.Fatalf("disable source-event monitor: %v", err)
		}
	}
	if seen > 0 {
		if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventRecord{
			ID:            "ser_clean_" + job.ID,
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        job.Source,
			SourceEventID: string(job.Source) + ":contact:clean",
			ResourceType:  "subscriber",
			Action:        "upsert",
			OccurredAt:    &syncedAt,
			Applied:       true,
		}); err != nil {
			t.Fatalf("save source-event result: %v", err)
		}
	}
}

func getPilotAcceptanceFixture(t *testing.T, store *jobstore.MemoryJobStore, jobID string) PilotAcceptanceReport {
	t.Helper()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/pilot-acceptance", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got PilotAcceptanceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got
}

func assertActiveCampaignEvidenceRedacted(t *testing.T, evidence []string) {
	t.Helper()
	joined := strings.Join(evidence, "\n")
	for _, leaked := range []string{"tenant.activehosted.com", "secret-token", "activecampaign:contact:42", "last_id=42", "ada@example.com"} {
		if strings.Contains(joined, leaked) {
			t.Fatalf("evidence leaked %q: %#v", leaked, evidence)
		}
	}
	for _, marker := range []string{"[redacted-activecampaign-api-url]", "Api-Token=[redacted]", "[redacted-activecampaign-source-event-id]", "last_id=[redacted]", "contact [redacted-activecampaign-contact] missing"} {
		if !strings.Contains(joined, marker) {
			t.Fatalf("evidence = %#v, want marker %q", evidence, marker)
		}
	}
}

func pilotItemByKey(report PilotAcceptanceReport, key string) PilotAcceptanceItem {
	for _, item := range report.Items {
		if item.Key == key {
			return item
		}
	}
	return PilotAcceptanceItem{}
}
