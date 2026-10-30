// SPDX-License-Identifier: MIT

package beehiiv

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

var sourceArchiveTestCutoff = time.Now().UTC().Truncate(time.Second)

func archiveTestSession() adapter.Session {
	sess := testSession()
	sess.Extra[ArchiveClassificationCutoffExtraKey] = sourceArchiveTestCutoff.Format(time.RFC3339)
	return sess
}

func TestSourceArchiveTraversesProviderSurfacesWithDurableCursors(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-time.Hour).Unix()
	future := now.Add(time.Hour).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/publications/pub_main":
			require.Equal(t, "stats", r.URL.Query().Get("expand"))
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":{"id":"pub_main","name":"Main publication","organization_name":"Org","created":%d,"stats":{"active_subscriptions":10}}}`, past)))
		case "/publications/pub_main/newsletter_lists":
			require.Equal(t, strconv.Itoa(newsletterListArchivePageSize), r.URL.Query().Get("limit"))
			require.Equal(t, "asc", r.URL.Query().Get("direction"))
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"nl_list_product","name":"Product notes","slug":"product-notes","description":"Product updates","status":"archived","auto_subscribe":false,"subscriber_count":1,"created_at":%d,"updated_at":%d}],"limit":1,"page":2,"total_pages":2,"total_results":2}`, past-500, past)))
				return
			}
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"nl_list_weekly","name":"Weekly digest","slug":"weekly-digest","description":"Weekly mail","status":"active","auto_subscribe":true,"subscriber_count":1,"created_at":%d,"updated_at":%d}],"limit":1,"page":1,"total_pages":2,"total_results":2}`, past-1000, past)))
		case "/publications/pub_main/newsletter_lists/nl_list_weekly/subscriptions":
			require.Equal(t, "100", r.URL.Query().Get("limit"))
			require.Equal(t, "asc", r.URL.Query().Get("direction"))
			if r.URL.Query().Get("cursor") == "list-next" {
				_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"nl_list_sub_weekly-lapsed","newsletter_list_id":"nl_list_weekly","subscription_id":"sub_lapsed","status":"inactive","subscribed_at":%d,"unsubscribed_at":%d,"created_at":%d}],"has_more":false}`, past-700, past-100, past-800)))
				return
			}
			require.Empty(t, r.URL.Query().Get("cursor"))
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"nl_list_sub_weekly-active","newsletter_list_id":"nl_list_weekly","subscription_id":"sub_active","status":"active","subscribed_at":%d,"unsubscribed_at":null,"created_at":%d}],"has_more":true,"next_cursor":"list-next"}`, past-600, past-700)))
		case "/publications/pub_main/newsletter_lists/nl_list_product/subscriptions":
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"nl_list_sub_product-paused","newsletter_list_id":"nl_list_product","subscription_id":"sub_paused","status":"paused","subscribed_at":%d,"unsubscribed_at":null,"created_at":%d}],"has_more":false}`, past-300, past-400)))
		case "/publications/pub_main/automations":
			require.Equal(t, strconv.Itoa(automationArchivePageSize), r.URL.Query().Get("limit"))
			require.Equal(t, "stats", r.URL.Query().Get("expand[]"))
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(`{"data":[{"id":"aut_retention","status":"draft","name":"Retention","trigger_events":["unengaged"],"description":"Re-engage readers","stats":{"journeys":{"running":0,"completed":4,"total":4}}}],"limit":1,"page":2,"total_pages":2,"total_results":2}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":["signup","api"],"description":"Onboarding","stats":{"journeys":{"running":1,"completed":9,"total":10},"email":{"recipients":10,"delivered":10,"opens":8,"unique_opens":7,"clicks":4,"unique_clicks":3,"unsubscribes":0,"spam_reports":0}}}],"limit":1,"page":1,"total_pages":2,"total_results":2}`))
		case "/publications/pub_main/automations/aut_welcome/emails":
			require.Equal(t, "100", r.URL.Query().Get("limit"))
			if r.URL.Query().Get("cursor") == "automation-email-next" {
				_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"email-two","automation_step_id":"step-two","subject_line":"Day two","preview_text":"Keep going","status":"inactive","first_sent_at":%d,"last_sent_at":%d,"created_at":%d,"stats":{"email":{"recipients":5,"delivered":5,"opens":3,"unique_opens":3,"clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":0},"clicks":[]}}],"has_more":false}`, past-30, past-20, past-200)))
				return
			}
			require.Empty(t, r.URL.Query().Get("cursor"))
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"email-one","automation_step_id":"step-one","subject_line":"Welcome!","preview_text":"Start here","status":"active","first_sent_at":%d,"last_sent_at":%d,"created_at":%d,"stats":{"email":{"recipients":10,"delivered":9,"opens":8,"unique_opens":7,"clicks":4,"unique_clicks":3,"unsubscribes":0,"spam_reports":0},"clicks":[{"url":"https://example.com/start","total_clicks":4}]}}],"has_more":true,"next_cursor":"automation-email-next"}`, past-90, past-10, past-300)))
		case "/publications/pub_main/automations/aut_retention/emails":
			_, _ = w.Write([]byte(`{"data":[],"has_more":false}`))
		case "/publications/pub_main/automations/aut_welcome/journeys":
			require.Equal(t, "100", r.URL.Query().Get("limit"))
			require.Equal(t, "all", r.URL.Query().Get("status"))
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(`{"data":[{"id":"aj_removed","automation_id":"aut_welcome","status":"manually_removed"}],"limit":2,"page":2,"total_pages":2,"total_results":3}`))
				return
			}
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"aj_running","automation_id":"aut_welcome","status":"in_progress","subscription_id":"sub_running","email":"running@example.com","started_at":%d,"completed_at":null},{"id":"aj_completed","automation_id":"aut_welcome","status":"completed","subscription_id":"sub_completed","email":"completed@example.com","started_at":%d,"completed_at":%d}],"limit":2,"page":1,"total_pages":2,"total_results":3}`, past-100, past-500, past-400)))
		case "/publications/pub_main/automations/aut_retention/journeys":
			_, _ = w.Write([]byte(`{"data":[],"limit":100,"page":1,"total_pages":0,"total_results":0}`))
		case "/publications/pub_main/segments":
			require.Equal(t, "created", r.URL.Query().Get("order_by"))
			require.Equal(t, "asc", r.URL.Query().Get("direction"))
			require.Equal(t, "stats", r.URL.Query().Get("expand[]"))
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[
				{"id":"seg_power","name":"Power readers","type":"dynamic","last_calculated":%d,"total_results":12,"status":"completed","active":true,"stats":{"open_rate":0.75}},
				{"id":"seg_pending","name":"Pending cohort","type":"static","last_calculated":null,"total_results":0,"status":"pending","active":false}
			],"limit":100,"page":1,"total_pages":1,"total_results":2}`, past)))
		case "/publications/pub_main/condition_sets":
			require.Equal(t, "100", r.URL.Query().Get("limit"))
			if r.URL.Query().Get("cursor") == "condition-next" {
				_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"11111111-1111-1111-1111-111111111111","name":"Free readers in US","status":"active","created":%d,"updated":%d,"purpose":"dynamic_content"}],"limit":1,"has_more":false,"next_cursor":null}`, past-600, past-50)))
				return
			}
			require.Empty(t, r.URL.Query().Get("cursor"))
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"00000000-0000-0000-0000-000000000000","name":"Premium subscribers only","status":"active","created":%d,"updated":%d,"purpose":"dynamic_content"}],"limit":1,"has_more":true,"next_cursor":"condition-next"}`, past-700, past-100)))
		case "/publications/pub_main/custom_fields":
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[
				{"id":"00000000-0000-0000-0000-000000000001","kind":"string","display":"Company","created":%d},
				{"id":"00000000-0000-0000-0000-000000000002","kind":"list","display":"Plan","created":%d,"options":["Free","Pro"]}
			],"limit":100,"page":1,"total_pages":1,"total_results":2}`, past-100, past-50)))
		case "/publications/pub_main/tiers":
			require.ElementsMatch(t, []string{"stats", "prices"}, r.URL.Query()["expand[]"])
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(`{"data":[{"id":"tier_yearly","name":"Yearly","status":"active","stats":{"active_subscriptions":1},"prices":[{"id":"price_year","currency":"usd","amount_cents":5000,"interval":"year"}]}],"limit":1,"page":2,"total_pages":2,"total_results":2}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"tier_monthly","name":"Monthly","status":"active","stats":{"active_subscriptions":3},"prices":[{"id":"price_month","currency":"usd","amount_cents":500,"interval":"month"}]}],"limit":1,"page":1,"total_pages":2,"total_results":2}`))
		case "/publications/pub_main/referral_program":
			_, _ = w.Write([]byte(`{"data":[{"id":"mile_one","auto_fulfill":true,"num_referrals":1,"reward":{"id":"rew_one","name":"Sticker","description":"A sticker","image_url":"https://example.com/sticker.png","type":"physical"}}],"page":1,"total_pages":1,"total_results":1}`))
		case "/publications/pub_main/polls":
			require.Equal(t, "1", r.URL.Query().Get("limit"))
			require.ElementsMatch(t, []string{"stats", "trivia_answer"}, r.URL.Query()["expand[]"])
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"poll_color","name":"Favorite color","question":"Pick one","poll_type":"voting","status":"published","created_at":%d,"poll_choices":[{"id":"red","label":"Red"}],"stats":{"completions":2,"vote_counts":{"Red":2}}}],"has_more":false}`, past)))
		case "/publications/pub_main/polls/poll_color/responses":
			require.Equal(t, "post", r.URL.Query().Get("expand[]"))
			if r.URL.Query().Get("cursor") == "response-next" {
				_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"response_two","subscription_id":null,"subscription_deleted":true,"poll_choice_id":"red","poll_choice_label":"Red","created_at":%d}],"has_more":false}`, past+2)))
				return
			}
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"response_one","subscription_id":"sub_one","subscription_deleted":false,"poll_choice_id":"red","poll_choice_label":"Red","created_at":%d,"extended_feedback":"Bright"}],"has_more":true,"next_cursor":"response-next"}`, past+1)))
		case "/publications/pub_main/post_templates":
			_, _ = w.Write([]byte(`{"data":[{"id":"post_template_news","name":"Newsletter"}],"page":1,"total_pages":1,"total_results":1}`))
		case "/publications/pub_main/posts":
			require.Equal(t, "all", r.URL.Query().Get("status"))
			require.Empty(t, r.URL.Query()["expand"])
			require.Empty(t, r.URL.Query()["expand[]"])
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[
				{"id":"post_sent","title":"Sent","status":"confirmed","platform":"email","publish_date":%d},
				{"id":"post_draft","title":"Draft","status":"draft","platform":"email","created":%d},
				{"id":"post_scheduled","title":"Scheduled","status":"confirmed","platform":"email","created":%d,"publish_date":%d},
				{"id":"post_web","title":"Web only","status":"confirmed","platform":"web","created":%d,"publish_date":%d}
			],"page":1,"total_pages":1,"total_results":4}`, past, past, past, future, past, past)))
		case "/publications/pub_main/posts/post_draft":
			require.ElementsMatch(t, postExpansionValues()["expand"], r.URL.Query()["expand"])
			require.Empty(t, r.URL.Query()["expand[]"])
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":{"id":"post_draft","title":"Draft","status":"draft","platform":"email","created":%d,"content":{"free":{"email":"<p>draft</p>","web":"","rss":""},"premium":{"email":"","web":""}}}}`, past)))
		case "/publications/pub_main/posts/post_scheduled":
			require.ElementsMatch(t, postExpansionValues()["expand"], r.URL.Query()["expand"])
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":{"id":"post_scheduled","title":"Scheduled","status":"confirmed","platform":"email","created":%d,"publish_date":%d,"content":{"free":{"email":"<p>scheduled</p>","web":"","rss":""},"premium":{"email":"","web":""}}}}`, past, future)))
		case "/publications/pub_main/posts/post_web":
			require.ElementsMatch(t, postExpansionValues()["expand"], r.URL.Query()["expand"])
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":{"id":"post_web","title":"Web only","status":"confirmed","platform":"web","created":%d,"publish_date":%d,"content":{"free":{"email":"","web":"<p>web</p>","rss":""},"premium":{"email":"","web":""}}}}`, past, past)))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	cursor := ""
	seenCursors := map[string]struct{}{}
	var items []canonical.SourceArchiveItem
	for calls := 0; ; calls++ {
		require.Less(t, calls, 50, "source archive traversal did not terminate")
		batch, next, err := a.ListSourceArchive(context.Background(), archiveTestSession(), cursor)
		require.NoError(t, err)
		items = append(items, batch...)
		if next == "" {
			break
		}
		require.NotEqual(t, cursor, next)
		_, duplicate := seenCursors[next]
		require.False(t, duplicate, "source archive cursor repeated")
		seenCursors[next] = struct{}{}
		cursor = next
	}

	require.Len(t, items, 39)
	require.Equal(t, 1, countArchiveType(items, "beehiiv_publication"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_newsletter_list"))
	require.Equal(t, 3, countArchiveType(items, "beehiiv_newsletter_list_subscription"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_newsletter_list_history_manifest"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_automation"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_automation_email"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_automation_email_inventory_manifest"))
	require.Equal(t, 3, countArchiveType(items, "beehiiv_automation_journey"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_automation_journey_inventory_manifest"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_segment"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_condition_set"))
	require.Equal(t, 1, countArchiveType(items, "beehiiv_condition_set_inventory_manifest"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_custom_field"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_premium_tier"))
	require.Equal(t, 1, countArchiveType(items, "beehiiv_referral_milestone"))
	require.Equal(t, 1, countArchiveType(items, "beehiiv_poll"))
	require.Equal(t, 2, countArchiveType(items, "beehiiv_poll_response"))
	require.Equal(t, 1, countArchiveType(items, "beehiiv_post_template"))
	require.Equal(t, 3, countArchiveType(items, "beehiiv_non_campaign_post"))
	require.Equal(t, 1, countArchiveType(items, "parity_gap:website_settings"))
	require.Equal(t, 1, countArchiveType(items, "parity_gap:referrals_boosts"))
	require.Equal(t, 1, countArchiveType(items, "parity_gap:ad_network"))
	require.Nil(t, findArchiveItem(items, "post_sent"), "sent newsletter must remain in campaign archive only")
	weekly := findArchiveItem(items, "nl_list_weekly")
	require.NotNil(t, weekly)
	require.Equal(t, "active", weekly.Status)
	require.Equal(t, true, weekly.Payload["auto_subscribe"])
	lapsed := findArchiveItem(items, "nl_list_sub_weekly-lapsed")
	require.NotNil(t, lapsed)
	require.Equal(t, "sub_lapsed", lapsed.LinkedContactID)
	require.Equal(t, "inactive", lapsed.Status)
	require.Equal(t, float64(past-700), lapsed.Payload["subscribed_at"])
	require.Equal(t, float64(past-100), lapsed.Payload["unsubscribed_at"])
	require.Equal(t, float64(past-800), lapsed.Payload["created_at"])
	require.Equal(t, time.Unix(past-800, 0).UTC(), *lapsed.OccurredAt)
	weeklyHistory := findArchiveItemByType(items, "beehiiv_newsletter_list_history_manifest", "nl_list_weekly")
	require.NotNil(t, weeklyHistory)
	require.Equal(t, 2, weeklyHistory.Payload["records_preserved"])
	require.Equal(t, true, weeklyHistory.Payload["traversal_complete"])
	welcome := findArchiveItem(items, "aut_welcome")
	require.NotNil(t, welcome)
	require.Equal(t, []interface{}{"signup", "api"}, welcome.Payload["trigger_events"])
	require.Equal(t, false, welcome.Payload["executable_graph_exported"])
	require.Equal(t, false, welcome.Payload["message_bodies_exported"])
	require.Contains(t, welcome.Payload, "stats")
	firstAutomationEmail := findArchiveItem(items, "aut_welcome:email:email-one")
	require.NotNil(t, firstAutomationEmail)
	require.Equal(t, "aut_welcome", firstAutomationEmail.Payload["automation_id"])
	require.Equal(t, "step-one", firstAutomationEmail.Payload["automation_step_id"])
	require.Equal(t, "Welcome!", firstAutomationEmail.Payload["subject_line"])
	require.Equal(t, "Start here", firstAutomationEmail.Payload["preview_text"])
	require.Equal(t, "active", firstAutomationEmail.Status)
	require.Equal(t, float64(past-90), firstAutomationEmail.Payload["first_sent_at"])
	require.Equal(t, float64(past-10), firstAutomationEmail.Payload["last_sent_at"])
	require.Equal(t, time.Unix(past-300, 0).UTC(), *firstAutomationEmail.OccurredAt)
	require.Equal(t, false, firstAutomationEmail.Payload["message_body_exported"])
	require.Contains(t, firstAutomationEmail.Payload, "stats")
	welcomeInventory := findArchiveItemByType(items, "beehiiv_automation_email_inventory_manifest", "aut_welcome")
	require.NotNil(t, welcomeInventory)
	require.Equal(t, 2, welcomeInventory.Payload["records_preserved"])
	retentionInventory := findArchiveItemByType(items, "beehiiv_automation_email_inventory_manifest", "aut_retention")
	require.NotNil(t, retentionInventory)
	require.Equal(t, 0, retentionInventory.Payload["records_preserved"])
	runningJourney := findArchiveItem(items, "aut_welcome:journey:aj_running")
	require.NotNil(t, runningJourney)
	require.Equal(t, "sub_running", runningJourney.LinkedContactID)
	require.Equal(t, "in_progress", runningJourney.Status)
	require.Equal(t, false, runningJourney.Payload["runtime_replayed"])
	welcomeJourneyInventory := findArchiveItemByType(items, "beehiiv_automation_journey_inventory_manifest", "aut_welcome")
	require.NotNil(t, welcomeJourneyInventory)
	require.Equal(t, 3, welcomeJourneyInventory.Payload["records_preserved"])
	removedJourney := findArchiveItem(items, "aut_welcome:journey:aj_removed")
	require.NotNil(t, removedJourney)
	require.Equal(t, "manually_removed", removedJourney.Status)
	require.Empty(t, removedJourney.LinkedContactID)
	require.Nil(t, removedJourney.OccurredAt)
	retentionJourneyInventory := findArchiveItemByType(items, "beehiiv_automation_journey_inventory_manifest", "aut_retention")
	require.NotNil(t, retentionJourneyInventory)
	require.Equal(t, 0, retentionJourneyInventory.Payload["records_preserved"])
	segment := findArchiveItem(items, "seg_power")
	require.NotNil(t, segment)
	require.Equal(t, false, segment.Payload["saved_predicates_exported"])
	require.Equal(t, float64(12), segment.Payload["total_results"])
	require.Contains(t, segment.Payload, "stats")
	conditionSet := findArchiveItem(items, "00000000-0000-0000-0000-000000000000")
	require.NotNil(t, conditionSet)
	require.Equal(t, "dynamic_content", conditionSet.Payload["purpose"])
	require.Equal(t, false, conditionSet.Payload["saved_predicates_exported"])
	conditionManifest := findArchiveItem(items, "beehiiv:condition_sets:manifest")
	require.NotNil(t, conditionManifest)
	require.Equal(t, 2, conditionManifest.Payload["records_preserved"])
	require.Equal(t, "condition_sets:read", conditionManifest.Payload["required_scope"])
	field := findArchiveItem(items, "00000000-0000-0000-0000-000000000002")
	require.NotNil(t, field)
	require.Equal(t, "Plan", field.Name)
	require.Equal(t, "list", field.Payload["kind"])
	require.Equal(t, []interface{}{"Free", "Pro"}, field.Payload["options"])
	require.Equal(t, true, field.Payload["values_imported_with_subscribers"])

	response := findArchiveItem(items, "response_one")
	require.NotNil(t, response)
	require.Equal(t, "sub_one", response.LinkedContactID)
	require.Equal(t, "poll_color", response.Payload["poll_id"])
	template := findArchiveItem(items, "post_template_news")
	require.Equal(t, false, template.Payload["template_body_exported"])
	scheduled := findArchiveItem(items, "post_scheduled")
	require.Equal(t, "scheduled", scheduled.Payload["postwave_archive_classification"])
	require.NotEmpty(t, scheduled.Payload["postwave_classification_cutoff"])
	monthly := findArchiveItem(items, "tier_monthly")
	require.Contains(t, monthly.Payload, "prices")
	require.Empty(t, monthly.Warnings)
}

func TestSourceArchiveRequiredInventoriesFailClosed(t *testing.T) {
	tests := []struct {
		name  string
		state beehiivArchiveState
		body  string
		code  int
	}{
		{
			name:  "newsletter-list definitions require scope",
			state: beehiivArchiveState{Version: 1, Phase: archiveNewsletterLists, Page: 1},
			body:  `{"email":"list-owner@example.com"}`,
			code:  http.StatusForbidden,
		},
		{
			name:  "newsletter-list history cannot disappear",
			state: beehiivArchiveState{Version: 1, Phase: archiveNewsletterListSubscriptions, NewsletterListIDs: []string{"nl_list_deleted", "nl_list_remaining"}},
			body:  `{"email":"deleted-contact@example.com"}`,
			code:  http.StatusNotFound,
		},
		{
			name:  "automation definitions require scope",
			state: beehiivArchiveState{Version: 1, Phase: archiveAutomations, Page: 1},
			body:  `{"description":"private automation detail"}`,
			code:  http.StatusForbidden,
		},
		{
			name:  "automation email inventory cannot disappear",
			state: beehiivArchiveState{Version: 1, Phase: archiveAutomationEmails, AutomationIDs: []string{"aut_deleted", "aut_remaining"}},
			body:  `{"subject_line":"private subject"}`,
			code:  http.StatusNotFound,
		},
		{
			name:  "automation journey inventory cannot disappear",
			state: beehiivArchiveState{Version: 1, Phase: archiveAutomationJourneys, Page: 1, AutomationIDs: []string{"aut_deleted", "aut_remaining"}},
			body:  `{"email":"private journey contact"}`,
			code:  http.StatusNotFound,
		},
		{
			name:  "segment definitions require scope",
			state: beehiivArchiveState{Version: 1, Phase: archiveSegments, Page: 1},
			body:  `{"description":"private segment detail"}`,
			code:  http.StatusForbidden,
		},
		{
			name:  "condition-set definitions require scope",
			state: beehiivArchiveState{Version: 1, Phase: archiveConditionSets},
			body:  `{"name":"private dynamic content audience"}`,
			code:  http.StatusForbidden,
		},
		{
			name:  "custom-field definitions require scope",
			state: beehiivArchiveState{Version: 1, Phase: archiveCustomFields, Page: 1},
			body:  `{"display":"private field"}`,
			code:  http.StatusForbidden,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			tc.state.ClassificationCutoff = sourceArchiveTestCutoff.Unix()
			items, next, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(tc.state))
			require.Error(t, err)
			require.Empty(t, items)
			require.Empty(t, next)
			require.NotContains(t, err.Error(), "example.com")
			require.NotContains(t, err.Error(), "private")
		})
	}
}

func TestSourceArchiveOptionalRecordsRejectTruncatedSuccessfulResponses(t *testing.T) {
	_, err := mapTierArchiveItem(map[string]interface{}{
		"id": "tier_gold", "name": "Gold", "status": "active", "prices": []interface{}{},
	})
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "stats expansion")

	_, err = mapReferralMilestoneArchiveItem(map[string]interface{}{
		"id": "mile_one", "auto_fulfill": true, "num_referrals": float64(1),
	})
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "reward")

	_, err = mapPollArchiveItem(map[string]interface{}{
		"id": "poll_one", "name": "Question", "question": "Pick one", "poll_type": "voting", "status": "published",
		"created_at": float64(1), "poll_choices": []interface{}{},
	})
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "stats expansion")

	_, err = mapPostTemplateArchiveItem(map[string]interface{}{"id": "post_template_one"})
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "name")
}

func TestSourceArchiveOptionalScopeFailuresBecomeSanitizedEvidence(t *testing.T) {

	t.Run("forbidden optional tier endpoint", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/publications/pub_main/tiers":
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"email":"private@example.com"}`))
			case "/publications/pub_main":
				_, _ = w.Write([]byte(`{"data":{"id":"pub_main","name":"Main"}}`))
			default:
				http.NotFound(w, r)
			}
		}))
		defer server.Close()
		a := New()
		a.BaseURL = server.URL
		state := beehiivArchiveState{Version: 1, Phase: archiveTiers, Page: 1, ClassificationCutoff: sourceArchiveTestCutoff.Unix()}
		items, next, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
		require.NoError(t, err)
		require.Len(t, items, 1)
		require.Equal(t, "source_archive_warning:beehiiv:premium_tiers", items[0].SourceID)
		require.Equal(t, "beehiiv_premium_tier", items[0].ResourceType)
		require.Equal(t, "forbidden_or_scope_missing", items[0].Payload["error_code"])
		require.NotContains(t, fmt.Sprint(items[0]), "private@example.com")
		decoded, err := parseBeehiivArchiveCursor(next, time.Now())
		require.NoError(t, err)
		require.Equal(t, archiveReferrals, decoded.Phase)
	})

	t.Run("not found optional poll endpoint", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"extended_feedback":"private survey answer"}`))
		}))
		defer server.Close()
		a := New()
		a.BaseURL = server.URL
		state := beehiivArchiveState{Version: 1, Phase: archivePolls, ClassificationCutoff: sourceArchiveTestCutoff.Unix()}
		items, next, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
		require.NoError(t, err)
		require.Len(t, items, 1)
		require.Equal(t, "not_found", items[0].Payload["error_code"])
		require.NotContains(t, fmt.Sprint(items[0]), "private survey answer")
		decoded, err := parseBeehiivArchiveCursor(next, time.Now())
		require.NoError(t, err)
		require.Equal(t, archiveTemplates, decoded.Phase)
	})
}

func TestFinalPollResponseScopeFailureTransitionsToValidTemplateCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/polls/poll_final/responses":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"detail":"scope missing"}`))
		case "/publications/pub_main":
			_, _ = w.Write([]byte(`{"data":{"id":"pub_main","name":"Main"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	state := beehiivArchiveState{
		Version: 1, Phase: archivePollResponses, PollID: "poll_final",
		ClassificationCutoff: sourceArchiveTestCutoff.Unix(),
	}
	items, next, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "beehiiv_poll_response", items[0].ResourceType)
	decoded, err := parseBeehiivArchiveCursor(next, time.Now())
	require.NoError(t, err)
	require.Equal(t, archiveTemplates, decoded.Phase)
	require.False(t, decoded.SkipPollResponses, "a terminal phase must not carry a poll-only skip flag")
}

func TestSourceArchiveFailsClosedAtBeehiivOffsetPageCap(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":101,"total_results":10001}`))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	state := beehiivArchiveState{Version: 1, Phase: archiveTiers, Page: 1, ClassificationCutoff: sourceArchiveTestCutoff.Unix()}
	_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrUnsupported))
}

func TestSourceArchiveRejectsMalformedAndRepeatedProviderCursors(t *testing.T) {
	_, _, err := New().ListSourceArchive(context.Background(), archiveTestSession(), "bhiv2:not-base64!!!")
	require.Error(t, err)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "same", r.URL.Query().Get("cursor"))
		_, _ = w.Write([]byte(`{"data":[{"id":"poll_one","name":"One","question":"Q","poll_type":"voting","status":"published","created_at":1,"poll_choices":[]}],"has_more":true,"next_cursor":"same"}`))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	state := beehiivArchiveState{Version: 1, Phase: archivePolls, ProviderCursor: "same", ClassificationCutoff: sourceArchiveTestCutoff.Unix()}
	_, _, err = a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
}

func TestNewsletterListSubscriptionArchiveRejectsInvalidCursorPagination(t *testing.T) {
	validRecord := `{"id":"nl_list_sub_record-one","newsletter_list_id":"nl_list_weekly","subscription_id":"sub_one","status":"active","subscribed_at":10,"unsubscribed_at":null,"created_at":9}`
	tests := []struct {
		name     string
		current  string
		response string
	}{
		{name: "repeated cursor", current: "same", response: `{"data":[` + validRecord + `],"has_more":true,"next_cursor":"same"}`},
		{name: "missing cursor", response: `{"data":[` + validRecord + `],"has_more":true}`},
		{name: "empty page with more", response: `{"data":[],"has_more":true,"next_cursor":"next"}`},
		{name: "missing has more", response: `{"data":[` + validRecord + `]}`},
		{name: "cursor when complete", response: `{"data":[` + validRecord + `],"has_more":false,"next_cursor":"stale"}`},
		{name: "control character in cursor", response: `{"data":[` + validRecord + `],"has_more":true,"next_cursor":"next\u0000bad"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, tc.current, r.URL.Query().Get("cursor"))
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			state := beehiivArchiveState{
				Version: 1, Phase: archiveNewsletterListSubscriptions,
				ProviderCursor: tc.current, NewsletterListIDs: []string{"nl_list_weekly"},
				ClassificationCutoff: sourceArchiveTestCutoff.Unix(),
			}
			_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
		})
	}
}

func TestNewsletterListSubscriptionArchiveRejectsMismatchedOrIncompleteHistory(t *testing.T) {
	tests := []struct {
		name   string
		record string
	}{
		{name: "mismatched list", record: `{"id":"nl_list_sub_record-one","newsletter_list_id":"nl_list_other","subscription_id":"sub_one","status":"active","created_at":9}`},
		{name: "missing contact linkage", record: `{"id":"nl_list_sub_record-one","newsletter_list_id":"nl_list_weekly","status":"active","created_at":9}`},
		{name: "unknown status", record: `{"id":"nl_list_sub_record-one","newsletter_list_id":"nl_list_weekly","subscription_id":"sub_one","status":"deleted","created_at":9}`},
		{name: "missing creation time", record: `{"id":"nl_list_sub_record-one","newsletter_list_id":"nl_list_weekly","subscription_id":"sub_one","status":"active"}`},
		{name: "invalid unsubscribe time", record: `{"id":"nl_list_sub_record-one","newsletter_list_id":"nl_list_weekly","subscription_id":"sub_one","status":"inactive","created_at":9,"unsubscribed_at":"yesterday"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"data":[` + tc.record + `],"has_more":false}`))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			state := beehiivArchiveState{
				Version: 1, Phase: archiveNewsletterListSubscriptions,
				NewsletterListIDs: []string{"nl_list_weekly"}, ClassificationCutoff: sourceArchiveTestCutoff.Unix(),
			}
			_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
		})
	}
}

func TestAutomationEmailArchiveRejectsInvalidCursorPagination(t *testing.T) {
	validRecord := `{"id":"email-one","automation_step_id":"step-one","subject_line":"Welcome","preview_text":"Hello","status":"active","first_sent_at":10,"last_sent_at":11,"created_at":9,"stats":{"email":{"recipients":1,"delivered":1,"opens":1,"unique_opens":1,"clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":0}}}`
	tests := []struct {
		name     string
		current  string
		response string
	}{
		{name: "repeated cursor", current: "same", response: `{"data":[` + validRecord + `],"has_more":true,"next_cursor":"same"}`},
		{name: "missing cursor", response: `{"data":[` + validRecord + `],"has_more":true}`},
		{name: "empty page with more", response: `{"data":[],"has_more":true,"next_cursor":"next"}`},
		{name: "missing has more", response: `{"data":[` + validRecord + `]}`},
		{name: "cursor when complete", response: `{"data":[` + validRecord + `],"has_more":false,"next_cursor":"stale"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, tc.current, r.URL.Query().Get("cursor"))
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			state := beehiivArchiveState{
				Version: 1, Phase: archiveAutomationEmails,
				ProviderCursor: tc.current, AutomationIDs: []string{"aut_welcome"},
				ClassificationCutoff: sourceArchiveTestCutoff.Unix(),
			}
			_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
		})
	}
}

func TestAutomationArchiveRejectsIncompleteRebuildMetadata(t *testing.T) {
	tests := []struct {
		name       string
		automation string
		want       string
	}{
		{name: "missing id", automation: `{"status":"running","name":"Welcome","trigger_events":["signup"]}`},
		{name: "missing trigger events", automation: `{"id":"aut_welcome","status":"running","name":"Welcome"}`},
		{name: "invalid trigger event", automation: `{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":[null]}`},
		{name: "missing requested stats", automation: `{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":["signup"]}`},
		{name: "unknown-only requested stats", automation: `{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":["signup"],"stats":{"total_sent":1}}`, want: "no documented journey or aggregate email statistics"},
		{name: "invalid journey stats object", automation: `{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":["signup"],"stats":{"journeys":"invalid"}}`, want: "invalid journey statistics"},
		{name: "incomplete journey stats", automation: `{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":["signup"],"stats":{"journeys":{"running":0,"completed":1}}}`, want: "missing total"},
		{name: "invalid aggregate email stats", automation: `{"id":"aut_welcome","status":"running","name":"Welcome","trigger_events":["signup"],"stats":{"email":{"recipients":1}}}`, want: "missing delivered"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"data":[` + tc.automation + `],"page":1,"total_pages":1,"total_results":1}`))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			state := beehiivArchiveState{Version: 1, Phase: archiveAutomations, Page: 1, ClassificationCutoff: sourceArchiveTestCutoff.Unix()}
			_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
			if tc.want != "" {
				require.ErrorContains(t, err, tc.want)
			}
		})
	}
}

func TestAutomationEmailArchiveRejectsIncompleteMetadata(t *testing.T) {
	tests := []struct {
		name  string
		email string
	}{
		{name: "missing step id", email: `{"id":"email-one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":9}`},
		{name: "missing creation time", email: `{"id":"email-one","automation_step_id":"step-one","subject_line":"Welcome","preview_text":"Hi","status":"active"}`},
		{name: "invalid sent time", email: `{"id":"email-one","automation_step_id":"step-one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":9,"first_sent_at":"today"}`},
		{name: "missing engagement stats", email: `{"id":"email-one","automation_step_id":"step-one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":9}`},
		{name: "incomplete engagement stats", email: `{"id":"email-one","automation_step_id":"step-one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":9,"stats":{"email":{"recipients":1}}}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"data":[` + tc.email + `],"has_more":false}`))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			state := beehiivArchiveState{
				Version: 1, Phase: archiveAutomationEmails,
				AutomationIDs: []string{"aut_welcome"}, ClassificationCutoff: sourceArchiveTestCutoff.Unix(),
			}
			_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
		})
	}
}

func TestBoundedArchiveInventoriesRejectAmbiguousFullPages(t *testing.T) {
	tests := []struct {
		name      string
		phase     string
		path      string
		pageSize  int
		makeEntry func(int) string
	}{
		{
			name: "newsletter lists", phase: archiveNewsletterLists, path: "/publications/pub_main/newsletter_lists", pageSize: newsletterListArchivePageSize,
			makeEntry: func(i int) string {
				return fmt.Sprintf(`{"id":"nl_list_%d","name":"List %d","slug":"list-%d","status":"active","auto_subscribe":false,"subscriber_count":0,"created_at":1,"updated_at":1}`, i, i, i)
			},
		},
		{
			name: "automations", phase: archiveAutomations, path: "/publications/pub_main/automations", pageSize: automationArchivePageSize,
			makeEntry: func(i int) string {
				return fmt.Sprintf(`{"id":"aut_%d","status":"draft","name":"Automation %d","trigger_events":[]}`, i, i)
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			entries := make([]string, 0, tc.pageSize)
			for i := 0; i < tc.pageSize; i++ {
				entries = append(entries, tc.makeEntry(i))
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, tc.path, r.URL.Path)
				_, _ = w.Write([]byte(`{"data":[` + strings.Join(entries, ",") + `],"page":1}`))
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			state := beehiivArchiveState{Version: 1, Phase: tc.phase, Page: 1, ClassificationCutoff: sourceArchiveTestCutoff.Unix()}
			_, _, err := a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(state))
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
		})
	}
}

func TestNewsletterListArchiveCursorStateIsBoundedAndValidated(t *testing.T) {
	cutoff := sourceArchiveTestCutoff.Unix()
	valid := beehiivArchiveState{
		Version: 1, Phase: archiveNewsletterListSubscriptions,
		NewsletterListIDs:   []string{"nl_list_one", "nl_list_two"},
		NewsletterListIndex: 1, NextNewsletterListPage: 2,
		ProviderCursor: "opaque-next", ClassificationCutoff: cutoff,
	}
	encoded := encodeBeehiivArchiveCursor(valid)
	require.Less(t, len(encoded), maxArchiveCursorBytes)
	decoded, err := parseBeehiivArchiveCursor(encoded, time.Now())
	require.NoError(t, err)
	require.Equal(t, valid, decoded)

	maxIDs := make([]string, 0, newsletterListArchivePageSize)
	for i := 0; i < newsletterListArchivePageSize; i++ {
		prefix := fmt.Sprintf("nl_list_%02d", i)
		maxIDs = append(maxIDs, prefix+strings.Repeat("a", maxArchiveProviderIDBytes-len(prefix)))
	}
	maxState := beehiivArchiveState{
		Version: 1, Phase: archiveNewsletterListSubscriptions,
		NewsletterListIDs: maxIDs, ProviderCursor: strings.Repeat("c", maxArchiveProviderCursorBytes),
		ClassificationCutoff: cutoff,
	}
	maxEncoded := encodeBeehiivArchiveCursor(maxState)
	require.Less(t, len(maxEncoded), maxArchiveCursorBytes)
	_, err = parseBeehiivArchiveCursor(maxEncoded, time.Now())
	require.NoError(t, err)

	invalidStates := []beehiivArchiveState{
		{Version: 1, Phase: archiveNewsletterLists, Page: 1, SkipNewsletterListSubscriptions: true, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveNewsletterListSubscriptions, NewsletterListIDs: []string{"nl_list_duplicate", "nl_list_duplicate"}, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveNewsletterListSubscriptions, NewsletterListIDs: []string{"bad-list"}, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveNewsletterListSubscriptions, NewsletterListIDs: []string{"nl_list_one"}, NewsletterListIndex: 1, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveNewsletterListSubscriptions, NewsletterListIDs: []string{"nl_list_one"}, ProviderCursor: strings.Repeat("x", maxArchiveProviderCursorBytes+1), ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveNewsletterListSubscriptions, NewsletterListIDs: []string{"nl_list_one"}, NewsletterListSubscriptionCount: maxArchiveChildRecords + 1, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveAutomations, Page: 1, SkipAutomationEmails: true, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveAutomationEmails, AutomationIDs: []string{"aut_duplicate", "aut_duplicate"}, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveAutomationEmails, AutomationIDs: []string{"bad-automation"}, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveAutomationEmails, AutomationIDs: []string{"aut_one"}, AutomationIndex: 1, ClassificationCutoff: cutoff},
		{Version: 1, Phase: archiveAutomationEmails, AutomationIDs: []string{"aut_one"}, AutomationEmailCount: maxArchiveChildRecords + 1, ClassificationCutoff: cutoff},
	}
	for _, state := range invalidStates {
		_, err := parseBeehiivArchiveCursor(encodeBeehiivArchiveCursor(state), time.Now())
		require.Error(t, err)
	}
}

func countArchiveType(items []canonical.SourceArchiveItem, resourceType string) int {
	count := 0
	for _, item := range items {
		if item.ResourceType == resourceType {
			count++
		}
	}
	return count
}

func findArchiveItem(items []canonical.SourceArchiveItem, sourceID string) *canonical.SourceArchiveItem {
	for i := range items {
		if items[i].SourceID == sourceID {
			return &items[i]
		}
	}
	return nil
}

func findArchiveItemByType(items []canonical.SourceArchiveItem, resourceType, sourceID string) *canonical.SourceArchiveItem {
	for i := range items {
		if items[i].ResourceType == resourceType && items[i].SourceID == sourceID {
			return &items[i]
		}
	}
	return nil
}

func TestSourceArchiveCursorPreservesClassificationCutoff(t *testing.T) {
	cutoff := time.Unix(1_700_000_000, 0).UTC()
	state, err := parseBeehiivArchiveCursor("", cutoff)
	require.NoError(t, err)
	encoded := encodeBeehiivArchiveCursor(transitionBeehiivArchiveState(state, archivePosts, 1))
	decoded, err := parseBeehiivArchiveCursor(encoded, cutoff.Add(24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, cutoff.Unix(), decoded.ClassificationCutoff)
	require.True(t, strings.HasPrefix(encoded, beehiivArchiveCursorPrefix))
	require.Equal(t, "1", strconv.Itoa(decoded.Page))
}

func TestSourceArchiveBindsClassificationCutoffToMigrationSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/publications/pub_main", r.URL.Path)
		_, _ = w.Write([]byte(`{"data":{"id":"pub_main","name":"Main","created":1}}`))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL

	_, next, err := a.ListSourceArchive(context.Background(), archiveTestSession(), "")
	require.NoError(t, err)
	state, err := parseBeehiivArchiveCursor(next, time.Now())
	require.NoError(t, err)
	require.Equal(t, sourceArchiveTestCutoff.Unix(), state.ClassificationCutoff)

	mismatched := state
	mismatched.ClassificationCutoff++
	_, _, err = a.ListSourceArchive(context.Background(), archiveTestSession(), encodeBeehiivArchiveCursor(mismatched))
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrSourceUnavailable))
}
