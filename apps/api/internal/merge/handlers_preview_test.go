// SPDX-License-Identifier: AGPL-3.0-only
package merge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreviewHTMLUsesSendTimeEscapingAndConditions(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/merge/preview", strings.NewReader(`{"template":"{% if vip %}<p>{{ name }}</p>{% endif %}","vars":{"vip":"yes","name":"<script>"},"html":true}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	(&Deps{}).Preview(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload previewResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Rendered != "<p>&lt;script&gt;</p>" || payload.Error != "" {
		t.Fatalf("unexpected HTML preview: %+v", payload)
	}
}

func TestPreviewPlainTextRetainsPlainValues(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/merge/preview", strings.NewReader(`{"template":"Hi {{ name }}","vars":{"name":"A & B"}}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	(&Deps{}).Preview(response, request)
	var payload previewResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Rendered != "Hi A & B" {
		t.Fatalf("unexpected text preview: %+v", payload)
	}
}

func TestPreviewResolvesNestedSampleFields(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/merge/preview", strings.NewReader(`{"template":"{% if subscriber.vip %}<p>{{ subscriber.first_name }}</p>{% endif %}","vars":{"subscriber":{"vip":"yes","first_name":"Ada"}},"html":true}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	(&Deps{}).Preview(response, request)
	var payload previewResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Rendered != "<p>Ada</p>" || payload.Error != "" {
		t.Fatalf("unexpected nested preview: %+v", payload)
	}
}
