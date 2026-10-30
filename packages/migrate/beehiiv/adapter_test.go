// SPDX-License-Identifier: MIT

package beehiiv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestCapabilitiesAreTruthful(t *testing.T) {
	caps := New().Capabilities()
	require.True(t, caps.Supports.Subscribers)
	require.True(t, caps.Supports.Segments)
	require.True(t, caps.Supports.Groups)
	require.True(t, caps.Supports.Automations)
	require.Equal(t, "rebuild_review", caps.Supports.AutomationMode)
	require.True(t, caps.Supports.CampaignArchive)
	require.False(t, caps.Supports.PaidSubs)
	require.False(t, caps.Supports.ConsentTimestamps)
	require.False(t, caps.Supports.Templates)
}

func TestMapSubscriberPreservesProviderStateWithoutInventingConsent(t *testing.T) {
	created := int64(1_700_000_000)
	cases := []struct {
		status string
		want   canonical.SubscriberStatus
	}{
		{"active", canonical.StatusEnabled},
		{"inactive", canonical.StatusDisabled},
		{"paused", canonical.StatusDisabled},
		{"invalid", canonical.StatusBlocklisted},
		{"pending", canonical.StatusUnconfirmed},
		{"validating", canonical.StatusUnconfirmed},
		{"needs_attention", canonical.StatusUnconfirmed},
		{"future_status", canonical.StatusUnconfirmed},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			subscriber := mapSubscriber(bhSubscription{
				ID:                "sub_1",
				Email:             " person@example.com ",
				Status:            tc.status,
				Created:           created,
				SubscriptionTier:  "premium",
				PremiumTierNames:  []string{"Gold"},
				UTMSource:         "newsletter",
				CustomFields:      []bhCustomField{{Name: "city", Value: "Delhi"}},
				NewsletterListIDs: []string{"nl_list_weekly"},
				Tags:              []string{"vip"},
			}, "pub_primary", []string{"beehiiv:segment:seg_power"})

			require.Equal(t, tc.want, subscriber.Status)
			require.Nil(t, subscriber.ConsentTimestamp)
			require.Equal(t, canonical.ConsentUnknown, subscriber.ConsentSource)
			require.Equal(t, "person@example.com", subscriber.Email)
			require.Equal(t, "Delhi", subscriber.CustomFields["city"])
			provider := subscriber.CustomFields["beehiiv"].(map[string]interface{})
			require.Equal(t, tc.status, provider["status"])
			require.Equal(t, time.Unix(created, 0).UTC().Format(time.RFC3339), provider["subscription_created_at"])
			require.ElementsMatch(t, []string{"vip", "beehiiv:newsletter-list:nl_list_weekly", "beehiiv:segment:seg_power"}, subscriber.Tags)
		})
	}
}

func TestAuthenticateIdentifiesWorkspaceAndValidatesExplicitPublication(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/workspaces/identify":
			_, _ = w.Write([]byte(`{"data":{"id":"work_main","name":"Workspace","owner_email":"owner@example.com"}}`))
		case "/publications":
			require.Equal(t, "100", r.URL.Query().Get("limit"))
			_, _ = w.Write([]byte(`{"data":[{"id":"pub_one","name":"One"},{"id":"pub_two","name":"Two"}],"page":1,"total_pages":1,"total_results":2}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	a := New()
	a.BaseURL = server.URL
	session, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: " secret ", AccountID: "pub_two"})
	require.NoError(t, err)
	require.Equal(t, int64(2), calls.Load())
	require.Equal(t, "pub_two", session.AccountID)
	require.Equal(t, "work_main", session.Extra[WorkspaceIDExtraKey])
	require.Equal(t, "pub_two", session.Extra[PublicationIDExtraKey])
	require.Len(t, AccountFingerprint(session), 64)
	require.NotContains(t, session.Extra, "owner_email")
}

func TestAuthenticateRequiresSelectionForMultiplePublications(t *testing.T) {
	server := authServer(t, `{"data":[{"id":"pub_one","name":"One"},{"id":"pub_two","name":"Two"}],"page":1,"total_pages":1,"total_results":2}`)
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "secret"})
	require.ErrorIs(t, err, ErrPublicationSelectionRequired)
}

func TestAuthenticateRejectsPublicationOutsideCredential(t *testing.T) {
	server := authServer(t, `{"data":[{"id":"pub_one","name":"One"}],"page":1,"total_pages":1,"total_results":1}`)
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "secret", AccountID: "pub_other"})
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestListSubscribersUsesOpaqueCursorAndRequiredExpansions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
			_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
		case "/publications/pub_main/subscriptions":
			query := r.URL.Query()
			require.Equal(t, "opaque+/cursor==", query.Get("cursor"))
			require.Equal(t, "all", query.Get("status"))
			require.Equal(t, "all", query.Get("tier"))
			require.ElementsMatch(t, []string{"custom_fields", "stats", "newsletter_lists", "subscription_premium_tiers"}, query["expand[]"])
			_, _ = w.Write([]byte(`{"data":[{"id":"sub_one","email":"a@example.com","status":"active","created":1700000000,"subscription_tier":"premium","subscription_premium_tier_names":["Gold"],"subscription_premium_tiers":[{"id":"tier_gold","name":"Gold","status":"active"}],"custom_fields":[{"name":"city","kind":"string","value":"Pune"}],"newsletter_list_ids":["nl_list_weekly"],"tags":[]}],"has_more":true,"next_cursor":"next opaque"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	subscribers, next, err := a.ListSubscribers(context.Background(), testSession(), "opaque+/cursor==")
	require.NoError(t, err)
	require.Equal(t, "next opaque", next)
	require.Len(t, subscribers, 1)
	require.Equal(t, "Pune", subscribers[0].CustomFields["city"])
	provider := subscribers[0].CustomFields["beehiiv"].(map[string]interface{})
	require.Equal(t, "premium", provider["subscription_tier"])
	require.Equal(t, []string{"Gold"}, provider["subscription_premium_tier_names"])
	require.Equal(t, []bhSubscriptionTier{{ID: "tier_gold", Name: "Gold", Status: "active"}}, provider["subscription_premium_tiers"])
}

func TestListSubscribersRejectsBrokenCursorContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/segments"), strings.HasSuffix(r.URL.Path, "/newsletter_lists"):
			_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1}`))
		case strings.HasSuffix(r.URL.Path, "/subscriptions"):
			_, _ = w.Write([]byte(`{"data":[],"has_more":true,"next_cursor":null}`))
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, _, err := a.ListSubscribers(context.Background(), testSession(), "")
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestListSubscribersRejectsOmittedCursorMetadataBeforeDeletionReconciliation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/segments"), strings.HasSuffix(r.URL.Path, "/newsletter_lists"):
			_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1}`))
		case strings.HasSuffix(r.URL.Path, "/subscriptions"):
			_, _ = w.Write([]byte(`{"data":[{"id":"sub_one","email":"one@example.com","status":"active","subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[],"tags":[]}]}`))
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, _, err := a.ListSubscribers(context.Background(), testSession(), "")
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestSegmentsUseExactMembershipSnapshotsAndNewsletterLists(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/segments":
			_, _ = w.Write([]byte(`{"data":[{"id":"seg_power","name":"Power users","type":"dynamic","total_results":1,"status":"completed","active":true},{"id":"seg_busy","name":"Calculating","type":"dynamic","total_results":2,"status":"processing","active":true}],"page":1,"total_pages":1}`))
		case "/publications/pub_main/segments/seg_power/results":
			_, _ = w.Write([]byte(`{"data":["sub_one"],"page":1,"total_pages":1,"total_results":1}`))
		case "/publications/pub_main/newsletter_lists":
			_, _ = w.Write([]byte(`{"data":[{"id":"nl_list_weekly","name":"Weekly","status":"active","subscriber_count":1}],"page":1,"total_pages":1}`))
		case "/publications/pub_main/subscriptions":
			_, _ = w.Write([]byte(`{"data":[{"id":"sub_one","email":"a@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":["nl_list_weekly"],"tags":[]}],"has_more":false}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL

	subscribers, _, err := a.ListSubscribers(context.Background(), testSession(), "")
	require.NoError(t, err)
	require.ElementsMatch(t, []string{"beehiiv:segment:seg_power", "beehiiv:newsletter-list:nl_list_weekly"}, subscribers[0].Tags)

	segments, err := a.ListSegments(context.Background(), testSession())
	require.NoError(t, err)
	require.Len(t, segments, 3)
	require.Equal(t, "condition", segments[0].QueryAST.Op)
	require.Equal(t, "beehiiv:segment:seg_power", segments[0].QueryAST.Value)
	require.Equal(t, "unsupported", segments[1].QueryAST.Op)
	require.Equal(t, "beehiiv:newsletter-list:nl_list_weekly", segments[2].QueryAST.Value)
	require.Contains(t, segments[0].SourceDefinition, "static_membership_snapshot")
	require.Contains(t, segments[0].SourceDefinition, `"source_id":"beehiiv:segment:seg_power"`)
	require.Contains(t, segments[2].SourceDefinition, `"source_id":"beehiiv:newsletter-list:nl_list_weekly"`)
}

func TestListSubscribersRejectsMissingRequiredStatusOrCreationProvenance(t *testing.T) {
	tests := []struct {
		name     string
		response string
	}{
		{
			name:     "missing status",
			response: `{"data":[{"id":"sub_one","email":"private-reader@example.com","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[],"tags":[]}],"has_more":false}`,
		},
		{
			name:     "missing creation time",
			response: `{"data":[{"id":"sub_one","email":"private-reader@example.com","status":"active","subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[],"tags":[]}],"has_more":false}`,
		},
		{
			name:     "invalid creation time",
			response: `{"data":[{"id":"sub_one","email":"private-reader@example.com","status":"active","created":-1,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[],"tags":[]}],"has_more":false}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
					_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
				case "/publications/pub_main/subscriptions":
					_, _ = w.Write([]byte(tc.response))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			_, _, err := a.ListSubscribers(context.Background(), testSession(), "")
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), "required status or creation provenance")
			require.NotContains(t, err.Error(), "private-reader@example.com")
		})
	}
}

func TestListSubscribersAcceptsExplicitEmptyAuthoritativeExpansions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
			_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
		case "/publications/pub_main/subscriptions":
			_, _ = w.Write([]byte(`{"data":[
				{"id":"sub_empty","email":"empty@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[],"tags":[]}
			],"has_more":false}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	subscribers, next, err := a.ListSubscribers(context.Background(), testSession(), "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, subscribers, 1)
	require.Empty(t, subscribers[0].Tags)
	for _, subscriber := range subscribers {
		provider := subscriber.CustomFields["beehiiv"].(map[string]interface{})
		require.Equal(t, "free", provider["subscription_tier"])
		require.Equal(t, []string{}, provider["subscription_premium_tier_names"])
		require.Equal(t, []bhSubscriptionTier{}, provider["subscription_premium_tiers"])
	}
}

func TestListSubscribersRejectsMissingAuthoritativeExpansionKeys(t *testing.T) {
	tests := []struct {
		name string
		row  string
	}{
		{
			name: "missing custom fields",
			row:  `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"newsletter_list_ids":[],"tags":[]}`,
		},
		{
			name: "missing newsletter lists",
			row:  `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"tags":[]}`,
		},
		{
			name: "missing tags",
			row:  `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[]}`,
		},
		{
			name: "null custom fields",
			row:  `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":null,"newsletter_list_ids":[],"tags":[]}`,
		},
		{
			name: "null newsletter lists",
			row:  `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":null,"tags":[]}`,
		},
		{
			name: "null tags",
			row:  `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[],"newsletter_list_ids":[],"tags":null}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
					_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
				case "/publications/pub_main/subscriptions":
					_, _ = fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, tc.row)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			_, _, err := a.ListSubscribers(context.Background(), testSession(), "")
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), "authoritative custom_fields, newsletter_list_ids, or tags arrays")
			require.NotContains(t, err.Error(), "private-reader@example.com")
		})
	}
}

func TestListSubscribersRejectsMalformedAuthoritativeItems(t *testing.T) {
	const prefix = `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],`
	tests := []struct {
		name string
		row  string
		want string
	}{
		{name: "nameless custom field", row: prefix + `"custom_fields":[{"name":"","kind":"string","value":"x"}],"newsletter_list_ids":[],"tags":[]}`, want: "custom-field name"},
		{name: "missing custom field kind", row: prefix + `"custom_fields":[{"name":"city","value":"x"}],"newsletter_list_ids":[],"tags":[]}`, want: "invalid kind"},
		{name: "missing custom field value", row: prefix + `"custom_fields":[{"name":"city","kind":"string"}],"newsletter_list_ids":[],"tags":[]}`, want: "without an explicit value"},
		{name: "string custom field object value", row: prefix + `"custom_fields":[{"name":"city","kind":"string","value":{"name":"Pune"}}],"newsletter_list_ids":[],"tags":[]}`, want: `does not match kind "string"`},
		{name: "fractional integer custom field", row: prefix + `"custom_fields":[{"name":"visits","kind":"integer","value":1.5}],"newsletter_list_ids":[],"tags":[]}`, want: `does not match kind "integer"`},
		{name: "boolean custom field string value", row: prefix + `"custom_fields":[{"name":"vip","kind":"boolean","value":"true"}],"newsletter_list_ids":[],"tags":[]}`, want: `does not match kind "boolean"`},
		{name: "list custom field mixed value", row: prefix + `"custom_fields":[{"name":"interests","kind":"list","value":["news",1]}],"newsletter_list_ids":[],"tags":[]}`, want: `does not match kind "list"`},
		{name: "duplicate custom field", row: prefix + `"custom_fields":[{"name":"city","kind":"string","value":"x"},{"name":"city","kind":"string","value":"y"}],"newsletter_list_ids":[],"tags":[]}`, want: "duplicate custom field"},
		{name: "empty tag", row: prefix + `"custom_fields":[],"newsletter_list_ids":[],"tags":[""]}`, want: "invalid source tag"},
		{name: "duplicate tag", row: prefix + `"custom_fields":[],"newsletter_list_ids":[],"tags":["vip","vip"]}`, want: "duplicate source tag"},
		{name: "duplicate newsletter list", row: prefix + `"custom_fields":[],"newsletter_list_ids":["nl_list_weekly","nl_list_weekly"],"tags":[]}`, want: "duplicate newsletter-list identity"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
					_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
				case "/publications/pub_main/subscriptions":
					_, _ = fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, tc.row)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			_, _, err := a.ListSubscribers(context.Background(), testSession(), "")
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), tc.want)
			require.NotContains(t, err.Error(), "private-reader@example.com")
		})
	}
}

func TestListSubscribersPreservesExplicitNullCustomFieldAsIntentionalRemoval(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
			_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
		case "/publications/pub_main/subscriptions":
			_, _ = w.Write([]byte(`{"data":[{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":[],"custom_fields":[{"name":"city","kind":"string","value":null}],"newsletter_list_ids":[],"tags":[]}],"has_more":false}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	subscribers, next, err := a.ListSubscribers(context.Background(), testSession(), "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, subscribers, 1)
	require.NotContains(t, subscribers[0].CustomFields, "city")
	provider := subscribers[0].CustomFields["beehiiv"].(map[string]interface{})
	require.Equal(t, []string{"city"}, provider["null_custom_fields"])
}

func TestSubscriptionCustomFieldValuesMatchDocumentedKinds(t *testing.T) {
	valid := []struct {
		kind  string
		value interface{}
	}{
		{kind: "string", value: "Pune"},
		{kind: "date", value: "2026-07-16"},
		{kind: "datetime", value: "2026-07-16T10:00:00Z"},
		{kind: "boolean", value: true},
		{kind: "integer", value: float64(42)},
		{kind: "double", value: 42.5},
		{kind: "list", value: []interface{}{"news", "events"}},
		{kind: "list", value: []interface{}{}},
	}
	for _, tc := range valid {
		require.True(t, validSubscriptionCustomFieldValue(tc.kind, tc.value), "%s should accept %#v", tc.kind, tc.value)
	}

	invalid := []struct {
		kind  string
		value interface{}
	}{
		{kind: "string", value: map[string]interface{}{}},
		{kind: "date", value: true},
		{kind: "datetime", value: float64(1)},
		{kind: "boolean", value: "true"},
		{kind: "integer", value: 1.5},
		{kind: "double", value: "1.5"},
		{kind: "list", value: []interface{}{"news", float64(1)}},
	}
	for _, tc := range invalid {
		require.False(t, validSubscriptionCustomFieldValue(tc.kind, tc.value), "%s should reject %#v", tc.kind, tc.value)
	}
}

func TestListSubscribersRequiresCompletePremiumTierMetadata(t *testing.T) {
	const prefix = `{"id":"sub_one","email":"private-reader@example.com","status":"active","created":1700000000,`
	const suffix = `,"custom_fields":[],"newsletter_list_ids":[],"tags":[]}`
	tests := []struct {
		name string
		row  string
	}{
		{
			name: "missing subscription tier",
			row:  prefix + `"subscription_premium_tier_names":[],"subscription_premium_tiers":[]` + suffix,
		},
		{
			name: "invalid subscription tier",
			row:  prefix + `"subscription_tier":"enterprise","subscription_premium_tier_names":[],"subscription_premium_tiers":[]` + suffix,
		},
		{
			name: "missing premium tier names",
			row:  prefix + `"subscription_tier":"free","subscription_premium_tiers":[]` + suffix,
		},
		{
			name: "null premium tier names",
			row:  prefix + `"subscription_tier":"free","subscription_premium_tier_names":null,"subscription_premium_tiers":[]` + suffix,
		},
		{
			name: "missing expanded premium tiers",
			row:  prefix + `"subscription_tier":"free","subscription_premium_tier_names":[]` + suffix,
		},
		{
			name: "null expanded premium tiers",
			row:  prefix + `"subscription_tier":"free","subscription_premium_tier_names":[],"subscription_premium_tiers":null` + suffix,
		},
		{
			name: "incomplete expanded premium tier",
			row:  prefix + `"subscription_tier":"premium","subscription_premium_tier_names":["Gold"],"subscription_premium_tiers":[{"id":"tier_gold","name":"Gold"}]` + suffix,
		},
		{
			name: "duplicate expanded premium tier",
			row: prefix + `"subscription_tier":"premium","subscription_premium_tier_names":["Gold"],"subscription_premium_tiers":[` +
				`{"id":"tier_gold","name":"Gold","status":"active"},{"id":"tier_gold","name":"Gold","status":"active"}]` + suffix,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists":
					_, _ = w.Write([]byte(`{"data":[],"page":1,"total_pages":1,"total_results":0}`))
				case "/publications/pub_main/subscriptions":
					_, _ = fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, tc.row)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			_, _, err := a.ListSubscribers(context.Background(), testSession(), "")
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, strings.ToLower(err.Error()), "tier")
			require.NotContains(t, err.Error(), "private-reader@example.com")
		})
	}
}

func TestSegmentSnapshotRejectsDuplicateMemberAcrossPages(t *testing.T) {
	firstPage := make([]string, 0, 100)
	for i := 0; i < 100; i++ {
		firstPage = append(firstPage, fmt.Sprintf("sub_%03d", i))
	}
	firstRaw, err := json.Marshal(firstPage)
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/publications/pub_main/segments/seg_power/results", r.URL.Path)
		if r.URL.Query().Get("page") == "2" {
			_, _ = w.Write([]byte(`{"data":["sub_000"],"limit":100,"page":2,"total_pages":2,"total_results":101}`))
			return
		}
		_, _ = w.Write([]byte(fmt.Sprintf(`{"data":%s,"limit":100,"page":1,"total_pages":2,"total_results":101}`, firstRaw)))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err = a.listSegmentMemberIDs(context.Background(), testSession(), bhSegment{
		ID: "seg_power", Name: "Power readers", Status: "completed", TotalResults: 101,
	})
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "duplicate subscription id")
}

func TestSegmentSnapshotAggregateEvidenceBudgetFailsClosed(t *testing.T) {
	require.True(t, segmentMembershipBudgetAllows(0, 10000))
	require.True(t, segmentMembershipBudgetAllows(maxSegmentMembershipEvidence-10000, 10000))
	require.False(t, segmentMembershipBudgetAllows(maxSegmentMembershipEvidence-10000, 10001))
	require.False(t, segmentMembershipBudgetAllows(maxSegmentMembershipEvidence, 1))
	require.False(t, segmentMembershipBudgetAllows(-1, 1))
}

func TestOffsetPaginationRejectsTruncatedDeclaredInventory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/publications/pub_main/newsletter_lists", r.URL.Path)
		_, _ = w.Write([]byte(`{"data":[{"id":"nl_list_one","name":"One"}],"limit":100,"page":1,"total_pages":1,"total_results":100}`))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err := a.listNewsletterLists(context.Background(), testSession())
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestOffsetPaginationRejectsDuplicateDefinitionAcrossPages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/publications/pub_main/segments", r.URL.Path)
		page := r.URL.Query().Get("page")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"seg_duplicate","name":"Duplicate","type":"dynamic","total_results":0,"status":"completed","active":true}],"limit":1,"page":%s,"total_pages":2,"total_results":2}`, page)))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err := a.listSegments(context.Background(), testSession())
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "duplicate id")
}

func TestAutomationsAreRebuildOnlyAndPreservePaginatedEmails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/automations":
			_, _ = w.Write([]byte(`{"data":[{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"description":"Welcome series","stats":{"journeys":{"running":0,"completed":2,"total":2}}}],"page":1,"total_pages":1}`))
		case "/publications/pub_main/automations/aut_welcome/emails":
			if r.URL.Query().Get("cursor") == "email-next" {
				_, _ = w.Write([]byte(`{"data":[{"id":"email_two","automation_step_id":"step_two","subject_line":"Day 2","preview_text":"Hi","status":"active","created_at":2,"stats":{"email":{"recipients":1,"delivered":1,"opens":1,"unique_opens":1,"clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":0}}}],"has_more":false}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"email_one","automation_step_id":"step_one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":1,"stats":{"email":{"recipients":1,"delivered":1,"opens":1,"unique_opens":1,"clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":0}}}],"has_more":true,"next_cursor":"email-next"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	automations, err := a.ListAutomations(context.Background(), testSession())
	require.NoError(t, err)
	require.Len(t, automations, 1)
	require.Equal(t, "draft", automations[0].Status)
	require.Empty(t, automations[0].Triggers)
	require.Empty(t, automations[0].Nodes)
	require.Contains(t, automations[0].SourceDefinition, "email_two")
	require.Contains(t, automations[0].SourceDefinition, "rebuild_review")
	require.Contains(t, automations[0].SourceDefinition, `"source_id":"beehiiv:automation:aut_welcome"`)
}

func TestAutomationInventoryRequiresRequestedStatistics(t *testing.T) {
	tests := []struct {
		name       string
		automation string
		email      string
		want       string
	}{
		{
			name:       "automation stats omitted",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"]}`,
			want:       "omitted requested statistics",
		},
		{
			name:       "email stats omitted",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"stats":{"journeys":{"running":0,"completed":1,"total":1}}}`,
			email:      `{"id":"email_one","automation_step_id":"step_one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":1}`,
			want:       "omitted requested statistics",
		},
		{
			name:       "email stats incomplete",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"stats":{"journeys":{"running":0,"completed":1,"total":1}}}`,
			email:      `{"id":"email_one","automation_step_id":"step_one","subject_line":"Welcome","preview_text":"Hi","status":"active","created_at":1,"stats":{"email":{"recipients":1}}}`,
			want:       "missing delivered",
		},
		{
			name:       "automation stats unknown-only",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"stats":{"total_sent":1}}`,
			want:       "no documented journey or aggregate email statistics",
		},
		{
			name:       "automation journey stats malformed",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"stats":{"journeys":{"running":0,"completed":1,"total":-1}}}`,
			want:       "invalid total",
		},
		{
			name: "automation aggregate email stats malformed",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"stats":{"email":` +
				`{"recipients":1,"delivered":1,"opens":1,"unique_opens":1,"clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":"none"}}}`,
			want: "invalid spam_reports",
		},
		{
			name: "automation aggregate email rate malformed",
			automation: `{"id":"aut_welcome","name":"Welcome","status":"running","trigger_events":["signup"],"stats":{"email":` +
				`{"recipients":1,"delivered":1,"opens":1,"unique_opens":1,"open_rate":"all","clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":0}}}`,
			want: "invalid open_rate",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/publications/pub_main/automations":
					_, _ = fmt.Fprintf(w, `{"data":[%s],"page":1,"total_pages":1,"total_results":1}`, tc.automation)
				case "/publications/pub_main/automations/aut_welcome/emails":
					_, _ = fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, tc.email)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a := New()
			a.BaseURL = server.URL
			_, err := a.ListAutomations(context.Background(), testSession())
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), tc.want)
		})
	}
}

func TestAutomationEmailInventoryRejectsEndlessNovelCursorsAtBound(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/publications/pub_main/automations/aut_unbounded/emails", r.URL.Path)
		call := calls.Add(1)
		_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"id":"email_%d","automation_step_id":"step_%d","subject_line":"Step","preview_text":"","status":"active","created_at":1,"stats":{"email":{"recipients":0,"delivered":0,"opens":0,"unique_opens":0,"clicks":0,"unique_clicks":0,"unsubscribes":0,"spam_reports":0}}}],"has_more":true,"next_cursor":"cursor-%d"}`, call, call, call)))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err := a.listAutomationEmails(context.Background(), testSession(), "aut_unbounded")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	require.ErrorContains(t, err, "exceeded 100 cursor pages")
	require.Equal(t, int64(maxOffsetPages), calls.Load())
}

func TestCampaignArchiveMapsNestedContentStatsAndExcludesUnsentPosts(t *testing.T) {
	now := time.Now().UTC()
	past := now.Add(-time.Hour).Unix()
	future := now.Add(time.Hour).Unix()
	response := map[string]interface{}{
		"data": []interface{}{
			map[string]interface{}{
				"id": "post_sent", "title": "Launch", "subject_line": "Big launch", "status": "confirmed", "platform": "both", "audience": "both", "created": past - 60, "publish_date": past, "displayed_date": past + 1, "recipient_count": 500,
				"content": map[string]interface{}{"free": map[string]interface{}{"email": "<p>free email</p>", "web": "<p>free web</p>", "rss": ""}, "premium": map[string]interface{}{"email": "<p>premium</p>", "web": ""}},
				"stats": map[string]interface{}{"email": map[string]interface{}{
					"recipients": 0, "delivered": 0, "opens": 200, "unique_opens": 180,
					"clicks": 50, "unique_clicks": 45, "verified_clicks": 40, "unsubscribes": 2, "spam_reports": 1,
				}},
			},
			map[string]interface{}{"id": "post_scheduled", "title": "Later", "status": "confirmed", "platform": "email", "publish_date": future},
			map[string]interface{}{"id": "post_web", "title": "Web", "status": "confirmed", "platform": "web", "publish_date": past},
			map[string]interface{}{"id": "post_draft", "title": "Draft", "status": "draft", "platform": "email"},
		},
		"page": 1, "total_pages": 1,
	}
	raw, err := json.Marshal(response)
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/posts":
			require.Equal(t, "all", r.URL.Query().Get("status"))
			require.Empty(t, r.URL.Query()["expand"])
			require.Empty(t, r.URL.Query()["expand[]"])
			_, _ = w.Write(raw)
		case "/publications/pub_main/posts/post_sent":
			require.ElementsMatch(t, postExpansionValues()["expand"], r.URL.Query()["expand"])
			require.Empty(t, r.URL.Query()["expand[]"])
			postRaw, marshalErr := json.Marshal(map[string]interface{}{"data": response["data"].([]interface{})[0]})
			require.NoError(t, marshalErr)
			_, _ = w.Write(postRaw)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	archive, next, err := a.ListCampaignArchive(context.Background(), testSession(), "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, archive, 1)
	require.Equal(t, "<p>free email</p>", archive[0].HTML)
	require.Equal(t, 500, archive[0].RecipientsCount)
	require.Equal(t, 200, archive[0].Opens)
	require.Equal(t, 50, archive[0].Clicks)
	require.Equal(t, past-60, archive[0].Report["created"])
	require.Equal(t, past, *archive[0].Report["publish_date"].(*int64))
	require.Equal(t, past+1, *archive[0].Report["displayed_date"].(*int64))
	require.Equal(t, 500, *archive[0].Report["recipient_count"].(*int))
	require.Empty(t, archive[0].Text)
	reportContent := archive[0].Report["content"].(map[string]interface{})
	require.Equal(t, "<p>premium</p>", reportContent["premium"].(map[string]interface{})["email"])
	reportStats := archive[0].Report["stats"].(map[string]interface{})
	require.NotContains(t, reportStats["email"].(map[string]interface{}), "unique_verified_clicks", "omitted optional analytics must not be fabricated as zero")
}

func TestExpandedSentPostStatsRequireDocumentedEmailCounters(t *testing.T) {
	validEmail := func() map[string]interface{} {
		return map[string]interface{}{
			"recipients":    0,
			"delivered":     0,
			"opens":         0,
			"unique_opens":  0,
			"clicks":        0,
			"unique_clicks": 0,
			"unsubscribes":  0,
			"spam_reports":  0,
		}
	}
	require.NoError(t, validateExpandedSentPostStats("post_zero", map[string]interface{}{
		"stats": map[string]interface{}{"email": validEmail()},
	}), "explicit zero counters are valid analytics, not synthesized values")

	tests := []struct {
		name    string
		payload map[string]interface{}
	}{
		{name: "missing stats", payload: map[string]interface{}{}},
		{name: "null stats", payload: map[string]interface{}{"stats": nil}},
		{name: "array stats", payload: map[string]interface{}{"stats": []interface{}{}}},
		{name: "missing email stats", payload: map[string]interface{}{"stats": map[string]interface{}{}}},
		{name: "null email stats", payload: map[string]interface{}{"stats": map[string]interface{}{"email": nil}}},
		{name: "array email stats", payload: map[string]interface{}{"stats": map[string]interface{}{"email": []interface{}{}}}},
		{name: "invalid negative counter", payload: map[string]interface{}{"stats": map[string]interface{}{"email": func() map[string]interface{} {
			email := validEmail()
			email["opens"] = -1
			return email
		}()}}},
		{name: "invalid fractional counter", payload: map[string]interface{}{"stats": map[string]interface{}{"email": func() map[string]interface{} {
			email := validEmail()
			email["clicks"] = 0.5
			return email
		}()}}},
		{name: "invalid string counter", payload: map[string]interface{}{"stats": map[string]interface{}{"email": func() map[string]interface{} {
			email := validEmail()
			email["delivered"] = "0"
			return email
		}()}}},
	}
	for _, field := range []string{"recipients", "delivered", "opens", "unique_opens", "clicks", "unique_clicks", "unsubscribes", "spam_reports"} {
		email := validEmail()
		delete(email, field)
		tests = append(tests, struct {
			name    string
			payload map[string]interface{}
		}{
			name:    "missing " + field,
			payload: map[string]interface{}{"stats": map[string]interface{}{"email": email}},
		})
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateExpandedSentPostStats("post_private", tc.payload)
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.NotContains(t, err.Error(), "reader@example.com")
		})
	}
}

func TestExpandedPostContentRejectsOmittedRequestedEmailRendering(t *testing.T) {
	payload := map[string]interface{}{
		"content": map[string]interface{}{
			"free":    map[string]interface{}{"web": "<p>web fallback</p>", "rss": ""},
			"premium": map[string]interface{}{"email": "", "web": ""},
		},
	}
	err := validateExpandedPostContent("post_private", payload)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "free_email")
}

func TestCampaignArchiveRejectsSentPostDetailWithoutExpandedStats(t *testing.T) {
	past := time.Now().UTC().Add(-time.Hour).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/posts":
			_, _ = fmt.Fprintf(w, `{"data":[{"id":"post_deadbeef","title":"Sent","status":"confirmed","platform":"email","publish_date":%d}],"page":1,"total_pages":1,"total_results":1}`, past)
		case "/publications/pub_main/posts/post_deadbeef":
			require.Contains(t, r.URL.Query()["expand"], "stats")
			_, _ = fmt.Fprintf(w, `{"data":{"id":"post_deadbeef","title":"Sent","status":"confirmed","platform":"email","publish_date":%d,"content":{"free":{"email":"<p>sent</p>","web":"","rss":""},"premium":{"email":"","web":""}}}}`, past)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	archive, next, err := a.ListCampaignArchive(context.Background(), testSession(), "")
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "requested stats")
	require.Empty(t, archive)
	require.Empty(t, next)
}

func TestCampaignArchiveFailsClosedAtOffsetPageCapWithoutTerminalMetadata(t *testing.T) {
	posts := make([]map[string]interface{}, 100)
	for i := range posts {
		posts[i] = map[string]interface{}{
			"id":           fmt.Sprintf("post_%d", i),
			"title":        "Archived post",
			"status":       "archived",
			"platform":     "email",
			"publish_date": time.Now().UTC().Add(-time.Hour).Unix(),
		}
	}
	raw, err := json.Marshal(map[string]interface{}{"data": posts, "page": maxOffsetPages})
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, strconv.Itoa(maxOffsetPages), r.URL.Query().Get("page"))
		_, _ = w.Write(raw)
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, _, err = a.ListCampaignArchive(context.Background(), testSession(), strconv.Itoa(maxOffsetPages))
	require.ErrorIs(t, err, adapter.ErrUnsupported)
}

func TestDiscoverPropagatesProviderFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	_, err := a.Discover(context.Background(), testSession())
	require.Error(t, err)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestDiscoverReadsOfficialCustomFieldDefinitionShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/publications/pub_main/segments", "/publications/pub_main/newsletter_lists", "/publications/pub_main/automations", "/publications/pub_main/posts":
			_, _ = w.Write([]byte(`{"data":[],"limit":100,"page":1,"total_pages":0,"total_results":0}`))
		case "/publications/pub_main/subscriptions":
			_, _ = w.Write([]byte(`{"data":[],"limit":1,"page":1,"total_pages":0,"total_results":0}`))
		case "/publications/pub_main/custom_fields":
			_, _ = w.Write([]byte(`{"data":[
				{"id":"00000000-0000-0000-0000-000000000001","kind":"string","display":"Company","created":1700000000},
				{"id":"00000000-0000-0000-0000-000000000002","kind":"list","display":"Plan","created":1700000001,"options":["Free","Pro"]}
			],"limit":100,"page":1,"total_pages":1,"total_results":2}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	report, err := a.Discover(context.Background(), testSession())
	require.NoError(t, err)
	require.Equal(t, []string{"Company", "Plan"}, report.CustomFields)
}

func TestCustomFieldDefinitionsRequireCreationProvenance(t *testing.T) {
	for _, created := range []*int64{nil, ptrInt64(0), ptrInt64(-1)} {
		err := validateCustomFieldDefinition(bhCustomFieldDefinition{
			ID:      "00000000-0000-0000-0000-000000000001",
			Kind:    "string",
			Display: "Private field",
			Created: created,
		})
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		require.Contains(t, err.Error(), "invalid created timestamp")
	}
}

func ptrInt64(value int64) *int64 { return &value }

func TestMapSubscriberSkipsNullCustomFieldValuesWithoutLosingSchemaProvenance(t *testing.T) {
	subscriber := mapSubscriber(bhSubscription{
		ID: "sub_one", Email: "reader@example.com", Status: "active",
		CustomFields: []bhCustomField{
			{Name: "interests", Kind: "list", Value: nil},
			{Name: "birthday", Kind: "date", Value: "2026-07-16"},
			{Name: "vip", Kind: "boolean", Value: true},
		},
	}, "pub_main", nil)
	require.NotContains(t, subscriber.CustomFields, "interests", "a null value must not register the field as a string before a later typed value")
	require.Equal(t, "2026-07-16", subscriber.CustomFields["birthday"])
	require.Equal(t, true, subscriber.CustomFields["vip"])
	provider := subscriber.CustomFields["beehiiv"].(map[string]interface{})
	require.Equal(t, map[string]string{"interests": "list", "birthday": "date", "vip": "boolean"}, provider["custom_field_kinds"])
	require.Equal(t, []string{"interests"}, provider["null_custom_fields"])
}

func TestMapSubscriberPreservesCustomFieldNamedBeehiivWithoutOverwritingIt(t *testing.T) {
	subscriber := mapSubscriber(bhSubscription{
		ID: "sub_collision", Email: "collision@example.com", Status: "active",
		CustomFields: []bhCustomField{
			{Name: "beehiiv", Kind: "string", Value: "source value"},
			{Name: "BeeHiiv", Kind: "string", Value: "case-insensitive source value"},
		},
	}, "pub_main", nil)
	provider := subscriber.CustomFields["beehiiv"].(map[string]interface{})
	collisions := provider["custom_field_name_collisions"].(map[string]interface{})
	escaped := beehiivCustomFieldDestinationKey("beehiiv")
	escapedMixedCase := beehiivCustomFieldDestinationKey("BeeHiiv")
	require.Equal(t, "source value", subscriber.CustomFields[escaped])
	require.Equal(t, "case-insensitive source value", subscriber.CustomFields[escapedMixedCase])
	require.Equal(t, map[string]interface{}{"destination_key": escaped, "kind": "string"}, collisions["beehiiv"])
	require.Equal(t, map[string]interface{}{"destination_key": escapedMixedCase, "kind": "string"}, collisions["BeeHiiv"])
	require.Equal(t, map[string]string{escaped: "string", escapedMixedCase: "string"}, provider["custom_field_kinds"])
}

func TestMapSubscriberEscapesReservedCustomFieldsAndSyntheticTagNamespaces(t *testing.T) {
	reservedField := "postwave_mailchimp_status"
	forgedSegmentTag := "beehiiv:segment:seg_member"
	forgedListTag := "Beehiiv:Newsletter-List:nl_list_member"
	subscriber := mapSubscriber(bhSubscription{
		ID: "sub_collision", Email: "collision@example.com", Status: "active",
		CustomFields: []bhCustomField{{Name: reservedField, Kind: "string", Value: "legitimate source value"}},
		Tags:         []string{forgedSegmentTag, forgedListTag, "ordinary"},
	}, "pub_main", []string{segmentMembershipTag("seg_actual")})

	escapedField := beehiivCustomFieldDestinationKey(reservedField)
	require.Equal(t, "legitimate source value", subscriber.CustomFields[escapedField])
	require.NotContains(t, subscriber.CustomFields, reservedField)
	require.ElementsMatch(t, []string{
		beehiivSourceTagDestination(forgedSegmentTag),
		beehiivSourceTagDestination(forgedListTag),
		"ordinary",
		segmentMembershipTag("seg_actual"),
	}, subscriber.Tags)
	require.NotContains(t, subscriber.Tags, forgedSegmentTag)
	require.NotContains(t, subscriber.Tags, forgedListTag)

	provider := subscriber.CustomFields["beehiiv"].(map[string]interface{})
	require.Equal(t, map[string]string{
		forgedSegmentTag: beehiivSourceTagDestination(forgedSegmentTag),
		forgedListTag:    beehiivSourceTagDestination(forgedListTag),
	}, provider["source_tag_namespace_collisions"])
}

func TestPaidSubscriptionsAreDeliberatelyUnsupported(t *testing.T) {
	_, err := New().ListPaidSubs(context.Background(), testSession(), "acct_untrusted")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	require.Contains(t, err.Error(), "billing objects are not imported")
	require.Contains(t, err.Error(), "plan billing continuity separately")
}

func TestDoNeverForwardsBearerAcrossRedirect(t *testing.T) {
	var leaked atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			leaked.Store(true)
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer source.Close()
	a := New()
	a.BaseURL = source.URL
	err := a.do(context.Background(), testSession(), http.MethodGet, "/publications", nil, &struct{}{})
	require.Error(t, err)
	require.False(t, leaked.Load())
}

func TestDoReturnsRateLimitDelayWithoutLeakingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"email":"private@example.com"}`))
	}))
	defer server.Close()
	a := New()
	a.BaseURL = server.URL
	err := a.do(context.Background(), testSession(), http.MethodGet, "/publications", nil, &struct{}{})
	var rateErr *adapter.ErrRateLimited
	require.ErrorAs(t, err, &rateErr)
	require.Equal(t, 2*time.Second, rateErr.RetryAfter)
	require.NotContains(t, err.Error(), "private@example.com")
}

func TestURLQueryRoundTripsOpaqueCursor(t *testing.T) {
	values := url.Values{"cursor": {"opaque+/=="}}
	path, err := publicationPath("pub_main", "/subscriptions", values)
	require.NoError(t, err)
	parsed, err := url.Parse(path)
	require.NoError(t, err)
	require.Equal(t, "opaque+/==", parsed.Query().Get("cursor"))
}

func authServer(t *testing.T, publications string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/workspaces/identify":
			_, _ = w.Write([]byte(`{"data":{"id":"work_main","name":"Workspace","owner_email":"owner@example.com"}}`))
		case "/publications":
			_, _ = w.Write([]byte(publications))
		default:
			http.NotFound(w, r)
		}
	}))
}

func testSession() adapter.Session {
	return adapter.Session{
		AccessToken: "secret",
		AccountID:   "pub_main",
		Source:      canonical.SourceBeehiiv,
		Extra: map[string]string{
			WorkspaceIDExtraKey:        "work_main",
			PublicationIDExtraKey:      "pub_main",
			AccountFingerprintExtraKey: accountFingerprint("work_main", "pub_main"),
		},
	}
}

func TestRetryDelaySupportsHTTPDateAndRateLimitReset(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	headers := http.Header{"Retry-After": {now.Add(3 * time.Second).Format(http.TimeFormat)}}
	require.Equal(t, 3*time.Second, retryDelay(headers, now))
	headers = http.Header{"Ratelimit-Reset": {strconv.FormatInt(now.Add(4*time.Second).Unix(), 10)}}
	require.Equal(t, 4*time.Second, retryDelay(headers, now))
}

func TestAuthenticateMissingKey(t *testing.T) {
	_, err := New().Authenticate(context.Background(), adapter.Credentials{})
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestValidateSessionRejectsPathInjection(t *testing.T) {
	session := testSession()
	session.AccountID = "pub_main/../../workspaces"
	_, _, err := New().ListSubscribers(context.Background(), session, "")
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestValidateSessionRejectsInconsistentWorkspacePublicationBinding(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*adapter.Session)
	}{
		{name: "missing workspace", mutate: func(sess *adapter.Session) { delete(sess.Extra, WorkspaceIDExtraKey) }},
		{name: "different publication metadata", mutate: func(sess *adapter.Session) { sess.Extra[PublicationIDExtraKey] = "pub_other" }},
		{name: "forged fingerprint", mutate: func(sess *adapter.Session) { sess.Extra[AccountFingerprintExtraKey] = strings.Repeat("a", 64) }},
		{name: "wrong source", mutate: func(sess *adapter.Session) { sess.Source = canonical.SourceMailchimp }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sess := testSession()
			test.mutate(&sess)
			require.ErrorIs(t, validateSession(sess), adapter.ErrAuth)
		})
	}
}
