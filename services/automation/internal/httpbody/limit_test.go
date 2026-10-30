package httpbody

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONTooLarge(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"`+strings.Repeat("x", 32)+`"}`))
	rec := httptest.NewRecorder()
	var dst struct {
		Value string `json:"value"`
	}

	err := DecodeJSON(rec, req, 8, &dst)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
	if got := StatusCode(err); got != http.StatusRequestEntityTooLarge {
		t.Fatalf("StatusCode() = %d, want %d", got, http.StatusRequestEntityTooLarge)
	}
	if got := ErrorCode(err); got != "payload_too_large" {
		t.Fatalf("ErrorCode() = %q", got)
	}
}

func TestDecodeJSONRejectsTrailingValues(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"ok"} {"value":"extra"}`))
	rec := httptest.NewRecorder()
	var dst struct {
		Value string `json:"value"`
	}

	err := DecodeJSON(rec, req, 1024, &dst)
	if !errors.Is(err, ErrMultipleJSONValues) {
		t.Fatalf("expected ErrMultipleJSONValues, got %v", err)
	}
	if got := StatusCode(err); got != http.StatusBadRequest {
		t.Fatalf("StatusCode() = %d, want %d", got, http.StatusBadRequest)
	}
}
