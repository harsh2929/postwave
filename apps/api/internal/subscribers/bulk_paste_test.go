// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_paste_test.go — SUB-089: comma/newline list pasted into the
// add-subscriber modal.
//
// These tests cover the pure parse logic (parseBulkPasteEmails) plus the
// BulkPaste handler's pre-DB guard paths (no tenant, empty paste, over-cap,
// invalid status). The successful upsert loop itself needs Postgres and is
// exercised by the integration suite; here we pin the input contract the
// modal depends on.
package subscribers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func bulkPasteReq(t *testing.T, body string, withTenant bool) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk-paste", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if withTenant {
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	}
	return httptest.NewRecorder(), req
}

func TestParseBulkPasteEmails_SplitsAndDedupes(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"commas", "a@x.com, b@y.com,c@z.com", []string{"a@x.com", "b@y.com", "c@z.com"}},
		{"newlines", "a@x.com\nb@y.com\r\nc@z.com\n", []string{"a@x.com", "b@y.com", "c@z.com"}},
		{"semicolons", "a@x.com; b@y.com", []string{"a@x.com", "b@y.com"}},
		{"spaces and tabs", "a@x.com\tb@y.com  c@z.com", []string{"a@x.com", "b@y.com", "c@z.com"}},
		{"mixed", "a@x.com,\n b@y.com ;c@z.com", []string{"a@x.com", "b@y.com", "c@z.com"}},
		{"dedupe case-insensitive", "a@x.com\nA@X.com\nb@y.com", []string{"a@x.com", "b@y.com"}},
		{"blank only", "  \n , ; \t ", []string{}},
		{"empty", "", []string{}},
		{"order preserved", "z@x.com\na@x.com", []string{"z@x.com", "a@x.com"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseBulkPasteEmails(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("len = %d (%v), want %d (%v)", len(got), got, len(tc.want), tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("got[%d] = %q, want %q (full %v)", i, got[i], tc.want[i], got)
				}
			}
		})
	}
}

func TestBulkPaste_RequiresTenant(t *testing.T) {
	d := &Deps{}
	rec, req := bulkPasteReq(t, `{"emails":"a@x.com"}`, false)
	d.BulkPaste(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkPaste_EmptyEmails(t *testing.T) {
	d := &Deps{}
	rec, req := bulkPasteReq(t, `{"emails":"   \n , ; "}`, true)
	d.BulkPaste(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_emails") {
		t.Fatalf("body = %s, want no_emails", rec.Body.String())
	}
}

func TestBulkPaste_TooManyEmails(t *testing.T) {
	d := &Deps{}
	var sb strings.Builder
	for i := 0; i <= MaxBulkPasteEmails; i++ { // MaxBulkPasteEmails+1 distinct
		sb.WriteString("user")
		sb.WriteString(strings.Repeat("x", 1)) // keep cheap; vary via index below
		// write a unique local part
		sb.WriteByte('\n')
	}
	// Build a genuinely distinct list of MaxBulkPasteEmails+1 addresses.
	sb.Reset()
	for i := 0; i <= MaxBulkPasteEmails; i++ {
		sb.WriteString("user")
		sb.WriteString(itoa(i))
		sb.WriteString("@example.com\n")
	}
	rec, req := bulkPasteReq(t, `{"emails":`+jsonString(sb.String())+`}`, true)
	d.BulkPaste(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too_many_emails") {
		t.Fatalf("body = %s, want too_many_emails", rec.Body.String())
	}
}

func TestBulkPaste_RejectsEverySendableOrInferredStatus(t *testing.T) {
	d := &Deps{}
	for _, status := range []string{"enabled", "disabled", "blocklisted", "archived"} {
		rec, req := bulkPasteReq(t, `{"emails":"a@x.com","status":"`+status+`"}`, true)
		d.BulkPaste(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status %q: got %d, want 400; body=%s", status, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "invalid_status") {
			t.Fatalf("status %q: body = %s, want invalid_status", status, rec.Body.String())
		}
	}
}

// itoa is a tiny base-10 formatter so the test stays dependency-free.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// jsonString wraps s in JSON double quotes, escaping the characters the test
// inputs can contain (newline, quote, backslash) so the body is valid JSON.
func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
