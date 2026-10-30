// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSalesforceWriteProfileFieldAndCampaign(t *testing.T) {
	var gotAuth, patchedID, soql string
	var patchedFields map[string]string
	var campaignMember map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/query"):
			soql = r.URL.Query().Get("q")
			_, _ = w.Write([]byte(`{"records":[{"Id":"003ABC"}]}`))
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/sobjects/Contact/"):
			parts := strings.Split(r.URL.Path, "/")
			patchedID = parts[len(parts)-1]
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &patchedFields)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/sobjects/CampaignMember"):
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &campaignMember)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"00vXXX","success":true}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	adapter := SalesforceWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "sf-tok"},
		map[string]any{"api_base_url": srv.URL, "api_version": "v60.0", "campaign_id": "701XYZ"},
		ProfileWrite{Email: "Lead@Example.com", Fields: map[string]string{"Loyalty_Tier__c": "Gold"}},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 1 || res.TagsWritten != 1 {
		t.Fatalf("result=%+v", res)
	}
	if gotAuth != "Bearer sf-tok" {
		t.Fatalf("bearer=%q", gotAuth)
	}
	if !strings.Contains(soql, "Email = 'lead@example.com'") {
		t.Fatalf("SOQL not keyed by email: %q", soql)
	}
	if patchedID != "003ABC" || patchedFields["Loyalty_Tier__c"] != "Gold" {
		t.Fatalf("patch wrong: id=%q fields=%+v", patchedID, patchedFields)
	}
	if campaignMember["CampaignId"] != "701XYZ" || campaignMember["ContactId"] != "003ABC" {
		t.Fatalf("campaign member wrong: %+v", campaignMember)
	}
}

func TestSalesforceWriteProfileNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"records":[]}`))
	}))
	defer srv.Close()
	adapter := SalesforceWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "t"}, map[string]any{"api_base_url": srv.URL, "campaign_id": "x"},
		ProfileWrite{Email: "ghost@example.com", Fields: map[string]string{"A__c": "b"}})
	if err != nil || res.Matched {
		t.Fatalf("missing record should be a clean no-op: res=%+v err=%v", res, err)
	}
}

func TestPipedriveWriteProfileCustomFieldsAndLabels(t *testing.T) {
	var gotToken string
	var patched map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("x-api-token")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/v1/persons/search"):
			_, _ = w.Write([]byte(`{"data":{"items":[{"item":{"id":77}}]}}`))
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/api/v2/persons/77"):
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &patched)
			_, _ = w.Write([]byte(`{"data":{"id":77}}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	adapter := PipedriveWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "pd-tok"},
		map[string]any{"api_base_url": srv.URL, "label_ids": []any{float64(2), float64(3)}},
		ProfileWrite{Email: "person@example.com", Fields: map[string]string{"dcf558aac1ae4e8c4f849ba5e668430d8df9be12": "Enterprise"}},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 1 || res.TagsWritten != 2 {
		t.Fatalf("result=%+v", res)
	}
	if gotToken != "pd-tok" {
		t.Fatalf("x-api-token=%q", gotToken)
	}
	cf, _ := patched["custom_fields"].(map[string]any)
	if cf["dcf558aac1ae4e8c4f849ba5e668430d8df9be12"] != "Enterprise" {
		t.Fatalf("custom_fields not nested/sent: %+v", patched)
	}
	labels, _ := patched["label_ids"].([]any)
	if len(labels) != 2 {
		t.Fatalf("label_ids not sent: %+v", patched)
	}
}
