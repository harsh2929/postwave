// SPDX-License-Identifier: AGPL-3.0-only
package httpbody

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func jsonRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestReadAtMostAllowsExactLimit(t *testing.T) {
	body, err := ReadAtMost(strings.NewReader("abcd"), 4)
	if err != nil {
		t.Fatalf("ReadAtMost: %v", err)
	}
	if string(body) != "abcd" {
		t.Fatalf("body = %q", string(body))
	}
}

func TestReadAtMostRejectsExtraByte(t *testing.T) {
	body, err := ReadAtMost(strings.NewReader("abcde"), 4)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if body != nil {
		t.Fatalf("body = %q, want nil", string(body))
	}
}

func TestReadAtMostNormalizesOuterMaxBytesReader(t *testing.T) {
	rec := httptest.NewRecorder()
	outer := http.MaxBytesReader(rec, io.NopCloser(strings.NewReader("abcde")), 4)
	if _, err := ReadAtMost(outer, 8); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

func TestPeekAtMostRestoresOversizedStream(t *testing.T) {
	body := io.NopCloser(strings.NewReader("abcdef"))
	peeked, err := PeekAtMost(&body, 4)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if peeked != nil {
		t.Fatalf("peeked = %q, want nil", peeked)
	}
	replayed, readErr := io.ReadAll(body)
	if readErr != nil || string(replayed) != "abcdef" {
		t.Fatalf("restored body = %q, err=%v", replayed, readErr)
	}
}

func TestCopyAtMostRejectsExtraWithoutWritingIt(t *testing.T) {
	var dst bytes.Buffer
	n, err := CopyAtMost(&dst, strings.NewReader("abcde"), 4)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if n != 4 || dst.String() != "abcd" {
		t.Fatalf("n=%d dst=%q, want 4 and abcd", n, dst.String())
	}
}

func TestCopyAtMostNormalizesOuterMaxBytesReader(t *testing.T) {
	rec := httptest.NewRecorder()
	outer := http.MaxBytesReader(rec, io.NopCloser(strings.NewReader("abcde")), 4)
	var dst bytes.Buffer
	n, err := CopyAtMost(&dst, outer, 8)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if n != 4 || dst.String() != "abcd" {
		t.Fatalf("n=%d dst=%q, want 4 and abcd", n, dst.String())
	}
}

func TestReadJSONAtMostEnforcesContentTypeBeforeSignedByteRead(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(`{"ok":true}`))
	if _, err := ReadJSONAtMost(req, 64, Options{}); !errors.Is(err, ErrUnsupportedMediaType) {
		t.Fatalf("err = %v, want ErrUnsupportedMediaType", err)
	}
}

func TestReadJSONAtMostRejectsEmptyBodyWithoutPanicking(t *testing.T) {
	req := &http.Request{Header: make(http.Header)}
	if _, err := ReadJSONAtMost(req, 64, Options{}); !errors.Is(err, ErrEmpty) {
		t.Fatalf("err = %v, want ErrEmpty", err)
	}
}

func TestDecodeJSONBytesRetainsRawAndUsesNumber(t *testing.T) {
	raw := `{"id":9007199254740993,"extension":true}`
	req := jsonRequest(http.MethodPost, "/scim", raw)
	var dst map[string]any
	body, err := DecodeJSONBytes(req, 256, &dst, Options{AllowUnknownFields: true, UseNumber: true})
	if err != nil {
		t.Fatalf("DecodeJSONBytes: %v", err)
	}
	if string(body) != raw {
		t.Fatalf("body = %q, want %q", body, raw)
	}
	if got, ok := dst["id"].(json.Number); !ok || got.String() != "9007199254740993" {
		t.Fatalf("id = %#v, want exact json.Number", dst["id"])
	}
}

func TestDecodeJSONRejectsOversizedBody(t *testing.T) {
	req := jsonRequest(http.MethodPost, "/", `{"value":"`+strings.Repeat("x", 16)+`"}`)
	rec := httptest.NewRecorder()
	var dst map[string]string
	err := DecodeJSON(rec, req, 8, &dst)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if StatusCode(err) != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", StatusCode(err))
	}
	if ErrorCode(err) != "payload_too_large" {
		t.Fatalf("code = %q, want payload_too_large", ErrorCode(err))
	}
}

func TestDecodeJSONRejectsMultipleValuesAndTrailingGarbage(t *testing.T) {
	for _, body := range []string{`{"a":1}{"b":2}`, `{"a":1} trailing`} {
		req := jsonRequest(http.MethodPost, "/", body)
		rec := httptest.NewRecorder()
		var dst map[string]int
		err := DecodeJSON(rec, req, 64, &dst)
		if err == nil {
			t.Fatalf("body %q unexpectedly accepted", body)
		}
		if StatusCode(err) != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", StatusCode(err))
		}
	}
}

type decodeTarget struct {
	Value string `json:"value"`
}

func TestDecodeJSONRejectsUnknownFieldsByDefault(t *testing.T) {
	req := jsonRequest(http.MethodPost, "/", `{"value":"ok","oops":1}`)
	rec := httptest.NewRecorder()
	var dst decodeTarget
	err := DecodeJSON(rec, req, 256, &dst)
	if !errors.Is(err, ErrUnknownField) {
		t.Fatalf("err = %v, want ErrUnknownField", err)
	}
	if ErrorCode(err) != "unknown_field" {
		t.Fatalf("code = %q, want unknown_field", ErrorCode(err))
	}
}

func TestDecodeJSONUnknownFieldCompatibilityIsExplicit(t *testing.T) {
	req := jsonRequest(http.MethodPost, "/", `{"value":"ok","extra":2}`)
	rec := httptest.NewRecorder()
	var dst decodeTarget
	if err := DecodeJSONWith(rec, req, 256, &dst, Options{AllowUnknownFields: true}); err != nil {
		t.Fatalf("DecodeJSONWith compatibility exception: %v", err)
	}
	if dst.Value != "ok" {
		t.Fatalf("value = %q", dst.Value)
	}
}

func TestDecodeJSONEnforcesContentType(t *testing.T) {
	for _, contentType := range []string{"", "text/plain", "text/vendor+json", "application/json; charset=iso-8859-1", "application/json; profile=x"} {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"ok"}`))
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		rec := httptest.NewRecorder()
		var dst decodeTarget
		err := DecodeJSON(rec, req, 256, &dst)
		if !errors.Is(err, ErrUnsupportedMediaType) {
			t.Fatalf("Content-Type %q: err = %v, want ErrUnsupportedMediaType", contentType, err)
		}
		if StatusCode(err) != http.StatusUnsupportedMediaType {
			t.Fatalf("Content-Type %q: status = %d, want 415", contentType, StatusCode(err))
		}
	}
}

func TestDecodeJSONAcceptsRegisteredJSONMediaTypes(t *testing.T) {
	for _, contentType := range []string{"application/json", "application/json; charset=utf-8", "application/scim+json"} {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"ok"}`))
		req.Header.Set("Content-Type", contentType)
		rec := httptest.NewRecorder()
		var dst decodeTarget
		if err := DecodeJSON(rec, req, 256, &dst); err != nil {
			t.Fatalf("Content-Type %q: DecodeJSON: %v", contentType, err)
		}
	}
}

func TestDecodeJSONEmptyBodyRequiresExplicitOption(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	var dst decodeTarget
	if err := DecodeJSON(rec, req, 256, &dst); !errors.Is(err, ErrEmpty) {
		t.Fatalf("err = %v, want ErrEmpty", err)
	}
	if err := DecodeJSONWith(rec, req, 256, &dst, Options{AllowEmptyBody: true}); err != nil {
		t.Fatalf("optional empty body: %v", err)
	}
}

func TestLimitRequestsRejectsKnownOversizeBeforeHandler(t *testing.T) {
	called := false
	h := LimitRequests(4, nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ordinary", strings.NewReader("12345"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if called {
		t.Fatal("handler called for oversized body")
	}
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"code":"payload_too_large"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestLimitRequestsUsesAuditedRouteOverrideAndStillCapsChunkedBody(t *testing.T) {
	overrides := []RouteLimit{{
		Method: http.MethodPost, Pattern: "/api/v1/lists/{id}/import", MaxBytes: 8, Reason: "test CSV",
	}}
	h := LimitRequests(4, overrides)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(r.Body)
		if err != nil {
			WriteError(w, normalizeDecodeError(err))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	accepted := httptest.NewRequest(http.MethodPost, "/api/v1/lists/list-1/import", strings.NewReader("12345678"))
	accepted.ContentLength = -1
	acceptedRec := httptest.NewRecorder()
	h.ServeHTTP(acceptedRec, accepted)
	if acceptedRec.Code != http.StatusNoContent {
		t.Fatalf("accepted status = %d, want 204", acceptedRec.Code)
	}

	rejected := httptest.NewRequest(http.MethodPost, "/api/v1/lists/list-1/import", strings.NewReader("123456789"))
	rejected.ContentLength = -1
	rejectedRec := httptest.NewRecorder()
	h.ServeHTTP(rejectedRec, rejected)
	if rejectedRec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("rejected status = %d, want 413", rejectedRec.Code)
	}
}

func TestProductionRouteLimitsAreValidAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, limit := range ProductionRouteLimits {
		key := limit.Method + " " + limit.Pattern
		if seen[key] {
			t.Fatalf("duplicate route limit %s", key)
		}
		seen[key] = true
		if limit.MaxBytes <= DefaultRequestMaxBodyBytes {
			t.Fatalf("override %s max=%d does not exceed default=%d", key, limit.MaxBytes, DefaultRequestMaxBodyBytes)
		}
		if strings.TrimSpace(limit.Reason) == "" {
			t.Fatalf("override %s has no reason", key)
		}
	}
}

func TestProductionRouteLimitsMatchAuditedContracts(t *testing.T) {
	want := map[string]int64{
		http.MethodPost + " /api/v1/assets":                     20 << 20,
		http.MethodPost + " /api/v1/subscribers/import":         32 << 20,
		http.MethodPost + " /api/v1/subscriber-imports/preview": 50 << 20,
		http.MethodPost + " /api/v1/lists/{id}/import":          32 << 20,
		http.MethodPost + " /api/v1/suppressions/import":        25 << 20,
		http.MethodPost + " /api/v1/suppressions/bulk-import":   16 << 20,
		http.MethodPost + " /api/v1/suppressions/bulk-delete":   16 << 20,
		http.MethodPost + " /api/v1/suppressions/bulk-action":   16 << 20,
		http.MethodPost + " /api/v1/emails":                     35 << 20,
		http.MethodPost + " /api/v1/emails/batch":               40 << 20,
		http.MethodPut + " /api/internal/uploads/*":             25 << 20,
	}
	for _, limit := range ProductionRouteLimits {
		key := limit.Method + " " + limit.Pattern
		expected, ok := want[key]
		if !ok {
			t.Fatalf("unaudited large-route override %s", key)
		}
		if limit.MaxBytes != expected {
			t.Fatalf("%s max=%d, want %d", key, limit.MaxBytes, expected)
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing audited large-route override(s): %v", want)
	}
}
