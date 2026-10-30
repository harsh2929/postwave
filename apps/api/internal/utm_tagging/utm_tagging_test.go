// SPDX-License-Identifier: AGPL-3.0-only

package utm_tagging

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestUpsertRejectsEmptyAndOversizedUTMTemplates(t *testing.T) {
	tests := []struct {
		name    string
		body    map[string]string
		message string
	}{
		{name: "empty", body: map[string]string{}, message: "at least one UTM parameter is required"},
		{name: "whitespace only", body: map[string]string{"utm_source": "  "}, message: "at least one UTM parameter is required"},
	}
	for _, field := range []string{"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"} {
		tests = append(tests, struct {
			name    string
			body    map[string]string
			message string
		}{
			name: field + " oversized", body: map[string]string{field: strings.Repeat("界", maxUTMTemplateValueRunes+1)},
			message: field + " must be at most",
		})
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(test.body)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			req := utmTenantRequest(http.MethodPost, "/api/v1/utm-templates", string(body))
			rec := httptest.NewRecorder()

			(&Deps{}).UpsertDefault(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"code":"invalid_utm_template"`) ||
				!strings.Contains(rec.Body.String(), test.message) {
				t.Fatalf("body = %s, want stable code and %q", rec.Body.String(), test.message)
			}
		})
	}
}

func TestUTMTemplateValidationTrimsAndAcceptsValidBoundaries(t *testing.T) {
	body := upsertReq{
		UTMSource: strings.Repeat("界", maxUTMTemplateValueRunes),
		UTMMedium: "  email  ",
	}
	body.normalize()
	if err := validateUpsert(body); err != nil {
		t.Fatalf("valid boundary template rejected: %v", err)
	}
	if body.UTMMedium != "email" || utf8RuneCount(body.UTMSource) != maxUTMTemplateValueRunes {
		t.Fatalf("normalized body = %+v, want trimmed medium and intact Unicode boundary", body)
	}
}

func TestPreviewRejectsEmptyOversizedAndNonHTTPURLs(t *testing.T) {
	tests := []struct {
		name string
		url  string
	}{
		{name: "empty"},
		{name: "whitespace", url: "  "},
		{name: "oversized", url: "https://example.com/" + strings.Repeat("a", maxUTMPreviewURLRunes)},
		{name: "relative", url: "/campaign"},
		{name: "ftp", url: "ftp://example.com/file"},
		{name: "missing host", url: "https:///campaign"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"url": test.url})
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			req := utmTenantRequest(http.MethodPost, "/api/v1/utm-templates/preview", string(body))
			rec := httptest.NewRecorder()

			(&Deps{}).Preview(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"code":"invalid_preview_url"`) {
				t.Fatalf("body = %s, want stable invalid_preview_url code", rec.Body.String())
			}
		})
	}
}

func TestPreviewURLValidationAcceptsBoundedHTTPAndHTTPS(t *testing.T) {
	for _, raw := range []string{
		"http://localhost:8080/campaign?x=1",
		"https://example.com/" + strings.Repeat("a", maxUTMPreviewURLRunes-len("https://example.com/")),
	} {
		if err := validatePreviewURL(raw); err != nil {
			t.Fatalf("valid preview URL rejected: %v", err)
		}
	}
}

func TestScanTemplatesFailsClosedOnScanAndIterationErrors(t *testing.T) {
	scanFailure := errors.New("scan failed")
	rows := &utmTemplateRows{templates: []Template{{ID: "one"}}, scanErrAt: 0, rowErr: scanFailure}
	if out, err := scanTemplates(rows); err == nil || out != nil || !strings.Contains(err.Error(), "scan UTM template") {
		t.Fatalf("scan result = (%v, %v), want no partial data and scan error", out, err)
	}

	iterationFailure := errors.New("stream interrupted")
	rows = &utmTemplateRows{templates: []Template{{ID: "one"}}, iterationErr: iterationFailure, scanErrAt: -1}
	if out, err := scanTemplates(rows); err == nil || out != nil || !strings.Contains(err.Error(), "iterate UTM templates") {
		t.Fatalf("iteration result = (%v, %v), want no partial data and iteration error", out, err)
	}
}

func TestScanTemplatesPreservesValidRowsAndDefaultFlag(t *testing.T) {
	now := time.Now().UTC()
	rows := &utmTemplateRows{scanErrAt: -1, templates: []Template{
		{ID: "default", UTMSource: "newsletter", Enabled: true, CreatedAt: now, UpdatedAt: now},
		{ID: "campaign", CampaignID: "campaign-id", UTMMedium: "email", Enabled: true, CreatedAt: now, UpdatedAt: now},
	}}
	out, err := scanTemplates(rows)
	if err != nil {
		t.Fatalf("scan valid templates: %v", err)
	}
	if len(out) != 2 || !out[0].IsDefault || out[1].IsDefault || out[1].CampaignID != "campaign-id" {
		t.Fatalf("scanned templates = %+v", out)
	}
}

func utmTenantRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-id"}))
}

func utf8RuneCount(value string) int {
	return len([]rune(value))
}

type utmTemplateRows struct {
	templates    []Template
	index        int
	current      int
	scanErrAt    int
	rowErr       error
	iterationErr error
	closed       bool
}

func (rows *utmTemplateRows) Close() { rows.closed = true }

func (rows *utmTemplateRows) Err() error {
	if rows.closed {
		return rows.iterationErr
	}
	return nil
}

func (rows *utmTemplateRows) CommandTag() pgconn.CommandTag { return pgconn.NewCommandTag("SELECT") }

func (rows *utmTemplateRows) FieldDescriptions() []pgconn.FieldDescription { return nil }

func (rows *utmTemplateRows) Next() bool {
	if rows.index >= len(rows.templates) {
		rows.closed = true
		return false
	}
	rows.current = rows.index
	rows.index++
	return true
}

func (rows *utmTemplateRows) Scan(dest ...any) error {
	if rows.current == rows.scanErrAt {
		rows.closed = true
		return rows.rowErr
	}
	template := rows.templates[rows.current]
	*dest[0].(*string) = template.ID
	*dest[1].(*string) = template.CampaignID
	*dest[2].(*string) = template.UTMSource
	*dest[3].(*string) = template.UTMMedium
	*dest[4].(*string) = template.UTMCampaign
	*dest[5].(*string) = template.UTMTerm
	*dest[6].(*string) = template.UTMContent
	*dest[7].(*bool) = template.Enabled
	*dest[8].(*time.Time) = template.CreatedAt
	*dest[9].(*time.Time) = template.UpdatedAt
	return nil
}

func (rows *utmTemplateRows) Values() ([]any, error) { return nil, nil }

func (rows *utmTemplateRows) RawValues() [][]byte { return nil }

func (rows *utmTemplateRows) Conn() *pgx.Conn { return nil }
