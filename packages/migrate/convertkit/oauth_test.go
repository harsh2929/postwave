package convertkit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestV4OAuthURLsAndRotatingRefresh(t *testing.T) {
	t.Setenv("CONVERTKIT_CLIENT_ID", "test-client")
	t.Setenv("CONVERTKIT_CLIENT_SECRET", "test-secret")
	authorize, err := url.Parse(BuildAuthorizeURL("state", "https://app.example.test/callback"))
	require.NoError(t, err)
	require.Equal(t, "api.kit.com", authorize.Host)
	require.Equal(t, "/v4/oauth/authorize", authorize.Path)
	require.Equal(t, "state", authorize.Query().Get("state"))
	require.Empty(t, authorize.Query().Get("client_secret"))
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/oauth/token" {
			require.Equal(t, "Bearer new-access", r.Header.Get("Authorization"))
			return false
		}
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		var body map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "old-refresh", body["refresh_token"])
		require.Equal(t, "refresh_token", body["grant_type"])
		_, _ = w.Write([]byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":172800,"token_type":"bearer"}`))
		return true
	})
	sess := kitSession()
	sess.RefreshToken = "old-refresh"
	updated, err := a.RefreshSession(context.Background(), sess)
	require.NoError(t, err)
	require.Equal(t, "new-refresh", updated.RefreshToken)
	require.Equal(t, "42", updated.AccountID)
	require.True(t, updated.ExpiresAt.After(time.Now()))
}

func TestTokenExchangeDoesNotReplaySecretsOnRedirect(t *testing.T) {
	for _, code := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			requests := 0
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				_, _ = w.Write([]byte(`{"access_token":"leaked","refresh_token":"leaked","expires_in":172800,"token_type":"bearer"}`))
			}))
			defer destination.Close()
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, destination.URL, code)
			}))
			defer origin.Close()
			_, err := exchangeToken(context.Background(), origin.Client(), origin.URL, map[string]string{"client_id": "client", "client_secret": "secret", "code": "single-use"})
			require.Error(t, err)
			require.Zero(t, requests)
		})
	}
}

func TestBroadcastArchiveRejectsMissingContentOrStatistics(t *testing.T) {
	for _, body := range []string{
		`{"broadcast":{"id":700}}`,
		`{"broadcast":{"id":700,"stats":{"recipients":20,"emails_opened":null,"total_clicks":0}}}`,
		`{"broadcast":{"id":700,"stats":{"recipients":20,"emails_opened":0,"total_clicks":-1}}}`,
	} {
		a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path != "/broadcasts/700/stats" {
				return false
			}
			_, _ = w.Write([]byte(body))
			return true
		})
		_, _, err := a.ListCampaignArchive(context.Background(), kitSession(), "")
		require.Error(t, err)
	}
	a := kitFixture(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/broadcasts" {
			return false
		}
		_ = json.NewEncoder(w).Encode(v4Page("broadcasts", []any{map[string]any{"id": 700, "status": "completed", "send_at": "2024-05-01T10:00:00Z"}}, ""))
		return true
	})
	_, _, err := a.ListCampaignArchive(context.Background(), kitSession(), "")
	require.ErrorContains(t, err, "missing content")
}
