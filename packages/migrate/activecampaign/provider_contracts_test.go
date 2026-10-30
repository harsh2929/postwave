// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path"
	"sort"
	"strconv"
	"strings"
	"testing"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestListSavedSegmentsV2HydratesEverySummary(t *testing.T) {
	requested := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.RequestURI())
		switch r.URL.Path {
		case "/api/3/audiences":
			if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("page_size") != "100" || r.URL.Query().Get("sort") != "-updated_date" {
				t.Fatalf("audiences query = %s", r.URL.RawQuery)
			}
			writeJSON(t, w, map[string]interface{}{"data": []interface{}{
				map[string]interface{}{"id": "7", "type": "Segment", "attributes": map[string]interface{}{"segment_id": "7", "name": "VIP"}},
			}})
		case "/api/3/segmentsV2/7":
			writeJSON(t, w, map[string]interface{}{"data": []interface{}{
				map[string]interface{}{"id": "7", "type": "Segment.v2", "attributes": map[string]interface{}{
					"name": "VIP", "segment_condition_group_operator": "AND", "segment_condition_groups": []interface{}{}, "segment_conditions": []interface{}{},
				}},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got, err := New().listSavedSegmentsV2(context.Background(), activeCampaignTestSession(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "7" || got[0].Name != "VIP" {
		t.Fatalf("segments = %+v", got)
	}
	if got[0].Raw["contract"] != "segments_v2" || got[0].Raw["summary"] == nil || got[0].Raw["definition"] == nil {
		t.Fatalf("source definition = %#v", got[0].Raw)
	}
	if len(requested) != 2 {
		t.Fatalf("requests = %v", requested)
	}
}

func TestListSavedSegmentsV2FailsOnDefinitionIdentityMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/audiences":
			writeJSON(t, w, map[string]interface{}{"data": []interface{}{map[string]interface{}{"id": "7", "attributes": map[string]interface{}{"segment_id": "7"}}}})
		case "/api/3/segmentsV2/7":
			writeJSON(t, w, map[string]interface{}{"data": map[string]interface{}{"id": "8", "attributes": map[string]interface{}{}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	_, err := New().listSavedSegmentsV2(context.Background(), activeCampaignTestSession(srv.URL))
	if err == nil || !strings.Contains(err.Error(), "identity mismatch") {
		t.Fatalf("error = %v", err)
	}
}

func TestHydrateCampaignArchiveItemFetchesRenderedMessage(t *testing.T) {
	requested := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		switch r.URL.Path {
		case "/api/3/campaigns/42":
			writeJSON(t, w, map[string]interface{}{"campaign": map[string]interface{}{
				"id": "42", "name": "Weekly", "status": "5", "sdate": "2026-07-01T12:00:00Z", "message_id": "9", "send_amt": "10", "uniqueopens": "4", "uniquelinkclicks": "2",
			}})
		case "/api/3/messages/9":
			writeJSON(t, w, map[string]interface{}{"message": map[string]interface{}{"id": "9", "subject": "Rendered subject", "html": "<p>Hello</p>", "text": "Hello"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got, err := New().hydrateCampaignArchiveItem(context.Background(), activeCampaignTestSession(srv.URL), acCampaign{ID: "42", Status: "5"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != "Rendered subject" || got.HTML != "<p>Hello</p>" || got.Text != "Hello" {
		t.Fatalf("campaign = %+v", got)
	}
	if got.Extra["campaign"] == nil || got.Extra["message"] == nil {
		t.Fatalf("preserved payload = %#v", got.Extra)
	}
	if strings.Join(requested, ",") != "/api/3/campaigns/42,/api/3/messages/9" {
		t.Fatalf("requests = %v", requested)
	}
}

func TestHydrateCampaignArchiveItemFailsWithoutMessageContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/campaigns/42":
			writeJSON(t, w, map[string]interface{}{"campaign": map[string]interface{}{"id": "42", "status": "5", "message_id": "9"}})
		case "/api/3/messages/9":
			writeJSON(t, w, map[string]interface{}{"message": map[string]interface{}{"id": "9", "subject": "No body"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	_, err := New().hydrateCampaignArchiveItem(context.Background(), activeCampaignTestSession(srv.URL), acCampaign{ID: "42", Status: "5"})
	if err == nil || !strings.Contains(err.Error(), "no rendered content") {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchCampaignMessageVariantsPaginatesEveryRelationship(t *testing.T) {
	offsets := []string{}
	messageRequests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/3/campaigns/42/campaignMessages":
			offset := r.URL.Query().Get("offset")
			offsets = append(offsets, offset)
			if r.URL.Query().Get("limit") != "100" {
				t.Fatalf("variant limit = %q", r.URL.Query().Get("limit"))
			}
			start, count := 0, 100
			if offset == "100" {
				start, count = 100, 1
			} else if offset != "0" {
				t.Fatalf("variant offset = %q", offset)
			}
			rows := make([]interface{}, 0, count)
			for i := start; i < start+count; i++ {
				id := strconv.Itoa(i + 1)
				rows = append(rows, map[string]interface{}{"id": "relationship-" + id, "campaign": "42", "message": id})
			}
			writeJSON(t, w, map[string]interface{}{"campaignMessages": rows, "meta": map[string]interface{}{"total": "101"}})
		case strings.HasPrefix(r.URL.Path, "/api/3/messages/"):
			messageRequests++
			id := strings.TrimPrefix(r.URL.Path, "/api/3/messages/")
			writeJSON(t, w, map[string]interface{}{"message": map[string]interface{}{"id": id, "html": "<p>variant " + id + "</p>"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got, err := New().fetchCampaignMessageVariants(context.Background(), activeCampaignTestSession(srv.URL), "42", "1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 101 || messageRequests != 101 {
		t.Fatalf("variants = %d, message requests = %d", len(got), messageRequests)
	}
	if fmt.Sprint(offsets) != "[0 100]" {
		t.Fatalf("variant offsets = %v", offsets)
	}
}

func TestFetchCampaignMessageVariantsRejectsDuplicateAndMalformedResults(t *testing.T) {
	t.Run("duplicate message", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/3/campaigns/42/campaignMessages":
				writeJSON(t, w, map[string]interface{}{
					"campaignMessages": []interface{}{
						map[string]interface{}{"id": "relationship-1", "campaign": "42", "message": "9"},
						map[string]interface{}{"id": "relationship-2", "campaign": "42", "message": "9"},
					},
					"meta": map[string]interface{}{"total": 2},
				})
			case "/api/3/messages/9":
				writeJSON(t, w, map[string]interface{}{"message": map[string]interface{}{"id": "9", "html": "<p>variant</p>"}})
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()

		_, err := New().fetchCampaignMessageVariants(context.Background(), activeCampaignTestSession(srv.URL), "42", "9")
		if err == nil || !strings.Contains(err.Error(), "repeated message 9") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("malformed collection", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(t, w, map[string]interface{}{"campaignMessages": map[string]interface{}{"message": "9"}, "meta": map[string]interface{}{"total": 1}})
		}))
		defer srv.Close()

		_, err := New().fetchCampaignMessageVariants(context.Background(), activeCampaignTestSession(srv.URL), "42", "9")
		if err == nil || !strings.Contains(err.Error(), `decode "campaignMessages" array`) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestHydrateAutomationDefinitionPreservesDocumentedRelationships(t *testing.T) {
	requested := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		writeJSON(t, w, map[string]interface{}{"items": []interface{}{}})
	}))
	defer srv.Close()

	got, err := New().hydrateAutomationDefinition(context.Background(), activeCampaignTestSession(srv.URL), acAutomation{ID: "12", Name: "Revenue", Raw: map[string]interface{}{"id": "12"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Raw["contract"] != "automation_rebuild_v3" {
		t.Fatalf("definition = %#v", got.Raw)
	}
	relationships, ok := got.Raw["relationships"].(map[string]interface{})
	if !ok || len(relationships) != 5 {
		t.Fatalf("relationships = %#v", got.Raw["relationships"])
	}
	sort.Strings(requested)
	want := []string{
		"/api/3/automations/12/blocks", "/api/3/automations/12/campaigns", "/api/3/automations/12/goals", "/api/3/automations/12/sitemessages", "/api/3/automations/12/sms",
	}
	if strings.Join(requested, ",") != strings.Join(want, ",") {
		t.Fatalf("requests = %v", requested)
	}
}

func TestHydrateAutomationDefinitionPaginatesRelationshipCollections(t *testing.T) {
	blockOffsets := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		relationship := path.Base(r.URL.Path)
		if r.URL.Query().Get("limit") != strconv.Itoa(activeCampaignAutomationRelationshipPageSize) {
			t.Fatalf("limit = %q", r.URL.Query().Get("limit"))
		}
		if relationship != "blocks" {
			writeJSON(t, w, map[string]interface{}{relationship: []interface{}{}, "meta": map[string]interface{}{"total": 0}})
			return
		}
		offset := r.URL.Query().Get("offset")
		blockOffsets = append(blockOffsets, offset)
		if offset == "0" {
			rows := make([]interface{}, 20)
			for i := range rows {
				rows[i] = map[string]interface{}{"id": strconv.Itoa(i + 1)}
			}
			writeJSON(t, w, map[string]interface{}{"blocks": rows, "meta": map[string]interface{}{"total": 21}})
			return
		}
		if offset == "20" {
			writeJSON(t, w, map[string]interface{}{"blocks": []interface{}{map[string]interface{}{"id": "21"}}, "meta": map[string]interface{}{"total": 21}})
			return
		}
		t.Fatalf("unexpected blocks offset %q", offset)
	}))
	defer srv.Close()

	got, err := New().hydrateAutomationDefinition(context.Background(), activeCampaignTestSession(srv.URL), acAutomation{ID: "12", Name: "Revenue"})
	if err != nil {
		t.Fatal(err)
	}
	relationships, ok := got.Raw["relationships"].(map[string]interface{})
	if !ok {
		t.Fatalf("relationships = %#v", got.Raw["relationships"])
	}
	blocks, ok := relationships["blocks"].(map[string]interface{})
	if !ok {
		t.Fatalf("blocks = %#v", relationships["blocks"])
	}
	rows, ok := blocks["blocks"].([]interface{})
	if !ok || len(rows) != 21 {
		t.Fatalf("block rows = %#v, want 21 preserved rows", blocks["blocks"])
	}
	if strings.Join(blockOffsets, ",") != "0,20" {
		t.Fatalf("block offsets = %v, want [0 20]", blockOffsets)
	}
}

func TestHydrateAutomationDefinitionRejectsEmptyRelationshipPageBeforeTotal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]interface{}{"blocks": []interface{}{}, "meta": map[string]interface{}{"total": 1}})
	}))
	defer srv.Close()

	_, err := New().hydrateAutomationDefinition(context.Background(), activeCampaignTestSession(srv.URL), acAutomation{ID: "12"})
	if err == nil || !strings.Contains(err.Error(), "empty page") || !strings.Contains(err.Error(), "provider total 1") {
		t.Fatalf("error = %v, want empty-before-total failure", err)
	}
}

func TestHydrateAutomationDefinitionRejectsRelationshipTotalDrift(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset := r.URL.Query().Get("offset")
		if offset == "0" {
			writeJSON(t, w, map[string]interface{}{"blocks": []interface{}{map[string]interface{}{"id": "1"}}, "meta": map[string]interface{}{"total": 2}})
			return
		}
		writeJSON(t, w, map[string]interface{}{"blocks": []interface{}{map[string]interface{}{"id": "2"}}, "meta": map[string]interface{}{"total": 3}})
	}))
	defer srv.Close()

	_, err := New().hydrateAutomationDefinition(context.Background(), activeCampaignTestSession(srv.URL), acAutomation{ID: "12"})
	if err == nil || !strings.Contains(err.Error(), "pagination total changed or disappeared") {
		t.Fatalf("error = %v, want total-drift failure", err)
	}
}

func TestHydrateAutomationDefinitionRejectsMalformedRelationshipPagination(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload map[string]interface{}
		wantErr string
	}{
		{
			name:    "invalid total",
			payload: map[string]interface{}{"blocks": []interface{}{}, "meta": map[string]interface{}{"total": "many"}},
			wantErr: "meta.total must be a non-negative integer",
		},
		{
			name:    "collection is not an array",
			payload: map[string]interface{}{"blocks": map[string]interface{}{}, "meta": map[string]interface{}{"total": 0}},
			wantErr: "candidate collection arrays",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(t, w, tc.payload)
			}))
			defer srv.Close()

			_, err := New().hydrateAutomationDefinition(context.Background(), activeCampaignTestSession(srv.URL), acAutomation{ID: "12"})
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func activeCampaignTestSession(serverURL string) adapter.Session {
	return adapter.Session{
		AccessToken: "token",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": strings.TrimRight(serverURL, "/") + "/api/3"},
	}
}
