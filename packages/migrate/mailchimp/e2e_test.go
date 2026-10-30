// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// mailchimpServer is a hand-rolled httptest mock that returns canned JSON for
// the Mailchimp endpoints the adapter touches.
type mailchimpServer struct {
	t                  *testing.T
	listsResp          string
	mergeFieldsResp    string
	segmentsResp       string
	automationsLst     string
	automationsEm      string
	campaignsResp      string
	contentResp        string
	reportsResp        string
	templatesResp      string
	defaultContentResp string
	landingResp        string
	landingDetailResp  string
	landingContentResp string
	ecommerceResp      string
	customersResp      string
	productsResp       string
	ordersResp         string
	cartsResp          string
	interestsResp      string
	formResp           string
	emailActivityResp  string
	clickDetailsResp   string
	clickMembersResp   string
	openDetailsResp    string
	sentToResp         string

	// Per-list members — keyed by list_id, sliced by offset.
	membersByList map[string]map[int]string
	// Per-list static segment members — keyed by list_id, segment_id, offset.
	segmentMembersByList map[string]map[int]map[int]string

	// Rate-limit harness: trip429ForPath causes a 429 with Retry-After once
	// for that exact request path; subsequent requests succeed.
	trip429ForPath string
	tripped        atomic.Bool

	// authToken is the expected bearer; if non-empty and request differs we
	// return 401.
	authToken string

	calls atomic.Int64
}

func (m *mailchimpServer) handler(w http.ResponseWriter, r *http.Request) {
	m.calls.Add(1)
	if m.authToken != "" && r.Header.Get("Authorization") != "Bearer "+m.authToken {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"detail":"bad token"}`))
		return
	}
	pathQ := r.URL.Path + "?" + r.URL.RawQuery

	if m.trip429ForPath != "" && !m.tripped.Load() && strings.HasPrefix(pathQ, m.trip429ForPath) {
		m.tripped.Store(true)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}

	switch {
	case r.URL.Path == "/":
		_, _ = w.Write([]byte(`{"account_id":"e2e-account"}`))
	case r.URL.Path == "/lists":
		_, _ = w.Write([]byte(m.listsResp))
	case strings.HasSuffix(r.URL.Path, "/merge-fields") && strings.Contains(r.URL.Path, "/lists/"):
		_, _ = w.Write([]byte(m.mergeFieldsResp))
	case strings.Contains(r.URL.Path, "/interest-categories/") && strings.HasSuffix(r.URL.Path, "/interests"):
		_, _ = w.Write([]byte(m.interestsResp))
	case strings.Contains(r.URL.Path, "/segments/") && strings.HasSuffix(r.URL.Path, "/members") && strings.Contains(r.URL.Path, "/lists/"):
		parts := strings.Split(r.URL.Path, "/")
		listID := parts[2]
		segmentID := 0
		_, _ = fmt.Sscanf(parts[4], "%d", &segmentID)
		offset := 0
		if v := r.URL.Query().Get("offset"); v != "" {
			for _, ch := range v {
				if ch < '0' || ch > '9' {
					offset = -1
					break
				}
				offset = offset*10 + int(ch-'0')
			}
		}
		if bySegment, ok := m.segmentMembersByList[listID]; ok {
			if pages, ok2 := bySegment[segmentID]; ok2 {
				if body, ok3 := pages[offset]; ok3 {
					_, _ = w.Write([]byte(body))
					return
				}
			}
		}
		_, _ = w.Write([]byte(`{"members":[]}`))
	case strings.HasSuffix(r.URL.Path, "/segments") && strings.Contains(r.URL.Path, "/lists/"):
		_, _ = w.Write([]byte(m.segmentsResp))
	case strings.HasSuffix(r.URL.Path, "/interest-categories"):
		_, _ = w.Write([]byte(m.interestsResp))
	case strings.HasSuffix(r.URL.Path, "/members") && strings.Contains(r.URL.Path, "/lists/"):
		// Decode listID and offset; we hardcode "/lists/<id>/members".
		parts := strings.Split(r.URL.Path, "/")
		listID := parts[2]
		offset := 0
		if v := r.URL.Query().Get("offset"); v != "" {
			// 0 if invalid; we'll error later
			for _, ch := range v {
				if ch < '0' || ch > '9' {
					offset = -1
					break
				}
				offset = offset*10 + int(ch-'0')
			}
		}
		if pages, ok := m.membersByList[listID]; ok {
			if body, ok2 := pages[offset]; ok2 {
				_, _ = w.Write([]byte(body))
				return
			}
		}
		// Default: empty page.
		_, _ = w.Write([]byte(`{"members":[]}`))
	case r.URL.Path == "/automations":
		_, _ = w.Write([]byte(m.automationsLst))
	case strings.HasPrefix(r.URL.Path, "/automations/") && strings.HasSuffix(r.URL.Path, "/emails"):
		_, _ = w.Write([]byte(m.automationsEm))
	case r.URL.Path == "/campaigns":
		_, _ = w.Write([]byte(m.campaignsResp))
	case strings.HasPrefix(r.URL.Path, "/campaigns/") && strings.HasSuffix(r.URL.Path, "/content"):
		_, _ = w.Write([]byte(m.contentResp))
	case strings.HasSuffix(r.URL.Path, "/email-activity") && strings.HasPrefix(r.URL.Path, "/reports/"):
		_, _ = w.Write([]byte(m.emailActivityResp))
	case strings.HasSuffix(r.URL.Path, "/click-details") && strings.HasPrefix(r.URL.Path, "/reports/"):
		_, _ = w.Write([]byte(m.clickDetailsResp))
	case strings.Contains(r.URL.Path, "/click-details/") && strings.HasSuffix(r.URL.Path, "/members"):
		_, _ = w.Write([]byte(m.clickMembersResp))
	case strings.HasSuffix(r.URL.Path, "/open-details") && strings.HasPrefix(r.URL.Path, "/reports/"):
		_, _ = w.Write([]byte(m.openDetailsResp))
	case strings.HasSuffix(r.URL.Path, "/sent-to") && strings.HasPrefix(r.URL.Path, "/reports/"):
		_, _ = w.Write([]byte(m.sentToResp))
	case r.URL.Path == "/reports":
		_, _ = w.Write([]byte(`{"total_items":1}`))
	case strings.HasPrefix(r.URL.Path, "/reports/"):
		_, _ = w.Write([]byte(m.reportsResp))
	case r.URL.Path == "/templates":
		_, _ = w.Write([]byte(m.templatesResp))
	case strings.HasPrefix(r.URL.Path, "/templates/") && strings.HasSuffix(r.URL.Path, "/default-content"):
		_, _ = w.Write([]byte(m.defaultContentResp))
	case r.URL.Path == "/landing-pages":
		_, _ = w.Write([]byte(m.landingResp))
	case strings.HasPrefix(r.URL.Path, "/landing-pages/") && strings.HasSuffix(r.URL.Path, "/content"):
		_, _ = w.Write([]byte(m.landingContentResp))
	case strings.HasPrefix(r.URL.Path, "/landing-pages/"):
		_, _ = w.Write([]byte(m.landingDetailResp))
	case r.URL.Path == "/ecommerce/stores":
		_, _ = w.Write([]byte(m.ecommerceResp))
	case strings.HasSuffix(r.URL.Path, "/customers") && strings.Contains(r.URL.Path, "/ecommerce/stores/"):
		_, _ = w.Write([]byte(m.customersResp))
	case strings.HasSuffix(r.URL.Path, "/products") && strings.Contains(r.URL.Path, "/ecommerce/stores/"):
		_, _ = w.Write([]byte(m.productsResp))
	case strings.HasSuffix(r.URL.Path, "/orders") && strings.Contains(r.URL.Path, "/ecommerce/stores/"):
		_, _ = w.Write([]byte(m.ordersResp))
	case strings.HasSuffix(r.URL.Path, "/carts") && strings.Contains(r.URL.Path, "/ecommerce/stores/"):
		_, _ = w.Write([]byte(m.cartsResp))
	case strings.HasSuffix(r.URL.Path, "/signup-forms") && strings.Contains(r.URL.Path, "/lists/"):
		_, _ = w.Write([]byte(m.formResp))
	default:
		http.NotFound(w, r)
	}
}

// fixture builds the canned server.
func newMailchimpServer(t *testing.T) (*httptest.Server, *mailchimpServer) {
	srv := &mailchimpServer{
		t:         t,
		authToken: "tok-abc",
		listsResp: `{
			"lists":[
				{"id":"list_a","stats":{"member_count":3}},
				{"id":"list_b","stats":{"member_count":2}}
			],
			"total_items":2
		}`,
		segmentsResp: `{
			"segments":[
				{"id":111,"name":"VIPs","type":"saved","options":{"match":"any","conditions":[
					{"field":"EMAIL","op":"contains","value":"@gmail.com"}
				]}},
				{"id":222,"name":"Static Buyers","type":"static","options":{"match":"all","conditions":[]}}
			],
			"total_items":2
		}`,
		mergeFieldsResp: `{
			"merge_fields":[
				{"merge_id":1,"tag":"FNAME","name":"First Name","type":"text","public":true},
				{"merge_id":2,"tag":"BIRTHDAY","name":"Birthday","type":"date","public":false}
			],
			"total_items":2
		}`,
		interestsResp: `{"categories":[{"id":"cat_1","title":"Preferences","type":"checkboxes","display_order":2}],"interests":[{"id":"int1","name":"News"}],"total_items":1}`,
		automationsLst: `{
			"automations":[
				{"id":"auto_1","status":"sending","recipients":{"list_id":"list_a"},"trigger_settings":{"workflow_type":"welcomeSeries"},"settings":{"title":"Welcome"}}
			],
			"total_items":1
		}`,
		automationsEm: `{
			"emails":[
				{"id":"e1","delay":{"amount":0,"type":"now"},"settings":{"subject_line":"Hi","title":"Hi","template_id":99}},
				{"id":"e2","delay":{"amount":2,"type":"day"},"settings":{"subject_line":"Day 2","title":"Day 2","template_id":99}}
			]
		}`,
		campaignsResp: `{
			"campaigns":[
				{"id":"camp_1","send_time":"2024-09-01T10:00:00+00:00","emails_sent":1234,"settings":{"subject_line":"Big Launch"}}
			],
			"total_items":1
		}`,
		contentResp: `{"html":"<p>Hello</p>","plain_text":"Hello"}`,
		reportsResp: `{"opens":{"unique_opens":456,"open_rate":0.37},"clicks":{"unique_clicks":78,"click_rate":0.06},"industry_stats":{"open_rate":0.21}}`,
		// Total items for the long-tail discover endpoints. Used so Discover
		// reports the correct counts.
		templatesResp:      `{"templates":[{"id":99,"name":"Weekly Digest","type":"user","html":"<h1>*|FNAME|*</h1>","active":true}],"total_items":1}`,
		defaultContentResp: `{"sections":[{"name":"body","value":"<p>Default body</p>"},{"name":"footer","value":"Thanks"}]}`,
		landingResp:        `{"landing_pages":[{"id":"lp_1","name":"Spring signup","status":"published","url":"https://landing.example.test/spring"}],"total_items":1}`,
		landingDetailResp:  `{"id":"lp_1","title":"Spring signup detail","status":"published"}`,
		landingContentResp: `{"html":"<main>Join us</main>"}`,
		ecommerceResp:      `{"stores":[{"id":"store_1","name":"Shop","currency_code":"USD","platform":"shopify","domain":"shop.example.test"}],"total_items":1}`,
		customersResp:      `{"customers":[{"id":"cust_1","email_address":"buyer@example.com","first_name":"Buyer","opt_in_status":true}],"total_items":1}`,
		productsResp:       `{"products":[{"id":"prod_1","title":"Course","url":"https://shop.example.test/course","price":49.99,"currency_code":"USD"}],"total_items":1}`,
		ordersResp:         `{"orders":[{"id":"order_1","email":"buyer@example.com","order_total":49.99,"currency_code":"USD","campaign_id":"camp_1","processed_at":"2024-09-01T11:00:00+00:00"}],"total_items":1}`,
		cartsResp:          `{"carts":[{"id":"cart_1","email":"cart@example.com","checkout_total":25,"currency_code":"USD","created_at":"2024-09-01T12:00:00+00:00"}],"total_items":1}`,
		formResp:           `{"forms":[{"type":"embedded","enabled":true}],"embed_url":"https://example.test/form"}`,
		emailActivityResp:  `{"emails":[{"email_address":"alice@example.com","activity":[{"action":"open","timestamp":"2024-09-01T10:01:00+00:00"},{"action":"click","timestamp":"2024-09-01T10:02:00+00:00","url":"https://example.test"}]}]}`,
		clickDetailsResp:   `{"urls_clicked":[{"id":"link_1","url":"https://example.test","total_clicks":2,"unique_clicks":1}]}`,
		clickMembersResp:   `{"members":[{"email_address":"alice@example.com","timestamp":"2024-09-01T10:02:00+00:00"}]}`,
		openDetailsResp:    `{"members":[{"email_address":"alice@example.com","timestamp":"2024-09-01T10:01:00+00:00"}]}`,
		sentToResp:         `{"sent_to":[{"email_address":"alice@example.com","timestamp":"2024-09-01T10:00:00+00:00"}]}`,
	}

	// Subscriber pages — use page size 1000 since adapter hardcodes it; we
	// emit only a handful per page to verify pagination.
	srv.membersByList = map[string]map[int]string{
		"list_a": {
			0: `{"members":[
				{"id":"m1","email_address":"alice@example.com","status":"subscribed","timestamp_opt":"2024-03-01 10:00:00","tags":[{"name":"vip"},{"name":"early-adopter"}],"merge_fields":{"FNAME":"Alice","LNAME":"A","PHONE":"+15551111"}},
				{"id":"m2","email_address":"bob@example.com","status":"unsubscribed","tags":[],"merge_fields":{"FNAME":"Bob"}},
				{"id":"m3","email_address":"carol@example.com","status":"cleaned","tags":[],"merge_fields":{}}
			],"total_items":3}`,
		},
		"list_b": {
			0: `{"members":[
				{"id":"m4","email_address":"dimitri@example.com","status":"pending","tags":[{"name":"weird,with-comma"}],"merge_fields":{"FNAME":"Дмитрий"},"interests":{"int1":true,"int2":false}},
				{"id":"m5","email_address":"erin@example.com","status":"transactional","tags":[]}
			],"total_items":2}`,
		},
	}
	srv.segmentMembersByList = map[string]map[int]map[int]string{
		"list_a": {
			222: {
				0: `{"members":[
					{"id":"m1","email_address":"alice@example.com"},
					{"id":"m2","email_address":"bob@example.com"}
				]}`,
			},
		},
		"list_b": {
			222: {
				0: `{"members":[
					{"id":"m4","email_address":"dimitri@example.com"}
				]}`,
			},
		},
	}

	return httptest.NewServer(http.HandlerFunc(srv.handler)), srv
}

func TestMailchimpE2E_FullMigrationLifecycle(t *testing.T) {
	hs, _ := newMailchimpServer(t)
	defer hs.Close()

	a := New()
	a.BaseURL = hs.URL
	ctx := context.Background()

	// 1. Authenticate via direct token (skip OAuth dance).
	sess, err := a.Authenticate(ctx, adapter.Credentials{
		AccessToken: "tok-abc",
		AccountID:   "us21", // Real value but our BaseURL override ignores it.
	})
	require.NoError(t, err)
	require.Equal(t, canonical.SourceMailchimp, sess.Source)
	require.Equal(t, "tok-abc", sess.AccessToken)

	// 2. Discover.
	rep, err := a.Discover(ctx, sess)
	require.NoError(t, err)
	require.Contains(t, strings.Join(rep.Warnings, "\n"), "not a transactionally consistent account snapshot")
	require.Equal(t, 5, rep.SubscribersTotal, "3 in list_a + 2 in list_b")
	require.Equal(t, 4, rep.SegmentsTotal, "1 saved + 1 static segment per list")
	require.Equal(t, 2, rep.GroupsTotal, "1 interest category per list")
	require.Equal(t, 1, rep.AutomationsTotal)
	require.Equal(t, 1, rep.ArchiveTotal)
	require.Equal(t, 1, rep.TemplatesTotal)
	require.Equal(t, 1, rep.LandingPagesTotal)
	require.Equal(t, 1, rep.EcommerceTotal)
	require.Equal(t, 2, rep.FormsTotal, "FormsTotal derived from audience signup forms")
	require.ElementsMatch(t, []string{"FNAME", "BIRTHDAY"}, rep.CustomFields)
	require.Len(t, rep.Warnings, 2)
	require.Contains(t, rep.Warnings[0], "Customer Journeys")

	// 3. ListSubscribers — paginate across both lists.
	var allSubs []canonical.Subscriber
	cursor := ""
	for i := 0; i < 5; i++ {
		batch, next, err := a.ListSubscribers(ctx, sess, cursor)
		require.NoError(t, err)
		allSubs = append(allSubs, batch...)
		if next == "" {
			break
		}
		cursor = next
	}
	require.Len(t, allSubs, 5)

	// Verify status mapping covers all enum branches.
	statusByEmail := map[string]canonical.SubscriberStatus{}
	for _, s := range allSubs {
		statusByEmail[s.Email] = s.Status
	}
	require.Equal(t, canonical.StatusEnabled, statusByEmail["alice@example.com"])
	require.Equal(t, canonical.StatusDisabled, statusByEmail["bob@example.com"])
	require.Equal(t, canonical.StatusBlocklisted, statusByEmail["carol@example.com"], "cleaned should remain a hard suppression")
	require.Equal(t, canonical.StatusUnconfirmed, statusByEmail["dimitri@example.com"])
	require.Equal(t, canonical.StatusDisabled, statusByEmail["erin@example.com"], "transactional should map to disabled")

	// Edge-case fields:
	for _, s := range allSubs {
		switch s.Email {
		case "alice@example.com":
			require.Equal(t, "Alice", s.CustomFields["FNAME"])
			require.Equal(t, "A", s.CustomFields["LNAME"])
			require.Equal(t, "+15551111", s.CustomFields["PHONE"])
			require.Contains(t, s.Tags, "mailchimp:list:list_a")
			require.Contains(t, s.Tags, "mailchimp:list:list_a:segment:222")
			require.Contains(t, s.Tags, "vip")
			require.Contains(t, s.Tags, "early-adopter")
			require.NotNil(t, s.ConsentTimestamp, "timestamp_opt should parse")
		case "bob@example.com":
			require.Contains(t, s.Tags, "mailchimp:list:list_a")
			require.Contains(t, s.Tags, "mailchimp:list:list_a:segment:222")
		case "carol@example.com":
			// Empty merge_fields should produce empty CustomFields, not nil.
			require.NotNil(t, s.CustomFields)
			require.Contains(t, s.Tags, "mailchimp:list:list_a")
			require.NotContains(t, s.Tags, "mailchimp:list:list_a:segment:222")
		case "dimitri@example.com":
			require.Contains(t, s.Tags, "mailchimp:list:list_b")
			require.Contains(t, s.Tags, "mailchimp:list:list_b:segment:222")
			require.Contains(t, s.Tags, "weird,with-comma", "comma-tag must round-trip")
			require.Contains(t, s.Tags, "interest:int1", "interests collapsed to tags")
			require.NotContains(t, s.Tags, "interest:int2", "false interests skipped")
			require.Equal(t, "Дмитрий", s.CustomFields["FNAME"])
			groups := s.CustomFields["postwave_mailchimp_groups"].([]map[string]interface{})
			require.Equal(t, "News", groups[0]["name"])
			require.Equal(t, "Preferences", groups[0]["category"])
			require.Equal(t, "list_b", groups[0]["audience_id"])
			require.Equal(t, "checkbox", groups[0]["type"])
			require.Equal(t, "checkboxes", groups[0]["source_category_type"])
			require.Equal(t, 2, groups[0]["display_order"])
			require.Equal(t, 2, groups[0]["category_display_order"])
		}
	}

	// 4. ListSegments.
	segs, err := a.ListSegments(ctx, sess)
	require.NoError(t, err)
	require.Len(t, segs, 4, "one saved + one static segment per list")
	require.Equal(t, "VIPs [list_a]", segs[0].Name)
	require.Equal(t, "or", segs[0].QueryAST.Op, "match=any -> or")
	require.Len(t, segs[0].QueryAST.Children, 1)
	require.Equal(t, "email", segs[0].QueryAST.Children[0].Field)
	require.Equal(t, "contains", segs[0].QueryAST.Children[0].Comparator)
	require.Equal(t, "Static Buyers [list_a]", segs[1].Name)
	require.Equal(t, "tag", segs[1].QueryAST.Field)
	require.Equal(t, "equals", segs[1].QueryAST.Comparator)
	require.Equal(t, "mailchimp:list:list_a:segment:222", segs[1].QueryAST.Value)

	// 5. ListAutomations.
	autos, err := a.ListAutomations(ctx, sess)
	require.NoError(t, err)
	require.Len(t, autos, 1)
	require.Equal(t, "Welcome", autos[0].Name)
	require.Equal(t, "paused", autos[0].Status)
	require.Len(t, autos[0].Triggers, 1)
	require.Equal(t, "subscriber_added_to_list", autos[0].Triggers[0].Type)
	// Expect: send-0 (delay=now skips wait), wait-1 (2 days), send-1.
	require.Len(t, autos[0].Nodes, 3)
	require.Equal(t, "send_email", autos[0].Nodes[0].Type)
	require.Empty(t, autos[0].Nodes[0].TemplateID)
	require.Equal(t, "99", autos[0].Nodes[0].Metadata["source_template_id"])
	require.Equal(t, "e1", autos[0].Nodes[0].Metadata["source_automation_email_id"])
	require.Equal(t, "mailchimp:classic-automation:auto_1:email:e1", autos[0].Nodes[0].Metadata["source_content_id"])
	require.Equal(t, "wait", autos[0].Nodes[1].Type)
	require.Equal(t, int64(2*86400), autos[0].Nodes[1].DurationSeconds)
	require.Equal(t, "send_email", autos[0].Nodes[2].Type)

	// 6. ListCampaignArchive.
	camps, next, err := a.ListCampaignArchive(ctx, sess, "")
	require.NoError(t, err)
	require.Equal(t, "", next, "single page")
	require.Len(t, camps, 1)
	require.Equal(t, "Big Launch", camps[0].Subject)
	require.Equal(t, 1234, camps[0].RecipientsCount)
	require.Equal(t, 456, camps[0].Opens)
	require.Equal(t, 78, camps[0].Clicks)
	require.Equal(t, "<p>Hello</p>", camps[0].HTML)
	require.Equal(t, 0.37, camps[0].Report["opens"].(map[string]interface{})["open_rate"])
	require.Contains(t, camps[0].Report, "email_activity")
	require.Contains(t, camps[0].Report, "click_members")
	require.False(t, camps[0].SentAt.IsZero(), "send_time must parse")

	// 7. ListTemplates.
	templates, _, err := a.ListTemplates(ctx, sess, "")
	require.NoError(t, err)
	require.Len(t, templates, 1)
	require.Equal(t, "99", templates[0].SourceID)
	require.Equal(t, "Weekly Digest", templates[0].Name)
	require.Contains(t, templates[0].HTML, "*|FNAME|*")
	require.NotEmpty(t, templates[0].DefaultContent)

	// 8. ListSourceArchive preserves readable objects and emits unsupported
	// capabilities as warning-only guidance rather than detected imports.
	var archived []canonical.SourceArchiveItem
	sourceCursor := ""
	for i := 0; i < 20; i++ {
		batch, next, err := a.ListSourceArchive(ctx, sess, sourceCursor)
		require.NoError(t, err)
		archived = append(archived, batch...)
		if next == "" {
			break
		}
		sourceCursor = next
	}
	types := map[string]int{}
	detectedTypes := map[string]int{}
	for _, item := range archived {
		types[item.ResourceType]++
		if !strings.HasPrefix(item.SourceID, "source_archive_warning:") {
			detectedTypes[item.ResourceType]++
		}
	}
	require.Equal(t, 2, detectedTypes["mailchimp_audience_schema"])
	require.Equal(t, 1, types["mailchimp_customer_journey"])
	require.Equal(t, 2, detectedTypes["mailchimp_form"])
	require.Equal(t, 1, detectedTypes["mailchimp_landing_page"])
	require.Equal(t, 1, detectedTypes["mailchimp_ecommerce_store"])
	for _, resource := range []string{
		"mailchimp_content_studio", "mailchimp_survey_poll", "mailchimp_sms_program",
		"mailchimp_connected_site", "mailchimp_verified_domain", "mailchimp_social_ad",
		"mailchimp_developer_platform", "mailchimp_transactional", "mailchimp_marketplace",
	} {
		require.Zero(t, detectedTypes[resource], resource+" is guidance, not an account-detected object")
	}
	for _, item := range archived {
		if item.ResourceType == "mailchimp_customer_journey" {
			require.Equal(t, "manual_review", item.Status)
			require.False(t, item.Payload["export_available"].(bool))
			require.NotEmpty(t, item.Warnings)
		}
		if item.ResourceType == "mailchimp_audience_schema" {
			require.Equal(t, "materialized", item.Status)
			require.Contains(t, item.Payload, "merge_fields")
			require.Contains(t, item.Payload, "segments")
		}
		if item.ResourceType == "mailchimp_landing_page" {
			require.Contains(t, item.Payload, "content")
		}
		if item.ResourceType == "mailchimp_ecommerce_store" {
			require.Contains(t, item.Payload, "products")
			require.Contains(t, item.Payload, "orders")
		}
		if strings.HasPrefix(item.ResourceType, "mailchimp_") && strings.HasPrefix(item.SourceID, "source_archive_warning:") && item.Status == "not_detected" {
			require.False(t, item.Payload["detected"].(bool))
			require.Contains(t, item.Payload, "foundation_guidance")
			require.Contains(t, item.Payload, "foundation_artifacts")
			require.NotEmpty(t, item.Warnings)
		}
	}

	// 9. ListPaidSubs — Mailchimp doesn't own these; expect empty.
	paid, err := a.ListPaidSubs(ctx, sess, "")
	require.NoError(t, err)
	require.Empty(t, paid)
}

func TestMailchimpE2E_SelectedAudiences(t *testing.T) {
	hs, _ := newMailchimpServer(t)
	defer hs.Close()

	a := New()
	a.BaseURL = hs.URL
	ctx := context.Background()
	sess := adapter.Session{
		AccessToken: "tok-abc",
		AccountID:   "us21",
		Source:      canonical.SourceMailchimp,
		Extra:       map[string]string{SelectedAudiencesExtraKey: "list_b"},
	}

	rep, err := a.Discover(ctx, sess)
	require.NoError(t, err)
	require.Equal(t, 2, rep.SubscribersTotal)
	require.Equal(t, 2, rep.SegmentsTotal)
	require.Equal(t, 1, rep.GroupsTotal)
	require.Equal(t, 1, rep.FormsTotal)
	require.Equal(t, 0, rep.AutomationsTotal)
	require.Len(t, rep.Audiences, 1)
	require.Equal(t, "list_b", rep.Audiences[0].ID)

	subs, next, err := a.ListSubscribers(ctx, sess, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, subs, 2)
	for _, sub := range subs {
		require.Contains(t, sub.Tags, "mailchimp:list:list_b")
		require.NotContains(t, sub.SourceID, "list:list_a:")
	}

	segs, err := a.ListSegments(ctx, sess)
	require.NoError(t, err)
	require.Len(t, segs, 2)
	for _, seg := range segs {
		require.Contains(t, seg.Name, "[list_b]")
	}

	autos, err := a.ListAutomations(ctx, sess)
	require.NoError(t, err)
	require.Empty(t, autos)
}

func TestMailchimpE2E_AuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"detail":"bad token"}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := adapter.Session{AccessToken: "bad", AccountID: "us21"}
	_, err := a.Discover(context.Background(), sess)
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestMailchimpE2E_RateLimitedThenRecover(t *testing.T) {
	hs, srv := newMailchimpServer(t)
	defer hs.Close()
	srv.trip429ForPath = "/lists?count=1000&fields=lists.id,lists.name,lists.stats.member_count"

	a := New()
	a.BaseURL = hs.URL
	sess := adapter.Session{AccessToken: "tok-abc", AccountID: "us21"}

	// First call should fail with ErrRateLimited.
	_, err := a.Discover(context.Background(), sess)
	require.Error(t, err)
	var rateErr *adapter.ErrRateLimited
	require.True(t, errors.As(err, &rateErr))
	require.Equal(t, time.Second, rateErr.RetryAfter)

	// Second call (server now lets it pass) succeeds.
	_, err = a.Discover(context.Background(), sess)
	require.NoError(t, err)
}

func TestMailchimpE2E_CursorIdempotency(t *testing.T) {
	hs, _ := newMailchimpServer(t)
	defer hs.Close()

	a := New()
	a.BaseURL = hs.URL
	sess := adapter.Session{AccessToken: "tok-abc", AccountID: "us21"}

	// Calling with the same cursor should yield identical output.
	subs1, next1, err := a.ListSubscribers(context.Background(), sess, "list_b:0")
	require.NoError(t, err)
	subs2, next2, err := a.ListSubscribers(context.Background(), sess, "list_b:0")
	require.NoError(t, err)
	require.Equal(t, next1, next2)
	require.Equal(t, len(subs1), len(subs2))
	for i := range subs1 {
		require.Equal(t, subs1[i].Email, subs2[i].Email)
		require.Equal(t, subs1[i].SourceID, subs2[i].SourceID)
		require.Equal(t, subs1[i].Status, subs2[i].Status)
	}
}

func TestMailchimpE2E_EmptyMembersTerminatesCleanly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/lists":
			_, _ = w.Write([]byte(`{"lists":[{"id":"empty_list","stats":{"member_count":0}}]}`))
		default:
			_, _ = w.Write([]byte(`{"members":[]}`))
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	subs, next, err := a.ListSubscribers(context.Background(), adapter.Session{AccessToken: "x", AccountID: "us21"}, "")
	require.NoError(t, err)
	require.Empty(t, subs)
	require.Equal(t, "", next, "empty list must terminate without panicking")
}

func TestMailchimpE2E_CampaignSentAtToleratesFractionalSeconds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/campaigns":
			_, _ = w.Write([]byte(`{"campaigns":[{"id":"c1","send_time":"2024-09-01T10:00:00.123+00:00","emails_sent":1,"settings":{"subject_line":"S"}}]}`))
		case strings.HasPrefix(r.URL.Path, "/campaigns/") && strings.HasSuffix(r.URL.Path, "/content"):
			_, _ = w.Write([]byte(`{"html":"","plain_text":""}`))
		case strings.HasPrefix(r.URL.Path, "/reports/"):
			_, _ = w.Write([]byte(`{"opens":{"unique_opens":0},"clicks":{"unique_clicks":0}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	camps, _, err := a.ListCampaignArchive(context.Background(), adapter.Session{AccessToken: "x", AccountID: "us21"}, "")
	require.NoError(t, err)
	require.Len(t, camps, 1)
	require.False(t, camps[0].SentAt.IsZero(), "fractional-seconds RFC3339 must parse")
	require.Equal(t, 2024, camps[0].SentAt.Year())
}

func TestMailchimpE2E_CampaignPartialReportWarnings(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/campaigns":
			_, _ = w.Write([]byte(`{"campaigns":[{"id":"c1","send_time":"2024-09-01T10:00:00+00:00","emails_sent":1,"settings":{"subject_line":"S"}}]}`))
		case strings.HasPrefix(r.URL.Path, "/campaigns/") && strings.HasSuffix(r.URL.Path, "/content"):
			_, _ = w.Write([]byte(`{"html":"<p>Hi</p>","plain_text":"Hi"}`))
		case strings.HasSuffix(r.URL.Path, "/email-activity") && strings.HasPrefix(r.URL.Path, "/reports/"):
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"detail":"temporary report failure"}`))
		case strings.HasPrefix(r.URL.Path, "/reports/"):
			_, _ = w.Write([]byte(`{"opens":{"unique_opens":0},"clicks":{"unique_clicks":0}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	camps, _, err := a.ListCampaignArchive(context.Background(), adapter.Session{AccessToken: "x", AccountID: "us21"}, "")
	require.NoError(t, err)
	require.Len(t, camps, 1)
	require.NotEmpty(t, camps[0].Warnings)
	require.Contains(t, camps[0].Warnings[0], "email_activity fetch failed")
	require.Contains(t, camps[0].Report, "postwave_warnings")
}

func TestMailchimpE2E_NoListsTerminatesCleanly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"lists":[]}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	subs, next, err := a.ListSubscribers(context.Background(), adapter.Session{AccessToken: "x", AccountID: "us21"}, "")
	require.NoError(t, err)
	require.Empty(t, subs)
	require.Equal(t, "", next)
}
