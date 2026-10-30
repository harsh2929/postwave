// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
)

func TestMailchimpSelectedAudienceCampaignDiscoveryAndArchiveAreScoped(t *testing.T) {
	var mu sync.Mutex
	discoveryCampaignScopes := []string{}
	archiveCampaignScopes := []string{}
	contentRequests := map[string]int{}
	reportRequests := map[string]int{}
	globalCampaignOrReportRequest := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/lists":
			_, _ = w.Write([]byte(`{"lists":[
				{"id":"list_a","name":"A","stats":{"member_count":900}},
				{"id":"list_b","name":"B","stats":{"member_count":800}}
			],"total_items":2}`))
		case strings.HasSuffix(r.URL.Path, "/segments") && strings.HasPrefix(r.URL.Path, "/lists/"):
			_, _ = w.Write([]byte(`{"segments":[],"total_items":0}`))
		case strings.HasSuffix(r.URL.Path, "/members") && strings.HasPrefix(r.URL.Path, "/lists/"):
			_, _ = w.Write([]byte(`{"members":[],"total_items":1}`))
		case strings.HasSuffix(r.URL.Path, "/interest-categories") && strings.HasPrefix(r.URL.Path, "/lists/"):
			_, _ = w.Write([]byte(`{"categories":[],"total_items":0}`))
		case strings.HasSuffix(r.URL.Path, "/merge-fields") && strings.HasPrefix(r.URL.Path, "/lists/"):
			_, _ = w.Write([]byte(`{"merge_fields":[],"total_items":0}`))
		case strings.HasSuffix(r.URL.Path, "/signup-forms") && strings.HasPrefix(r.URL.Path, "/lists/"):
			_, _ = w.Write([]byte(`{"forms":[],"total_items":0}`))
		case r.URL.Path == "/automations":
			_, _ = w.Write([]byte(`{"automations":[],"total_items":0}`))
		case r.URL.Path == "/campaigns":
			listID := r.URL.Query().Get("list_id")
			mu.Lock()
			if listID == "" {
				globalCampaignOrReportRequest = true
			}
			if r.URL.Query().Get("count") == "1" {
				discoveryCampaignScopes = append(discoveryCampaignScopes, listID)
			} else {
				archiveCampaignScopes = append(archiveCampaignScopes, listID)
			}
			mu.Unlock()
			if r.URL.Query().Get("count") == "1" {
				_, _ = w.Write([]byte(`{"total_items":1}`))
				return
			}
			switch listID {
			case "list_a":
				_, _ = w.Write([]byte(`{"campaigns":[
					{"id":"campaign_a","recipients":{"list_id":"list_a"},"settings":{"subject_line":"A"}},
					{"id":"campaign_b","recipients":{"list_id":"list_b"},"settings":{"subject_line":"leaked B"}},
					{"id":"campaign_unknown","settings":{"subject_line":"unowned"}}
				],"total_items":3}`))
			case "list_b":
				_, _ = w.Write([]byte(`{"campaigns":[
					{"id":"campaign_b","recipients":{"list_id":"list_b"},"settings":{"subject_line":"B"}},
					{"id":"campaign_a","recipients":{"list_id":"list_a"},"settings":{"subject_line":"duplicate A"}}
				],"total_items":2}`))
			default:
				http.Error(w, "campaign request was not audience scoped", http.StatusBadRequest)
			}
		case strings.HasPrefix(r.URL.Path, "/campaigns/") && strings.HasSuffix(r.URL.Path, "/content"):
			parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
			id := parts[1]
			mu.Lock()
			contentRequests[id]++
			mu.Unlock()
			_, _ = w.Write([]byte(`{"html":"<p>Scoped</p>","plain_text":"Scoped"}`))
		case r.URL.Path == "/reports":
			mu.Lock()
			globalCampaignOrReportRequest = true
			mu.Unlock()
			http.Error(w, "global reports are forbidden in a selected-audience migration", http.StatusBadRequest)
		case strings.HasPrefix(r.URL.Path, "/reports/"):
			parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
			if len(parts) == 2 {
				mu.Lock()
				reportRequests[parts[1]]++
				mu.Unlock()
				_, _ = w.Write([]byte(`{"opens":{"unique_opens":1},"clicks":{"unique_clicks":1}}`))
				return
			}
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/templates", r.URL.Path == "/landing-pages", r.URL.Path == "/ecommerce/stores":
			_, _ = w.Write([]byte(`{"total_items":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{
		AccessToken: "token",
		AccountID:   "us1",
		Extra:       map[string]string{SelectedAudiencesExtraKey: "list_b,list_a"},
	}

	discovery, err := a.Discover(context.Background(), sess)
	require.NoError(t, err)
	require.Equal(t, 2, discovery.SubscribersTotal, "discovery must use the all-state members total rather than subscribed-only stats.member_count")
	require.Equal(t, 1, discovery.Audiences[0].SubscribersTotal)
	require.Equal(t, 1, discovery.Audiences[1].SubscribersTotal)
	require.Equal(t, 2, discovery.CampaignsTotal)
	require.Equal(t, 2, discovery.ArchiveTotal)
	require.Equal(t, 2, discovery.ReportsTotal)
	require.Contains(t, strings.Join(discovery.Warnings, "\n"), "restricted to the selected Mailchimp audience")
	require.Contains(t, strings.Join(discovery.Warnings, "\n"), "account-wide APIs")

	first, next, err := a.ListCampaignArchive(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, first, 1)
	require.Equal(t, "campaign_a", first[0].SourceID)
	require.Equal(t, "list_a", first[0].Report["postwave_mailchimp_audience_scope"])
	decoded, encoded, err := decodeMailchimpPageCursor(next, "campaign_archive")
	require.NoError(t, err)
	require.True(t, encoded)
	require.Equal(t, "list_b", decoded.Scope)

	second, finalCursor, err := a.ListCampaignArchive(context.Background(), sess, next)
	require.NoError(t, err)
	require.Len(t, second, 1)
	require.Equal(t, "campaign_b", second[0].SourceID)
	require.Equal(t, "list_b", second[0].Report["postwave_mailchimp_audience_scope"])
	require.Empty(t, finalCursor)

	mu.Lock()
	defer mu.Unlock()
	require.ElementsMatch(t, []string{"list_a", "list_a", "list_b", "list_b"}, discoveryCampaignScopes, "sent and all-campaign discovery counts must each be list scoped")
	require.Equal(t, []string{"list_a", "list_b"}, archiveCampaignScopes, "archive traversal must use the sorted selected-audience cursor order")
	require.False(t, globalCampaignOrReportRequest)
	require.Equal(t, map[string]int{"campaign_a": 1, "campaign_b": 1}, contentRequests)
	require.Equal(t, map[string]int{"campaign_a": 1, "campaign_b": 1}, reportRequests)
	require.Zero(t, contentRequests["campaign_unknown"], "a campaign without provable audience ownership must fail closed before content fetch")
}

func TestMailchimpAccountWideObjectsAreMarkedWhenAudiencesAreSelected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/templates":
			_, _ = w.Write([]byte(`{"templates":[{"id":1,"name":"Account template","html":"<p>Template</p>"}],"total_items":1}`))
		case r.URL.Path == "/templates/1/default-content":
			_, _ = w.Write([]byte(`{"sections":[]}`))
		case r.URL.Path == "/landing-pages":
			_, _ = w.Write([]byte(`{"landing_pages":[{"id":"landing_1","name":"Account landing"}],"total_items":1}`))
		case r.URL.Path == "/landing-pages/landing_1", r.URL.Path == "/landing-pages/landing_1/content":
			_, _ = w.Write([]byte(`{"id":"landing_1","html":"<p>Landing</p>"}`))
		case r.URL.Path == "/ecommerce/stores":
			_, _ = w.Write([]byte(`{"stores":[{"id":"store_1","name":"Account store"}],"total_items":1}`))
		case strings.HasPrefix(r.URL.Path, "/ecommerce/stores/store_1/"):
			key := strings.TrimPrefix(r.URL.Path, "/ecommerce/stores/store_1/")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{key: []interface{}{}, "total_items": 0})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{
		AccessToken: "token",
		AccountID:   "us1",
		Extra:       map[string]string{SelectedAudiencesExtraKey: "list_b,list_a"},
	}

	templates, _, err := a.ListTemplates(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, templates, 1)
	require.Contains(t, strings.Join(templates[0].Warnings, "\n"), "account-wide")

	landing, _, err := a.ListSourceArchive(context.Background(), sess, "landing:0")
	require.NoError(t, err)
	require.Len(t, landing, 1)
	require.Equal(t, "manual_review", landing[0].Status)
	require.Equal(t, "account_wide", landing[0].Payload["postwave_scope"])
	require.Equal(t, []string{"list_a", "list_b"}, landing[0].Payload["selected_audience_ids"])
	require.Contains(t, strings.Join(landing[0].Warnings, "\n"), "cannot be filtered")

	stores, _, err := a.ListSourceArchive(context.Background(), sess, "ecommerce:0")
	require.NoError(t, err)
	require.Len(t, stores, 1)
	require.Equal(t, "manual_review", stores[0].Status)
	require.Equal(t, "account_wide", stores[0].Payload["postwave_scope"])
	require.Equal(t, []string{"list_a", "list_b"}, stores[0].Payload["selected_audience_ids"])
	require.Contains(t, strings.Join(stores[0].Warnings, "\n"), "cannot be filtered")
}
