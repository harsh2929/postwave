// SPDX-License-Identifier: AGPL-3.0-only
package conversions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestParseIngestInputAcceptsJSONMediaTypes(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
	}{
		{name: "exact application json", contentType: "application/json"},
		{name: "utf8 charset", contentType: "application/json; charset=utf-8"},
		{name: "quoted mixed case utf8 charset", contentType: `Application/JSON; Charset="UTF-8"`},
		{name: "registered json suffix", contentType: "application/vnd.postwave.conversion+json"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPost,
				"/api/public/track/conversion?email=query@example.com&event=query_event",
				strings.NewReader(`{"email":"body@example.com","event_name":"purchase","properties":{"plan":"pro"}}`),
			)
			req.Header.Set("Content-Type", tt.contentType)

			got, err := parseIngestInput(req)
			if err != nil {
				t.Fatalf("parseIngestInput() error = %v", err)
			}
			if got.Email != "body@example.com" {
				t.Errorf("email = %q, want body@example.com", got.Email)
			}
			if got.EventName != "purchase" {
				t.Errorf("event_name = %q, want purchase", got.EventName)
			}
			if got.Properties["plan"] != "pro" {
				t.Errorf("properties[plan] = %#v, want pro", got.Properties["plan"])
			}
		})
	}
}

func TestParseIngestInputReadsBodyIndependentOfContentLength(t *testing.T) {
	tests := []struct {
		name          string
		contentLength int64
	}{
		{name: "chunked or HTTP2 unknown length", contentLength: -1},
		{name: "zero metadata with readable stream", contentLength: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPost,
				"/api/public/track/conversion",
				io.NopCloser(strings.NewReader(`{"event_name":"purchase"}`)),
			)
			req.Header.Set("Content-Type", "application/json")
			req.ContentLength = tt.contentLength

			got, err := parseIngestInput(req)
			if err != nil {
				t.Fatalf("parseIngestInput() error = %v", err)
			}
			if got.EventName != "purchase" {
				t.Fatalf("event_name = %q, want purchase", got.EventName)
			}
		})
	}
}

func TestParseIngestInputPreservesEmptyBodyPixelContract(t *testing.T) {
	tests := []struct {
		name        string
		method      string
		body        io.Reader
		contentType string
	}{
		{name: "GET pixel with no body", method: http.MethodGet},
		{name: "POST query-only with no body", method: http.MethodPost},
		{name: "explicit empty JSON body", method: http.MethodPost, body: strings.NewReader(""), contentType: "application/json"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(
				tt.method,
				"/api/public/track/conversion?email=pixel@example.com&event=purchase&c=campaign-1",
				tt.body,
			)
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}

			got, err := parseIngestInput(req)
			if err != nil {
				t.Fatalf("parseIngestInput() error = %v", err)
			}
			if got.Email != "pixel@example.com" || got.EventName != "purchase" || got.CampaignID != "campaign-1" {
				t.Fatalf("query-only input = %#v", got)
			}
			if got.Properties == nil {
				t.Fatal("properties map is nil, want initialized empty map")
			}
		})
	}
}

func TestParseIngestInputRejectsMalformedJSON(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/track/conversion",
		strings.NewReader(`{"event_name":`),
	)
	req.Header.Set("Content-Type", "application/json")

	_, err := parseIngestInput(req)

	if err == nil {
		t.Fatal("expected malformed JSON to fail")
	}
	if errors.Is(err, httpbody.ErrTooLarge) || errors.Is(err, httpbody.ErrUnsupportedMediaType) {
		t.Fatalf("error = %v, want JSON syntax error", err)
	}
}

func TestParseIngestInputRejectsUnsupportedMediaTypes(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
	}{
		{name: "missing content type"},
		{name: "plain text", contentType: "text/plain"},
		{name: "form encoded", contentType: "application/x-www-form-urlencoded"},
		{name: "malformed media type", contentType: `application/json; charset="`},
		{name: "unsupported charset", contentType: "application/json; charset=iso-8859-1"},
		{name: "unsupported parameter", contentType: "application/json; profile=conversion"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPost,
				"/api/public/track/conversion?event=query_fallback_must_not_win",
				strings.NewReader(`{"event_name":"purchase"}`),
			)
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}

			_, err := parseIngestInput(req)

			if !errors.Is(err, httpbody.ErrUnsupportedMediaType) {
				t.Fatalf("error = %v, want ErrUnsupportedMediaType", err)
			}
		})
	}
}

func TestParseIngestInputRejectsOversizedJSON(t *testing.T) {
	body := `{"event_name":"purchase","properties":{"note":"` + strings.Repeat("x", int(conversionTrackMaxBodyBytes)) + `"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/track/conversion", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	_, err := parseIngestInput(req)

	if err == nil {
		t.Fatal("expected oversized JSON to fail")
	}
	if !errors.Is(err, httpbody.ErrTooLarge) {
		t.Fatalf("error = %v", err)
	}
}

func TestNormalizeIngestInputAcceptsBoundariesAndNegativeAdjustments(t *testing.T) {
	t.Parallel()

	minSafe := -maxJavaScriptSafeInteger
	got, err := normalizeIngestInput(IngestInput{
		EventName:   "  " + strings.Repeat("界", maxConversionEventRunes) + "  ",
		Email:       "  Buyer+refund@example.com  ",
		AmountCents: &minSafe,
		Currency:    " usd ",
		Properties:  map[string]interface{}{"reason": "refund"},
	})
	if err != nil {
		t.Fatalf("normalizeIngestInput() error = %v", err)
	}
	if got.EventName != strings.Repeat("界", maxConversionEventRunes) {
		t.Errorf("event_name was not trimmed or Unicode boundary was not preserved")
	}
	if got.Email != "Buyer+refund@example.com" {
		t.Errorf("email = %q, want trimmed exact address", got.Email)
	}
	if got.AmountCents == nil || *got.AmountCents != -maxJavaScriptSafeInteger {
		t.Errorf("amount_cents = %v, want negative JS-safe boundary", got.AmountCents)
	}
	if got.Currency != "USD" {
		t.Errorf("currency = %q, want USD", got.Currency)
	}

	maxSafe := maxJavaScriptSafeInteger
	if _, err := normalizeIngestInput(IngestInput{
		EventName:   "purchase",
		AmountCents: &maxSafe,
		Currency:    "EUR",
	}); err != nil {
		t.Fatalf("positive JS-safe boundary rejected: %v", err)
	}
}

func TestNormalizeIngestInputRejectsInvalidSemanticInputs(t *testing.T) {
	t.Parallel()

	tooLargePositive := maxJavaScriptSafeInteger + 1
	tooLargeNegative := -maxJavaScriptSafeInteger - 1
	one := int64(1)
	tests := []struct {
		name string
		in   IngestInput
		want error
	}{
		{
			name: "empty event",
			in:   IngestInput{},
			want: ErrEventName,
		},
		{
			name: "event over Unicode code point limit",
			in:   IngestInput{EventName: strings.Repeat("界", maxConversionEventRunes+1)},
			want: ErrEventName,
		},
		{
			name: "event contains control character",
			in:   IngestInput{EventName: "checkout\ncomplete"},
			want: ErrEventName,
		},
		{
			name: "event is invalid UTF-8",
			in:   IngestInput{EventName: string([]byte{'o', 'k', 0xff})},
			want: ErrEventName,
		},
		{
			name: "display-name email",
			in: IngestInput{
				EventName: "purchase",
				Email:     "Buyer <buyer@example.com>",
			},
			want: ErrInvalidEmail,
		},
		{
			name: "angle-address email",
			in: IngestInput{
				EventName: "purchase",
				Email:     "<buyer@example.com>",
			},
			want: ErrInvalidEmail,
		},
		{
			name: "address without domain",
			in: IngestInput{
				EventName: "purchase",
				Email:     "buyer",
			},
			want: ErrInvalidEmail,
		},
		{
			name: "email over byte limit",
			in: IngestInput{
				EventName: "purchase",
				Email:     strings.Repeat("a", maxConversionEmailBytes) + "@example.com",
			},
			want: ErrInvalidEmail,
		},
		{
			name: "amount without currency",
			in: IngestInput{
				EventName:   "purchase",
				AmountCents: &one,
			},
			want: ErrInvalidCurrency,
		},
		{
			name: "currency without amount",
			in: IngestInput{
				EventName: "purchase",
				Currency:  "USD",
			},
			want: ErrCurrencyWithoutAmount,
		},
		{
			name: "currency contains digit",
			in: IngestInput{
				EventName:   "purchase",
				AmountCents: &one,
				Currency:    "US1",
			},
			want: ErrInvalidCurrency,
		},
		{
			name: "currency contains non-ASCII letter",
			in: IngestInput{
				EventName:   "purchase",
				AmountCents: &one,
				Currency:    "EU€",
			},
			want: ErrInvalidCurrency,
		},
		{
			name: "amount above JavaScript-safe range",
			in: IngestInput{
				EventName:   "purchase",
				AmountCents: &tooLargePositive,
				Currency:    "USD",
			},
			want: ErrAmountOutOfRange,
		},
		{
			name: "amount below JavaScript-safe range",
			in: IngestInput{
				EventName:   "refund",
				AmountCents: &tooLargeNegative,
				Currency:    "USD",
			},
			want: ErrAmountOutOfRange,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if _, err := normalizeIngestInput(tt.in); !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestNormalizePublicIngestInputCoversQueryAndJSONVariants(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		method       string
		target       string
		body         string
		contentType  string
		wantEvent    string
		wantEmail    string
		wantCurrency string
		wantAmount   int64
		wantErr      error
	}{
		{
			name:      "query values are trimmed",
			method:    http.MethodGet,
			target:    "/api/public/track/conversion?event=%20purchase.completed%20&email=%20buyer%40example.com%20",
			wantEvent: "purchase.completed",
			wantEmail: "buyer@example.com",
		},
		{
			name:      "missing query event gets public default",
			method:    http.MethodGet,
			target:    "/api/public/track/conversion?event=%20%20%20",
			wantEvent: "conversion",
		},
		{
			name:         "JSON values normalize and allow refund",
			method:       http.MethodPost,
			target:       "/api/public/track/conversion",
			body:         `{"event_name":" refund.processed ","email":" buyer@example.com ","amount_cents":-2500,"currency":" usd "}`,
			contentType:  "application/json",
			wantEvent:    "refund.processed",
			wantEmail:    "buyer@example.com",
			wantCurrency: "USD",
			wantAmount:   -2500,
		},
		{
			name:        "query display-name email is rejected",
			method:      http.MethodGet,
			target:      "/api/public/track/conversion?event=purchase&email=Buyer%20%3Cbuyer%40example.com%3E",
			wantErr:     ErrInvalidEmail,
			wantEvent:   "",
			wantEmail:   "",
			wantAmount:  0,
			contentType: "",
		},
		{
			name:        "JSON control character event is rejected",
			method:      http.MethodPost,
			target:      "/api/public/track/conversion",
			body:        `{"event_name":"purchase\u0000complete"}`,
			contentType: "application/json",
			wantErr:     ErrEventName,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var body io.Reader
			if tt.body != "" {
				body = strings.NewReader(tt.body)
			}
			req := httptest.NewRequest(tt.method, tt.target, body)
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}
			in, err := parseIngestInput(req)
			if err == nil {
				in, err = normalizePublicIngestInput(in)
			}
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse + normalize error = %v", err)
			}
			if in.EventName != tt.wantEvent || in.Email != tt.wantEmail || in.Currency != tt.wantCurrency {
				t.Fatalf("normalized input = %#v", in)
			}
			if tt.wantCurrency != "" && (in.AmountCents == nil || *in.AmountCents != tt.wantAmount) {
				t.Fatalf("amount_cents = %v, want %d", in.AmountCents, tt.wantAmount)
			}
		})
	}
}

func TestNormalizeTrackingKeyLabel(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		label     string
		wantLabel string
		wantErr   bool
	}{
		{name: "omitted defaults explicitly", wantLabel: "web"},
		{name: "whitespace defaults explicitly", label: "  ", wantLabel: "web"},
		{name: "trimmed", label: "  checkout backend  ", wantLabel: "checkout backend"},
		{
			name:      "Unicode code point boundary",
			label:     strings.Repeat("界", maxTrackingKeyLabelRunes),
			wantLabel: strings.Repeat("界", maxTrackingKeyLabelRunes),
		},
		{name: "over code point limit", label: strings.Repeat("界", maxTrackingKeyLabelRunes+1), wantErr: true},
		{name: "internal control", label: "checkout\tbackend", wantErr: true},
		{name: "invalid UTF-8", label: string([]byte{'k', 0xff}), wantErr: true},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeTrackingKeyLabel(tt.label)
			if tt.wantErr {
				if !errors.Is(err, ErrTrackingKeyLabel) {
					t.Fatalf("error = %v, want ErrTrackingKeyLabel", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeTrackingKeyLabel() error = %v", err)
			}
			if got != tt.wantLabel {
				t.Fatalf("label = %q, want %q", got, tt.wantLabel)
			}
		})
	}
}

func TestPublicTrackMissingKeyReturnsJSONForXHR(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/public/track/conversion", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	(&Deps{}).PublicTrack(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("content-type = %q, want application/json", got)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "unauthorized" {
		t.Fatalf("error code = %q, want unauthorized", body.Error.Code)
	}
}

func TestPublicTrackMissingKeyPreservesPixelResponse(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/public/track/conversion", nil)
	req.Header.Set("Accept", "image/gif")

	(&Deps{}).PublicTrack(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/gif" {
		t.Fatalf("content-type = %q, want image/gif", got)
	}
	if rec.Body.Len() != len(transparentPixel) {
		t.Fatalf("pixel bytes = %d, want %d", rec.Body.Len(), len(transparentPixel))
	}
}

func TestPublicTrackBodyErrorsUseStableSafeJSON(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		err         error
		wantStatus  int
		wantCode    string
		wantMessage string
	}{
		{
			name:        "malformed JSON hides parser detail",
			err:         errors.New(`bad JSON: invalid character 's' looking for beginning of value: secret-canary`),
			wantStatus:  http.StatusBadRequest,
			wantCode:    "bad_json",
			wantMessage: "Request body is not valid JSON.",
		},
		{
			name:        "body cap",
			err:         httpbody.ErrTooLarge,
			wantStatus:  http.StatusRequestEntityTooLarge,
			wantCode:    "payload_too_large",
			wantMessage: "Request body exceeds the permitted size.",
		},
		{
			name:        "media type",
			err:         httpbody.ErrUnsupportedMediaType,
			wantStatus:  http.StatusUnsupportedMediaType,
			wantCode:    "unsupported_media_type",
			wantMessage: "Content-Type must be application/json.",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/public/track/conversion", nil)
			req.Header.Set("Accept", "application/json")

			writePublicTrackBodyError(rec, req, tt.err)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			rawBody := rec.Body.String()
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.NewDecoder(strings.NewReader(rawBody)).Decode(&body); err != nil {
				t.Fatalf("decode error envelope: %v", err)
			}
			if body.Error.Code != tt.wantCode || body.Error.Message != tt.wantMessage {
				t.Fatalf("error envelope = %#v", body.Error)
			}
			if strings.Contains(rawBody, "secret-canary") {
				t.Fatal("parser detail leaked into response")
			}
		})
	}
}

func TestPublicTrackValidationErrorPreservesPixelContract(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/public/track/conversion", nil)
	req.Header.Set("Accept", "image/gif")

	writePublicTrackError(
		rec,
		req,
		http.StatusUnprocessableEntity,
		"conversion_rejected",
		ErrInvalidEmail.Error(),
	)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/gif" {
		t.Fatalf("content-type = %q, want image/gif", got)
	}
	if !reflect.DeepEqual(rec.Body.Bytes(), transparentPixel) {
		t.Fatal("validation pixel body differs from canonical transparent GIF")
	}
}

func TestAdminCreateKeyRejectsInvalidLabelBeforeDatabaseWork(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/conversions/keys",
		strings.NewReader(`{"label":"checkout\u0000backend"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})

	(&Deps{Repo: &Repo{Pool: &db.Pool{}}}).AdminCreateKey(rec, req.WithContext(ctx))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if body.Error.Code != "invalid_label" || body.Error.Message != ErrTrackingKeyLabel.Error() {
		t.Fatalf("error envelope = %#v", body.Error)
	}
}

func TestParseConversionCursor(t *testing.T) {
	t.Parallel()

	const timestamp = "2026-07-24T10:20:30.123456Z"
	tests := []struct {
		name        string
		values      url.Values
		wantTime    string
		wantID      int64
		wantInvalid bool
	}{
		{name: "first page", values: url.Values{}},
		{
			name:     "composite cursor",
			values:   url.Values{"before": {timestamp}, "before_id": {"123"}},
			wantTime: timestamp,
			wantID:   123,
		},
		{
			name:     "legacy timestamp cursor",
			values:   url.Values{"before": {timestamp}},
			wantTime: timestamp,
		},
		{name: "malformed timestamp", values: url.Values{"before": {"yesterday"}}, wantInvalid: true},
		{name: "empty timestamp", values: url.Values{"before": {""}}, wantInvalid: true},
		{name: "id without timestamp", values: url.Values{"before_id": {"1"}}, wantInvalid: true},
		{name: "empty id", values: url.Values{"before": {timestamp}, "before_id": {""}}, wantInvalid: true},
		{name: "zero id", values: url.Values{"before": {timestamp}, "before_id": {"0"}}, wantInvalid: true},
		{name: "negative id", values: url.Values{"before": {timestamp}, "before_id": {"-1"}}, wantInvalid: true},
		{name: "non numeric id", values: url.Values{"before": {timestamp}, "before_id": {"abc"}}, wantInvalid: true},
		{name: "duplicate timestamp", values: url.Values{"before": {timestamp, timestamp}}, wantInvalid: true},
		{name: "duplicate id", values: url.Values{"before": {timestamp}, "before_id": {"1", "2"}}, wantInvalid: true},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			gotTime, gotID, err := parseConversionCursor(tt.values)
			if tt.wantInvalid {
				if !errors.Is(err, ErrInvalidCursor) {
					t.Fatalf("error = %v, want ErrInvalidCursor", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseConversionCursor() error = %v", err)
			}
			if gotID != tt.wantID {
				t.Errorf("before_id = %d, want %d", gotID, tt.wantID)
			}
			if tt.wantTime == "" {
				if !gotTime.IsZero() {
					t.Errorf("before = %s, want zero", gotTime)
				}
				return
			}
			wantTime, err := time.Parse(time.RFC3339Nano, tt.wantTime)
			if err != nil {
				t.Fatalf("test timestamp: %v", err)
			}
			if !gotTime.Equal(wantTime) {
				t.Errorf("before = %s, want %s", gotTime, wantTime)
			}
		})
	}
}

func TestAdminListRejectsMalformedCursorBeforeDatabaseWork(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/conversions?before=not-rfc3339&before_id=1",
		nil,
	)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})

	(&Deps{Repo: &Repo{Pool: &db.Pool{}}}).AdminList(rec, req.WithContext(ctx))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if body.Error.Code != "invalid_cursor" {
		t.Fatalf("error code = %q, want invalid_cursor", body.Error.Code)
	}
}

type savepointTestExecutor struct {
	statements []string
	aborted    bool
	failOn     string
}

func (e *savepointTestExecutor) Exec(
	_ context.Context,
	statement string,
	_ ...any,
) (pgconn.CommandTag, error) {
	e.statements = append(e.statements, statement)
	if statement == e.failOn {
		return pgconn.CommandTag{}, errors.New("forced savepoint failure")
	}
	switch {
	case strings.HasPrefix(statement, "ROLLBACK TO SAVEPOINT "):
		e.aborted = false
		return pgconn.CommandTag{}, nil
	case e.aborted:
		return pgconn.CommandTag{}, errors.New("current transaction is aborted")
	default:
		return pgconn.CommandTag{}, nil
	}
}

func TestRunBestEffortInSavepointRestoresAbortedTransaction(t *testing.T) {
	t.Parallel()

	executor := &savepointTestExecutor{}
	wantOperationErr := errors.New("mirror statement failed")
	operationErr, savepointErr := runBestEffortInSavepoint(
		context.Background(),
		executor,
		reportMirrorSavepoint,
		func() error {
			// PostgreSQL enters this state after any failed statement.
			executor.aborted = true
			return wantOperationErr
		},
	)

	if !errors.Is(operationErr, wantOperationErr) {
		t.Fatalf("operation error = %v, want %v", operationErr, wantOperationErr)
	}
	if savepointErr != nil {
		t.Fatalf("savepoint error = %v", savepointErr)
	}
	wantStatements := []string{
		"SAVEPOINT " + reportMirrorSavepoint,
		"ROLLBACK TO SAVEPOINT " + reportMirrorSavepoint,
		"RELEASE SAVEPOINT " + reportMirrorSavepoint,
	}
	if !reflect.DeepEqual(executor.statements, wantStatements) {
		t.Fatalf("statements = %#v, want %#v", executor.statements, wantStatements)
	}
	if _, err := executor.Exec(context.Background(), "SELECT 1"); err != nil {
		t.Fatalf("transaction remained aborted after savepoint recovery: %v", err)
	}
}

func TestRunBestEffortInSavepointFailsClosedWhenRollbackFails(t *testing.T) {
	t.Parallel()

	executor := &savepointTestExecutor{
		failOn: "ROLLBACK TO SAVEPOINT " + attributionLookupSavepoint,
	}
	operationErr, savepointErr := runBestEffortInSavepoint(
		context.Background(),
		executor,
		attributionLookupSavepoint,
		func() error {
			executor.aborted = true
			return errors.New("lookup statement failed")
		},
	)

	if operationErr == nil {
		t.Fatal("operation error = nil, want lookup failure")
	}
	if savepointErr == nil || !strings.Contains(savepointErr.Error(), "rollback") {
		t.Fatalf("savepoint error = %v, want explicit rollback failure", savepointErr)
	}
}
