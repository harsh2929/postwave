package handlers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/migrate/canonical"
)

func TestCustomerIOPilotRequiresAllSixPostDeltaReviews(t *testing.T) {
	job := customerIOPilotJob()
	report := BuildPilotAcceptanceReport(job)
	keys := customerIOPilotEvidenceKeys()
	consent := pilotItemByKey(report, customerIOConsentSubscriptionReviewKey)
	for _, expected := range []string{
		"global state is subscribed",
		"email-channel state is subscribed explicitly or by configured default",
		"applicable topic is subscribed explicitly or by configured default",
		"/v1/optouts contains separate sender-specific SMS/WhatsApp evidence",
	} {
		if !strings.Contains(consent.Detail, expected) {
			t.Fatalf("consent review detail %q does not explain %q", consent.Detail, expected)
		}
	}
	for _, key := range keys {
		item := pilotItemByKey(report, key)
		if item.Key == "" || item.Status != "blocker" {
			t.Fatalf("initial %s = %+v, want blocker", key, item)
		}
	}
	if item := pilotItemByKey(report, "consent_reconciliation"); item.Key != "" {
		t.Fatalf("generic consent gate must not replace Customer.io review: %+v", item)
	}

	reviewedAt := job.CompletedAt.Add(time.Second)
	for _, key := range keys {
		setCustomerIOPilotEvidence(t, job, key, "pass", reviewedAt)
	}
	report = BuildPilotAcceptanceReport(job)
	for _, key := range keys {
		item := pilotItemByKey(report, key)
		if item.Status != "pass" {
			t.Fatalf("post-delta %s = %+v, want pass", key, item)
		}
	}
}

func TestCustomerIOPilotRejectsStaleOrIncompleteEvidence(t *testing.T) {
	job := customerIOPilotJob()
	for _, key := range customerIOPilotEvidenceKeys() {
		setCustomerIOPilotEvidence(t, job, key, "pass", job.CompletedAt.Add(-time.Second))
	}
	report := BuildPilotAcceptanceReport(job)
	for _, key := range customerIOPilotEvidenceKeys() {
		if item := pilotItemByKey(report, key); item.Status != "blocker" {
			t.Fatalf("stale %s = %+v, want blocker", key, item)
		}
	}

	for _, key := range customerIOPilotEvidenceKeys() {
		setCustomerIOPilotEvidence(t, job, key, "pass", job.CompletedAt.Add(time.Second))
	}
	for index := range job.VerificationReport.ResourceCompleteness {
		if job.VerificationReport.ResourceCompleteness[index].Resource == "source_archive" {
			job.VerificationReport.ResourceCompleteness[index].Imported--
		}
	}
	report = BuildPilotAcceptanceReport(job)
	for _, key := range customerIOPilotEvidenceKeys() {
		item := pilotItemByKey(report, key)
		if item.Status != "blocker" {
			t.Fatalf("incomplete exact snapshot %s = %+v, want blocker", key, item)
		}
	}
}

func TestCustomerIOPilotRejectsIncompleteEditableTemplateSnapshot(t *testing.T) {
	job := customerIOPilotJob()
	for _, key := range customerIOPilotEvidenceKeys() {
		setCustomerIOPilotEvidence(t, job, key, "pass", job.CompletedAt.Add(time.Second))
	}
	for index := range job.VerificationReport.ResourceCompleteness {
		if job.VerificationReport.ResourceCompleteness[index].Resource == "templates" {
			job.VerificationReport.ResourceCompleteness[index].Imported--
		}
	}

	report := BuildPilotAcceptanceReport(job)
	for _, key := range customerIOPilotEvidenceKeys() {
		item := pilotItemByKey(report, key)
		if item.Status != "blocker" {
			t.Fatalf("incomplete editable-template snapshot %s = %+v, want blocker", key, item)
		}
		if !strings.Contains(strings.Join(item.Evidence, "\n"), "editable-template") {
			t.Fatalf("incomplete editable-template snapshot %s evidence = %#v", key, item.Evidence)
		}
	}
}

func TestCustomerIOPilotRequiresFreshLedgerBackedRollbackRehearsal(t *testing.T) {
	job := customerIOPilotJob()
	rollbackUntil := job.CompletedAt.Add(defaultMigrationRollbackWindow)
	job.RollbackUntil = &rollbackUntil

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), "rollback_rehearsal")
	if item.Status != "blocker" || item.Actual != 0 {
		t.Fatalf("rollback rehearsal without evidence = %+v, want blocker", item)
	}
	if item.Detail != "Run rollback rehearsal after the latest Customer.io final delta import and preserve the rehearsal evidence before cutover." {
		t.Fatalf("rollback rehearsal detail = %q", item.Detail)
	}

	markRollbackRehearsalPassed(job, job.CompletedAt.Add(time.Second))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), "rollback_rehearsal")
	if item.Status != "pass" {
		t.Fatalf("fresh ledger-backed rollback rehearsal = %+v, want pass", item)
	}

	delete(job.Cursor, rollbackRehearsalValidationKey)
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), "rollback_rehearsal")
	if item.Status != "blocker" || !strings.Contains(item.Detail, "conflict-checked") {
		t.Fatalf("legacy count-only rollback rehearsal = %+v, want conflict-validation blocker", item)
	}

	markRollbackRehearsalPassed(job, job.CompletedAt.Add(-time.Second))
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), "rollback_rehearsal")
	if item.Status != "blocker" {
		t.Fatalf("stale rollback rehearsal = %+v, want blocker", item)
	}
}

func TestCustomerIOExpectedWarningsResolveOnlyThroughAllSixFreshReviews(t *testing.T) {
	job := customerIOPilotJob()
	job.VerificationReport.DiscoveryWarnings = []string{
		"Customer.io creation timestamps are provenance, not opt-in proof.",
		"Customer.io segment rules require manual rebuild.",
	}
	job.VerificationReport.SourceArchiveWarnings = []canonical.ResourceWarning{{
		Resource: "customerio_campaign_workflow",
		SourceID: "customerio:campaign:42",
		Name:     "Welcome",
		Warning:  "Workflow metadata is rebuild-only evidence.",
	}}

	for _, key := range []string{"source_discovery_warnings", "source_archive_warnings"} {
		if item := pilotItemByKey(BuildPilotAcceptanceReport(job), key); item.Status != "blocker" {
			t.Fatalf("%s before reviews = %+v, want blocker", key, item)
		}
	}

	reviewedAt := job.CompletedAt.Add(time.Second)
	for _, key := range customerIOPilotEvidenceKeys() {
		setCustomerIOPilotEvidence(t, job, key, "pass", reviewedAt)
	}
	for _, key := range []string{"source_discovery_warnings", "source_archive_warnings"} {
		item := pilotItemByKey(BuildPilotAcceptanceReport(job), key)
		if item.Status != "pass" {
			t.Fatalf("%s after all six reviews = %+v, want pass", key, item)
		}
		if len(item.Evidence) < len(customerIOPilotEvidenceKeys()) {
			t.Fatalf("%s evidence = %#v, want six review bindings", key, item.Evidence)
		}
	}
}

func customerIOPilotJob() *canonical.MigrationJob {
	completedAt := time.Now().UTC().Add(-time.Minute)
	mode := runModeDeltaImport
	return &canonical.MigrationJob{
		ID:          "customerio-pilot",
		TenantID:    "tenant_a",
		Source:      canonical.SourceCustomerIO,
		Status:      canonical.MigCompleted,
		StartedAt:   completedAt.Add(-time.Hour),
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
		Progress: canonical.MigrationProgress{
			SubscribersDone:   2,
			SegmentsDone:      2,
			TemplatesDone:     1,
			ArchiveDone:       1,
			SourceArchiveDone: 8,
		},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported:   2,
			ConsentUnknown:        2,
			SuppressionListSize:   1,
			SegmentsTranslated:    2,
			TemplatesImported:     1,
			ArchiveImported:       1,
			SourceArchiveImported: 8,
			ResourceCompleteness: []canonical.ResourceCompleteness{
				{Resource: "subscribers", Label: "Profiles", SourceTotal: 2, Imported: 2, Supported: true, Status: "imported_runtime"},
				{Resource: "segments", Label: "Audiences", SourceTotal: 2, Imported: 2, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "campaigns", Label: "Newsletters", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "source_archive", Label: "Source archive", SourceTotal: 8, Imported: 8, Supported: true, Status: "imported_runtime"},
				{Resource: "non_email_profiles", Label: "Non-email profiles", SourceTotal: 1, Imported: 0, Status: "manual_rebuild_required"},
				{Resource: "subscription_topics", Label: "Topics", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "workflow_definitions", Label: "Workflows", SourceTotal: 2, Imported: 2, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "transactional", Label: "Transactional", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "templates", Label: "Templates", SourceTotal: 1, Imported: 1, Supported: true, Status: "imported_runtime"},
				{Resource: "structured_templates", Label: "Structured templates", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "consent_exclusions", Label: "Suppressions", SourceTotal: 2, Imported: 2, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "channel_dependencies", Label: "Channels", SourceTotal: 2, Imported: 1, Status: "manual_rebuild_required"},
				{Resource: "custom_objects", Label: "Objects", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "deliverability", Label: "Deliverability", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
				{Resource: "ecosystem", Label: "Ecosystem", SourceTotal: 1, Imported: 1, Supported: true, Status: "preserved_for_rebuild"},
			},
		},
	}
}

func customerIOPilotEvidenceKeys() []string {
	return []string{
		customerIOConsentSubscriptionReviewKey,
		customerIOIdentityAudienceReviewKey,
		customerIOAutomationRebuildReviewKey,
		customerIOChannelDependencyReviewKey,
		customerIODeliverabilityReviewKey,
		customerIOEcosystemDependenciesReviewKey,
	}
}

func setCustomerIOPilotEvidence(t *testing.T, job *canonical.MigrationJob, key, status string, reviewedAt time.Time) {
	t.Helper()
	detail := "operator reviewed Customer.io cutover dependency"
	evidenceRaw, err := json.Marshal([]string{"ticket=CIO-42"})
	if err != nil {
		t.Fatalf("marshal evidence: %v", err)
	}
	evidence := string(evidenceRaw)
	at := reviewedAt.UTC().Format(time.RFC3339Nano)
	statusKey, atKey, detailKey, evidenceKey := customerIOCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &at
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidence
}
