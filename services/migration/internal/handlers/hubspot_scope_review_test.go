package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestHubSpotCRMBridgeScopeReviewIsDurableAndPostSnapshot(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC().Add(-time.Minute)
	job := hubSpotAcceptedJob("hubspot-scope-review", completedAt)
	addHubSpotStaticScopeRows(job)
	markFinalDeltaCompleted(job, completedAt)
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	before := BuildPilotAcceptanceReport(job)
	if item := pilotItemByKey(before, hubSpotCRMBridgeScopeReviewKey); item.Status != "blocker" {
		t.Fatalf("scope item before review = %+v, want blocker", item)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	body := bytes.NewBufferString(`{"key":"hubspot_crm_bridge_scope_review","status":"pass","detail":"All unsupported HubSpot surfaces were inventoried after the final full snapshot.","evidence":["HS-SCOPE-42","workflows retained in HubSpot; forms and SMS explicitly retired"]}`)
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
	item := pilotItemByKey(got, hubSpotCRMBridgeScopeReviewKey)
	if item.Status != "pass" || !strings.Contains(strings.Join(item.Evidence, "\n"), "HS-SCOPE-42") {
		t.Fatalf("scope item after review = %+v, want durable pass evidence", item)
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get stored job: %v", err)
	}
	statusKey, atKey, _, evidenceKey := hubSpotCutoverEvidenceCursorKeys(hubSpotCRMBridgeScopeReviewKey)
	if status, ok := cursorString(stored.Cursor, statusKey); !ok || status != "pass" {
		t.Fatalf("stored scope status = %q/%v, want pass/true", status, ok)
	}
	if reviewedAt, ok := cursorString(stored.Cursor, atKey); !ok || reviewedAt == "" {
		t.Fatalf("stored reviewed_at = %q/%v, want value/true", reviewedAt, ok)
	}
	if evidence, ok := cursorString(stored.Cursor, evidenceKey); !ok || !strings.Contains(evidence, "HS-SCOPE-42") {
		t.Fatalf("stored evidence = %q/%v, want reference", evidence, ok)
	}
}

func TestHubSpotCRMBridgeScopeReviewRequiresCurrentChecklistAndFinalSnapshot(t *testing.T) {
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("hubspot-scope-stale-report", completedAt)
	markFinalDeltaCompleted(job, completedAt)
	status := "pass"
	reviewedAt := completedAt.Add(time.Minute).Format(time.RFC3339Nano)
	detail := "Scope reviewed."
	evidence := `["HS-SCOPE-OLD"]`
	statusKey, atKey, detailKey, evidenceKey := hubSpotCutoverEvidenceCursorKeys(hubSpotCRMBridgeScopeReviewKey)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &reviewedAt
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidence

	item := pilotItemByKey(BuildPilotAcceptanceReport(job), hubSpotCRMBridgeScopeReviewKey)
	if item.Status != "blocker" || item.Actual != 0 || !strings.Contains(item.Detail, "predates") {
		t.Fatalf("scope item for old report = %+v, want fail-closed checklist blocker", item)
	}

	addHubSpotStaticScopeRows(job)
	newerSnapshot := completedAt.Add(2 * time.Minute)
	markFinalDeltaCompleted(job, newerSnapshot)
	item = pilotItemByKey(BuildPilotAcceptanceReport(job), hubSpotCRMBridgeScopeReviewKey)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "latest successful final full snapshot") {
		t.Fatalf("scope item with stale evidence = %+v, want post-snapshot blocker", item)
	}
}

func TestHubSpotCommunicationPreferenceAcceptanceIsExactAndConservative(t *testing.T) {
	report := &canonical.VerificationReport{
		SubscribersImported: 4,
		ConsentKnown:        1,
		ConsentUnknown:      3,
		SuppressionListSize: 2,
		ResourceCompleteness: []canonical.ResourceCompleteness{{
			Resource:    "communication_preferences",
			Label:       "HubSpot email communication preferences",
			SourceTotal: 4,
			Imported:    4,
			Supported:   true,
			Status:      "imported_runtime",
			Notes: []string{
				"Only contacts subscribed to every active email definition can be enabled.",
				"Opted-out and NOT_SPECIFIED contacts remain non-sendable.",
			},
		}, {
			Resource:    "email_eligibility",
			Label:       "HubSpot current-primary-email eligibility",
			SourceTotal: 4,
			Imported:    4,
			Supported:   true,
			Status:      "imported_runtime",
			Notes:       []string{"Every enabled contact passed current-primary-email eligibility checks."},
		}},
	}

	item := hubSpotCommunicationPreferenceAcceptanceItem(report)
	if item.Status != "pass" {
		t.Fatalf("preference item = %+v, want pass for an exact conservative projection", item)
	}
	evidence := strings.Join(item.Evidence, "\n")
	for _, want := range []string{"consent_timestamp_known=1", "consent_timestamp_unknown=3", "preference_projection_covered=4", "current_email_eligibility_covered=4", "suppression_list_size=2"} {
		if !strings.Contains(evidence, want) {
			t.Fatalf("preference evidence = %q, want %q", evidence, want)
		}
	}

	report.ResourceCompleteness[0].Imported = 3
	item = hubSpotCommunicationPreferenceAcceptanceItem(report)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "every email-addressable contact") {
		t.Fatalf("partial preference item = %+v, want exact-coverage blocker", item)
	}
}

func TestHubSpotCommunicationPreferenceAcceptanceFailsClosedOnMissingOrUnaccountedEvidence(t *testing.T) {
	report := &canonical.VerificationReport{
		SubscribersImported: 4,
		ConsentKnown:        1,
		ConsentUnknown:      2,
	}
	item := hubSpotCommunicationPreferenceAcceptanceItem(report)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "predates") {
		t.Fatalf("missing preference item = %+v, want legacy-report blocker", item)
	}

	report.ResourceCompleteness = []canonical.ResourceCompleteness{{
		Resource:    "communication_preferences",
		SourceTotal: 4,
		Imported:    4,
		Supported:   true,
		Status:      "imported_runtime",
	}, {
		Resource:    "email_eligibility",
		SourceTotal: 4,
		Imported:    4,
		Supported:   true,
		Status:      "imported_runtime",
	}}
	item = hubSpotCommunicationPreferenceAcceptanceItem(report)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "account for every imported contact") {
		t.Fatalf("unaccounted preference item = %+v, want fail-closed blocker", item)
	}
}

func TestHubSpotCommunicationPreferenceAcceptanceFailsClosedOnPartialEligibility(t *testing.T) {
	report := &canonical.VerificationReport{
		SubscribersImported: 4,
		ConsentKnown:        1,
		ConsentUnknown:      3,
		ResourceCompleteness: []canonical.ResourceCompleteness{
			{
				Resource:    "communication_preferences",
				SourceTotal: 4,
				Imported:    4,
				Supported:   true,
				Status:      "imported_runtime",
			},
			{
				Resource:    "email_eligibility",
				SourceTotal: 4,
				Imported:    3,
				Supported:   true,
				Status:      "partial_runtime",
			},
		},
	}

	item := hubSpotCommunicationPreferenceAcceptanceItem(report)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "eligibility was not evaluated") {
		t.Fatalf("partial eligibility item = %+v, want fail-closed blocker", item)
	}
}

func addHubSpotStaticScopeRows(job *canonical.MigrationJob) {
	for _, resource := range []string{
		"non_email_profiles",
		"additional_email_identities",
		"contact_property_definitions",
		"dynamic_list_predicates",
		"automations",
		"campaigns",
		"templates",
		"reports",
		"forms",
		"landing",
		"ecommerce",
		"sms",
		"custom_objects",
		"other_crm_objects",
	} {
		job.VerificationReport.ResourceCompleteness = append(
			job.VerificationReport.ResourceCompleteness,
			canonical.ResourceCompleteness{
				Resource:    resource,
				Label:       resource,
				SourceTotal: 1,
				Imported:    0,
				Supported:   false,
				Status:      "manual_rebuild_required",
				Notes:       []string{"static non-additive HubSpot scope-review item"},
			},
		)
	}
}
