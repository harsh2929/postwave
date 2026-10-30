// SPDX-License-Identifier: AGPL-3.0-only
package dmarc

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type snapshotClockTx struct {
	pgx.Tx
	query string
	value time.Time
}

func (tx *snapshotClockTx) QueryRow(_ context.Context, query string, _ ...any) pgx.Row {
	tx.query = query
	return snapshotClockRow{value: tx.value}
}

type snapshotClockRow struct {
	value time.Time
}

func (row snapshotClockRow) Scan(destinations ...any) error {
	*destinations[0].(*time.Time) = row.value
	return nil
}

func TestListRequiresTenantAndDisablesCaching(t *testing.T) {
	d := &Deps{}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/deliverability/dmarc-reports", nil)
	response := httptest.NewRecorder()

	d.List(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	assertSensitiveResponseHeaders(t, response)
}

func TestListInternalErrorLogsTenantWithoutLeakingFailure(t *testing.T) {
	var logs bytes.Buffer
	d := &Deps{Logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	request := withTestTenant(httptest.NewRequest(http.MethodGet, "/api/v1/deliverability/dmarc-reports", nil))
	response := httptest.NewRecorder()

	d.List(response, request)

	if response.Code != http.StatusInternalServerError || responseErrorCode(t, response) != "internal_error" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "nil pool") {
		t.Fatal("internal database failure leaked to the client")
	}
	logText := logs.String()
	if !strings.Contains(logText, `"tenant_id":"00000000-0000-4000-8000-000000000001"`) ||
		!strings.Contains(logText, "dmarc reports: nil pool") {
		t.Fatalf("internal log is missing tenant/failure context: %s", logText)
	}
}

func TestListRejectsInvalidQueriesBeforeDatabaseAccess(t *testing.T) {
	tests := []struct {
		name string
		url  string
		code string
	}{
		{name: "zero limit", url: "?limit=0", code: "invalid_limit"},
		{name: "oversized limit", url: "?limit=501", code: "invalid_limit"},
		{name: "non integer limit", url: "?limit=1.5", code: "invalid_limit"},
		{name: "signed limit", url: "?limit=%2B1", code: "invalid_limit"},
		{name: "IP is not domain", url: "?domain=127.0.0.1", code: "invalid_domain"},
		{name: "empty label", url: "?domain=bad..example", code: "invalid_domain"},
		{name: "unicode domain", url: "?domain=%E2%98%83.example", code: "invalid_domain"},
		{name: "invalid from", url: "?from=tomorrow", code: "invalid_from"},
		{name: "invalid to", url: "?to=tomorrow", code: "invalid_to"},
		{
			name: "reversed window",
			url:  "?from=2026-08-03T10%3A00%3A00Z&to=2026-08-03T09%3A00%3A00Z",
			code: "invalid_window",
		},
		{name: "unknown parameter", url: "?private-canary=1", code: "invalid_query"},
		{name: "repeated parameter", url: "?limit=10&limit=20", code: "invalid_query"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			d := &Deps{Pool: nil}
			request := withTestTenant(httptest.NewRequest(
				http.MethodGet,
				"/api/v1/deliverability/dmarc-reports"+test.url,
				nil,
			))
			response := httptest.NewRecorder()

			d.List(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
			}
			if got := responseErrorCode(t, response); got != test.code {
				t.Errorf("error code = %q, want %q", got, test.code)
			}
			if strings.Contains(response.Body.String(), "private-canary") {
				t.Fatal("response reflected an unsupported query parameter name")
			}
			assertSensitiveResponseHeaders(t, response)
		})
	}
}

func TestParseListOptionsCanonicalisesAnExactScope(t *testing.T) {
	values := url.Values{
		"domain": {" Example.COM "},
		"from":   {"2026-08-01T08:30:00+05:30"},
		"to":     {"2026-08-03T03:00:00Z"},
		"limit":  {"500"},
	}

	opts, err := parseListOptions(values)
	if err != nil {
		t.Fatalf("parseListOptions: %v", err)
	}
	if opts.Domain != "example.com" || opts.Limit != 500 {
		t.Fatalf("unexpected options: %+v", opts)
	}
	if got := opts.From.Format(time.RFC3339); got != "2026-08-01T03:00:00Z" {
		t.Errorf("from = %s", got)
	}
	if got := opts.To.Format(time.RFC3339); got != "2026-08-03T03:00:00Z" {
		t.Errorf("to = %s", got)
	}
}

func TestCanonicalHostname(t *testing.T) {
	tests := []struct {
		input string
		want  string
		ok    bool
	}{
		{input: " EXAMPLE.COM ", want: "example.com", ok: true},
		{input: "mail-1.example.com", want: "mail-1.example.com", ok: true},
		{input: "example.com.", ok: false},
		{input: "-mail.example.com", ok: false},
		{input: "mail_.example.com", ok: false},
		{input: "2001:db8::1", ok: false},
		{input: strings.Repeat("a", 64) + ".example", ok: false},
	}
	for _, test := range tests {
		got, ok := canonicalHostname(test.input)
		if got != test.want || ok != test.ok {
			t.Errorf("canonicalHostname(%q) = (%q, %v), want (%q, %v)", test.input, got, ok, test.want, test.ok)
		}
	}
}

func TestTruncateUTF16MatchesDesktopStringLimits(t *testing.T) {
	if got := truncateUTF16("a😀b", 3); got != "a😀" {
		t.Errorf("three UTF-16 units = %q, want a😀", got)
	}
	if got := truncateUTF16("a😀b", 2); got != "a" {
		t.Errorf("two UTF-16 units = %q, want a", got)
	}
	if got := truncateUTF16(strings.Repeat("😀", 200), 256); got != strings.Repeat("😀", 128) {
		t.Errorf("astral truncation retained %d bytes, want %d", len(got), len(strings.Repeat("😀", 128)))
	}
}

func TestListResponseEmptyCollectionsMarshalAsArrays(t *testing.T) {
	payload := listResponse{
		Items: []Report{},
		Meta: listMeta{
			GeneratedAt:      time.Date(2026, 8, 3, 3, 0, 0, 0, time.UTC),
			Limit:            500,
			AvailableDomains: []string{},
			Scope:            listScope{},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal list response: %v", err)
	}
	jsonText := string(encoded)
	for _, expected := range []string{
		`"items":[]`,
		`"availableDomains":[]`,
		`"returned":0`,
		`"totalReports":0`,
		`"hasMore":false`,
		`"domainInventoryTruncated":false`,
		`"scope":{}`,
	} {
		if !strings.Contains(jsonText, expected) {
			t.Errorf("response missing %s: %s", expected, jsonText)
		}
	}
}

func TestSnapshotGeneratedAtUsesDatabaseClockAndCanonicalUTC(t *testing.T) {
	zone := time.FixedZone("receipt-test", 5*60*60+30*60)
	tx := &snapshotClockTx{value: time.Date(2026, 8, 3, 8, 30, 0, 123, zone)}

	got, err := snapshotGeneratedAt(context.Background(), tx)
	if err != nil {
		t.Fatalf("snapshotGeneratedAt: %v", err)
	}
	if strings.TrimSpace(tx.query) != "SELECT clock_timestamp()" {
		t.Fatalf("snapshot receipt query = %q", tx.query)
	}
	if got.Location() != time.UTC || got.Format(time.RFC3339Nano) != "2026-08-03T03:00:00.000000123Z" {
		t.Fatalf("snapshot receipt = %s (%s)", got.Format(time.RFC3339Nano), got.Location())
	}
}
