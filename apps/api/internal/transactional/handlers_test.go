// SPDX-License-Identifier: AGPL-3.0-only

package transactional

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func invokeInvalidBatch(t *testing.T, body, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/emails/batch", strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	(&Deps{}).handleBatch(rec, req)
	return rec
}

func TestHandleBatchRequiresJSONContentType(t *testing.T) {
	rec := invokeInvalidBatch(t, `[{}]`, "")
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status=%d body=%s, want 415", rec.Code, rec.Body.String())
	}
}

func TestHandleBatchRejectsUnknownFields(t *testing.T) {
	rec := invokeInvalidBatch(t, `[{"unexpected":true}]`, "application/json")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"unknown_field"`) {
		t.Fatalf("status=%d body=%s, want unknown_field", rec.Code, rec.Body.String())
	}
}

func TestHandleBatchRejectsTrailingJSONValue(t *testing.T) {
	rec := invokeInvalidBatch(t, `[{}] {}`, "application/json")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"multiple_json_values"`) {
		t.Fatalf("status=%d body=%s, want multiple_json_values", rec.Code, rec.Body.String())
	}
}
