// SPDX-License-Identifier: AGPL-3.0-only
package compat

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestDecodeRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"category":"Interest","name":"` + strings.Repeat("x", int(compatJSONMaxBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mailchimp-compat/groups", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.CreateGroup(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestExchangeShopifyTokenCapsSuccessResponseBody(t *testing.T) {
	oldClient := shopifyTokenHTTPClient
	defer func() { shopifyTokenHTTPClient = oldClient }()
	shopifyTokenHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(strings.Repeat("{", (64<<10)+1))),
			Request:    req,
		}, nil
	})}

	_, _, err := exchangeShopifyToken(context.Background(), "example.myshopify.com", "code_1")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("exchangeShopifyToken err = %v, want response body too large", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}
