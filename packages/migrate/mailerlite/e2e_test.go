// SPDX-License-Identifier: MIT

package mailerlite

import (
	"context"
	"errors"
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

type mlServer struct {
	t          *testing.T
	expectedTk string

	subsByCursor     map[string]string // cursor -> response
	groupsResp       string
	segmentsListResp string
	autosListResp    string
	campsListResp    string
	draftCampsResp   string
	readyCampsResp   string
	campDetailResp   string
	fieldsResp       string
	formsResp        string
	ecommerceResp    string

	trip429Path string
	tripped     atomic.Bool

	calls atomic.Int64
}

func (m *mlServer) handler(w http.ResponseWriter, r *http.Request) {
	m.calls.Add(1)
	if m.expectedTk != "" && r.Header.Get("Authorization") != "Bearer "+m.expectedTk {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}
	if m.trip429Path != "" && !m.tripped.Load() && r.URL.Path == m.trip429Path {
		m.tripped.Store(true)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}

	switch {
	case r.URL.Path == "/subscribers":
		if r.URL.Query().Get("limit") == "0" {
			_, _ = w.Write([]byte(`{"total":5}`))
			return
		}
		if r.URL.Query().Get("include") != "groups" {
			http.Error(w, `{"message":"include=groups required"}`, http.StatusBadRequest)
			return
		}
		cur := r.URL.Query().Get("cursor")
		if body, ok := m.subsByCursor[cur]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		_, _ = w.Write([]byte(`{"data":[],"meta":{"next_cursor":""}}`))
	case r.URL.Path == "/groups":
		_, _ = w.Write([]byte(m.groupsResp))
	case r.URL.Path == "/segments":
		_, _ = w.Write([]byte(m.segmentsListResp))
	case r.URL.Path == "/automations":
		_, _ = w.Write([]byte(m.autosListResp))
	case r.URL.Path == "/campaigns":
		switch r.URL.Query().Get("filter[status]") {
		case "draft":
			_, _ = w.Write([]byte(m.draftCampsResp))
		case "ready":
			_, _ = w.Write([]byte(m.readyCampsResp))
		default:
			_, _ = w.Write([]byte(m.campsListResp))
		}
	case strings.HasPrefix(r.URL.Path, "/campaigns/"):
		_, _ = w.Write([]byte(m.campDetailResp))
	case r.URL.Path == "/fields":
		_, _ = w.Write([]byte(m.fieldsResp))
	case strings.HasPrefix(r.URL.Path, "/forms/"):
		_, _ = w.Write([]byte(m.formsResp))
	case r.URL.Path == "/ecommerce/shops":
		_, _ = w.Write([]byte(m.ecommerceResp))
	default:
		http.NotFound(w, r)
	}
}

func newMLServer(t *testing.T) (*httptest.Server, *mlServer) {
	srv := &mlServer{
		t:          t,
		expectedTk: "key-ml",
		subsByCursor: map[string]string{
			"": `{
				"data":[
					{"id":"1","email":"alice@example.com","status":"active","opted_in_at":"2024-01-01T00:00:00Z","fields":{"city":"NYC"},"groups":[{"id":"g1","name":"VIP"},{"id":"g2","name":"Beta"}]},
					{"id":"2","email":"bob@example.com","status":"unsubscribed","subscribed_at":"2024-01-02 10:00:00","fields":{}},
					{"id":"3","email":"carol@example.com","status":"bounced","subscribed_at":"2024-01-03T00:00:00Z"}
				],
				"meta":{"next_cursor":"page2","total":5}
			}`,
			"page2": `{
				"data":[
					{"id":"4","email":"dimitri@example.com","status":"unconfirmed","subscribed_at":"2024-02-01T00:00:00Z","fields":{"name":"Дмитрий"}},
					{"id":"5","email":"erin@example.com","status":"junk","subscribed_at":"2024-02-02T00:00:00Z"}
				],
				"meta":{"next_cursor":"","total":5}
			}`,
		},
		groupsResp:       `{"data":[{"id":"g1","name":"VIP","active_count":50},{"id":"g2","name":"Beta","active_count":20}],"meta":{"current_page":1,"last_page":1,"total":2}}`,
		segmentsListResp: `{"data":[{"id":"seg_1","name":"Engaged","total":31}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
		autosListResp: `{"data":[{
			"id":"auto_1","name":"Welcome","enabled":true,
			"triggers":[{"id":"t1","type":"subscriber_joins_group","group_ids":["g1"]}],
			"steps":[
				{"id":"s1","type":"delay","parent_id":null,"unit":"hours","value":"1"},
				{"id":"s2","type":"email","parent_id":"s1","email_id":"e1","subject":"Welcome"}
			]
		}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
		campsListResp: `{
			"data":[
				{"id":"c1","name":"Launch","status":"sent","finished_at":"2024-05-01T10:00:00Z","emails":[{"id":"e1","subject":"Big Launch","plain_text":"text","preview_url":"https://dashboard.mailerlite.com/preview/e1","stats":{"sent":500,"opens_count":200,"clicks_count":50}}]},
				{"id":"c2","name":"Update","subject":"","status":"sent","finished_at":"2024-06-01T10:00:00Z"}
			],
			"meta":{"current_page":1,"last_page":1,"total":2}
		}`,
		draftCampsResp: `{"data":[{"id":"draft_1","name":"Next launch","status":"draft"}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
		readyCampsResp: `{"data":[{"id":"ready_1","name":"Tomorrow","status":"ready","scheduled_for":"2024-07-01 10:00:00"}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
		campDetailResp: `{"data":{"id":"c2","name":"Update","status":"sent","finished_at":"2024-06-01T10:00:00Z","emails":[{"id":"e2","subject":"","plain_text":"fallback text","preview_url":"https://dashboard.mailerlite.com/preview/e2","stats":{"sent":600,"opens_count":250,"clicks_count":40}}]}}`,
		fieldsResp:     `{"data":[{"id":"field_1","name":"Company size","key":"company_size","type":"number"}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
		formsResp:      `{"data":[{"id":"form_1","name":"Newsletter form","type":"embedded","active":true}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
		ecommerceResp:  `{"data":[{"id":"shop_1","name":"Example shop","url":"https://shop.example"}],"meta":{"current_page":1,"last_page":1,"total":1}}`,
	}
	return httptest.NewServer(http.HandlerFunc(srv.handler)), srv
}

func TestMailerliteE2E_FullJourney(t *testing.T) {
	hs, _ := newMLServer(t)
	defer hs.Close()
	a := New()
	a.BaseURL = hs.URL
	ctx := context.Background()

	sess, err := a.Authenticate(ctx, adapter.Credentials{APIKey: "key-ml"})
	require.NoError(t, err)
	require.Equal(t, "key-ml", sess.AccessToken)
	require.Equal(t, canonical.SourceMailerLite, sess.Source)

	rep, err := a.Discover(ctx, sess)
	require.NoError(t, err)
	require.Equal(t, 5, rep.SubscribersTotal)
	// Groups (2) + segments (1) = 3.
	require.Equal(t, 3, rep.SegmentsTotal)
	require.Equal(t, 2, rep.GroupsTotal)
	require.Equal(t, 1, rep.AutomationsTotal)
	require.Equal(t, 2, rep.ArchiveTotal)
	require.Equal(t, 4, rep.CampaignsTotal)
	require.Equal(t, []string{"company_size"}, rep.CustomFields)
	require.Zero(t, rep.TemplatesTotal)
	require.Equal(t, 3, rep.FormsTotal)
	require.Zero(t, rep.LandingPagesTotal)
	require.Equal(t, 1, rep.EcommerceTotal)
	require.Equal(t, 8, rep.SourceArchiveTotal)

	// ListSubscribers cursor-paginated.
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

	statusByEmail := map[string]canonical.SubscriberStatus{}
	for _, s := range allSubs {
		statusByEmail[s.Email] = s.Status
	}
	require.Equal(t, canonical.StatusEnabled, statusByEmail["alice@example.com"])
	require.Equal(t, canonical.StatusDisabled, statusByEmail["bob@example.com"])
	require.Equal(t, canonical.StatusBlocklisted, statusByEmail["carol@example.com"])
	require.Equal(t, canonical.StatusUnconfirmed, statusByEmail["dimitri@example.com"])
	require.Equal(t, canonical.StatusBlocklisted, statusByEmail["erin@example.com"], "junk -> blocklisted")

	for _, s := range allSubs {
		switch s.Email {
		case "alice@example.com":
			require.Equal(t, "NYC", s.CustomFields["city"])
			require.Contains(t, s.Tags, "VIP")
			require.Contains(t, s.Tags, "Beta")
			require.Equal(t, canonical.ConsentDoubleOptIn, s.ConsentSource, "opted_in_at populates double-optin")
			require.NotNil(t, s.ConsentTimestamp)
		case "bob@example.com":
			require.Nil(t, s.ConsentTimestamp, "subscribed_at is ingestion time, not portable consent evidence")
			require.Equal(t, canonical.ConsentUnknown, s.ConsentSource)
		case "dimitri@example.com":
			require.Equal(t, "Дмитрий", s.CustomFields["name"])
		}
	}

	// ListSegments — groups + segments.
	segs, err := a.ListSegments(ctx, sess)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(segs), 3, "two groups + one segment")
	require.Equal(t, "Group: VIP", segs[0].Name)
	// Find the real segment "Engaged".
	var engaged *canonical.Segment
	for i := range segs {
		if segs[i].Name == "Engaged" {
			engaged = &segs[i]
			break
		}
	}
	require.NotNil(t, engaged, "saved segment metadata must be present")
	require.Equal(t, "mailerlite_saved_segment_review", engaged.QueryAST.Op)
	require.Contains(t, engaged.SourceDefinition, `"total":31`)

	// ListAutomations.
	autos, err := a.ListAutomations(ctx, sess)
	require.NoError(t, err)
	require.Len(t, autos, 1)
	require.Equal(t, "Welcome", autos[0].Name)
	require.Equal(t, "draft", autos[0].Status)
	require.Empty(t, autos[0].Triggers)
	require.Empty(t, autos[0].Nodes)
	require.Contains(t, autos[0].SourceDefinition, `"migration_mode":"rebuild_review"`)
	require.Contains(t, autos[0].SourceDefinition, `"subscriber_joins_group"`)

	// ListCampaignArchive.
	camps, next, err := a.ListCampaignArchive(ctx, sess, "")
	require.NoError(t, err)
	require.Equal(t, "", next)
	require.Len(t, camps, 2)
	require.Equal(t, "Big Launch", camps[0].Subject)
	require.Empty(t, camps[0].HTML)
	require.Equal(t, "text", camps[0].Text)
	require.Equal(t, 500, camps[0].RecipientsCount)
	require.Equal(t, 200, camps[0].Opens)
	require.NotEmpty(t, camps[0].Warnings)
	require.Equal(t, "https://dashboard.mailerlite.com/preview/e1", camps[0].Report["preview_url"])
	// Empty subject falls back to name.
	require.Equal(t, "Update", camps[1].Subject)
	require.Equal(t, "fallback text", camps[1].Text, "empty Emails triggers detail fetch")

	// Forms and ecommerce metadata are retained as paginated rebuild evidence,
	// followed by one explicit sites/landing-pages API gap.
	var sourceArchive []canonical.SourceArchiveItem
	archiveCursor := ""
	for {
		items, nextCursor, err := a.ListSourceArchive(ctx, sess, archiveCursor)
		require.NoError(t, err)
		sourceArchive = append(sourceArchive, items...)
		if nextCursor == "" {
			break
		}
		archiveCursor = nextCursor
	}
	require.Len(t, sourceArchive, 8)
	require.Equal(t, "mailerlite_custom_field", sourceArchive[0].ResourceType)
	require.Equal(t, "mailerlite_campaign_rebuild", sourceArchive[1].ResourceType)
	require.Equal(t, "mailerlite_campaign_rebuild", sourceArchive[2].ResourceType)
	require.Equal(t, "mailerlite_form", sourceArchive[3].ResourceType)
	require.Equal(t, "mailerlite_ecommerce_shop", sourceArchive[6].ResourceType)
	require.Equal(t, "parity_gap:sites_landing_pages", sourceArchive[7].ResourceType)

	// ListPaidSubs is unsupported.
	_, err = a.ListPaidSubs(ctx, sess, "")
	require.True(t, errors.Is(err, adapter.ErrUnsupported))
}

func TestMailerliteE2E_AuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"bad"}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	_, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "bad"})
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestMailerliteE2E_AuthMissingKey(t *testing.T) {
	a := New()
	_, err := a.Authenticate(context.Background(), adapter.Credentials{})
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestMailerliteE2E_RateLimitedThenRecover(t *testing.T) {
	hs, srv := newMLServer(t)
	defer hs.Close()
	srv.trip429Path = "/subscribers"

	a := New()
	a.BaseURL = hs.URL
	sess := adapter.Session{AccessToken: "key-ml"}
	_, _, err := a.ListSubscribers(context.Background(), sess, "")
	require.Error(t, err)
	var rateErr *adapter.ErrRateLimited
	require.True(t, errors.As(err, &rateErr))
	require.Equal(t, time.Second, rateErr.RetryAfter)

	_, _, err = a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
}

func TestMailerliteE2E_CursorIdempotency(t *testing.T) {
	hs, _ := newMLServer(t)
	defer hs.Close()
	a := New()
	a.BaseURL = hs.URL
	sess := adapter.Session{AccessToken: "key-ml"}

	subs1, next1, err := a.ListSubscribers(context.Background(), sess, "page2")
	require.NoError(t, err)
	subs2, next2, err := a.ListSubscribers(context.Background(), sess, "page2")
	require.NoError(t, err)
	require.Equal(t, next1, next2)
	require.Equal(t, len(subs1), len(subs2))
	for i := range subs1 {
		require.Equal(t, subs1[i].SourceID, subs2[i].SourceID)
	}
}

func TestMailerliteE2E_CampaignArchivePaginationGuardsAgainstZeroPage(t *testing.T) {
	// Regression: when the campaigns response omits current_page (returns 0)
	// we used to fetch page 1 forever.
	calls := atomic.Int64{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		// Return last_page=2 but no current_page.
		_, _ = w.Write([]byte(`{"data":[{"id":"c1","name":"x","subject":"x","finished_at":"2024-01-01T00:00:00Z"}],"meta":{"last_page":2,"total":2}}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := adapter.Session{AccessToken: "k"}

	_, next1, err := a.ListCampaignArchive(context.Background(), sess, "")
	require.NoError(t, err)
	require.Equal(t, "2", next1)

	_, next2, err := a.ListCampaignArchive(context.Background(), sess, "2")
	require.NoError(t, err)
	require.Equal(t, "", next2)
}

func TestMailerliteE2E_CursorPaginationTerminates(t *testing.T) {
	calls := atomic.Int64{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		cur := r.URL.Query().Get("cursor")
		switch cur {
		case "":
			_, _ = w.Write([]byte(`{"data":[{"id":"1","email":"a@b.com","status":"active"}],"meta":{"next_cursor":"two"}}`))
		case "two":
			_, _ = w.Write([]byte(`{"data":[{"id":"2","email":"b@c.com","status":"active"}],"meta":{"next_cursor":""}}`))
		default:
			t.Errorf("unexpected cursor %q", cur)
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := adapter.Session{AccessToken: "k"}
	cur := ""
	pages := 0
	count := 0
	for {
		batch, next, err := a.ListSubscribers(context.Background(), sess, cur)
		require.NoError(t, err)
		count += len(batch)
		pages++
		if next == "" {
			break
		}
		cur = next
		require.LessOrEqual(t, pages, 2)
	}
	require.Equal(t, 2, count)
	require.Equal(t, 2, pages)
}
