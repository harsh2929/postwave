// SPDX-License-Identifier: AGPL-3.0-only
package dmarc

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSuggestionAcknowledgementMutationsAreDefaultOffBeforeDatabaseAccess(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		call   func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{
			name: "ack", method: http.MethodPost,
			path: "/api/v1/deliverability/dmarc-suggestions/ack",
			call: (*Deps).AckSuggestion,
		},
		{
			name: "unack", method: http.MethodDelete,
			path: "/api/v1/deliverability/dmarc-suggestions/ack/alignment_low",
			call: (*Deps).UnackSuggestion,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// A nil pool proves the default-off gate runs before db.WithTenant.
			d := &Deps{Pool: nil}
			request := withTestTenant(httptest.NewRequest(test.method, test.path, nil))
			response := httptest.NewRecorder()

			test.call(d, response, request)

			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
			}
			if got := responseErrorCode(t, response); got != suggestionAckDisabledCode {
				t.Errorf("error code = %q, want %q", got, suggestionAckDisabledCode)
			}
			if !strings.Contains(response.Body.String(), "DMARC suggestion acknowledgements are not available") {
				t.Errorf("unexpected stable message: %s", response.Body.String())
			}
			assertSensitiveResponseHeaders(t, response)
		})
	}
}

func TestSuggestionAcknowledgementMutationsStillRequireTenant(t *testing.T) {
	d := &Deps{}
	for _, test := range []struct {
		method string
		call   func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{method: http.MethodPost, call: (*Deps).AckSuggestion},
		{method: http.MethodDelete, call: (*Deps).UnackSuggestion},
	} {
		request := httptest.NewRequest(test.method, "/", nil)
		response := httptest.NewRecorder()
		test.call(d, response, request)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("%s status = %d, want 401", test.method, response.Code)
		}
		assertSensitiveResponseHeaders(t, response)
	}
}

func TestEnabledAcknowledgementValidatesStrictBodyBeforeDatabaseAccess(t *testing.T) {
	tests := []struct {
		name string
		body string
		code string
	}{
		{name: "empty body", body: "", code: "bad_json"},
		{name: "unknown field", body: `{"code":"alignment_low","extra":true}`, code: "unknown_field"},
		{name: "unknown code", body: `{"code":"anything"}`, code: "invalid_code"},
		{name: "whitespace padded code", body: `{"code":" alignment_low "}`, code: "invalid_code"},
		{name: "control in note", body: `{"code":"alignment_low","note":"line1\nline2"}`, code: "invalid_note"},
		{name: "note too large", body: `{"code":"alignment_low","note":"` + strings.Repeat("a", 1001) + `"}`, code: "invalid_note"},
		{name: "whitespace note too large", body: `{"code":"alignment_low","note":"` + strings.Repeat(" ", 1001) + `"}`, code: "invalid_note"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			d := &Deps{Pool: nil, EnableSuggestionAcknowledgements: true}
			request := withTestTenant(httptest.NewRequest(
				http.MethodPost,
				"/api/v1/deliverability/dmarc-suggestions/ack",
				strings.NewReader(test.body),
			))
			if test.body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()

			d.AckSuggestion(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
			}
			if got := responseErrorCode(t, response); got != test.code {
				t.Errorf("error code = %q, want %q; body=%s", got, test.code, response.Body.String())
			}
			assertSensitiveResponseHeaders(t, response)
		})
	}
}

func TestAcknowledgeableSuggestionCodeAllowlist(t *testing.T) {
	for _, code := range []string{
		"alignment_low",
		"no_observed_messages",
		"no_reports",
		"policy_action_volume_high",
		"policy_action_volume_low",
		"spf_only_alignment",
	} {
		if !isAcknowledgeableSuggestionCode(code) {
			t.Errorf("allowlisted code %q was rejected", code)
		}
	}
	for _, code := range []string{"", "policy_quarantine_ready", "alignment-low", strings.Repeat("a", 65)} {
		if isAcknowledgeableSuggestionCode(code) {
			t.Errorf("unsafe/obsolete code %q was accepted", code)
		}
	}
}
