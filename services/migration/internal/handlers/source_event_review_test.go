package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestUpdateSourceEventReviewRecordsEvidenceWithoutClaimingApplication(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := completedSourceEventReviewJob(t, store)
	eventID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	occurredAt := time.Now().UTC().Add(-time.Minute)
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID:            eventID,
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        job.Source,
		SourceEventID: "activecampaign:non-email-contact:42",
		ResourceType:  "activecampaign_non_email_contact",
		Action:        "manual_review",
		OccurredAt:    &occurredAt,
		Applied:       false,
		Error:         "captured for review; no automatic replay for this source-event type",
		ReviewStatus:  "pending",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	rec := patchSourceEventReview(t, store, job, eventID, http.StatusOK, `{
		"status":"reviewed",
		"detail":"Phone-only contact ada@example.com reconciled against tenant.activehosted.com/api/3.",
		"evidence":["ticket AC-42; Api-Token: secret"]
	}`)
	if rec.Applied {
		t.Fatal("manual review must not be reported as an automatic destination application")
	}
	if rec.ReviewStatus != "reviewed" || rec.ReviewedAt == nil {
		t.Fatalf("review state = %+v, want durable reviewed timestamp", rec)
	}
	if strings.Contains(rec.ReviewDetail, "activehosted.com") || strings.Contains(rec.ReviewDetail, "ada@example.com") || strings.Contains(strings.Join(rec.ReviewEvidence, "\n"), "secret") {
		t.Fatalf("review response leaked source credentials: %+v", rec)
	}
	if rec.SourceEventID == "activecampaign:non-email-contact:42" || string(rec.Payload) != `{}` {
		t.Fatalf("sensitive source event was not redacted: %+v", rec)
	}

	failed, err := store.ListFailedSourceEventResults(context.Background(), job.TenantID, job.ID, 50)
	if err != nil {
		t.Fatalf("list failed source events: %v", err)
	}
	if len(failed) != 0 {
		t.Fatalf("reviewed manual event remained unresolved: %+v", failed)
	}
	if failures := sourceEventReplayFailures([]jobstore.SourceEventRecord{rec}); len(failures) != 0 {
		t.Fatalf("reviewed manual event remained a pilot replay failure: %+v", failures)
	}
	if reviewed := sourceEventReplayReviewedCount([]jobstore.SourceEventRecord{rec}); reviewed != 1 {
		t.Fatalf("reviewed manual event count = %d, want 1", reviewed)
	}
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID:            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        job.Source,
		SourceEventID: "activecampaign:non-email-contact:42:new-projection",
		ResourceType:  "activecampaign_non_email_contact",
		Action:        "manual_review",
		Applied:       false,
		Error:         "captured for review; no automatic replay for this source-event type",
		ReviewStatus:  "pending",
	}); err != nil {
		t.Fatalf("save later source mutation: %v", err)
	}
	failed, err = store.ListFailedSourceEventResults(context.Background(), job.TenantID, job.ID, 50)
	if err != nil || len(failed) != 1 || failed[0].ReviewStatus != "pending" {
		t.Fatalf("later source mutation inherited stale review evidence: failed=%+v err=%v", failed, err)
	}
}

func TestUpdateSourceEventReviewCannotReopenAfterPostPilotCleanupAuthorization(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("11111111-1111-4111-8111-111111111112", completedAt)
	markPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	eventID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"
	reviewedAt := completedAt.Add(30 * time.Second)
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID:             eventID,
		JobID:          job.ID,
		TenantID:       job.TenantID,
		Source:         job.Source,
		SourceEventID:  "activecampaign:non-email-contact:42",
		ResourceType:   "activecampaign_non_email_contact",
		Action:         "manual_review",
		Applied:        false,
		ReviewStatus:   "reviewed",
		ReviewDetail:   "Reconciled before cleanup authorization.",
		ReviewEvidence: []string{"ticket AC-42"},
		ReviewedAt:     &reviewedAt,
	}); err != nil {
		t.Fatalf("save reviewed source event: %v", err)
	}

	patchSourceEventReview(t, store, job, eventID, http.StatusConflict, `{"status":"pending"}`)

	storedJob, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if !activeCampaignPostPilotCleanupAuthorized(storedJob) {
		t.Fatal("rejected review reopen invalidated cleanup authorization")
	}
	storedEvent, err := store.GetSourceEventResultByID(context.Background(), job.TenantID, job.ID, eventID)
	if err != nil {
		t.Fatalf("reload source event: %v", err)
	}
	if storedEvent.ReviewStatus != "reviewed" || storedEvent.ReviewedAt == nil {
		t.Fatalf("source-event review changed after authorization: %+v", storedEvent)
	}
}

func TestUpdateSourceEventReviewCannotWaiveAutomaticReplayFailure(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := completedSourceEventReviewJob(t, store)
	eventID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID:            eventID,
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        job.Source,
		SourceEventID: "activecampaign:contact:43",
		ResourceType:  "subscriber",
		Action:        "upsert",
		Applied:       false,
		Error:         "destination write failed",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	patchSourceEventReview(t, store, job, eventID, http.StatusConflict, `{
		"status":"reviewed",
		"detail":"waive failure",
		"evidence":["operator approval"]
	}`)
	stored, err := store.GetSourceEventResultByID(context.Background(), job.TenantID, job.ID, eventID)
	if err != nil {
		t.Fatalf("get source-event result: %v", err)
	}
	if stored.ReviewStatus == "reviewed" {
		t.Fatalf("automatic failure was incorrectly waivable: %+v", stored)
	}
}

func TestUpdateSourceEventReviewRequiresDetailAndEvidenceAndCanReopen(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := completedSourceEventReviewJob(t, store)
	eventID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID:            eventID,
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        job.Source,
		SourceEventID: "activecampaign:non-email-contact:44",
		ResourceType:  "activecampaign_non_email_contact",
		Action:        "manual_review",
		Applied:       false,
		Error:         "captured for review; no automatic replay for this source-event type",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	patchSourceEventReview(t, store, job, eventID, http.StatusBadRequest, `{"status":"reviewed","detail":"checked"}`)
	patchSourceEventReview(t, store, job, eventID, http.StatusOK, `{"status":"reviewed","detail":"checked","evidence":["export row reconciled"]}`)
	reopened := patchSourceEventReview(t, store, job, eventID, http.StatusOK, `{"status":"pending"}`)
	if reopened.ReviewStatus != "pending" || reopened.ReviewedAt != nil || reopened.ReviewDetail != "" || len(reopened.ReviewEvidence) != 0 {
		t.Fatalf("reopened review retained stale evidence: %+v", reopened)
	}
	failed, err := store.ListFailedSourceEventResults(context.Background(), job.TenantID, job.ID, 50)
	if err != nil || len(failed) != 1 {
		t.Fatalf("reopened manual event must block again: failed=%+v err=%v", failed, err)
	}
}

func TestUpdateSourceEventReviewPreservesFiftyEvidenceReferencesAndRejectsFiftyOne(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := completedSourceEventReviewJob(t, store)
	eventID := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID: eventID, JobID: job.ID, TenantID: job.TenantID, Source: job.Source,
		SourceEventID: "activecampaign:non-email-contact:50", ResourceType: "activecampaign_non_email_contact",
		Action: "manual_review", Error: "captured for review; no automatic replay for this source-event type",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	evidence := make([]string, maxSourceEventReviewEvidenceItems)
	for i := range evidence {
		evidence[i] = fmt.Sprintf("reconciliation-reference-%02d", i+1)
	}
	body, err := json.Marshal(sourceEventReviewRequest{
		Status: "reviewed", Detail: "All references reconciled.", Evidence: evidence,
	})
	if err != nil {
		t.Fatalf("marshal review request: %v", err)
	}
	reviewed := patchSourceEventReview(t, store, job, eventID, http.StatusOK, string(body))
	if len(reviewed.ReviewEvidence) != maxSourceEventReviewEvidenceItems {
		t.Fatalf("review evidence count = %d, want %d: %#v", len(reviewed.ReviewEvidence), maxSourceEventReviewEvidenceItems, reviewed.ReviewEvidence)
	}
	if reviewed.ReviewEvidence[len(reviewed.ReviewEvidence)-1] != evidence[len(evidence)-1] {
		t.Fatalf("last accepted evidence reference was lost: %#v", reviewed.ReviewEvidence)
	}

	twoMany := append(append([]string{}, evidence...), "reconciliation-reference-51")
	body, err = json.Marshal(sourceEventReviewRequest{
		Status: "reviewed", Detail: "Must be rejected.", Evidence: twoMany,
	})
	if err != nil {
		t.Fatalf("marshal oversized review request: %v", err)
	}
	patchSourceEventReview(t, store, job, eventID, http.StatusBadRequest, string(body))
	stored, err := store.GetSourceEventResultByID(context.Background(), job.TenantID, job.ID, eventID)
	if err != nil {
		t.Fatalf("get source-event result: %v", err)
	}
	if len(stored.ReviewEvidence) != maxSourceEventReviewEvidenceItems {
		t.Fatalf("rejected request mutated stored evidence: %#v", stored.ReviewEvidence)
	}
}

func TestUpdateSourceEventReviewRejectsOverlongTextInsteadOfTruncating(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := completedSourceEventReviewJob(t, store)
	eventID := "abababab-abab-4bab-8bab-abababababab"
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID: eventID, JobID: job.ID, TenantID: job.TenantID, Source: job.Source,
		SourceEventID: "activecampaign:non-email-contact:length", ResourceType: "activecampaign_non_email_contact",
		Action: "manual_review", Error: "captured for review; no automatic replay for this source-event type",
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	requestBody := func(detail string, evidence []string) string {
		t.Helper()
		body, err := json.Marshal(sourceEventReviewRequest{
			Status: "reviewed", Detail: detail, Evidence: evidence,
		})
		if err != nil {
			t.Fatalf("marshal review request: %v", err)
		}
		return string(body)
	}
	patchSourceEventReview(
		t, store, job, eventID, http.StatusBadRequest,
		requestBody(strings.Repeat("é", maxCutoverEvidenceDetailChars+1), []string{"valid-reference"}),
	)
	patchSourceEventReview(
		t, store, job, eventID, http.StatusBadRequest,
		requestBody("valid detail", []string{strings.Repeat("界", maxCutoverEvidenceItemChars+1)}),
	)

	detail := strings.Repeat("é", maxCutoverEvidenceDetailChars)
	evidence := strings.Repeat("界", maxCutoverEvidenceItemChars)
	reviewed := patchSourceEventReview(
		t, store, job, eventID, http.StatusOK,
		requestBody(detail, []string{evidence}),
	)
	if got := len([]rune(reviewed.ReviewDetail)); got != maxCutoverEvidenceDetailChars {
		t.Fatalf("accepted review detail rune count = %d, want %d", got, maxCutoverEvidenceDetailChars)
	}
	if got := len([]rune(reviewed.ReviewEvidence[0])); got != maxCutoverEvidenceItemChars {
		t.Fatalf("accepted evidence rune count = %d, want %d", got, maxCutoverEvidenceItemChars)
	}
}

func TestGetSourceEventMonitorIncludesOlderUnresolvedManualReviews(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := completedSourceEventReviewJob(t, store)
	if _, err := store.UpsertSourceEventMonitor(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: job.Source, Enabled: true,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	manualID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		ID: manualID, JobID: job.ID, TenantID: job.TenantID, Source: job.Source,
		SourceEventID: "activecampaign:non-email-contact:old", ResourceType: "activecampaign_non_email_contact",
		Action: "manual_review", Error: "captured for review; no automatic replay for this source-event type",
	}); err != nil {
		t.Fatalf("save manual source event: %v", err)
	}
	for i := 0; i < 60; i++ {
		if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
			JobID: job.ID, TenantID: job.TenantID, Source: job.Source,
			SourceEventID: "activecampaign:contact:clean-" + string(rune(i+65)), ResourceType: "subscriber",
			Action: "upsert", Applied: true,
		}); err != nil {
			t.Fatalf("save clean event %d: %v", i, err)
		}
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID+"/source-events", nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET source events status=%d body=%s", w.Code, w.Body.String())
	}
	var response sourceEventMonitorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode source-events response: %v", err)
	}
	found := false
	for _, event := range response.Events {
		if event.ID == manualID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("older unresolved manual review was hidden behind recent applied events: %+v", response.Events)
	}

	patchSourceEventReview(t, store, job, manualID, http.StatusOK, `{
		"status":"reviewed",
		"detail":"Older phone-only contact reconciled.",
		"evidence":["cutover-ticket-old"]
	}`)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET source events after review status=%d body=%s", w.Code, w.Body.String())
	}
	response = sourceEventMonitorResponse{}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode reviewed source-events response: %v", err)
	}
	found = false
	for _, event := range response.Events {
		if event.ID == manualID && event.ReviewStatus == "reviewed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("older completed review disappeared before it could be inspected or reopened: %+v", response.Events)
	}
}

func completedSourceEventReviewJob(t *testing.T, store *jobstore.MemoryJobStore) *canonical.MigrationJob {
	t.Helper()
	completedAt := time.Now().UTC()
	job := &canonical.MigrationJob{
		ID:          "11111111-1111-4111-8111-111111111111",
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		StartedAt:   completedAt.Add(-time.Hour),
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	return job
}

func patchSourceEventReview(t *testing.T, store *jobstore.MemoryJobStore, job *canonical.MigrationJob, eventID string, wantStatus int, body string) jobstore.SourceEventRecord {
	t.Helper()
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/source-events/"+eventID+"/review", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tenant-ID", job.TenantID)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != wantStatus {
		t.Fatalf("PATCH source-event review status=%d want=%d body=%s", w.Code, wantStatus, w.Body.String())
	}
	if wantStatus != http.StatusOK {
		return jobstore.SourceEventRecord{}
	}
	var rec jobstore.SourceEventRecord
	if err := json.Unmarshal(w.Body.Bytes(), &rec); err != nil {
		t.Fatalf("decode source-event review: %v", err)
	}
	return rec
}
