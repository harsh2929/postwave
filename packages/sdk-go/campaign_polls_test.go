package postwave

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	testPollCampaignID = "11111111-1111-4111-8111-111111111111"
	testPollRevisionID = "22222222-2222-4222-8222-222222222222"
)

func TestCampaignPollsAuthenticatedRoutesAndExclusions(t *testing.T) {
	t.Helper()
	type requestRecord struct {
		method string
		path   string
		query  string
		auth   string
		body   map[string]any
	}
	requests := make([]requestRecord, 0, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		record := requestRecord{
			method: request.Method,
			path:   request.URL.EscapedPath(),
			query:  request.URL.RawQuery,
			auth:   request.Header.Get("Authorization"),
		}
		if request.Body != nil {
			_ = json.NewDecoder(request.Body).Decode(&record.body)
		}
		requests = append(requests, record)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(request.URL.Path, "/tally"):
			_, _ = w.Write([]byte(`{
				"poll_id":"33333333-3333-4333-8333-333333333333",
				"poll_key":"venue:primary",
				"question":"Which venue?",
				"options":[
					{"option_key":"north","label":"North hall","counted":2},
					{"option_key":"south","label":"South hall","counted":1}
				],
				"machine_excluded":4,
				"unclassified_excluded":9,
				"voided_multi_option":3,
				"previewed_only":12
			}`))
		case request.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"items":[],"next_cursor":"pwcp1.next"}`))
		default:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{
				"id":"33333333-3333-4333-8333-333333333333",
				"campaign_id":"11111111-1111-4111-8111-111111111111",
				"poll_key":"venue:primary",
				"question":"Which venue?",
				"two_step_required":false,
				"options":[
					{"option_key":"north","label":"North hall","position":0},
					{"option_key":"south","label":"South hall","position":1}
				],
				"created_at":"2026-08-13T00:00:00Z"
			}`))
		}
	}))
	defer server.Close()

	client := New("pw_campaign_polls", WithBaseURL(server.URL), WithMaxRetries(0))
	twoStep := false
	closesAt := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	created, err := client.CampaignPolls.Materialize(context.Background(), testPollCampaignID,
		&CampaignPollMaterializationInput{
			ContentRevisionID: testPollRevisionID,
			PollKey:           "venue:primary",
			TwoStepRequired:   &twoStep,
			ClosesAt:          &closesAt,
		})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	listed, err := client.CampaignPolls.List(context.Background(), testPollCampaignID,
		CampaignPollListOptions{Limit: 25, Cursor: "pwcp1.a2lk.payload.signature"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	tally, err := client.CampaignPolls.Tally(context.Background(), testPollCampaignID, "venue:primary")
	if err != nil {
		t.Fatalf("Tally: %v", err)
	}

	wantPaths := []string{
		"/api/v1/campaigns/" + testPollCampaignID + "/polls",
		"/api/v1/campaigns/" + testPollCampaignID + "/polls",
		"/api/v1/campaigns/" + testPollCampaignID + "/polls/venue:primary/tally",
	}
	if len(requests) != len(wantPaths) {
		t.Fatalf("requests=%d, want %d", len(requests), len(wantPaths))
	}
	for index, request := range requests {
		if request.path != wantPaths[index] {
			t.Errorf("request %d path=%q, want %q", index, request.path, wantPaths[index])
		}
		if request.auth != "Bearer pw_campaign_polls" {
			t.Errorf("request %d auth=%q", index, request.auth)
		}
	}
	if requests[1].query != "cursor=pwcp1.a2lk.payload.signature&limit=25" {
		t.Errorf("list query=%q", requests[1].query)
	}
	wantBody := map[string]any{
		"content_revision_id": testPollRevisionID,
		"poll_key":            "venue:primary",
		"two_step_required":   false,
		"closes_at":           "2026-09-01T12:00:00Z",
	}
	if !reflect.DeepEqual(requests[0].body, wantBody) {
		t.Errorf("materialization body=%#v, want %#v", requests[0].body, wantBody)
	}
	if created.Question != "Which venue?" || len(created.Options) != 2 {
		t.Fatalf("created=%+v", created)
	}
	if listed.Items == nil || len(listed.Items) != 0 || listed.NextCursor != "pwcp1.next" {
		t.Fatalf("listed=%+v", listed)
	}
	if tally.UnclassifiedExcluded != 9 || tally.MachineExcluded != 4 {
		t.Fatalf("tally lost exclusions: %+v", tally)
	}
	if tally.Options[0].Counted+tally.Options[1].Counted != 3 {
		t.Fatalf("counted totals drifted: %+v", tally.Options)
	}
}

func TestCampaignPollsRejectInvalidAuthoringIdentityBeforeTransport(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer server.Close()
	client := New("pw_campaign_polls", WithBaseURL(server.URL), WithMaxRetries(0))

	_, err := client.CampaignPolls.Materialize(context.Background(), testPollCampaignID,
		&CampaignPollMaterializationInput{ContentRevisionID: testPollRevisionID, PollKey: "not/a/reference"})
	if err == nil || !strings.Contains(err.Error(), "stable ASCII reference") {
		t.Fatalf("err=%v", err)
	}
	_, err = client.CampaignPolls.Tally(context.Background(), testPollCampaignID, "not/a/reference")
	if err == nil || !strings.Contains(err.Error(), "stable ASCII reference") {
		t.Fatalf("err=%v", err)
	}
	_, err = client.CampaignPolls.List(context.Background(), testPollCampaignID,
		CampaignPollListOptions{Limit: 101})
	if err == nil || !strings.Contains(err.Error(), "integer from 1 to 100") {
		t.Fatalf("err=%v", err)
	}
	_, err = client.CampaignPolls.List(context.Background(), testPollCampaignID,
		CampaignPollListOptions{Cursor: "not a cursor"})
	if err == nil || !strings.Contains(err.Error(), "opaque ASCII cursor") {
		t.Fatalf("err=%v", err)
	}
	if requests != 0 {
		t.Fatalf("invalid input reached transport %d time(s)", requests)
	}
}
