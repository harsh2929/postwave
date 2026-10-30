package admin

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// fakeExporter satisfies SpamCorpusExporter without touching the real
// deliverability extractor.
type fakeExporter struct {
	samples []Sample
	err     error
	// captured records the args the handler passed through so tests
	// can assert since / limit propagation.
	captured struct {
		since time.Time
		limit int
	}
}

func (f *fakeExporter) Export(_ context.Context, since time.Time, limit int) ([]Sample, error) {
	f.captured.since = since
	f.captured.limit = limit
	if f.err != nil {
		return nil, f.err
	}
	return f.samples, nil
}

func mountTestRouter(d *SpamCorpusDeps) chi.Router {
	r := chi.NewRouter()
	d.MountRoutes(r)
	return r
}

func TestSpamCorpus_AuthRequired(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export", strings.NewReader(""))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestSpamCorpus_AuthWrongToken(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export", strings.NewReader(""))
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestSpamCorpus_AuthMissingExporter(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         nil,
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export", strings.NewReader(""))
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d", rec.Code)
	}
}

func TestSpamCorpus_MalformedBody(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export", strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestSpamCorpus_OversizedBody(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"format":"json","since":"`+strings.Repeat("x", int(spamCorpusExportJSONMaxBodyBytes))+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %q, want payload_too_large", rec.Body.String())
	}
}

func TestSpamCorpus_TrailingJSONValue(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"format":"json"} {"format":"csv"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "exactly one JSON value") {
		t.Fatalf("body = %q, want exactly one JSON value", rec.Body.String())
	}
}

func TestSpamCorpus_BadSince(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"since":"yesterday"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestSpamCorpus_BadFormat(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)

	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"format":"xml"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestSpamCorpus_HappyCSV(t *testing.T) {
	fake := &fakeExporter{samples: []Sample{
		{Text: "BUY NOW", IsSpam: true, Source: "seedlist", SampleAt: time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)},
		{Text: "Hi friend", IsSpam: false, Source: "seedlist", SampleAt: time.Date(2026, 4, 2, 12, 0, 0, 0, time.UTC)},
	}}
	d := &SpamCorpusDeps{
		Exporter:         fake,
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)
	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"since":"2026-04-01"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/csv") {
		t.Fatalf("expected csv content-type, got %q", ct)
	}
	c := csv.NewReader(bytes.NewReader(rec.Body.Bytes()))
	records, err := c.ReadAll()
	if err != nil {
		t.Fatalf("csv parse: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("expected 3 csv records, got %d", len(records))
	}
	if records[0][0] != "text" || records[0][1] != "label" {
		t.Fatalf("unexpected header: %v", records[0])
	}
	wantSince := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	if !fake.captured.since.Equal(wantSince) {
		t.Fatalf("since not propagated: got %s want %s", fake.captured.since, wantSince)
	}
	if records[1][1] != "spam" {
		t.Fatalf("expected first row label=spam, got %q", records[1][1])
	}
	if records[2][1] != "ham" {
		t.Fatalf("expected second row label=ham, got %q", records[2][1])
	}
}

func TestSpamCorpus_HappyJSON(t *testing.T) {
	at := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	fake := &fakeExporter{samples: []Sample{
		{Text: "spam-1", IsSpam: true, Source: "seedlist", SampleAt: at},
	}}
	d := &SpamCorpusDeps{
		Exporter:         fake,
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)
	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"since":"2026-04-01","format":"json"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%q", rec.Code, rec.Body.String())
	}
	var got []Sample
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Text != "spam-1" {
		t.Fatalf("unexpected json body: %+v", got)
	}
}

func TestSpamCorpus_LimitTrims(t *testing.T) {
	fake := &fakeExporter{samples: []Sample{
		{Text: "a", Source: "s"}, {Text: "b", Source: "s"}, {Text: "c", Source: "s"},
	}}
	d := &SpamCorpusDeps{
		Exporter:         fake,
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)
	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"limit":2,"format":"json","since":"2026-04-01"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var got []Sample
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if len(got) != 2 {
		t.Fatalf("want 2 rows, got %d", len(got))
	}
	if fake.captured.limit != 2 {
		t.Fatalf("limit not propagated: got %d", fake.captured.limit)
	}
}

func TestSpamCorpus_ExporterError(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:         &fakeExporter{err: errors.New("boom")},
		InternalAPIToken: "secret",
	}
	r := mountTestRouter(d)
	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"since":"2026-04-01"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", rec.Code)
	}
}

func TestSpamCorpus_EmptyBodyUsesDefaults(t *testing.T) {
	fake := &fakeExporter{}
	d := &SpamCorpusDeps{
		Exporter:         fake,
		InternalAPIToken: "secret",
		DefaultSince:     7 * 24 * time.Hour,
	}
	r := mountTestRouter(d)
	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%q", rec.Code, rec.Body.String())
	}
	target := time.Now().UTC().Add(-7 * 24 * time.Hour)
	delta := fake.captured.since.Sub(target)
	if delta < -2*time.Minute || delta > 2*time.Minute {
		t.Fatalf("default since not applied; got %s (target %s)", fake.captured.since, target)
	}
}

func TestSpamCorpus_AllowDevTokenBypasses(t *testing.T) {
	d := &SpamCorpusDeps{
		Exporter:      &fakeExporter{},
		AllowDevToken: true,
	}
	r := mountTestRouter(d)
	req := httptest.NewRequest("POST", "/api/internal/admin/spam-corpus/export",
		strings.NewReader(`{"since":"2026-04-01"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 with AllowDevToken, got %d", rec.Code)
	}
}

func TestCSVCellEscapesSpreadsheetFormulaCells(t *testing.T) {
	for _, in := range []string{"=cmd|evil", "+SUM(1,2)", "-1", "@vip"} {
		got := csvCell(in)
		if !strings.HasPrefix(got, "'") {
			t.Fatalf("csvCell(%q) = %q, want leading apostrophe", in, got)
		}
	}
	if got := csvCell("normal"); got != "normal" {
		t.Fatalf("csvCell normal = %q", got)
	}
}
