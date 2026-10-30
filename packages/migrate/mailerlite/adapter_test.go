// SPDX-License-Identifier: MIT

package mailerlite

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestMapSubscriber_Status(t *testing.T) {
	cases := []struct {
		raw  string
		want canonical.SubscriberStatus
	}{
		{`{"id":"1","email":"a@b.com","status":"active","opted_in_at":"2024-01-01T00:00:00Z"}`, canonical.StatusEnabled},
		{`{"id":"2","email":"b@c.com","status":"unsubscribed"}`, canonical.StatusDisabled},
		{`{"id":"3","email":"c@d.com","status":"bounced"}`, canonical.StatusBlocklisted},
		{`{"id":"4","email":"d@e.com","status":"unconfirmed"}`, canonical.StatusUnconfirmed},
	}
	for _, tc := range cases {
		var s mlSubscriber
		require.NoError(t, json.Unmarshal([]byte(tc.raw), &s))
		got := mapSubscriber(s)
		require.Equal(t, tc.want, got.Status)
	}
}

func TestMapSubscriber_DoubleOptInFromOptInAt(t *testing.T) {
	raw := `{"id":"1","email":"a@b.com","status":"active","opted_in_at":"2024-03-01T10:00:00Z","groups":[{"id":"g1","name":"VIP"}]}`
	var s mlSubscriber
	require.NoError(t, json.Unmarshal([]byte(raw), &s))
	got := mapSubscriber(s)
	require.Equal(t, canonical.ConsentDoubleOptIn, got.ConsentSource)
	require.Contains(t, got.Tags, "VIP")
}

func TestMapSubscriber_DoesNotPromoteSubscribedAtToConsent(t *testing.T) {
	var imported mlSubscriber
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"1",
		"email":"imported@example.com",
		"status":"active",
		"source":"import",
		"subscribed_at":"2024-03-01 10:00:00"
	}`), &imported))
	got := mapSubscriber(imported)
	require.Nil(t, got.ConsentTimestamp)
	require.Equal(t, canonical.ConsentImport, got.ConsentSource)
	require.Equal(t, "import", got.CustomFields["postwave_mailerlite_source"])
	require.Equal(t, "2024-03-01 10:00:00", got.CustomFields["postwave_mailerlite_subscribed_at"])

	var unconfirmed mlSubscriber
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"2",
		"email":"pending@example.com",
		"status":"unconfirmed",
		"source":"api",
		"opted_in_at":"2024-03-01T10:00:00Z"
	}`), &unconfirmed))
	got = mapSubscriber(unconfirmed)
	require.Nil(t, got.ConsentTimestamp)
	require.Equal(t, canonical.ConsentUnknown, got.ConsentSource)
}

func TestMapSubscriber_MalformedOptInEvidenceFailsConservativeAndPreservesRawValues(t *testing.T) {
	var subscriber mlSubscriber
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"1",
		"email":"bad-evidence@example.com",
		"status":"active",
		"source":"form",
		"opted_in_at":"not-a-timestamp",
		"optin_ip":"203.0.113.7",
		"unsubscribed_at":"2024-02-01 10:00:00"
	}`), &subscriber))

	got := mapSubscriber(subscriber)
	require.Nil(t, got.ConsentTimestamp)
	require.Equal(t, canonical.ConsentSingleOptIn, got.ConsentSource)
	require.Equal(t, "not-a-timestamp", got.CustomFields["postwave_mailerlite_opted_in_at"])
	require.Equal(t, "203.0.113.7", got.CustomFields["postwave_mailerlite_optin_ip"])
	require.Equal(t, "2024-02-01 10:00:00", got.CustomFields["postwave_mailerlite_unsubscribed_at"])
}

func TestTranslateSegment_PreservesRebuildEvidence(t *testing.T) {
	s := mlSegment{ID: "seg_1", Name: "Engaged", Total: 42}
	out := translateSegment(s)
	require.Equal(t, "mailerlite_saved_segment_review", out.QueryAST.Op)
	require.Contains(t, out.Description, "could not be translated")
	require.Contains(t, out.SourceDefinition, `"migration_mode":"rebuild_review"`)
	require.Contains(t, out.SourceDefinition, `"source_id":"mailerlite:segment:seg_1"`)
	require.Contains(t, out.SourceDefinition, `"total":42`)
}

func TestTranslateGroupAsSegment(t *testing.T) {
	g := mlGroup{ID: "g1", Name: "VIP"}
	out := translateGroupAsSegment(g)
	require.Equal(t, "Group: VIP", out.Name)
	require.Equal(t, "tag", out.QueryAST.Field)
	require.Equal(t, "VIP", out.QueryAST.Value)
	require.Contains(t, out.SourceDefinition, `"source_id":"mailerlite:group:g1"`)
}

func TestTranslateAutomation_IsRebuildOnly(t *testing.T) {
	au := mlAutomation{
		ID: "a", Name: "Onboarding", Enabled: true,
		Raw: json.RawMessage(`{"id":"a","name":"Onboarding","enabled":true,"steps":[{"id":"s1","type":"delay","unit":"hours","value":"1"}]}`),
	}
	out := translateAutomation(au)
	require.Equal(t, "draft", out.Status)
	require.Empty(t, out.Nodes)
	require.Empty(t, out.Triggers)
	require.Contains(t, out.SourceDefinition, `"migration_mode":"rebuild_review"`)
	require.Contains(t, out.SourceDefinition, `"unit":"hours"`)
}

func TestMapCampaign_PreservesAllEmailVariants(t *testing.T) {
	var campaign mlCampaign
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"campaign_1",
		"name":"Subject experiment",
		"status":"sent",
		"finished_at":"2024-03-01 10:00:00",
		"emails":[
			{"id":"email_a","subject":"Variant A","from":"news@example.com","plain_text":"A","stats":{"sent":60,"opens_count":22,"clicks_count":6}},
			{"id":"email_b","subject":"Variant B","from":"news@example.com","plain_text":"B","stats":{"sent":40,"opens_count":18,"clicks_count":4}}
		]
	}`), &campaign))

	out := mapCampaign(campaign)
	require.Equal(t, "Variant A", out.Subject)
	require.Equal(t, "A", out.Text)
	variants, ok := out.Report["emails"].([]map[string]interface{})
	require.True(t, ok)
	require.Len(t, variants, 2)
	require.Equal(t, "Variant B", variants[1]["subject"])
	require.Contains(t, variants[1]["stats"], "opens_count")
	require.Equal(t, 100, out.RecipientsCount)
	require.Equal(t, 40, out.Opens)
	require.Equal(t, 10, out.Clicks)
	require.Contains(t, out.Warnings, "This campaign contains multiple email variants. Every API-visible variant is preserved in the report; the first variant is used as the canonical archive subject and plain-text body.")
}

func TestListSubscribers_CursorPagination(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "groups", r.URL.Query().Get("include"))
		if calls == 1 {
			require.Equal(t, "", r.URL.Query().Get("cursor"))
			_, _ = w.Write([]byte(`{"data":[{"id":"1","email":"a@b.com","status":"active"}],"meta":{"next_cursor":"abc"}}`))
			return
		}
		require.Equal(t, "abc", r.URL.Query().Get("cursor"))
		_, _ = w.Write([]byte(`{"data":[{"id":"2","email":"b@c.com","status":"active"}],"meta":{"next_cursor":""}}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := adapter.Session{AccessToken: "k"}

	subs1, next1, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, subs1, 1)
	require.Equal(t, "abc", next1)

	subs2, next2, err := a.ListSubscribers(context.Background(), sess, next1)
	require.NoError(t, err)
	require.Len(t, subs2, 1)
	require.Equal(t, "", next2)
}

func TestListAutomations_PaginatesAndPreservesRawDefinitions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("page") {
		case "1":
			_, _ = w.Write([]byte(`{"data":[{"id":"a1","name":"First","enabled":true,"steps":[{"id":"step_1","type":"delay","unit":"days","value":"2"}]}],"meta":{"current_page":1,"last_page":2,"total":2}}`))
		case "2":
			_, _ = w.Write([]byte(`{"data":[{"id":"a2","name":"Second","enabled":false,"triggers":[{"type":"subscriber_joins_group","group_ids":["g1"]}]}],"meta":{"current_page":2,"last_page":2,"total":2}}`))
		default:
			http.Error(w, "unexpected page", http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	got, err := a.ListAutomations(context.Background(), adapter.Session{AccessToken: "k"})
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Contains(t, got[0].SourceDefinition, `"unit":"days"`)
	require.Contains(t, got[1].SourceDefinition, `"subscriber_joins_group"`)
	require.Empty(t, got[0].Nodes)
	require.Empty(t, got[1].Triggers)
}

func TestListSegments_PaginatesGroupsAndSavedMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		switch r.URL.Path {
		case "/groups":
			if page == "1" {
				_, _ = w.Write([]byte(`{"data":[{"id":"g1","name":"One"}],"meta":{"current_page":1,"last_page":2,"total":2}}`))
			} else {
				_, _ = w.Write([]byte(`{"data":[{"id":"g2","name":"Two"}],"meta":{"current_page":2,"last_page":2,"total":2}}`))
			}
		case "/segments":
			if page == "1" {
				_, _ = w.Write([]byte(`{"data":[{"id":"s1","name":"First","total":10}],"meta":{"current_page":1,"last_page":2,"total":2}}`))
			} else {
				_, _ = w.Write([]byte(`{"data":[{"id":"s2","name":"Second","total":20}],"meta":{"current_page":2,"last_page":2,"total":2}}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	got, err := a.ListSegments(context.Background(), adapter.Session{AccessToken: "k"})
	require.NoError(t, err)
	require.Len(t, got, 4)
	require.Equal(t, "Group: One", got[0].Name)
	require.Equal(t, "Group: Two", got[1].Name)
	require.Equal(t, "First", got[2].Name)
	require.Equal(t, "mailerlite_saved_segment_review", got[3].QueryAST.Op)
}

func TestListCampaignArchive_RejectsInvalidCursorBeforeRequest(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls++
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL

	_, _, err := a.ListCampaignArchive(context.Background(), adapter.Session{AccessToken: "k"}, "not-a-page")
	require.Error(t, err)
	require.Zero(t, calls)
}

func TestCapabilities_SurfaceLongTailGaps(t *testing.T) {
	caps := New().Capabilities()
	require.True(t, caps.Supports.Subscribers)
	require.True(t, caps.Supports.Segments)
	require.True(t, caps.Supports.Automations)
	require.Equal(t, "rebuild_review", caps.Supports.AutomationMode)
	require.True(t, caps.Supports.CampaignArchive)
	require.False(t, caps.Supports.PaidSubs)
	require.True(t, caps.Supports.Groups)
	require.True(t, caps.Supports.Campaigns)
	require.True(t, caps.Supports.Reports)
	require.False(t, caps.Supports.Templates)
	require.False(t, caps.Supports.Forms)
	require.False(t, caps.Supports.LandingPages)
	require.False(t, caps.Supports.Ecommerce)
}
