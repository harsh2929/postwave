package handlers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeRequestJSONRejectsOversizedBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"`+strings.Repeat("x", int(migrationRequestJSONMaxBodyBytes))+`"}`))
	rec := httptest.NewRecorder()
	var dst struct {
		Value string `json:"value"`
	}

	err := decodeRequestJSON(rec, req, &dst)
	if !errors.Is(err, errRequestJSONTooLarge) {
		t.Fatalf("expected errRequestJSONTooLarge, got %v", err)
	}
	if got := requestJSONStatusCode(err); got != http.StatusRequestEntityTooLarge {
		t.Fatalf("requestJSONStatusCode() = %d, want %d", got, http.StatusRequestEntityTooLarge)
	}
}

func TestDecodeRequestJSONRejectsTrailingValues(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"ok"} {"value":"extra"}`))
	rec := httptest.NewRecorder()
	var dst struct {
		Value string `json:"value"`
	}

	err := decodeRequestJSON(rec, req, &dst)
	if !errors.Is(err, errRequestJSONMultipleValues) {
		t.Fatalf("expected errRequestJSONMultipleValues, got %v", err)
	}
	if got := requestJSONStatusCode(err); got != http.StatusBadRequest {
		t.Fatalf("requestJSONStatusCode() = %d, want %d", got, http.StatusBadRequest)
	}
}
