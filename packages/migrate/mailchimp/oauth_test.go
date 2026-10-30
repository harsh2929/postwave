// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
)

func TestBuildAuthorizeURLUsesDocumentedMailchimpParameters(t *testing.T) {
	t.Setenv("MAILCHIMP_CLIENT_ID", "client_123")
	t.Setenv("MAILCHIMP_CLIENT_SECRET", "secret_123")

	raw := BuildAuthorizeURL("state_123", "https://postwave.example/oauth/callback")
	parsed, err := url.Parse(raw)
	require.NoError(t, err)
	require.Equal(t, "https", parsed.Scheme)
	require.Equal(t, "login.mailchimp.com", parsed.Host)
	require.Equal(t, "/oauth2/authorize", parsed.Path)
	require.Equal(t, "code", parsed.Query().Get("response_type"))
	require.Equal(t, "client_123", parsed.Query().Get("client_id"))
	require.Equal(t, "state_123", parsed.Query().Get("state"))
	require.Equal(t, "https://postwave.example/oauth/callback", parsed.Query().Get("redirect_uri"))
	require.Empty(t, parsed.Query().Get("access_type"), "Mailchimp has long-lived access tokens and no offline/refresh-token OAuth mode")
}

func TestOAuthDoesNotReplaySecretsOnRedirect(t *testing.T) {
	for _, redirectPath := range []string{"/token", "/metadata", "/root"} {
		t.Run(redirectPath, func(t *testing.T) {
			requests := 0
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++ }))
			defer destination.Close()
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == redirectPath {
					http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
					return
				}
				if r.URL.Path == "/token" {
					_, _ = w.Write([]byte(`{"access_token":"token"}`))
					return
				}
				_, _ = w.Write([]byte(`{"dc":"us1"}`))
			}))
			defer origin.Close()
			setMailchimpOAuthEndpoints(t, origin.URL+"/token", origin.URL+"/metadata")
			exchangeRootURL = origin.URL + "/root"
			t.Setenv("MAILCHIMP_CLIENT_ID", "client")
			t.Setenv("MAILCHIMP_CLIENT_SECRET", "secret")
			_, err := ExchangeCode(context.Background(), "code", "https://app.example.test/callback")
			require.Error(t, err)
			require.Zero(t, requests)
		})
	}
}

func TestExchangeCodeDerivesDataCenterFromValidatedAPIEndpoint(t *testing.T) {
	server := mailchimpOAuthServer(t, `{"api_endpoint":"https://us42.api.mailchimp.com/3.0"}`)
	defer server.Close()
	setMailchimpOAuthEndpoints(t, server.URL+"/token", server.URL+"/metadata")
	t.Setenv("MAILCHIMP_CLIENT_ID", "client")
	t.Setenv("MAILCHIMP_CLIENT_SECRET", "secret")

	sess, err := ExchangeCode(context.Background(), "code", "https://postwave.example/callback")
	require.NoError(t, err)
	require.Equal(t, "us42", sess.AccountID)
	require.Equal(t, "access-token", sess.AccessToken)
	require.NotEmpty(t, sess.Extra[AccountFingerprintExtraKey])
}

func TestExchangeCodeRejectsMetadataWithoutUsableDataCenter(t *testing.T) {
	for _, metadata := range []string{
		`{}`,
		`{"dc":"evil.example.com"}`,
		`{"api_endpoint":"https://attacker.example/api"}`,
		`{"api_endpoint":"http://us42.api.mailchimp.com/3.0"}`,
	} {
		t.Run(metadata, func(t *testing.T) {
			server := mailchimpOAuthServer(t, metadata)
			defer server.Close()
			setMailchimpOAuthEndpoints(t, server.URL+"/token", server.URL+"/metadata")
			t.Setenv("MAILCHIMP_CLIENT_ID", "client")
			t.Setenv("MAILCHIMP_CLIENT_SECRET", "secret")

			sess, err := ExchangeCode(context.Background(), "code", "https://postwave.example/callback")
			require.Error(t, err)
			require.True(t, errors.Is(err, adapter.ErrAuth))
			require.Empty(t, sess.AccountID)
		})
	}
}

func TestAuthenticateRejectsInvalidPersistedDataCenter(t *testing.T) {
	_, err := New().Authenticate(context.Background(), adapter.Credentials{
		AccessToken: "token",
		AccountID:   "us1.attacker.example",
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestAuthenticateDoesNotLetCallerOverrideAccountFingerprint(t *testing.T) {
	server := mailchimpOAuthServer(t, `{"api_endpoint":"https://us42.api.mailchimp.com/3.0"}`)
	defer server.Close()
	setMailchimpOAuthEndpoints(t, server.URL+"/token", server.URL+"/metadata")
	t.Setenv("MAILCHIMP_CLIENT_ID", "client")
	t.Setenv("MAILCHIMP_CLIENT_SECRET", "secret")

	sess, err := New().Authenticate(context.Background(), adapter.Credentials{
		OAuthCode: "code",
		Extra: map[string]string{
			"redirect_uri":             "https://postwave.example/callback",
			"caller_metadata":          "retained",
			AccountFingerprintExtraKey: "forged-account-fingerprint",
		},
	})
	require.NoError(t, err)
	require.Equal(t, "retained", sess.Extra["caller_metadata"])
	require.NotEmpty(t, sess.Extra[AccountFingerprintExtraKey])
	require.NotEqual(t, "forged-account-fingerprint", sess.Extra[AccountFingerprintExtraKey])
}

func mailchimpOAuthServer(t *testing.T, metadata string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			require.NoError(t, r.ParseForm())
			require.Equal(t, "authorization_code", r.Form.Get("grant_type"))
			require.Equal(t, "code", r.Form.Get("code"))
			_, _ = w.Write([]byte(`{"access_token":"access-token"}`))
		case "/metadata":
			require.Equal(t, "OAuth access-token", r.Header.Get("Authorization"))
			_, _ = w.Write([]byte(metadata))
		case "/root":
			require.Equal(t, "Bearer access-token", r.Header.Get("Authorization"))
			_, _ = w.Write([]byte(`{"account_id":"account-42"}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func setMailchimpOAuthEndpoints(t *testing.T, token, metadata string) {
	t.Helper()
	previousToken := exchangeTokenURL
	previousMetadata := exchangeMetadataURL
	previousRoot := exchangeRootURL
	exchangeTokenURL = token
	exchangeMetadataURL = metadata
	exchangeRootURL = strings.TrimSuffix(token, "/token") + "/root"
	t.Cleanup(func() {
		exchangeTokenURL = previousToken
		exchangeMetadataURL = previousMetadata
		exchangeRootURL = previousRoot
	})
}
