// SPDX-License-Identifier: AGPL-3.0-only
package nbp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	testTenantID     = "11111111-1111-1111-1111-111111111111"
	testSubscriberID = "22222222-2222-2222-2222-222222222222"
	testCampaignID   = "33333333-3333-3333-3333-333333333333"
)

func TestRecommendHandlerRejectsInvalidBoundedInputs(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		url  string
		code string
	}{
		{name: "missing subscriber", url: "/api/v1/nbp/recommend", code: "missing_subscriber_id"},
		{name: "malformed subscriber UUID", url: "/api/v1/nbp/recommend?subscriber_id=not-a-uuid", code: "invalid_subscriber_id"},
		{name: "noninteger limit", url: "/api/v1/nbp/recommend?subscriber_id=" + testSubscriberID + "&limit=abc", code: "invalid_limit"},
		{name: "negative limit", url: "/api/v1/nbp/recommend?subscriber_id=" + testSubscriberID + "&limit=-1", code: "invalid_limit"},
		{name: "zero limit", url: "/api/v1/nbp/recommend?subscriber_id=" + testSubscriberID + "&limit=0", code: "invalid_limit"},
		{name: "over maximum limit", url: "/api/v1/nbp/recommend?subscriber_id=" + testSubscriberID + "&limit=25", code: "invalid_limit"},
		{name: "integer overflow", url: "/api/v1/nbp/recommend?subscriber_id=" + testSubscriberID + "&limit=999999999999999999999999999999", code: "invalid_limit"},
		{name: "malformed campaign UUID", url: "/api/v1/nbp/recommend?subscriber_id=" + testSubscriberID + "&campaign_id=not-a-uuid", code: "invalid_campaign_id"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, test.url, nil)
			request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: testTenantID}))
			response := httptest.NewRecorder()

			recommendHandler(nil, nil).ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
			}
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode error response: %v", err)
			}
			if body.Error.Code != test.code {
				t.Fatalf("error code = %q, want %q", body.Error.Code, test.code)
			}
		})
	}
}

func TestRecommendHandlerAcceptsMaximumLimitAndUUIDs(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/nbp/recommend?subscriber_id="+testSubscriberID+"&campaign_id="+testCampaignID+"&limit=24", nil)
	request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: testTenantID}))
	response := httptest.NewRecorder()

	recommendHandler(nil, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
}
