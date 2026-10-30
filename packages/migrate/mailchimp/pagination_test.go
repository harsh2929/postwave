// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
)

func TestMailchimpPagination_AllCoreCollectionsCrossProviderBoundary(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		switch {
		case r.URL.Path == "/lists":
			writeGeneratedPage(t, w, "lists", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("aud_%04d", i), "name": fmt.Sprintf("Audience %d", i)}
			})
		case r.URL.Path == "/lists/aud_1/segments":
			writeGeneratedPage(t, w, "segments", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": i + 1, "name": fmt.Sprintf("Segment %d", i), "type": "static"}
			})
		case r.URL.Path == "/lists/aud_interest/interest-categories":
			writeGeneratedPage(t, w, "categories", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("category_%04d", i), "title": fmt.Sprintf("Category %d", i)}
			})
		case r.URL.Path == "/lists/aud_interest/interest-categories/category_1/interests":
			writeGeneratedPage(t, w, "interests", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("interest_%04d", i), "name": fmt.Sprintf("Interest %d", i)}
			})
		case r.URL.Path == "/automations":
			writeGeneratedPage(t, w, "automations", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("auto_%04d", i), "status": "paused", "settings": map[string]interface{}{"title": fmt.Sprintf("Automation %d", i)}}
			})
		case r.URL.Path == "/automations/auto_1/emails":
			writeGeneratedPage(t, w, "emails", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("email_%04d", i), "settings": map[string]interface{}{"template_id": i + 1}}
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1"}

	audiences, err := a.listAllAudiences(context.Background(), sess, "lists.id,lists.name")
	require.NoError(t, err)
	require.Len(t, audiences, 1001)
	require.Equal(t, "aud_1000", audiences[1000].ID)

	segments, err := a.listAllSegments(context.Background(), sess, "aud_1")
	require.NoError(t, err)
	require.Len(t, segments, 1001)
	require.Equal(t, 1001, segments[1000].ID)

	categories, err := a.listAllInterestCategories(context.Background(), sess, "aud_interest")
	require.NoError(t, err)
	require.Len(t, categories, 1001)
	require.Equal(t, "category_1000", categories[1000].ID)
	interests, err := a.listAllInterests(context.Background(), sess, "aud_interest", "category_1")
	require.NoError(t, err)
	require.Len(t, interests, 1001)
	require.Equal(t, "interest_1000", interests[1000].ID)

	automations, err := a.listAllClassicAutomations(context.Background(), sess)
	require.NoError(t, err)
	require.Len(t, automations, 1001)
	require.Equal(t, "auto_1000", automations[1000].ID)

	emails, err := a.listAllClassicAutomationEmails(context.Background(), sess, "auto_1")
	require.NoError(t, err)
	require.Len(t, emails, 1001, "automation email pagination must not stop at Mailchimp's default 10 steps")
	require.Equal(t, "email_1000", emails[1000].ID)
	require.Equal(t, 1001, emails[1000].Settings.TemplateID)
}

func TestMailchimpPagination_ReportAndClickMemberDetails(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		switch {
		case r.URL.Path == "/reports/campaign_1/email-activity":
			writeGeneratedPage(t, w, "emails", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"email_address": fmt.Sprintf("person-%04d@example.com", i)}
			})
		case r.URL.Path == "/reports/campaign_1/click-details":
			writeGeneratedPage(t, w, "urls_clicked", 1, offset, func(int) map[string]interface{} {
				return map[string]interface{}{"id": "link_1", "url": "https://example.test"}
			})
		case r.URL.Path == "/reports/campaign_1/click-details/link_1/members":
			writeGeneratedPage(t, w, "members", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"email_address": fmt.Sprintf("clicker-%04d@example.com", i)}
			})
		case r.URL.Path == "/reports/campaign_1/open-details":
			writeGeneratedPage(t, w, "opens", 0, offset, nil)
		case r.URL.Path == "/reports/campaign_1/sent-to":
			writeGeneratedPage(t, w, "sent_to", 0, offset, nil)
		case r.URL.Path == "/reports/campaign_1/unsubscribed":
			writeGeneratedPage(t, w, "unsubscribes", 0, offset, nil)
		case r.URL.Path == "/reports/campaign_1/abuse-reports":
			writeGeneratedPage(t, w, "abuse_reports", 0, offset, nil)
		case r.URL.Path == "/reports/campaign_1/locations":
			writeGeneratedPage(t, w, "locations", 0, offset, nil)
		case r.URL.Path == "/reports/campaign_1/domain-performance":
			writeGeneratedPage(t, w, "domains", 0, offset, nil)
		case r.URL.Path == "/reports/campaign_1/advice", r.URL.Path == "/reports/campaign_1/eepurl":
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	report := map[string]interface{}{}
	warnings := a.enrichCampaignReport(context.Background(), adapter.Session{AccessToken: "token", AccountID: "us1"}, "campaign_1", report)
	require.Empty(t, warnings)
	require.Len(t, report["email_activity"].(map[string]interface{})["emails"], 1001)
	clickMembers := report["click_members"].(map[string]interface{})
	require.Len(t, clickMembers["link_1"].(map[string]interface{})["members"], 1001)
}

func TestMailchimpPagination_ArchiveSchemaAndEcommerceDetails(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		switch {
		case r.URL.Path == "/lists":
			writeGeneratedPage(t, w, "lists", 1, offset, func(int) map[string]interface{} { return map[string]interface{}{"id": "aud_1"} })
		case r.URL.Path == "/lists/aud_1/merge-fields":
			writeGeneratedPage(t, w, "merge_fields", 1001, offset, func(i int) map[string]interface{} { return map[string]interface{}{"tag": fmt.Sprintf("FIELD%d", i)} })
		case r.URL.Path == "/lists/aud_1/segments":
			writeGeneratedPage(t, w, "segments", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": i + 1, "name": fmt.Sprintf("Segment %d", i)}
			})
		case r.URL.Path == "/lists/aud_1/interest-categories":
			writeGeneratedPage(t, w, "categories", 1, offset, func(int) map[string]interface{} { return map[string]interface{}{"id": "category_1"} })
		case r.URL.Path == "/lists/aud_1/interest-categories/category_1/interests":
			writeGeneratedPage(t, w, "interests", 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("interest_%04d", i)}
			})
		case strings.HasPrefix(r.URL.Path, "/ecommerce/stores/store_1/"):
			key := strings.TrimPrefix(r.URL.Path, "/ecommerce/stores/store_1/")
			writeGeneratedPage(t, w, key, 1001, offset, func(i int) map[string]interface{} {
				return map[string]interface{}{"id": fmt.Sprintf("%s_%04d", key, i)}
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1"}
	items, _, err := a.listAudienceSchemaArchive(context.Background(), sess, 0)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "materialized", items[0].Status)
	require.Len(t, items[0].Payload["merge_fields"], 1001)
	require.Len(t, items[0].Payload["segments"], 1001)
	byCategory := items[0].Payload["interests_by_category"].(map[string]interface{})
	require.Len(t, byCategory["category_1"].(map[string]interface{})["interests"], 1001)

	store := map[string]interface{}{}
	require.NoError(t, a.enrichEcommerceStore(context.Background(), sess, "store_1", store))
	for _, key := range []string{"customers", "products", "orders", "carts"} {
		require.Len(t, store[key], 1001, key)
	}
}

func TestMailchimpPagination_TruncationIsAnError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"lists":       []map[string]interface{}{{"id": "only_one"}},
			"total_items": 1001,
		})
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	_, err := a.listAllAudiences(context.Background(), adapter.Session{AccessToken: "token", AccountID: "us1"}, "lists.id")
	require.Error(t, err)
	require.Contains(t, err.Error(), "pagination truncated")
}

func TestMailchimpPagination_RepeatedFullPageIsAnError(t *testing.T) {
	t.Parallel()
	page := make([]map[string]interface{}, 0, mailchimpMaxPageSize)
	for i := 0; i < mailchimpMaxPageSize; i++ {
		page = append(page, map[string]interface{}{"id": fmt.Sprintf("aud_%04d", i)})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"lists": page})
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	_, err := a.listAllAudiences(context.Background(), adapter.Session{AccessToken: "token", AccountID: "us1"}, "lists.id")
	require.Error(t, err)
	require.Contains(t, err.Error(), "pagination stalled")
}

func TestMailchimpCustomerJourneysNeverProbeUndocumentedExportEndpoints(t *testing.T) {
	t.Parallel()
	var pathsMu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathsMu.Lock()
		paths = append(paths, r.URL.Path)
		pathsMu.Unlock()
		if r.URL.Path == "/automations" {
			_, _ = w.Write([]byte(`{"automations":[],"total_items":0}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1"}
	automations, err := a.ListAutomations(context.Background(), sess)
	require.NoError(t, err)
	require.Empty(t, automations)
	items, _, err := a.listJourneyArchive(context.Background(), sess, 0)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "manual_review", items[0].Status)

	pathsMu.Lock()
	defer pathsMu.Unlock()
	for _, path := range paths {
		require.NotContains(t, path, "customer-journeys")
	}
}

func TestMailchimpSubscribersCursorDetectsRepeatedPageAcrossCalls(t *testing.T) {
	members := make([]map[string]interface{}, 0, mailchimpMaxPageSize)
	for i := 0; i < mailchimpMaxPageSize; i++ {
		members = append(members, map[string]interface{}{
			"id":            fmt.Sprintf("member_%04d", i),
			"email_address": fmt.Sprintf("person-%04d@example.test", i),
			"status":        "subscribed",
		})
	}
	var memberRequests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lists":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"lists": []map[string]interface{}{{"id": "list_a"}}, "total_items": 1})
		case "/lists/list_a/members":
			memberRequests.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"members": members, "total_items": 2000})
		case "/lists/list_a/segments":
			_, _ = w.Write([]byte(`{"segments":[],"total_items":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1"}
	first, next, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, first, mailchimpMaxPageSize)
	require.True(t, strings.HasPrefix(next, mailchimpPageCursorPrefix))

	second, secondNext, err := a.ListSubscribers(context.Background(), sess, next)
	require.Error(t, err)
	require.Contains(t, err.Error(), "pagination stalled")
	require.Empty(t, second)
	require.Empty(t, secondNext)
	require.Equal(t, int64(2), memberRequests.Load())
}

func TestMailchimpSubscriberCursorResumeUsesDeterministicAudienceOrder(t *testing.T) {
	var mu sync.Mutex
	listRequests := 0
	memberAudienceOrder := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/lists":
			mu.Lock()
			listRequests++
			requestNumber := listRequests
			mu.Unlock()
			if requestNumber%2 == 1 {
				_, _ = w.Write([]byte(`{"lists":[{"id":"list_b"},{"id":"list_a"}],"total_items":2}`))
			} else {
				_, _ = w.Write([]byte(`{"lists":[{"id":"list_a"},{"id":"list_b"}],"total_items":2}`))
			}
		case strings.HasSuffix(r.URL.Path, "/members"):
			parts := strings.Split(r.URL.Path, "/")
			listID := parts[2]
			mu.Lock()
			memberAudienceOrder = append(memberAudienceOrder, listID)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"members":     []map[string]interface{}{{"id": "member_" + listID, "email_address": listID + "@example.test", "status": "subscribed"}},
				"total_items": 1,
			})
		case strings.HasSuffix(r.URL.Path, "/segments"):
			_, _ = w.Write([]byte(`{"segments":[],"total_items":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1"}
	first, next, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, first, 1)
	require.Contains(t, first[0].Email, "list_a")
	require.NotEmpty(t, next)

	second, finalCursor, err := a.ListSubscribers(context.Background(), sess, next)
	require.NoError(t, err)
	require.Len(t, second, 1)
	require.Contains(t, second[0].Email, "list_b")
	require.Empty(t, finalCursor)

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{"list_a", "list_b"}, memberAudienceOrder)
}

func TestMailchimpTemplatesCursorDetectsRepeatedPageBeforeDetailFetch(t *testing.T) {
	templates := []mcTemplate{{ID: 1, Name: "Template 1", HTML: "<p>Hello</p>"}}
	var defaultContentRequests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/templates":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"templates": templates, "total_items": 101})
		case strings.HasPrefix(r.URL.Path, "/templates/") && strings.HasSuffix(r.URL.Path, "/default-content"):
			defaultContentRequests.Add(1)
			_, _ = w.Write([]byte(`{"sections":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1"}
	checkpoint := encodeMailchimpPageCursor("templates", "", sourceArchivePageSize, templates)
	items, next, err := a.ListTemplates(context.Background(), sess, checkpoint)
	require.Error(t, err)
	require.Contains(t, err.Error(), "pagination stalled")
	require.Empty(t, items)
	require.Empty(t, next)
	require.Zero(t, defaultContentRequests.Load(), "a repeated inventory page must be rejected before fetching template content again")
}

func TestMailchimpCampaignCursorDetectsRepeatedOutOfScopePageWithoutFetchingPII(t *testing.T) {
	campaigns := make([]map[string]interface{}, 0, mailchimpMaxPageSize)
	for i := 0; i < mailchimpMaxPageSize; i++ {
		campaigns = append(campaigns, map[string]interface{}{
			"id":         fmt.Sprintf("campaign_%04d", i),
			"recipients": map[string]interface{}{"list_id": "list_b"},
		})
	}
	var detailRequests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/campaigns" {
			require.Equal(t, "list_a", r.URL.Query().Get("list_id"))
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"campaigns": campaigns, "total_items": 2000})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/campaigns/") || strings.HasPrefix(r.URL.Path, "/reports/") {
			detailRequests.Add(1)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1", Extra: map[string]string{SelectedAudiencesExtraKey: "list_a"}}
	first, next, err := a.ListCampaignArchive(context.Background(), sess, "")
	require.NoError(t, err)
	require.Empty(t, first, "campaigns owned by another audience must not be materialized")
	require.True(t, strings.HasPrefix(next, mailchimpPageCursorPrefix))
	require.Zero(t, detailRequests.Load(), "out-of-scope campaign IDs must never reach content or recipient-report endpoints")

	second, secondNext, err := a.ListCampaignArchive(context.Background(), sess, next)
	require.Error(t, err)
	require.Contains(t, err.Error(), "pagination stalled")
	require.Empty(t, second)
	require.Empty(t, secondNext)
	require.Zero(t, detailRequests.Load())
}

func TestMailchimpSelectedAutomationsFailClosedWithoutAudienceOwnership(t *testing.T) {
	var unscopedEmailRequests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/automations":
			_, _ = w.Write([]byte(`{"automations":[
				{"id":"selected","recipients":{"list_id":"list_a"},"trigger_settings":{"workflow_type":"welcomeSeries"},"settings":{"title":"Selected"}},
				{"id":"unscoped","trigger_settings":{},"settings":{"title":"Unscoped"}},
				{"id":"other","recipients":{"list_id":"list_b"},"trigger_settings":{"workflow_type":"welcomeSeries"},"settings":{"title":"Other"}}
			],"total_items":3}`))
		case r.URL.Path == "/automations/selected/emails":
			_, _ = w.Write([]byte(`{"emails":[],"total_items":0}`))
		case strings.HasPrefix(r.URL.Path, "/automations/") && strings.HasSuffix(r.URL.Path, "/emails"):
			unscopedEmailRequests.Add(1)
			_, _ = w.Write([]byte(`{"emails":[],"total_items":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{AccessToken: "token", AccountID: "us1", Extra: map[string]string{SelectedAudiencesExtraKey: "list_a"}}
	count, unscoped, err := a.discoverSelectedAutomations(context.Background(), sess, selectedAudienceSet(sess))
	require.NoError(t, err)
	require.Equal(t, 1, count)
	require.Equal(t, 1, unscoped)

	automations, err := a.ListAutomations(context.Background(), sess)
	require.NoError(t, err)
	require.Len(t, automations, 1)
	require.Equal(t, "Selected", automations[0].Name)
	require.Zero(t, unscopedEmailRequests.Load(), "unowned and other-audience automations must be excluded before email-step details are fetched")
}

func TestMailchimpSourceArchiveCursorsDetectRepeatedPagesBeforeEnrichment(t *testing.T) {
	tests := []struct {
		name             string
		cursor           string
		inventoryPath    string
		collection       string
		items            []map[string]interface{}
		enrichmentPrefix string
	}{
		{
			name:             "landing pages",
			cursor:           "landing",
			inventoryPath:    "/landing-pages",
			collection:       "landing_pages",
			items:            generatedArchiveItems("landing", 1),
			enrichmentPrefix: "/landing-pages/",
		},
		{
			name:             "ecommerce stores",
			cursor:           "ecommerce",
			inventoryPath:    "/ecommerce/stores",
			collection:       "stores",
			items:            generatedArchiveItems("store", 1),
			enrichmentPrefix: "/ecommerce/stores/",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var enrichmentRequests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == tc.inventoryPath:
					_ = json.NewEncoder(w).Encode(map[string]interface{}{tc.collection: tc.items, "total_items": 101})
				case strings.HasPrefix(r.URL.Path, tc.enrichmentPrefix):
					enrichmentRequests.Add(1)
					if tc.collection == "stores" {
						parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
						key := parts[len(parts)-1]
						_ = json.NewEncoder(w).Encode(map[string]interface{}{key: []interface{}{}, "total_items": 0})
						return
					}
					_, _ = w.Write([]byte(`{"id":"detail","html":"<p>content</p>"}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			a := New()
			a.BaseURL = server.URL
			sess := adapter.Session{AccessToken: "token", AccountID: "us1"}
			checkpoint := encodeMailchimpPageCursor(sourceArchiveCursorResource, tc.cursor, sourceArchivePageSize, tc.items)
			items, next, err := a.ListSourceArchive(context.Background(), sess, checkpoint)
			require.Error(t, err)
			require.Contains(t, err.Error(), "pagination stalled")
			require.Empty(t, items)
			require.Empty(t, next)
			require.Zero(t, enrichmentRequests.Load(), "a repeated inventory page must be rejected before fetching nested PII/content again")
		})
	}
}

func generatedArchiveItems(prefix string, count int) []map[string]interface{} {
	items := make([]map[string]interface{}, 0, count)
	for i := 0; i < count; i++ {
		items = append(items, map[string]interface{}{"id": fmt.Sprintf("%s_%04d", prefix, i), "name": fmt.Sprintf("%s %d", prefix, i)})
	}
	return items
}

func TestMailchimpHTTPConcurrencyIsCappedAtTen(t *testing.T) {
	t.Parallel()
	var active atomic.Int64
	var maximum atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		current := active.Add(1)
		for {
			previous := maximum.Load()
			if current <= previous || maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		active.Add(-1)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	sess := adapter.Session{
		AccessToken: "token",
		AccountID:   "us1",
		Extra: map[string]string{
			AccountFingerprintExtraKey: "single-adapter-concurrency-test",
		},
	}
	var wg sync.WaitGroup
	errs := make(chan error, 25)
	for i := 0; i < 25; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var out map[string]interface{}
			errs <- a.do(context.Background(), sess, http.MethodGet, "/ping", nil, &out)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.LessOrEqual(t, maximum.Load(), int64(10))
	require.Equal(t, int64(10), maximum.Load(), "the cap should allow all ten documented concurrent requests")
}

func writeGeneratedPage(t *testing.T, w http.ResponseWriter, key string, total, offset int, makeItem func(int) map[string]interface{}) {
	t.Helper()
	end := offset + mailchimpMaxPageSize
	if end > total {
		end = total
	}
	items := make([]map[string]interface{}, 0, max(end-offset, 0))
	if makeItem != nil {
		for i := offset; i < end; i++ {
			items = append(items, makeItem(i))
		}
	}
	require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
		key:           items,
		"total_items": total,
	}))
}
