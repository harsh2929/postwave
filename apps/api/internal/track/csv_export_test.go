// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"bytes"
	"encoding/csv"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestParseProductEventCSVExportOptions(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name              string
		query             url.Values
		wantEvent         string
		wantSubscriber    string
		wantOccurredAfter string
		wantLimit         int
	}{
		{
			name:      "defaults",
			query:     url.Values{},
			wantLimit: productEventCSVDefaultLimit,
		},
		{
			name: "all filters and UTC cutoff",
			query: url.Values{
				"event_name":     {"  checkout.completed  "},
				"subscriber_id":  {"  subscriber-1  "},
				"occurred_after": {"2026-07-24T13:00:00Z"},
				"limit":          {"250"},
			},
			wantEvent:         "checkout.completed",
			wantSubscriber:    "subscriber-1",
			wantOccurredAfter: "2026-07-24T13:00:00Z",
			wantLimit:         250,
		},
		{
			name: "offset and fractional timestamp normalize to UTC",
			query: url.Values{
				"occurred_after": {"2026-07-24T18:30:00.123456789+05:30"},
			},
			wantOccurredAfter: "2026-07-24T13:00:00.123456789Z",
			wantLimit:         productEventCSVDefaultLimit,
		},
		{
			name: "empty cutoff is omitted",
			query: url.Values{
				"occurred_after": {"   "},
			},
			wantLimit: productEventCSVDefaultLimit,
		},
		{
			name: "one row is accepted",
			query: url.Values{
				"limit": {"1"},
			},
			wantLimit: 1,
		},
		{
			name: "hard cap is accepted",
			query: url.Values{
				"limit": {"10000"},
			},
			wantLimit: productEventCSVHardCap,
		},
		{
			name: "above hard cap is clamped",
			query: url.Values{
				"limit": {"10001"},
			},
			wantLimit: productEventCSVHardCap,
		},
		{
			name: "historical malformed limit fallback is preserved",
			query: url.Values{
				"limit": {"not-a-number"},
			},
			wantLimit: productEventCSVDefaultLimit,
		},
		{
			name: "overflowing limit fallback is bounded",
			query: url.Values{
				"limit": {"999999999999999999999999999999999999"},
			},
			wantLimit: productEventCSVDefaultLimit,
		},
		{
			name: "historical zero limit fallback is preserved",
			query: url.Values{
				"limit": {"0"},
			},
			wantLimit: productEventCSVDefaultLimit,
		},
		{
			name: "historical negative limit fallback is preserved",
			query: url.Values{
				"limit": {"-1"},
			},
			wantLimit: productEventCSVDefaultLimit,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/track/events.csv?"+test.query.Encode(),
				nil,
			)
			got, err := parseProductEventCSVExportOptions(req)
			if err != nil {
				t.Fatalf("parseProductEventCSVExportOptions: %v", err)
			}
			if got.EventName != test.wantEvent ||
				got.SubscriberID != test.wantSubscriber ||
				got.Limit != test.wantLimit {
				t.Fatalf("options = %#v, want event=%q subscriber=%q limit=%d",
					got, test.wantEvent, test.wantSubscriber, test.wantLimit)
			}
			if test.wantOccurredAfter == "" {
				if got.OccurredAfter != nil {
					t.Fatalf("OccurredAfter = %s, want nil", got.OccurredAfter)
				}
				return
			}
			if got.OccurredAfter == nil {
				t.Fatalf("OccurredAfter = nil, want %s", test.wantOccurredAfter)
			}
			if formatted := got.OccurredAfter.Format(time.RFC3339Nano); formatted != test.wantOccurredAfter {
				t.Fatalf("OccurredAfter = %s, want %s", formatted, test.wantOccurredAfter)
			}
			if got.OccurredAfter.Location() != time.UTC {
				t.Fatalf("OccurredAfter location = %s, want UTC", got.OccurredAfter.Location())
			}
		})
	}
}

func TestParseProductEventCSVExportOptionsRejectsMalformedOccurredAfter(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		query url.Values
	}{
		{
			name:  "date only",
			query: url.Values{"occurred_after": {"2026-07-24"}},
		},
		{
			name:  "timestamp without timezone",
			query: url.Values{"occurred_after": {"2026-07-24T13:00:00"}},
		},
		{
			name:  "impossible calendar date",
			query: url.Values{"occurred_after": {"2026-02-30T13:00:00Z"}},
		},
		{
			name:  "arbitrary text",
			query: url.Values{"occurred_after": {"yesterday"}},
		},
		{
			name: "duplicate parameter",
			query: url.Values{
				"occurred_after": {
					"2026-07-24T13:00:00Z",
					"2026-07-25T13:00:00Z",
				},
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/track/events.csv?"+test.query.Encode(),
				nil,
			)
			_, err := parseProductEventCSVExportOptions(req)
			if err == nil || !strings.Contains(err.Error(), "occurred_after") {
				t.Fatalf("error = %v, want occurred_after validation error", err)
			}
		})
	}
}

func TestExportEventsCSVRejectsMalformedOccurredAfterBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()

	deps := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/track/events.csv?occurred_after=not-a-timestamp",
		nil,
	)
	req = req.WithContext(middleware.WithTenant(
		req.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	))
	rec := httptest.NewRecorder()

	deps.ExportEventsCSV(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if contentType := rec.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want JSON", contentType)
	}
	if !strings.Contains(rec.Body.String(), `"code":"invalid_occurred_after"`) {
		t.Fatalf("body = %s, want invalid_occurred_after", rec.Body.String())
	}
}

func TestExportEventsCSVRequiresTenantBeforeScopeValidation(t *testing.T) {
	t.Parallel()

	deps := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/track/events.csv?occurred_after=not-a-timestamp",
		nil,
	)
	rec := httptest.NewRecorder()

	deps.ExportEventsCSV(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"no_tenant"`) {
		t.Fatalf("body = %s, want no_tenant", rec.Body.String())
	}
}

func TestProductEventCSVHardCapContract(t *testing.T) {
	t.Parallel()

	if productEventCSVDefaultLimit != 10_000 {
		t.Fatalf("productEventCSVDefaultLimit = %d, want 10000", productEventCSVDefaultLimit)
	}
	if productEventCSVHardCap != 10_000 {
		t.Fatalf("productEventCSVHardCap = %d, want 10000", productEventCSVHardCap)
	}
}

func TestProductEventCSVSQLUsesOneTransactionAsOfForRowsAndLookahead(t *testing.T) {
	t.Parallel()

	if productEventCSVExportAsOfSQL != `SELECT transaction_timestamp()` {
		t.Fatalf("as-of SQL = %q, want database transaction timestamp", productEventCSVExportAsOfSQL)
	}
	if !strings.Contains(
		productEventCSVExportFromWhere,
		"AND occurred_at <= $5::timestamptz",
	) {
		t.Fatalf("shared export predicate lacks frozen upper bound: %s", productEventCSVExportFromWhere)
	}
	if !strings.Contains(productEventCSVExportTruncatedSQL, "OFFSET $6") {
		t.Fatalf("lookahead does not use bounded limit argument: %s", productEventCSVExportTruncatedSQL)
	}
	if !strings.Contains(productEventCSVExportRowsSQL, "LIMIT $6") {
		t.Fatalf("row query does not use bounded limit argument: %s", productEventCSVExportRowsSQL)
	}
}

func TestSpreadsheetSafeCSVCellNeutralizesFormulaAndControlPrefixes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "equals", input: "=1+1", want: "'=1+1"},
		{name: "plus", input: "+SUM(A1:A2)", want: "'+SUM(A1:A2)"},
		{name: "minus", input: "-2+3", want: "'-2+3"},
		{name: "at", input: "@SUM(A1:A2)", want: "'@SUM(A1:A2)"},
		{name: "tab", input: "\t=cmd", want: "'\t=cmd"},
		{name: "carriage_return", input: "\r=cmd", want: "'\r=cmd"},
		{name: "line_feed", input: "\n=cmd", want: "'\n=cmd"},
		{name: "nul", input: "\x00=cmd", want: "'\x00=cmd"},
		{name: "format_mark", input: "\ufeff=cmd", want: "'\ufeff=cmd"},
		{name: "formula_after_spaces", input: "  =cmd", want: "'  =cmd"},
		{name: "safe_after_spaces", input: "  checkout.completed", want: "  checkout.completed"},
		{name: "ordinary", input: "checkout.completed", want: "checkout.completed"},
		{name: "quoted_comma_newline", input: "quoted, \"value\"\nnext", want: "quoted, \"value\"\nnext"},
		{name: "empty", input: "", want: ""},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := spreadsheetSafeCSVCell(tt.input); got != tt.want {
				t.Fatalf("spreadsheetSafeCSVCell(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestWriteSpreadsheetSafeCSVRecordPreservesCSVContent(t *testing.T) {
	t.Parallel()

	input := []string{
		"42",
		`subscriber,"quoted"` + "\nnext",
		"=WEBSERVICE(\"https://attacker.invalid\")",
		`{"subject":"Hello, \"world\"","lines":["one","two"]}`,
	}
	want := []string{
		"42",
		`subscriber,"quoted"` + "\nnext",
		"'=WEBSERVICE(\"https://attacker.invalid\")",
		`{"subject":"Hello, \"world\"","lines":["one","two"]}`,
	}

	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	if err := writeSpreadsheetSafeCSVRecord(writer, input); err != nil {
		t.Fatalf("write record: %v", err)
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		t.Fatalf("flush record: %v", err)
	}

	reader := csv.NewReader(strings.NewReader(output.String()))
	got, err := reader.Read()
	if err != nil {
		t.Fatalf("read encoded record: %v; CSV = %q", err, output.String())
	}
	if _, err := reader.Read(); err != io.EOF {
		t.Fatalf("expected exactly one logical CSV record, got err %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded record = %#v, want %#v; CSV = %q", got, want, output.String())
	}
}
