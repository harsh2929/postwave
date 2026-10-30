package httperror_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

func TestWrite_EmitsStableEnvelopeAndContentType(t *testing.T) {
	rr := httptest.NewRecorder()
	httperror.Write(rr, http.StatusNotFound, "not_found", "subscriber not found")

	if got, want := rr.Code, http.StatusNotFound; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if got, want := rr.Header().Get("Content-Type"), httperror.ContentTypeJSON; got != want {
		t.Fatalf("Content-Type = %q, want %q", got, want)
	}

	var body struct {
		Err struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Err.Code != "not_found" {
		t.Errorf("code = %q, want not_found", body.Err.Code)
	}
	if body.Err.Message != "subscriber not found" {
		t.Errorf("message = %q, want %q", body.Err.Message, "subscriber not found")
	}
}

func TestWrite_RedactsEveryServerErrorRegardlessOfCaller(t *testing.T) {
	const secret = "SECRET_CANARY_provider-token_pgsql-offset"
	for _, status := range []int{
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			rr := httptest.NewRecorder()
			httperror.Write(rr, status, secret, secret)
			if rr.Code != status {
				t.Fatalf("status = %d, want %d", rr.Code, status)
			}
			if strings.Contains(rr.Body.String(), secret) {
				t.Fatalf("server response leaked caller input: %s", rr.Body.String())
			}
			var body struct {
				Err struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body.Err.Code != httperror.CodeInternal || body.Err.Message != httperror.MessageInternal {
				t.Fatalf("server body = %+v", body.Err)
			}
		})
	}
}

func TestMessageForStatus_IsFixedAndNeverEchoesCallerData(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 409, 413, 422, 429, 500, 502} {
		message := httperror.MessageForStatus(status)
		if strings.TrimSpace(message) == "" {
			t.Fatalf("status %d has no public message", status)
		}
	}
}

func TestWriteInternal_DoesNotEchoErrText_AndLogsServerSide(t *testing.T) {
	sensitive := "pgx: invalid input syntax for type uuid \"abc\" at /opt/repo/sql.go:42"
	err := errors.New(sensitive)

	buf := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	rr := httptest.NewRecorder()
	ctx := context.WithValue(context.Background(), chimiddleware.RequestIDKey, "req-abc-123")
	ctx = httperror.WithTenantIDLog(ctx, "tenant-xyz")

	httperror.WriteInternal(rr, logger, err, ctx)

	if got, want := rr.Code, http.StatusInternalServerError; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}

	// Response MUST NOT contain the raw error text.
	if strings.Contains(rr.Body.String(), "pgx") || strings.Contains(rr.Body.String(), "sql.go") {
		t.Fatalf("response leaked err text: %s", rr.Body.String())
	}

	var body struct {
		Err struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Err.Code != httperror.CodeInternal {
		t.Errorf("code = %q, want %q", body.Err.Code, httperror.CodeInternal)
	}
	if body.Err.Message != httperror.MessageInternal {
		t.Errorf("message = %q, want %q", body.Err.Message, httperror.MessageInternal)
	}
	if body.Err.RequestID != "req-abc-123" {
		t.Errorf("request_id = %q, want req-abc-123", body.Err.RequestID)
	}

	// Server-side log MUST contain err text + request_id + tenant_id.
	logged := buf.String()
	for _, needle := range []string{"pgx", "req-abc-123", "tenant-xyz", "http.internal_error"} {
		if !strings.Contains(logged, needle) {
			t.Errorf("expected log to contain %q, got: %s", needle, logged)
		}
	}
}

func TestWriteInternal_NilLogger_StillWritesResponse(t *testing.T) {
	rr := httptest.NewRecorder()
	httperror.WriteInternal(rr, nil, errors.New("boom"), context.Background())

	if got, want := rr.Code, http.StatusInternalServerError; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if !strings.Contains(rr.Body.String(), httperror.CodeInternal) {
		t.Fatalf("body missing code: %s", rr.Body.String())
	}
}

func TestWriteInternal_NilErr_DoesNotPanic(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := slog.New(slog.NewTextHandler(buf, nil))
	rr := httptest.NewRecorder()
	httperror.WriteInternal(rr, logger, nil, context.Background())

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rr.Code)
	}
}

func TestWriteValidation_400WithGivenCodeAndMessage(t *testing.T) {
	rr := httptest.NewRecorder()
	httperror.WriteValidation(rr, "validation_failed", "email is required")

	if got, want := rr.Code, http.StatusBadRequest; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if !strings.Contains(rr.Body.String(), "validation_failed") {
		t.Errorf("missing code: %s", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "email is required") {
		t.Errorf("missing message: %s", rr.Body.String())
	}
}

func TestWriteProblemJSON_EmitsRFC7807Shape(t *testing.T) {
	rr := httptest.NewRecorder()
	httperror.WriteProblemJSON(rr, httperror.Problem{
		Type:     "https://api.postwave.example/problems/validation",
		Title:    "Validation failed",
		Status:   http.StatusUnprocessableEntity,
		Detail:   "email is malformed",
		Instance: "/api/v1/subscribers",
		Code:     "validation_failed",
		Extras: map[string]any{
			"fields": []string{"email"},
		},
	})

	if got, want := rr.Code, http.StatusUnprocessableEntity; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if got, want := rr.Header().Get("Content-Type"), httperror.ContentTypeProblemJSON; got != want {
		t.Fatalf("Content-Type = %q, want %q", got, want)
	}

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for k, want := range map[string]any{
		"type":   "https://api.postwave.example/problems/validation",
		"title":  "Validation failed",
		"status": float64(http.StatusUnprocessableEntity),
		"detail": "email is malformed",
		"code":   "validation_failed",
	} {
		if got := body[k]; got != want {
			t.Errorf("body[%q] = %v, want %v", k, got, want)
		}
	}
	fields, ok := body["fields"].([]any)
	if !ok || len(fields) != 1 || fields[0] != "email" {
		t.Errorf("extras not flattened correctly: %v", body["fields"])
	}
}

func TestWriteProblemJSON_RedactsEveryServerErrorField(t *testing.T) {
	const secret = "SECRET_CANARY_oauth-client-secret_signature"
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable} {
		rr := httptest.NewRecorder()
		httperror.WriteProblemJSON(rr, httperror.Problem{
			Type:     secret,
			Title:    secret,
			Status:   status,
			Detail:   secret,
			Instance: secret,
			Code:     secret,
			Extras:   map[string]any{"secret": secret},
		})
		if strings.Contains(rr.Body.String(), secret) {
			t.Fatalf("status %d problem body leaked caller input: %s", status, rr.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode status %d body: %v", status, err)
		}
		if body["code"] != httperror.CodeInternal || body["detail"] != httperror.MessageInternal {
			t.Fatalf("status %d problem body = %v", status, body)
		}
		if _, exists := body["secret"]; exists {
			t.Fatalf("status %d retained extras: %v", status, body)
		}
	}
}

func TestWriteProblemJSON_DefaultsStatusTo400(t *testing.T) {
	rr := httptest.NewRecorder()
	httperror.WriteProblemJSON(rr, httperror.Problem{Title: "x"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestWriteProblemJSON_ExtrasCannotClobberCanonical(t *testing.T) {
	rr := httptest.NewRecorder()
	httperror.WriteProblemJSON(rr, httperror.Problem{
		Title:  "real",
		Status: http.StatusConflict,
		Extras: map[string]any{
			"title":  "hijacked",
			"status": 200,
		},
	})
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["title"] != "real" {
		t.Errorf("title clobbered: %v", body["title"])
	}
	if body["status"].(float64) != float64(http.StatusConflict) {
		t.Errorf("status clobbered: %v", body["status"])
	}
}

func TestIsValidationCode_AllowsKnownSet(t *testing.T) {
	allow := []string{
		"validation_failed",
		"erasure_blocked",
		"invalid_input",
		"invalid_request",
		"missing_field",
		"bad_json",
		"payload_too_large",
		"rate_limited",
	}
	for _, c := range allow {
		if !httperror.IsValidationCode(c) {
			t.Errorf("%q should be a validation code", c)
		}
	}
}

func TestIsValidationCode_RejectsUnknown(t *testing.T) {
	deny := []string{
		"",
		"internal_error",
		"db_error",
		"unexpected",
		"list_failed",
		"search_failed",
	}
	for _, c := range deny {
		if httperror.IsValidationCode(c) {
			t.Errorf("%q should NOT be a validation code", c)
		}
	}
}

func TestWithTenantIDLog_EmptyIsNoop(t *testing.T) {
	ctx := context.Background()
	got := httperror.WithTenantIDLog(ctx, "")
	if got != ctx {
		t.Errorf("WithTenantIDLog(ctx, \"\") should be a no-op")
	}
}
