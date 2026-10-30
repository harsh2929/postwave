// SPDX-License-Identifier: MIT
package convertkit

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func v4Page(key string, rows any, next string) map[string]any {
	return map[string]any{key: rows, "pagination": map[string]any{"has_next_page": next != "", "end_cursor": next}}
}

func kitFixture(t *testing.T, intercept func(http.ResponseWriter, *http.Request) bool) *Adapter {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.URL.Query().Get("api_secret"))
		require.Empty(t, r.URL.Query().Get("api_key"))
		if intercept != nil && intercept(w, r) {
			return
		}
		var body any
		switch r.URL.Path {
		case "/account":
			body = map[string]any{"account": map[string]any{"id": 42}}
		case "/subscribers":
			require.Equal(t, "all", r.URL.Query().Get("status"))
			rows := []map[string]any{{"id": 1, "email_address": "a@example.com", "state": "active", "created_at": "2024-01-01T00:00:00Z", "tags": []any{map[string]any{"id": 11, "name": "VIP"}}}, {"id": 2, "email_address": "b@example.com", "state": "cancelled", "tags": []any{}}}
			next := "cursor+/="
			if r.URL.Query().Get("after") != "" {
				require.Equal(t, next, r.URL.Query().Get("after"))
				rows = []map[string]any{{"id": 3, "email_address": "c@example.com", "state": "complained", "tags": []any{}}}
				next = ""
			}
			body = v4Page("subscribers", rows, next)
		case "/tags", "/subscribers/1/tags":
			body = v4Page("tags", []any{map[string]any{"id": 11, "name": "VIP"}}, "")
		case "/segments":
			body = v4Page("segments", []any{map[string]any{"id": 12, "name": "Engaged"}}, "")
		case "/sequences":
			body = v4Page("sequences", []any{map[string]any{"id": 100, "name": "Welcome", "email_count": 2, "send_days": []string{"monday"}, "send_hour": 9, "time_zone": "Asia/Kolkata"}}, "")
		case "/sequences/100/emails":
			require.Equal(t, "true", r.URL.Query().Get("include_content"))
			next := "email-next"
			id := 101
			if r.URL.Query().Get("after") != "" {
				id = 102
				next = ""
			}
			body = v4Page("emails", []any{map[string]any{"id": id, "sequence_id": 100, "content": "<p>Exact source HTML</p>", "delay_value": 2, "delay_unit": "days", "published": true}}, next)
		case "/broadcasts":
			require.Equal(t, "completed", r.URL.Query().Get("status"))
			body = v4Page("broadcasts", []any{map[string]any{"id": 700, "status": "completed", "subject": "News", "content": "<p>News</p>", "send_at": "2024-05-01T10:00:00Z", "published_at": "2024-05-02T10:00:00Z"}}, "")
		case "/broadcasts/700/stats":
			body = map[string]any{"broadcast": map[string]any{"id": 700, "stats": map[string]any{"recipients": 200, "emails_opened": 90, "total_clicks": 15}}}
		case "/forms":
			require.Equal(t, "all", r.URL.Query().Get("status"))
			body = v4Page("forms", []any{map[string]any{"id": 20, "type": r.URL.Query().Get("type")}}, "")
		default:
			t.Errorf("unexpected Kit API path: %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		require.NoError(t, json.NewEncoder(w).Encode(body))
	}))
	t.Cleanup(server.Close)
	a := New()
	a.BaseURL = server.URL
	a.limiter = adapter.NewTokenBucket(10000, time.Second, 10000)
	return a
}

func kitSession() adapter.Session {
	return adapter.Session{AccessToken: "test-token", AccountID: "42", Source: canonical.SourceConvertKit, Extra: map[string]string{"api_version": "4"}}
}

func TestKitV4JourneyPreservesStatusesMembershipAndRebuildEvidence(t *testing.T) {
	ctx := context.Background()
	a := kitFixture(t, nil)
	sess, err := a.Authenticate(ctx, adapter.Credentials{AccessToken: "test-token"})
	require.NoError(t, err)
	require.Equal(t, "42", sess.AccountID)
	disc, err := a.Discover(ctx, sess)
	require.NoError(t, err)
	require.Equal(t, 3, disc.SubscribersTotal)
	require.Equal(t, 2, disc.SegmentsTotal)
	require.Equal(t, 1, disc.AutomationsTotal)
	require.Equal(t, 1, disc.ArchiveTotal)
	require.Equal(t, 5, disc.SourceArchiveTotal)
	subs, next, err := a.ListSubscribers(ctx, sess, "")
	require.NoError(t, err)
	require.Len(t, subs, 2)
	require.NotEmpty(t, next)
	require.Equal(t, canonical.StatusEnabled, subs[0].Status)
	require.Equal(t, []string{"VIP"}, subs[0].Tags)
	require.Nil(t, subs[0].ConsentTimestamp)
	require.Equal(t, canonical.ConsentUnknown, subs[0].ConsentSource)
	require.Equal(t, canonical.StatusDisabled, subs[1].Status)
	rest, done, err := a.ListSubscribers(ctx, sess, next)
	require.NoError(t, err)
	require.Empty(t, done)
	require.Equal(t, canonical.StatusBlocklisted, rest[0].Status)
	replay, again, err := a.ListSubscribers(ctx, sess, next)
	require.NoError(t, err)
	require.Equal(t, rest, replay)
	require.Equal(t, done, again)
	segments, err := a.ListSegments(ctx, sess)
	require.NoError(t, err)
	require.Len(t, segments, 2)
	autos, err := a.ListAutomations(ctx, sess)
	require.NoError(t, err)
	require.Len(t, autos, 1)
	require.Equal(t, "draft", autos[0].Status)
	require.Equal(t, "kit_sequence_rebuild", autos[0].Nodes[0].Type)
	archive, _, err := a.ListSourceArchive(ctx, sess, "")
	require.NoError(t, err)
	require.Len(t, archive, 5)
	require.Equal(t, "Asia/Kolkata", archive[0].Payload["time_zone"])
	emails := archive[0].Payload["emails"].([]map[string]interface{})
	require.Len(t, emails, 2)
	require.Equal(t, "<p>Exact source HTML</p>", emails[1]["content"])
	broadcasts, _, err := a.ListCampaignArchive(ctx, sess, "")
	require.NoError(t, err)
	require.Len(t, broadcasts, 1)
	require.Equal(t, 90, broadcasts[0].Opens)
	require.Equal(t, 15, broadcasts[0].Clicks)
	require.Equal(t, 1, broadcasts[0].SentAt.Day())
}

func TestKitV4AuthenticationHeadersAndIdentity(t *testing.T) {
	ctx := context.Background()
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		require.Equal(t, "v4-key", r.Header.Get("X-Kit-Api-Key"))
		require.Empty(t, r.Header.Get("Authorization"))
		return false
	})
	sess, err := a.Authenticate(ctx, adapter.Credentials{APIKey: "v4-key"})
	require.NoError(t, err)
	require.Equal(t, "42", sess.AccountID)
	_, err = a.Authenticate(ctx, adapter.Credentials{APIKey: "v4-key", AccountID: "43"})
	require.ErrorIs(t, err, adapter.ErrAuth)
	_, err = a.Authenticate(ctx, adapter.Credentials{Extra: map[string]string{"api_secret": "old-secret"}})
	require.ErrorContains(t, err, "v3 API secrets")
	sess.AccountID = "43"
	_, err = a.Discover(ctx, sess)
	require.ErrorIs(t, err, adapter.ErrAuth)
	_, _, err = a.ListSubscribers(ctx, adapter.Session{AccessToken: "legacy"}, "")
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestKitV4EveryAdvertisedReadFailsClosed(t *testing.T) {
	for _, path := range []string{"/account", "/subscribers", "/tags", "/segments", "/sequences", "/broadcasts", "/forms"} {
		t.Run(path, func(t *testing.T) {
			a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
				if r.URL.Path == path {
					w.WriteHeader(403)
					return true
				}
				return false
			})
			_, err := a.Discover(context.Background(), kitSession())
			require.ErrorIs(t, err, adapter.ErrAuth)
		})
	}
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasSuffix(r.URL.Path, "/stats") {
			w.WriteHeader(403)
			return true
		}
		return false
	})
	_, _, err := a.ListCampaignArchive(context.Background(), kitSession(), "")
	require.ErrorContains(t, err, "report incomplete")
}

func TestKitV4MissingTagExpansionIsHydrated(t *testing.T) {
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/subscribers" {
			return false
		}
		require.NoError(t, json.NewEncoder(w).Encode(v4Page("subscribers", []any{map[string]any{"id": 1, "email_address": "a@example.com", "state": "active"}}, "")))
		return true
	})
	subs, _, err := a.ListSubscribers(context.Background(), kitSession(), "")
	require.NoError(t, err)
	require.Equal(t, []string{"VIP"}, subs[0].Tags)
}

func TestKitV4PaginationCannotSilentlyTruncateOrLoop(t *testing.T) {
	for _, body := range []string{`{"subscribers":[]}`, `{"pagination":{"has_next_page":false}}`, `{"subscribers":[],"pagination":{"has_next_page":true,"end_cursor":"next"}}`, `{"subscribers":[{}],"pagination":{"has_next_page":true,"end_cursor":"same"}}`} {
		t.Run(body, func(t *testing.T) {
			a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool { _, _ = w.Write([]byte(body)); return true })
			_, _, err := a.page(context.Background(), kitSession(), "/subscribers", "subscribers", "same")
			require.Error(t, err)
		})
	}
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		next := "a"
		if r.URL.Query().Get("after") == "a" {
			next = "b"
		}
		require.NoError(t, json.NewEncoder(w).Encode(v4Page("tags", []any{map[string]any{"id": 1}}, next)))
		return true
	})
	err := a.walk(context.Background(), kitSession(), "/tags", "tags", func([]json.RawMessage) error { return nil })
	require.ErrorContains(t, err, "repeated pagination")
}

func TestKitV4RateLimitedThenRecover(t *testing.T) {
	var first atomic.Bool
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		if !first.Swap(true) {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(429)
			return true
		}
		return false
	})
	_, _, err := a.ListSubscribers(context.Background(), kitSession(), "")
	var rate *adapter.ErrRateLimited
	require.True(t, errors.As(err, &rate))
	require.Equal(t, 2*time.Second, rate.RetryAfter)
	subs, _, err := a.ListSubscribers(context.Background(), kitSession(), "")
	require.NoError(t, err)
	require.Len(t, subs, 2)
}
