package postwave

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testAssuranceCampaignID = "11111111-1111-4111-8111-111111111111"
	testAssuranceRunID      = "22222222-2222-4222-8222-222222222222"
	testAssuranceFindingID  = "33333333-3333-4333-8333-333333333333"
	testAssuranceRevisionID = "44444444-4444-4444-8444-444444444444"
	testAssurancePlanID     = "55555555-5555-4555-8555-555555555555"
	testAssuranceRequestID  = "66666666-6666-4666-8666-666666666666"
)

type assuranceRequestRecord struct {
	method, path, query, auth, idempotencyKey, ifMatch, body string
}

func TestCampaignAssuranceSetFactContractReturnsNextETag(t *testing.T) {
	var request assuranceRequestRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, incoming *http.Request) {
		body, _ := io.ReadAll(incoming.Body)
		request = assuranceRequestRecord{
			method: incoming.Method, path: incoming.URL.Path,
			idempotencyKey: incoming.Header.Get("Idempotency-Key"),
			ifMatch:        incoming.Header.Get("If-Match"), body: string(body),
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"campaign-next-version"`)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": testAssuranceCampaignID, "status": "draft"})
	}))
	defer server.Close()

	client := New("pw_assurance", WithBaseURL(server.URL), WithMaxRetries(0))
	result, err := client.CampaignAssurance.SetFactContract(
		context.Background(),
		testAssuranceCampaignID,
		&FactContractV1{
			SchemaVersion:   1,
			PrimaryIntent:   FactContractIntentV1{Kind: FactContractIntentInvite, Statement: "Invite customers"},
			AudienceContext: FactContractAudienceV1{Description: "Existing Pro customers"},
			CoreClaim:       FactContractClaimV1{Statement: "The webinar demonstrates automation"},
			PrimaryAction: FactContractPrimaryActionV1{
				ActionID: "register", BlockID: "cta", Role: FactContractActionRegister,
				Label: "Reserve my seat", CanonicalURL: "https://example.test/events/launch",
			},
			RequiredFacts:           []FactContractRequiredFactV1{},
			ForbiddenClaims:         []FactContractForbiddenClaimV1{},
			AllowedSecondaryActions: []FactContractSecondaryActionRole{"unsubscribe"},
			Language:                "en-IN",
		},
		&SetFactContractOptions{
			IfMatch: `"campaign-reviewed-version"`, IdempotencyKey: "fact-contract-set",
		},
	)
	if err != nil {
		t.Fatalf("SetFactContract: %v", err)
	}
	base := "/api/v1/campaigns/" + testAssuranceCampaignID + "/fact-contract"
	if request.method != http.MethodPut || request.path != base ||
		request.ifMatch != `"campaign-reviewed-version"` || request.idempotencyKey != "fact-contract-set" {
		t.Fatalf("request=%+v", request)
	}
	if result.ETag != `"campaign-next-version"` || result.Campaign["id"] != testAssuranceCampaignID {
		t.Fatalf("result=%+v", result)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(request.body), &body); err != nil || body["schema_version"] != float64(1) {
		t.Fatalf("body=%s err=%v", request.body, err)
	}
}

func TestCampaignAssuranceSetFactContractRefusesSuccessWithoutNextETag(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"` + testAssuranceCampaignID + `"}`))
	}))
	defer server.Close()
	client := New("pw_assurance", WithBaseURL(server.URL), WithMaxRetries(0))
	_, err := client.CampaignAssurance.SetFactContract(context.Background(), testAssuranceCampaignID, nil,
		&SetFactContractOptions{IfMatch: `"campaign-reviewed-version"`})
	if err == nil || !strings.Contains(err.Error(), "did not include a valid strong campaign ETag") {
		t.Fatalf("err=%v", err)
	}
}

func TestCampaignAssuranceResourceMountedContract(t *testing.T) {
	var requests []assuranceRequestRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		requests = append(requests, assuranceRequestRecord{
			method: request.Method, path: request.URL.Path, query: request.URL.RawQuery,
			auth: request.Header.Get("Authorization"), idempotencyKey: request.Header.Get("Idempotency-Key"),
			ifMatch: request.Header.Get("If-Match"), body: string(body),
		})
		w.Header().Set("Content-Type", "application/json")
		data := map[string]any{}
		if strings.HasSuffix(request.URL.Path, "/events") {
			data = map[string]any{
				"run_id": testAssuranceRunID, "state": "running", "gate_decision": "pending",
				"attempt_count": 1, "required_extractions": 2, "terminal_extractions": 1,
				"successful_extractions": 1, "extraction_errors": 0, "finding_count": 0,
				"blocking_finding_count": 0, "updated_at": "2026-08-09T00:00:00Z",
				"event_history_available":   false,
				"event_history_explanation": "durable event history is unavailable; this is a snapshot",
				"source_classes":            []string{"deterministic"},
			}
		} else if strings.HasSuffix(request.URL.Path, "/apply") {
			data = map[string]any{
				"application": map[string]any{
					"campaign_updated_at": "2026-08-09T00:00:00Z",
				},
				"revision":              map[string]any{},
				"campaign_etag":         `"campaign-new-version"`,
				"originating_run_state": "stale",
				"rerun_required":        true,
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"measurement": map[string]any{
				"name":           "Predicted Agent Comprehension",
				"interpretation": "a prediction, not private inbox behavior",
				"source_classes": []map[string]any{
					{"class": "deterministic", "present": true, "meaning": "rule-based"},
					{"class": "modeled", "present": false, "meaning": "prediction only"},
					{"class": "controlled_observation", "present": false, "meaning": "named environment only"},
				},
			},
			"data": data,
		})
	}))
	defer server.Close()

	client := New("pw_assurance", WithBaseURL(server.URL), WithMaxRetries(0))
	ctx := context.Background()
	_, err := client.CampaignAssurance.CreateRun(ctx, testAssuranceCampaignID, &CreateCampaignAssuranceRunInput{
		Profile: CampaignAssuranceProfileFull, ContentRevisionID: testAssuranceRevisionID,
		SendPlanID: testAssurancePlanID, RequestID: testAssuranceRequestID,
	}, &CampaignAssuranceMutationOptions{IdempotencyKey: "assurance-create"})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	_, _ = client.CampaignAssurance.GetLatest(ctx, testAssuranceCampaignID)
	_, _ = client.CampaignAssurance.GetRun(ctx, testAssuranceCampaignID, testAssuranceRunID)
	_, _ = client.CampaignAssurance.GetManifest(ctx, testAssuranceCampaignID, testAssuranceRunID)
	_, _ = client.CampaignAssurance.GetEvidence(ctx, testAssuranceCampaignID, testAssuranceRunID, 20, 50)
	events, err := client.CampaignAssurance.GetEvents(ctx, testAssuranceCampaignID, testAssuranceRunID)
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	_, _ = client.CampaignAssurance.AppealFinding(ctx, testAssuranceCampaignID, testAssuranceRunID, testAssuranceFindingID,
		&CampaignAssuranceAppealInput{RequestID: testAssuranceRequestID, Decision: CampaignAssuranceAppealAllowSend, Reason: "Reviewed governed evidence"},
		&CampaignAssuranceMutationOptions{IdempotencyKey: "assurance-appeal"})
	_, _ = client.CampaignAssurance.OverrideFinding(ctx, testAssuranceCampaignID, testAssuranceRunID, testAssuranceFindingID,
		&CampaignAssuranceAppealInput{RequestID: testAssuranceRequestID, Decision: CampaignAssuranceAppealReject, Reason: "Rejected after evidence review"},
		&CampaignAssuranceMutationOptions{IdempotencyKey: "assurance-override"})
	applied, err := client.CampaignAssurance.ApplyFinding(ctx, testAssuranceCampaignID, testAssuranceRunID, testAssuranceFindingID,
		&CampaignAssuranceApplyFindingInput{RequestID: testAssuranceRequestID},
		&CampaignAssuranceApplyOptions{IfMatch: `"campaign-reviewed-version"`, IdempotencyKey: "assurance-apply"})
	if err != nil {
		t.Fatalf("ApplyFinding: %v", err)
	}
	_, _ = client.CampaignAssurance.CancelRun(ctx, testAssuranceCampaignID, testAssuranceRunID,
		&CampaignAssuranceMutationOptions{IdempotencyKey: "assurance-cancel"})

	base := "/api/v1/campaigns/" + testAssuranceCampaignID
	want := []string{
		"POST " + base + "/assurance-runs",
		"GET " + base + "/assurance",
		"GET " + base + "/assurance-runs/" + testAssuranceRunID,
		"GET " + base + "/assurance-runs/" + testAssuranceRunID + "/manifest",
		"GET " + base + "/assurance-runs/" + testAssuranceRunID + "/evidence",
		"GET " + base + "/assurance-runs/" + testAssuranceRunID + "/events",
		"POST " + base + "/assurance-runs/" + testAssuranceRunID + "/findings/" + testAssuranceFindingID + "/appeals",
		"POST " + base + "/assurance-runs/" + testAssuranceRunID + "/findings/" + testAssuranceFindingID + "/overrides",
		"POST " + base + "/assurance-runs/" + testAssuranceRunID + "/findings/" + testAssuranceFindingID + "/apply",
		"POST " + base + "/assurance-runs/" + testAssuranceRunID + "/cancel",
	}
	if len(requests) != len(want) {
		t.Fatalf("requests=%d want=%d: %+v", len(requests), len(want), requests)
	}
	for index := range want {
		if got := requests[index].method + " " + requests[index].path; got != want[index] {
			t.Errorf("request[%d]=%q want=%q", index, got, want[index])
		}
		if requests[index].auth != "Bearer pw_assurance" {
			t.Errorf("request[%d] auth=%q", index, requests[index].auth)
		}
	}
	if requests[0].idempotencyKey != "assurance-create" ||
		requests[6].idempotencyKey != "assurance-appeal" ||
		requests[7].idempotencyKey != "assurance-override" ||
		requests[8].idempotencyKey != "assurance-apply" ||
		requests[8].ifMatch != `"campaign-reviewed-version"` ||
		requests[9].idempotencyKey != "assurance-cancel" {
		t.Fatalf("explicit idempotency keys drifted: %+v", requests)
	}
	if requests[4].query != "limit=50&offset=20" {
		t.Errorf("evidence query=%q", requests[4].query)
	}
	if events.Data.EventHistoryAvailable || !strings.Contains(events.Data.EventHistoryExplanation, "unavailable") {
		t.Fatalf("events overclaimed history: %+v", events.Data)
	}
	if events.Measurement.SourceClasses[1].Present {
		t.Fatal("modeled source was incorrectly marked present")
	}
	if applied.Data.OriginatingRunState != "stale" || !applied.Data.RerunRequired ||
		applied.Data.Application.CampaignUpdatedAt.IsZero() {
		t.Fatalf("apply receipt lost stale/replay evidence: %+v", applied.Data)
	}
}

func TestCampaignAssuranceMutationValidatesExplicitIdempotencyKey(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	defer server.Close()
	client := New("pw_assurance", WithBaseURL(server.URL), WithMaxRetries(0))
	_, err := client.CampaignAssurance.CancelRun(context.Background(), testAssuranceCampaignID, testAssuranceRunID,
		&CampaignAssuranceMutationOptions{IdempotencyKey: "bad\nkey"})
	if err == nil || !strings.Contains(err.Error(), "1-255 UTF-8 bytes") {
		t.Fatalf("err=%v", err)
	}
	if requests != 0 {
		t.Fatalf("invalid key reached network %d time(s)", requests)
	}
}

func TestCampaignAssuranceApplyRequiresExactStrongETag(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	defer server.Close()
	client := New("pw_assurance", WithBaseURL(server.URL), WithMaxRetries(0))
	for _, ifMatch := range []string{"", "*", `W/"weak"`, `"one", "two"`, "bare", ` "spaced"`, "\"bad\nvalue\""} {
		_, err := client.CampaignAssurance.ApplyFinding(context.Background(), testAssuranceCampaignID, testAssuranceRunID, testAssuranceFindingID,
			&CampaignAssuranceApplyFindingInput{RequestID: testAssuranceRequestID},
			&CampaignAssuranceApplyOptions{IfMatch: ifMatch, IdempotencyKey: "assurance-apply"})
		if err == nil || !strings.Contains(err.Error(), "exact strong campaign ETag") {
			t.Fatalf("If-Match %q err=%v", ifMatch, err)
		}
	}
	if requests != 0 {
		t.Fatalf("invalid If-Match reached network %d time(s)", requests)
	}
}
