package postwave

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	conversionSecretTestKeyA  = "0123456789abcdef0123456789abcdef"
	conversionSecretTestKeyB  = "abcdef0123456789abcdef0123456789"
	conversionSecretTestValue = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	conversionSecretCreated   = "2026-08-30T12:00:00.123Z"
	conversionSecretUpdated   = "2026-08-30T12:00:01Z"
)

func conversionSecretMetadata(keyID, status string) map[string]any {
	return map[string]any{
		"key_id":                         keyID,
		"label":                          "Orders 🔐",
		"created_at":                     conversionSecretCreated,
		"identity_projection_status":     status,
		"identity_projection_updated_at": conversionSecretUpdated,
	}
}

func conversionSecretIssued() map[string]any {
	secret := conversionSecretMetadata(conversionSecretTestKeyA, "pending")
	secret["secret"] = conversionSecretTestValue
	return map[string]any{
		"secret": secret,
		"notice": conversionSecretNotice,
	}
}

func writeConversionSecretJSON(t *testing.T, w http.ResponseWriter, status int, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatalf("encode fixture response: %v", err)
	}
}

func TestConversionIngestSecretsListIsOneBoundedClosedPage(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != conversionIngestSecretsPath {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "17" {
			t.Errorf("limit=%q, want 17", got)
		}
		if got := r.URL.Query().Get("cursor"); got != "page-token" {
			t.Errorf("cursor=%q, want page-token", got)
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) != 0 {
			t.Errorf("GET body=%q, want empty", body)
		}
		failed := conversionSecretMetadata(conversionSecretTestKeyB, "failed")
		failed["label"] = "retired"
		failed["revoked_at"] = "2026-08-30T13:00:00+00:00"
		failed["identity_projection_error_code"] = "projection_failed"
		writeConversionSecretJSON(t, w, http.StatusOK, map[string]any{
			"items": []any{
				conversionSecretMetadata(conversionSecretTestKeyA, "ready"),
				failed,
			},
			"next_cursor": "next-page",
		})
	}))
	defer server.Close()

	client := New("pw_admin", WithBaseURL(server.URL), WithMaxRetries(4))
	page, err := client.ConversionIngestSecrets.List(context.Background(),
		ConversionIngestSecretListOptions{Limit: 17, Cursor: "page-token"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if calls.Load() != 1 || len(page.Items) != 2 || page.NextCursor != "next-page" {
		t.Fatalf("unexpected page/calls: %#v calls=%d", page, calls.Load())
	}
	if page.Items[1].IdentityProjectionErrorCode == nil ||
		*page.Items[1].IdentityProjectionErrorCode != ConversionEmailHMACProjectionFailedCode ||
		page.Items[1].RevokedAt == nil {
		t.Fatalf("failed/revoked projection not preserved: %#v", page.Items[1])
	}
}

func TestConversionIngestSecretsIssueIsExactlyOneKeylessAttempt(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != conversionIngestSecretsPath {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if value := r.Header.Get("Idempotency-Key"); value != "" {
			t.Errorf("reveal-once issuance leaked Idempotency-Key %q", value)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode issue body: %v", err)
		}
		if body["label"] != "Orders 🔐" || len(body) != 1 {
			t.Errorf("issue body=%#v", body)
		}
		writeConversionSecretJSON(t, w, http.StatusCreated, conversionSecretIssued())
	}))
	defer server.Close()

	client := New("pw_admin", WithBaseURL(server.URL), WithMaxRetries(9))
	issued, err := client.ConversionIngestSecrets.Issue(context.Background(), "Orders 🔐")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if calls.Load() != 1 || issued.Secret != conversionSecretTestValue ||
		issued.KeyID != conversionSecretTestKeyA ||
		issued.IdentityProjectionStatus != ConversionEmailHMACProjectionPending {
		t.Fatalf("unexpected issued key/calls: %#v calls=%d", issued, calls.Load())
	}
}

func TestConversionIngestSecretsIssueNeverRetriesAmbiguousFailure(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeConversionSecretJSON(t, w, http.StatusServiceUnavailable,
			map[string]any{"error": map[string]any{"code": "internal"}})
	}))
	defer server.Close()

	client := New("pw_admin", WithBaseURL(server.URL), WithMaxRetries(9))
	_, err := client.ConversionIngestSecrets.Issue(context.Background(), "orders")
	if err == nil || !strings.Contains(err.Error(), ConversionIngestSecretAmbiguousIssueRecovery) {
		t.Fatalf("expected ambiguity recovery error, got %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("reveal-once issuance made %d attempts, want exactly 1", calls.Load())
	}
	var ambiguous *AmbiguousConversionIngestSecretIssueError
	if !errors.As(err, &ambiguous) ||
		ambiguous.RecoveryInstruction() != ConversionIngestSecretAmbiguousIssueRecovery {
		t.Fatalf("ambiguous failure was not typed: %T %v", err, err)
	}
}

func TestConversionIngestSecretsIssueRejectsWrongSuccessAndMalformedReveal(t *testing.T) {
	tests := []struct {
		name   string
		status int
		mutate func(map[string]any)
	}{
		{name: "wrong-success-status", status: http.StatusOK, mutate: func(map[string]any) {}},
		{name: "wrong-secret", status: http.StatusCreated, mutate: func(value map[string]any) {
			value["secret"].(map[string]any)["secret"] = "wrong"
		}},
		{name: "issued-revoked", status: http.StatusCreated, mutate: func(value map[string]any) {
			value["secret"].(map[string]any)["revoked_at"] = conversionSecretUpdated
		}},
		{name: "not-pending", status: http.StatusCreated, mutate: func(value map[string]any) {
			value["secret"].(map[string]any)["identity_projection_status"] = "ready"
		}},
		{name: "mismatched-label", status: http.StatusCreated, mutate: func(value map[string]any) {
			value["secret"].(map[string]any)["label"] = "mismatched"
		}},
		{name: "unknown-envelope-field", status: http.StatusCreated, mutate: func(value map[string]any) {
			value["extra"] = true
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				value := conversionSecretIssued()
				test.mutate(value)
				writeConversionSecretJSON(t, w, test.status, value)
			}))
			defer server.Close()
			client := New("pw_admin", WithBaseURL(server.URL), WithMaxRetries(5))
			_, err := client.ConversionIngestSecrets.Issue(context.Background(), "Orders 🔐")
			if err == nil || !strings.Contains(err.Error(), "ambiguous") {
				t.Fatalf("expected ambiguous failure, got %v", err)
			}
			if strings.Contains(err.Error(), conversionSecretTestValue) {
				t.Fatalf("ambiguous error leaked reveal-once secret: %v", err)
			}
		})
	}
}

func TestConversionIngestSecretsClosedPageAndLocalBounds(t *testing.T) {
	client := New("pw_admin", WithBaseURL("http://127.0.0.1:1"), WithMaxRetries(0))
	for _, options := range []ConversionIngestSecretListOptions{
		{Limit: -1}, {Limit: 101}, {Cursor: strings.Repeat("x", 513)},
	} {
		if _, err := client.ConversionIngestSecrets.List(context.Background(), options); err == nil {
			t.Fatalf("accepted invalid options %#v", options)
		}
	}
	for _, label := range []string{" padded ", strings.Repeat("😀", 129), "control\u0085", string([]byte{0xff})} {
		if _, err := client.ConversionIngestSecrets.Issue(context.Background(), label); err == nil {
			t.Fatalf("accepted invalid label %q", label)
		}
	}
	if _, err := client.ConversionIngestSecrets.List(context.Background(),
		ConversionIngestSecretListOptions{Limit: 0}); err == nil {
		// Limit zero is the documented omitted/default sentinel and is valid. The
		// request should fail only because the fixture address is unreachable.
		t.Fatal("default limit unexpectedly reached no transport error")
	}

	hostile := []map[string]any{
		{"items": []any{func() map[string]any {
			row := conversionSecretMetadata(conversionSecretTestKeyA, "ready")
			row["secret"] = conversionSecretTestValue
			return row
		}()}},
		{"items": []any{func() map[string]any {
			row := conversionSecretMetadata(conversionSecretTestKeyA, "ready")
			row["identity_projection_error_code"] = nil
			return row
		}()}},
		{"items": []any{
			conversionSecretMetadata(conversionSecretTestKeyA, "ready"),
			conversionSecretMetadata(conversionSecretTestKeyA, "ready"),
		}},
		{"items": []any{}, "unknown": true},
		{"items": nil},
	}
	for index, payload := range hostile {
		t.Run("hostile-"+string(rune('a'+index)), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeConversionSecretJSON(t, w, http.StatusOK, payload)
			}))
			defer server.Close()
			closed := New("pw_admin", WithBaseURL(server.URL), WithMaxRetries(0))
			if _, err := closed.ConversionIngestSecrets.List(context.Background()); err == nil {
				t.Fatal("hostile page was accepted")
			}
		})
	}
}

func TestConversionIngestSecretsRevokeIsBodylessNormalWrite(t *testing.T) {
	var body []byte
	var idempotency string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		idempotency = r.Header.Get("Idempotency-Key")
		if r.URL.Path != conversionIngestSecretsPath+"/"+conversionSecretTestKeyA+"/revoke" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		writeConversionSecretJSON(t, w, http.StatusOK, map[string]any{"revoked": true})
	}))
	defer server.Close()

	client := New("pw_admin", WithBaseURL(server.URL), WithMaxRetries(0))
	if err := client.ConversionIngestSecrets.Revoke(context.Background(), conversionSecretTestKeyA); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if len(body) != 0 || idempotency == "" {
		t.Fatalf("revoke body=%q idempotency=%q", body, idempotency)
	}
	if err := client.ConversionIngestSecrets.Revoke(context.Background(), strings.ToUpper(conversionSecretTestKeyA)); err == nil {
		t.Fatal("uppercase key id accepted")
	}
}
