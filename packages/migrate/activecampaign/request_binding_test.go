// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	adapter "github.com/postwave/migrate/adapter"
)

type activeCampaignRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn activeCampaignRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestActiveCampaignDoRequiresStoredAccountBindingBeforeTokenUse(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "bound.provider.example,other.provider.example")
	const base = "https://bound.provider.example/api/3"
	var requests int
	ad := New()
	ad.HTTPClient = &http.Client{Transport: activeCampaignRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		return activeCampaignTestHTTPResponse(req, `{}`), nil
	})}

	err := ad.do(context.Background(), adapter.Session{
		AccessToken: "must-not-leave-process",
		Extra:       map[string]string{"api_url": base},
	}, http.MethodGet, "/contacts", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "missing its account binding") {
		t.Fatalf("missing-binding error = %v", err)
	}
	if requests != 0 {
		t.Fatalf("transport requests = %d, token-bearing request escaped before binding", requests)
	}
}

func TestActiveCampaignDoRejectsChangedAccountURLBeforeTokenUse(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "bound.provider.example,other.provider.example")
	fingerprint, err := accountFingerprintFromAPIURL("https://bound.provider.example/api/3")
	if err != nil {
		t.Fatal(err)
	}
	var requests int
	ad := New()
	ad.HTTPClient = &http.Client{Transport: activeCampaignRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		return activeCampaignTestHTTPResponse(req, `{}`), nil
	})}

	err = ad.do(context.Background(), adapter.Session{
		AccessToken: "must-not-cross-account",
		Extra: map[string]string{
			"api_url":                  "https://other.provider.example/api/3",
			AccountFingerprintExtraKey: fingerprint,
		},
	}, http.MethodGet, "/contacts", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "different account API URL") {
		t.Fatalf("changed-account error = %v", err)
	}
	if requests != 0 {
		t.Fatalf("transport requests = %d, token-bearing request escaped to changed account", requests)
	}
}

func TestActiveCampaignDoAllowsMatchingStoredAccountBinding(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "bound.provider.example")
	const base = "https://bound.provider.example/api/3"
	fingerprint, err := accountFingerprintFromAPIURL(base)
	if err != nil {
		t.Fatal(err)
	}
	var gotToken string
	ad := New()
	ad.HTTPClient = &http.Client{Transport: activeCampaignRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotToken = req.Header.Get("Api-Token")
		return activeCampaignTestHTTPResponse(req, `{}`), nil
	})}

	err = ad.do(context.Background(), adapter.Session{
		AccessToken: "bound-token",
		Extra: map[string]string{
			"api_url":                  base,
			AccountFingerprintExtraKey: fingerprint,
		},
	}, http.MethodGet, "/contacts", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if gotToken != "bound-token" {
		t.Fatalf("Api-Token = %q", gotToken)
	}
}

func TestActiveCampaignDoRejectsLoopbackFingerprintMismatch(t *testing.T) {
	first := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer first.Close()
	var secondRequests int
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondRequests++
		writeJSON(t, w, map[string]any{})
	}))
	defer second.Close()
	fingerprint, err := accountFingerprintFromAPIURL(first.URL + "/api/3")
	if err != nil {
		t.Fatal(err)
	}

	err = New().do(context.Background(), adapter.Session{
		AccessToken: "loopback-token",
		Extra: map[string]string{
			"api_url":                  second.URL + "/api/3",
			AccountFingerprintExtraKey: fingerprint,
		},
	}, http.MethodGet, "/contacts", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "different account API URL") {
		t.Fatalf("loopback mismatch error = %v", err)
	}
	if secondRequests != 0 {
		t.Fatalf("changed loopback account received %d requests", secondRequests)
	}
}

func activeCampaignTestHTTPResponse(req *http.Request, body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}
