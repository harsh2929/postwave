// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestHistoryResponseProjectionOmitsMailboxTenantAndRawProviderEvidence(t *testing.T) {
	t.Parallel()
	const canary = "sensitive-evidence-canary"
	projected := map[string]any{
		"bounces": projectHistoryBounces([]BounceEvent{{
			ID: 1, TenantID: "tenant-" + canary, SubscriberEmail: canary + "@example.test",
			BounceType: "hard", ESP: "postmark", Raw: json.RawMessage(`{"token":"` + canary + `"}`),
			ReceivedAt: time.Date(2026, 7, 14, 0, 0, 0, 0, time.UTC),
		}}),
		"complaints": projectHistoryComplaints(nil),
	}
	encoded, err := json.Marshal(projected)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), canary) || strings.Contains(string(encoded), "tenant_id") || strings.Contains(string(encoded), "subscriber_email") || strings.Contains(string(encoded), "raw") {
		t.Fatalf("history response leaked sensitive evidence: %s", encoded)
	}
}

func TestDecodeHistoryRequestCanonicalizesWithoutLocaleRules(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/feedback/history", strings.NewReader(`{"email":"  Alice.Tag+News@Example.COM  "}`))
	req.Header.Set("Content-Type", "application/json")
	email, err := decodeHistoryRequest(httptest.NewRecorder(), req)
	if err != nil {
		t.Fatalf("decode history request: %v", err)
	}
	if email != "alice.tag+news@example.com" {
		t.Fatalf("canonical email = %q", email)
	}
}

func TestHistoryRequestRejectsUnsafeBodiesWithoutReflectingPII(t *testing.T) {
	t.Parallel()
	const canary = "recipient-secret-canary"
	for _, body := range []string{
		`{"email":"` + canary + `\r\n@example.test"}`,
		`{"email":"alice@example.test","secret":"` + canary + `"}`,
		`{"email":"alice@example.test"}{"email":"second@example.test"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/feedback/history", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
		res := httptest.NewRecorder()
		(&Deps{}).HandleHistory(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body=%s", res.Code, res.Body.String())
		}
		if strings.Contains(res.Body.String(), canary) {
			t.Fatalf("validation response reflected mailbox canary: %s", res.Body.String())
		}
		if got := res.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
	}
}

func TestHistoryUnauthorizedResponseIsNoStore(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/feedback/history", strings.NewReader(`{"email":"alice@example.test"}`))
	res := httptest.NewRecorder()
	(&Deps{}).HandleHistory(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Code)
	}
	if got := res.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestTenantResolverUsesBothLedgersAndRejectsLatestRowWins(t *testing.T) {
	for _, relation := range []string{"outbox_events", "transactional_emails"} {
		if !strings.Contains(lookupTenantByESPMessageIDSQL, relation) {
			t.Fatalf("tenant resolver SQL omits %s", relation)
		}
	}
	if strings.Contains(strings.ToUpper(lookupTenantByESPMessageIDSQL), "LIMIT 1") {
		t.Fatal("tenant resolver must not hide cross-tenant ambiguity with LIMIT 1")
	}
	if !strings.Contains(lookupTenantByESPMessageIDSQL, "count(*) = 1") {
		t.Fatal("tenant resolver must require exactly one distinct owner")
	}
}

func TestParsePostmarkBounce(t *testing.T) {
	cases := []struct {
		name      string
		body      string
		wantType  string
		wantErr   bool
		wantEmail string
		wantMsgID string
	}{
		{
			name:      "hard bounce",
			body:      `{"Type":"HardBounce","Email":"alice@example.com","MessageID":"pm-1","BouncedAt":"2024-05-08T12:00:00Z"}`,
			wantType:  "hard",
			wantEmail: "alice@example.com",
			wantMsgID: "pm-1",
		},
		{
			name:      "soft bounce",
			body:      `{"Type":"SoftBounce","Email":"bob@example.com","MessageID":"pm-2"}`,
			wantType:  "soft",
			wantEmail: "bob@example.com",
			wantMsgID: "pm-2",
		},
		{
			name:      "transient",
			body:      `{"Type":"Transient","Email":"carol@example.com"}`,
			wantType:  "transient",
			wantEmail: "carol@example.com",
		},
		{
			name:    "spam complaint rejected from bounce parser",
			body:    `{"Type":"SpamComplaint","Email":"x@example.com"}`,
			wantErr: true,
		},
		{
			name:    "missing type",
			body:    `{"Email":"x@example.com"}`,
			wantErr: true,
		},
		{
			name:    "missing email",
			body:    `{"Type":"HardBounce"}`,
			wantErr: true,
		},
		{
			name:    "malformed json",
			body:    `{"Type":`,
			wantErr: true,
		},
		{
			name:    "unknown type",
			body:    `{"Type":"WeirdEvent","Email":"x@example.com"}`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParsePostmarkBounce([]byte(tc.body))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.BounceType != tc.wantType {
				t.Errorf("bounce_type=%q, want %q", got.BounceType, tc.wantType)
			}
			if got.SubscriberEmail != tc.wantEmail {
				t.Errorf("email=%q, want %q", got.SubscriberEmail, tc.wantEmail)
			}
			if got.ESP != "postmark" {
				t.Errorf("esp=%q, want postmark", got.ESP)
			}
			if tc.wantMsgID != "" && got.ESPMessageID != tc.wantMsgID {
				t.Errorf("esp_message_id=%q, want %q", got.ESPMessageID, tc.wantMsgID)
			}
			if len(got.Raw) == 0 {
				t.Error("Raw should be set")
			}
		})
	}
}

func TestParsePostmarkComplaint(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		body := `{"Type":"SpamComplaint","Email":"alice@example.com","MessageID":"pm-3"}`
		got, err := ParsePostmarkComplaint([]byte(body))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.ComplaintType != "spam" {
			t.Errorf("complaint_type=%q, want spam", got.ComplaintType)
		}
		if got.SubscriberEmail != "alice@example.com" {
			t.Errorf("email=%q", got.SubscriberEmail)
		}
		if got.ESP != "postmark" {
			t.Errorf("esp=%q, want postmark", got.ESP)
		}
		if got.ESPMessageID != "pm-3" {
			t.Errorf("esp_message_id=%q, want pm-3", got.ESPMessageID)
		}
	})
	t.Run("rejects bounce types", func(t *testing.T) {
		body := `{"Type":"HardBounce","Email":"alice@example.com"}`
		if _, err := ParsePostmarkComplaint([]byte(body)); err == nil {
			t.Fatal("expected error on bounce Type")
		}
	})
	t.Run("malformed json", func(t *testing.T) {
		if _, err := ParsePostmarkComplaint([]byte("not json")); err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("missing email", func(t *testing.T) {
		if _, err := ParsePostmarkComplaint([]byte(`{"Type":"SpamComplaint"}`)); err == nil {
			t.Fatal("expected error")
		}
	})
}

func TestParseSendGridBatch(t *testing.T) {
	body := `[
        {"event":"bounce","email":"hard@example.com","sg_message_id":"sg-1","bounce_classification":"Invalid Mailbox","timestamp":1700000000},
        {"event":"bounce","email":"soft@example.com","sg_message_id":"sg-2","bounce_classification":"Mailbox Full","timestamp":1700000001},
        {"event":"dropped","email":"dropped@example.com","sg_message_id":"sg-3","reason":"Invalid SMTPAPI"},
        {"event":"spamreport","email":"spam@example.com","sg_message_id":"sg-4"},
        {"event":"delivered","email":"ok@example.com","sg_message_id":"sg-5"},
        {"event":"open","email":"open@example.com"},
        {"event":"bounce","email":"","sg_message_id":"sg-6"}
    ]`
	bounces, complaints, err := ParseSendGridBatch([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(bounces) != 3 {
		t.Fatalf("bounces=%d, want 3 (hard, soft, dropped)", len(bounces))
	}
	if len(complaints) != 1 {
		t.Fatalf("complaints=%d, want 1", len(complaints))
	}

	if bounces[0].BounceType != "hard" {
		t.Errorf("bounces[0].BounceType=%q, want hard", bounces[0].BounceType)
	}
	if bounces[0].SubscriberEmail != "hard@example.com" {
		t.Errorf("bounces[0].SubscriberEmail=%q", bounces[0].SubscriberEmail)
	}
	if bounces[0].ESP != "sendgrid" {
		t.Errorf("bounces[0].ESP=%q, want sendgrid", bounces[0].ESP)
	}

	if bounces[1].BounceType != "soft" {
		t.Errorf("bounces[1].BounceType=%q, want soft (Mailbox Full not Invalid Mailbox)", bounces[1].BounceType)
	}
	if bounces[2].BounceType != "hard" {
		t.Errorf("bounces[2].BounceType=%q, want hard (dropped → hard)", bounces[2].BounceType)
	}
	if complaints[0].ComplaintType != "spam" {
		t.Errorf("complaints[0].ComplaintType=%q, want spam", complaints[0].ComplaintType)
	}
	if complaints[0].SubscriberEmail != "spam@example.com" {
		t.Errorf("complaints[0].SubscriberEmail=%q", complaints[0].SubscriberEmail)
	}
}

func TestParseSendGridBatch_EmptyAndMalformed(t *testing.T) {
	t.Run("empty array is valid no-op", func(t *testing.T) {
		bounces, complaints, err := ParseSendGridBatch([]byte("[]"))
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if len(bounces) != 0 || len(complaints) != 0 {
			t.Errorf("expected empty results, got %d bounces / %d complaints", len(bounces), len(complaints))
		}
	})
	t.Run("malformed json", func(t *testing.T) {
		if _, _, err := ParseSendGridBatch([]byte("not json")); err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("not an array", func(t *testing.T) {
		// SendGrid always sends an array; an object should fail to unmarshal.
		if _, _, err := ParseSendGridBatch([]byte(`{"event":"bounce"}`)); err == nil {
			t.Fatal("expected error on object body")
		}
	})
}

func TestParseARFReport(t *testing.T) {
	// Hand-rolled multipart/report payload mirroring RFC 5965.
	// CRLF line endings matter; mime/multipart is strict about them.
	const boundary = "feedback-boundary-1"
	body := strings.ReplaceAll(`This is a multi-part message in MIME format.

--BOUND
Content-Type: text/plain; charset=utf-8

User reported this message as junk.

--BOUND
Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: Moosewave-Test/1.0
Version: 1
Original-Mail-From: <sender@example.com>
Original-Rcpt-To: rfc822; alice@example.com
Arrival-Date: Wed, 08 May 2024 12:00:00 +0000
Source-IP: 198.51.100.7

--BOUND
Content-Type: message/rfc822

From: sender@example.com
To: alice@example.com
Subject: hi

original body
--BOUND--
`, "\n", "\r\n")
	body = strings.ReplaceAll(body, "BOUND", boundary)
	contentType := `multipart/report; report-type=feedback-report; boundary="` + boundary + `"`

	got, err := ParseARFReport([]byte(body), contentType)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SubscriberEmail != "alice@example.com" {
		t.Errorf("email=%q, want alice@example.com", got.SubscriberEmail)
	}
	if got.ComplaintType != "fbl" {
		t.Errorf("complaint_type=%q, want fbl", got.ComplaintType)
	}
	if got.ESP != "arf" {
		t.Errorf("esp=%q, want arf", got.ESP)
	}
	if got.ReceivedAt.IsZero() {
		t.Error("ReceivedAt should be parsed from Arrival-Date")
	}
}

func TestParseARFReport_FallbackToMailFrom(t *testing.T) {
	const boundary = "fb2"
	body := strings.ReplaceAll(`--BOUND
Content-Type: text/plain

x

--BOUND
Content-Type: message/feedback-report

Feedback-Type: abuse
Original-Mail-From: charlie@example.com

--BOUND--
`, "\n", "\r\n")
	body = strings.ReplaceAll(body, "BOUND", boundary)
	ct := `multipart/report; boundary="` + boundary + `"`
	got, err := ParseARFReport([]byte(body), ct)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SubscriberEmail != "charlie@example.com" {
		t.Errorf("email=%q, want charlie@example.com (fallback to Original-Mail-From)", got.SubscriberEmail)
	}
}

func TestParseARFReport_Errors(t *testing.T) {
	t.Run("missing boundary in content-type", func(t *testing.T) {
		if _, err := ParseARFReport([]byte("not a real mime body"), ""); err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("no feedback-report part", func(t *testing.T) {
		const boundary = "no-fb"
		body := strings.ReplaceAll(`--BOUND
Content-Type: text/plain

just text
--BOUND--
`, "\n", "\r\n")
		body = strings.ReplaceAll(body, "BOUND", boundary)
		ct := `multipart/report; boundary="` + boundary + `"`
		if _, err := ParseARFReport([]byte(body), ct); err == nil {
			t.Fatal("expected error: no Original-Rcpt-To/Mail-From extracted")
		}
	})
}

func TestVerifyHMACSig(t *testing.T) {
	// Smoke test the HMAC primitive used by the handlers.
	secret := "shhh"
	body := []byte(`{"hello":"world"}`)
	ts := "1700000000"
	mkSig := func(s, t string) string {
		h := hmac.New(sha256.New, []byte(s))
		h.Write([]byte(t))
		h.Write([]byte("."))
		h.Write(body)
		return hex.EncodeToString(h.Sum(nil))
	}
	if !verifyHMACSig(secret, body, mkSig(secret, ts), ts) {
		t.Fatal("valid sig should verify")
	}
	if verifyHMACSig(secret, body, mkSig(secret, ts), "1700000001") {
		t.Fatal("changing ts should break verification")
	}
	if verifyHMACSig("other", body, mkSig(secret, ts), ts) {
		t.Fatal("wrong secret should fail")
	}
	if verifyHMACSig(secret, body, "not-hex", ts) {
		t.Fatal("non-hex sig should fail")
	}
}
