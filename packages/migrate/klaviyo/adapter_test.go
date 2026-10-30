// SPDX-License-Identifier: MIT

package klaviyo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestMapProfile_Subscribed(t *testing.T) {
	raw := `{
		"id":"p1","type":"profile",
		"attributes":{
			"email":"a@b.com",
			"first_name":"Ada","last_name":"Lovelace",
			"properties":{"plan":"pro"},
			"subscriptions":{"email":{"marketing":{"can_receive_email_marketing":true,"consent":"SUBSCRIBED","consent_timestamp":"2024-03-01T10:00:00Z","double_optin":false,"suppression":[],"list_suppressions":[]}}}
		}
	}`
	var p kvProfile
	require.NoError(t, json.Unmarshal([]byte(raw), &p))
	got, err := mapProfile(p, []string{"klaviyo:list:L1"})
	require.NoError(t, err)
	require.Equal(t, "a@b.com", got.Email)
	require.Equal(t, canonical.StatusEnabled, got.Status)
	require.Equal(t, canonical.ConsentSingleOptIn, got.ConsentSource)
	require.NotNil(t, got.ConsentTimestamp)
	require.Equal(t, "Ada", got.CustomFields["first_name"])
	provider := got.CustomFields["klaviyo"].(map[string]interface{})
	require.Equal(t, "pro", provider["properties"].(map[string]interface{})["plan"])
	require.Equal(t, []string{"klaviyo:list:L1"}, got.Tags)
	require.Equal(t, "p1", got.SourceID)
	require.Equal(t, canonical.SourceKlaviyo, got.SourcePlatform)
}

func TestMapProfile_UnsubscribedNeverSubscribed(t *testing.T) {
	cases := []struct {
		consent string
		want    canonical.SubscriberStatus
	}{
		{"UNSUBSCRIBED", canonical.StatusDisabled},
		{"NEVER_SUBSCRIBED", canonical.StatusUnconfirmed},
	}
	for _, tc := range cases {
		raw := `{"id":"x","type":"profile","attributes":{"email":"x@y.com","subscriptions":{"email":{"marketing":{"can_receive_email_marketing":false,"consent":"` + tc.consent + `","suppression":[],"list_suppressions":[]}}}}}`
		var p kvProfile
		require.NoError(t, json.Unmarshal([]byte(raw), &p))
		got, err := mapProfile(p, nil)
		require.NoError(t, err)
		require.Equal(t, tc.want, got.Status, "consent=%s", tc.consent)
	}
}

func TestMapProfile_ConsentAndSuppressionPrecedence(t *testing.T) {
	cases := []struct {
		name        string
		marketing   string
		wantStatus  canonical.SubscriberStatus
		wantErrText string
	}{
		{
			name:       "hard bounce is blocklisted",
			marketing:  `{"can_receive_email_marketing":false,"consent":"SUBSCRIBED","consent_timestamp":"2026-07-01T00:00:00Z","double_optin":true,"suppression":[{"reason":"HARD_BOUNCE","timestamp":"2026-07-02T00:00:00Z"}],"list_suppressions":[]}`,
			wantStatus: canonical.StatusBlocklisted,
		},
		{
			name:       "spam complaint is blocklisted",
			marketing:  `{"can_receive_email_marketing":false,"consent":"UNSUBSCRIBED","double_optin":false,"suppression":[{"reason":"SPAM_COMPLAINT","timestamp":"2026-07-02T00:00:00Z"}],"list_suppressions":[]}`,
			wantStatus: canonical.StatusBlocklisted,
		},
		{
			name:       "user suppression is disabled",
			marketing:  `{"can_receive_email_marketing":false,"consent":"UNSUBSCRIBED","double_optin":false,"suppression":[{"reason":"USER_SUPPRESSED","timestamp":"2026-07-02T00:00:00Z"}],"list_suppressions":[]}`,
			wantStatus: canonical.StatusDisabled,
		},
		{
			name:       "subscribed but cannot receive is disabled",
			marketing:  `{"can_receive_email_marketing":false,"consent":"SUBSCRIBED","consent_timestamp":"2026-07-01T00:00:00Z","double_optin":true,"suppression":[],"list_suppressions":[]}`,
			wantStatus: canonical.StatusDisabled,
		},
		{
			name:       "subscribed without timestamp is disabled",
			marketing:  `{"can_receive_email_marketing":true,"consent":"SUBSCRIBED","double_optin":true,"suppression":[],"list_suppressions":[]}`,
			wantStatus: canonical.StatusDisabled,
		},
		{
			name:        "unknown suppression fails closed",
			marketing:   `{"can_receive_email_marketing":false,"consent":"UNSUBSCRIBED","suppression":[{"reason":"NEW_REASON","timestamp":"2026-07-02T00:00:00Z"}],"list_suppressions":[]}`,
			wantErrText: "unknown suppression reason",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := `{"id":"profile","type":"profile","attributes":{"email":"person@example.com","subscriptions":{"email":{"marketing":` + tc.marketing + `},"sms":{"marketing":{"consent":"SUBSCRIBED"}},"mobile_push":{"marketing":{"consent":"SUBSCRIBED"}}}}}`
			var profile kvProfile
			require.NoError(t, json.Unmarshal([]byte(raw), &profile))
			got, err := mapProfile(profile, nil)
			if tc.wantErrText != "" {
				require.ErrorContains(t, err, tc.wantErrText)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.wantStatus, got.Status)
			provider := got.CustomFields["klaviyo"].(map[string]interface{})
			subscriptions := provider["subscriptions"].(map[string]interface{})
			require.Contains(t, subscriptions, "sms")
			require.Contains(t, subscriptions, "mobile_push")
		})
	}
}

func TestTranslateListAsSegment(t *testing.T) {
	r := kvResource{ID: "L1", Attributes: json.RawMessage(`{"name":"Newsletter"}`)}
	got := translateListAsSegment(r)
	require.Equal(t, "List: Newsletter", got.Name)
	require.Equal(t, "tag", got.QueryAST.Field)
	require.Equal(t, "klaviyo:list:L1", got.QueryAST.Value)
	require.Contains(t, got.SourceDefinition, `"source_id":"klaviyo:list:L1"`)
}

func TestTranslateSegment_PreservesDefinition(t *testing.T) {
	r := kvResource{ID: "S1", Attributes: json.RawMessage(`{"name":"Engaged","definition":{"condition_groups":[{"conditions":[]}]}}`)}
	got := translateSegment(r)
	require.Equal(t, "Engaged", got.Name)
	require.NotEmpty(t, got.SourceDefinition)
}

func TestTranslateSegment_UsesFrozenMembershipInsteadOfGuessingPredicate(t *testing.T) {
	r := kvResource{ID: "S1", Attributes: json.RawMessage(`{
		"name":"VIP Gmail",
		"definition":{"condition_groups":[{"conditions":[{"type":"profile-property","property":"email","operator":"contains","value":"@gmail.com"}]}]}
	}`)}
	got := translateSegment(r)
	require.Equal(t, "VIP Gmail", got.Name)
	require.Equal(t, "condition", got.QueryAST.Op)
	require.Equal(t, "tag", got.QueryAST.Field)
	require.Equal(t, "equals", got.QueryAST.Comparator)
	require.Equal(t, "klaviyo:segment:S1", got.QueryAST.Value)
	require.Contains(t, got.SourceDefinition, "profile-property")
	require.Contains(t, got.Description, "Frozen")
}

func TestTranslateFlow_StatusMapping(t *testing.T) {
	r := kvResource{ID: "F1", Attributes: json.RawMessage(`{"name":"Welcome","status":"live","trigger":{"type":"list"}}`)}
	got := translateFlow(r)
	require.Equal(t, "draft", got.Status)
	require.Empty(t, got.Triggers)
	require.Empty(t, got.Nodes)
	require.Contains(t, got.SourceDefinition, `"migration_mode":"rebuild_review"`)
}

func TestTranslateFlowWithActions_MaterializesNodes(t *testing.T) {
	flow := kvResource{ID: "F1", Attributes: json.RawMessage(`{
		"name":"Post purchase",
		"status":"live",
		"trigger":{"type":"metric","metric_name":"Placed Order"}
	}`)}
	actions := []kvResource{
		{ID: "A1", Type: "flow-action", Attributes: json.RawMessage(`{"flow_id":"F1","action_type":"time-delay","duration_seconds":3600,"position":1}`)},
		{ID: "A2", Type: "flow-action", Attributes: json.RawMessage(`{"flow_id":"F1","action_type":"send-email","template_id":"T1","position":2}`)},
	}
	got := translateFlowWithActions(flow, actions)
	require.Equal(t, "draft", got.Status)
	require.Empty(t, got.Triggers)
	require.Empty(t, got.Nodes)
	require.Empty(t, got.Edges)
	require.Contains(t, got.SourceDefinition, "included_actions")
}

func TestExtractCursor(t *testing.T) {
	cases := map[string]string{
		"": "",
		"https://a.klaviyo.com/api/profiles?page[cursor]=abc&x=1":       "abc",
		"https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=encoded":   "encoded",
		"https://a.klaviyo.com/api/profiles?other=foo&page[cursor]=xyz": "xyz",
		"https://a.klaviyo.com/api/profiles?page[cursor]=last":          "last",
	}
	for in, want := range cases {
		require.Equal(t, want, extractCursor(in), in)
	}
}

func TestCampaignCursor_Encoding(t *testing.T) {
	raw := encodeCampaignCursor(0, "opaque:+/cursor")
	channel, page, err := decodeCampaignCursor(raw)
	require.NoError(t, err)
	require.Equal(t, 0, channel)
	require.Equal(t, "opaque:+/cursor", page)
}

func TestAuthenticate_PassesRevisionHeader(t *testing.T) {
	var sawHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawHeader = r.Header.Get("revision")
		require.Equal(t, "Klaviyo-API-Key k", r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"type":"account","id":"acct"}]}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "k"})
	require.NoError(t, err)
	require.Equal(t, "k", sess.AccessToken)
	require.Equal(t, "acct", sess.AccountID)
	require.NotEmpty(t, AccountFingerprint(sess))
	require.Equal(t, apiRevision, sawHeader)
}

func TestAuthenticate_UsesBearerAccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer oauth-token", r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"type":"account","id":"acct"}]}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{AccessToken: "oauth-token"})
	require.NoError(t, err)
	require.Equal(t, "oauth-token", sess.AccessToken)
	require.Equal(t, "bearer", sess.Extra["auth_scheme"])
}

func TestAuthenticate_MissingKey(t *testing.T) {
	a := New()
	_, err := a.Authenticate(context.Background(), adapter.Credentials{})
	require.Error(t, err)
}

func TestDo_401MapsToErrAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	err := a.do(context.Background(), adapter.Session{AccessToken: "x"}, http.MethodGet, "/anything", nil, nil)
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestDo_429MapsToRateLimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	err := a.do(context.Background(), adapter.Session{AccessToken: "x"}, http.MethodGet, "/anything", nil, nil)
	var rl *adapter.ErrRateLimited
	require.ErrorAs(t, err, &rl)
}

func TestListSubscribers_FollowsCursor(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			require.NotContains(t, r.URL.RawQuery, "page[cursor]")
			_, _ = w.Write([]byte(`{
				"data":[{"id":"p1","type":"profile","attributes":{"email":"a@b.com","subscriptions":{"email":{"marketing":{"can_receive_email_marketing":true,"consent":"SUBSCRIBED","consent_timestamp":"2024-01-01T00:00:00Z","double_optin":true,"suppression":[],"list_suppressions":[]}}}}}],
				"links":{"next":"https://example/api/profiles?page%5Bcursor%5D=next123"}
			}`))
			return
		}
		require.Equal(t, "next123", r.URL.Query().Get("page[cursor]"))
		_, _ = w.Write([]byte(`{
			"data":[{"id":"p2","type":"profile","attributes":{"email":"c@d.com","subscriptions":{"email":{"marketing":{"can_receive_email_marketing":false,"consent":"UNSUBSCRIBED","suppression":[],"list_suppressions":[]}}}}}],
			"links":{"next":""}
		}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	sess := boundTestSession()
	a.snapshots[AccountFingerprint(sess)] = &klaviyoSnapshot{
		EmailProfileIDs: map[string]struct{}{"p1": {}, "p2": {}},
		AllProfileIDs:   map[string]struct{}{"p1": {}, "p2": {}},
		TagsByProfile:   map[string][]string{},
	}

	subs1, next1, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, subs1, 1)
	require.Equal(t, "next123", next1)

	subs2, next2, err := a.ListSubscribers(context.Background(), sess, next1)
	require.NoError(t, err)
	require.Len(t, subs2, 1)
	require.Equal(t, "", next2)
	require.Equal(t, canonical.StatusDisabled, subs2[0].Status)
}

func TestCapabilities(t *testing.T) {
	caps := New().Capabilities()
	require.Equal(t, canonical.SourceKlaviyo, caps.Source)
	require.True(t, caps.Supports.Subscribers)
	require.True(t, caps.Supports.Segments)
	require.True(t, caps.Supports.Automations)
	require.Equal(t, "rebuild_review", caps.Supports.AutomationMode)
	require.True(t, caps.Supports.CampaignArchive)
	require.False(t, caps.Supports.PaidSubs)
	require.False(t, caps.Supports.SMS)
	require.True(t, caps.Supports.Forms)
	require.False(t, caps.Supports.Ecommerce)
	require.False(t, caps.Supports.Reports)
}

func TestListTemplates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/templates", r.URL.Path)
		_, _ = w.Write([]byte(`{
			"data":[{
				"id":"tmpl_1",
				"type":"template",
				"attributes":{
					"name":"Welcome",
					"subject":"Hi",
					"preview_text":"Preview",
					"html":"<p>Hello</p>",
					"editor_type":"drag_and_drop"
				}
			}],
			"links":{"next":"https://example/templates?page[cursor]=next"}
		}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	sess := boundTestSession()
	a.snapshots[AccountFingerprint(sess)] = &klaviyoSnapshot{EditableTemplateIDs: map[string]struct{}{"tmpl_1": {}}}
	out, next, err := a.ListTemplates(context.Background(), sess, "")
	require.NoError(t, err)
	require.Equal(t, "next", next)
	require.Len(t, out, 1)
	require.Equal(t, "tmpl_1", out[0].SourceID)
	require.Equal(t, "Welcome", out[0].Name)
	require.Contains(t, out[0].HTML, "Hello")
}

func TestListSourceArchiveKlaviyoRebuildTasks(t *testing.T) {
	a := New()
	sess := boundTestSession()
	a.snapshots[AccountFingerprint(sess)] = &klaviyoSnapshot{}
	cursor := ""
	var items []canonical.SourceArchiveItem
	for {
		batch, next, err := a.ListSourceArchive(context.Background(), sess, cursor)
		require.NoError(t, err)
		items = append(items, batch...)
		if next == "" {
			break
		}
		cursor = next
	}
	require.Len(t, items, klaviyoStaticArchiveTaskCount)
	require.Equal(t, "klaviyo_commerce", items[0].ResourceType)
	require.Equal(t, canonical.SourceKlaviyo, items[0].SourcePlatform)
	require.Contains(t, items[0].Payload, "rebuild_task")
	require.Equal(t, "klaviyo_marketplace", items[len(items)-1].ResourceType)
}

func TestURLEncode_FilterExpressions(t *testing.T) {
	got := urlEncode("equals(messages.channel,'email')")
	require.False(t, strings.Contains(got, " "))
	require.True(t, strings.Contains(got, "%27"))
}

func TestListPaidSubs_Unsupported(t *testing.T) {
	_, err := New().ListPaidSubs(context.Background(), adapter.Session{}, "")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
}

func boundTestSession() adapter.Session {
	accountID := "acct"
	return adapter.Session{
		AccessToken: "k",
		AccountID:   accountID,
		Source:      canonical.SourceKlaviyo,
		Extra: map[string]string{
			"auth_scheme":              "private_api_key",
			AccountIDExtraKey:          accountID,
			AccountFingerprintExtraKey: accountFingerprint(accountID),
		},
	}
}
