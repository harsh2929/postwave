package views

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	testIncidentID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b1"
	testIntentKey  = "018f4f4c-53de-7c12-ae4d-fbbac8f735b2"
)

// withURLParam attaches a chi {id} route param to a request.
func withURLParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

type fakeIncidents struct {
	list           []IncidentRow
	listErr        error
	openID         string
	openReplay     bool
	openErr        error
	appendReplay   bool
	appendErr      error
	openCalls      int
	appendCalls    int
	gotTitle       string
	gotSeverity    string
	gotBody        string
	gotActor       string
	gotStatus      string
	gotIncidentID  string
	gotIdempotency string
}

func (f *fakeIncidents) ListIncidents(_ context.Context, _ bool, _ int) ([]IncidentRow, error) {
	return f.list, f.listErr
}
func (f *fakeIncidents) OpenIncident(_ context.Context, title, severity, body, actor, key string) (string, bool, error) {
	f.openCalls++
	f.gotTitle, f.gotSeverity, f.gotBody, f.gotActor, f.gotIdempotency = title, severity, body, actor, key
	return f.openID, f.openReplay, f.openErr
}
func (f *fakeIncidents) AppendUpdate(_ context.Context, incidentID, body, newStatus, actor, key string) (bool, error) {
	f.appendCalls++
	f.gotIncidentID, f.gotBody, f.gotStatus, f.gotActor, f.gotIdempotency = incidentID, body, newStatus, actor, key
	return f.appendReplay, f.appendErr
}

func noopAudit(_ context.Context, _ string, _ map[string]any) error { return nil }
func fixedOperator(_ context.Context) string                        { return "op@postwave.test" }

func incidentRequest(method, target, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestIncidentsHandler_FailLoudAndDisclosesCap(t *testing.T) {
	bad := IncidentsHandler(&fakeIncidents{listErr: context.DeadlineExceeded})
	w := httptest.NewRecorder()
	bad(w, httptest.NewRequest(http.MethodGet, "/views/incidents", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("failed list must be 500, got %d", w.Code)
	}
	assertViewHeaders(t, w)

	rows := make([]IncidentRow, 2)
	ok := IncidentsHandler(&fakeIncidents{list: rows})
	w = httptest.NewRecorder()
	ok(w, httptest.NewRequest(http.MethodGet, "/views/incidents?limit=2", nil))
	if !strings.Contains(w.Body.String(), `"truncated":true`) {
		t.Fatalf("cap must be disclosed: %s", w.Body.String())
	}
}

func TestOpenIncidentHandler_StrictValidationAndReplay(t *testing.T) {
	valid := `{"title":" t ","severity":"sev2","body":" x ","idempotency_key":"` + testIntentKey + `"}`
	tests := []struct {
		name        string
		body        string
		contentType string
		want        int
	}{
		{name: "missing content type", body: valid, want: http.StatusUnsupportedMediaType},
		{name: "unknown field", body: `{"title":"t","severity":"sev2","body":"x","idempotency_key":"` + testIntentKey + `","extra":1}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "trailing value", body: valid + `{}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "missing title", body: `{"severity":"sev1","body":"x","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "control in title", body: `{"title":"bad\ntitle","severity":"sev1","body":"x","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "bad severity", body: `{"title":"t","severity":"boom","body":"x","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "severity is exact", body: `{"title":"t","severity":" sev2 ","body":"x","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "bad key", body: `{"title":"t","severity":"sev2","body":"x","idempotency_key":"not-a-uuid"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "key is canonical", body: `{"title":"t","severity":"sev2","body":"x","idempotency_key":" ` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "disallowed body control", body: `{"title":"t","severity":"sev2","body":"x\u0000y","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "invalid UTF-8", body: `{"title":"t","severity":"sev2","body":"` + string([]byte{0xff}) + `","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusBadRequest},
		{name: "oversized body", body: `{"title":"t","severity":"sev2","body":"` + strings.Repeat("x", 21<<10) + `","idempotency_key":"` + testIntentKey + `"}`, contentType: "application/json", want: http.StatusRequestEntityTooLarge},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeIncidents{openID: testIncidentID}
			h := OpenIncidentHandler(store, noopAudit, fixedOperator)
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/views/incidents", strings.NewReader(tc.body))
			if tc.contentType != "" {
				r.Header.Set("Content-Type", tc.contentType)
			}
			h(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
			if store.openCalls != 0 {
				t.Fatal("invalid request reached store")
			}
			assertViewHeaders(t, w)
		})
	}

	store := &fakeIncidents{openID: testIncidentID, openReplay: true}
	h := OpenIncidentHandler(store, noopAudit, fixedOperator)
	w := httptest.NewRecorder()
	h(w, incidentRequest(http.MethodPost, "/views/incidents", valid))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatalf("replay response=%d %s", w.Code, w.Body.String())
	}
	if store.gotTitle != "t" || store.gotBody != "x" || store.gotIdempotency != testIntentKey {
		t.Fatalf("normalization/idempotency not propagated: %+v", store)
	}
}

func TestIncidentHandlers_FailClosedWithoutOperatorOrAudit(t *testing.T) {
	valid := `{"title":"t","severity":"sev2","body":"x","idempotency_key":"` + testIntentKey + `"}`
	store := &fakeIncidents{openID: testIncidentID}
	h := OpenIncidentHandler(store, noopAudit, func(context.Context) string { return " " })
	w := httptest.NewRecorder()
	h(w, incidentRequest(http.MethodPost, "/views/incidents", valid))
	if w.Code != http.StatusInternalServerError || store.openCalls != 0 {
		t.Fatalf("missing operator must fail before store: %d calls=%d", w.Code, store.openCalls)
	}

	h = OpenIncidentHandler(store, func(context.Context, string, map[string]any) error {
		return errors.New("audit down")
	}, fixedOperator)
	w = httptest.NewRecorder()
	h(w, incidentRequest(http.MethodPost, "/views/incidents", valid))
	if w.Code != http.StatusServiceUnavailable || store.openCalls != 0 {
		t.Fatalf("audit failure must fail before store: %d calls=%d", w.Code, store.openCalls)
	}
}

func TestAppendUpdateHandler_ValidatesUUIDAndMapsConflicts(t *testing.T) {
	valid := `{"body":" watching\nnext ","status":"monitoring","idempotency_key":"` + testIntentKey + `"}`
	store := &fakeIncidents{appendReplay: true}
	h := AppendUpdateHandler(store, noopAudit, fixedOperator)

	w := httptest.NewRecorder()
	h(w, withURLParam(incidentRequest(http.MethodPost, "/views/incidents/nope/updates", valid), "id", "nope"))
	if w.Code != http.StatusBadRequest || store.appendCalls != 0 {
		t.Fatalf("invalid UUID status=%d calls=%d", w.Code, store.appendCalls)
	}

	w = httptest.NewRecorder()
	h(w, withURLParam(incidentRequest(http.MethodPost, "/views/incidents/x/updates", valid), "id", testIncidentID))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatalf("valid replay=%d %s", w.Code, w.Body.String())
	}
	if store.gotIncidentID != testIncidentID || store.gotBody != "watching\nnext" || store.gotStatus != "monitoring" {
		t.Fatalf("wrong store args: %+v", store)
	}

	w = httptest.NewRecorder()
	h(w, withURLParam(incidentRequest(http.MethodPost, "/views/incidents/x/updates", valid), "id", " "+testIncidentID))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("non-canonical incident UUID status=%d body=%s", w.Code, w.Body.String())
	}

	for _, tc := range []struct {
		err  error
		want int
	}{
		{ErrIncidentIdempotencyConflict, http.StatusConflict},
		{ErrIncidentResolved, http.StatusConflict},
		{ErrIncidentTimelineFull, http.StatusConflict},
		{context.DeadlineExceeded, http.StatusInternalServerError},
	} {
		store := &fakeIncidents{appendErr: tc.err}
		w := httptest.NewRecorder()
		AppendUpdateHandler(store, noopAudit, fixedOperator)(w,
			withURLParam(incidentRequest(http.MethodPost, "/views/incidents/x/updates", valid), "id", testIncidentID))
		if w.Code != tc.want {
			t.Fatalf("err=%v status=%d want=%d body=%s", tc.err, w.Code, tc.want, w.Body.String())
		}
	}
}

func TestIncidentTimelineHandler_RejectsMalformedUUID(t *testing.T) {
	w := httptest.NewRecorder()
	IncidentTimelineHandler(&fakeTimeline{})(w,
		withURLParam(httptest.NewRequest(http.MethodGet, "/views/incidents/nope", nil), "id", "nope"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestIncidentTimelineHandler_StrictCursorAndMissingCursorBehavior(t *testing.T) {
	for _, target := range []string{
		"/views/incidents/" + testIncidentID + "?before=nope",
		"/views/incidents/" + testIncidentID + "?before=" + testIntentKey + "&before=" + testIntentKey,
		"/views/incidents/" + testIncidentID + "?cursor=" + testIntentKey,
	} {
		fake := &fakeTimeline{}
		w := httptest.NewRecorder()
		IncidentTimelineHandler(fake)(w,
			withURLParam(httptest.NewRequest(http.MethodGet, target, nil), "id", testIncidentID))
		if w.Code != http.StatusBadRequest || fake.calls != 0 {
			t.Fatalf("target=%q status=%d calls=%d body=%s", target, w.Code, fake.calls, w.Body.String())
		}
	}

	fake := &fakeTimeline{err: ErrIncidentCursorNotFound}
	w := httptest.NewRecorder()
	IncidentTimelineHandler(fake)(w,
		withURLParam(httptest.NewRequest(http.MethodGet,
			"/views/incidents/"+testIncidentID+"?before="+testIntentKey, nil), "id", testIncidentID))
	if w.Code != http.StatusNotFound || fake.before != testIntentKey {
		t.Fatalf("missing cursor status=%d before=%q body=%s", w.Code, fake.before, w.Body.String())
	}
}

func TestIncidentTimelineHandler_BoundsEncodedResponseAndKeepsNewest(t *testing.T) {
	updates := make([]IncidentUpdate, 100)
	for i := range updates {
		updates[i] = IncidentUpdate{
			ID:        fmt.Sprintf("update-%03d", i),
			Body:      strings.Repeat("<", 4096),
			Author:    "op@postwave.test",
			CreatedAt: time.Unix(int64(i), 0).UTC(),
		}
	}
	detail := &IncidentDetail{
		IncidentRow: IncidentRow{
			ID:        testIncidentID,
			Title:     "bounded response",
			Severity:  "sev2",
			Status:    "open",
			OpenedBy:  "op@postwave.test",
			OpenedAt:  time.Unix(0, 0).UTC(),
			UpdatedAt: time.Unix(99, 0).UTC(),
		},
		Updates: updates,
	}
	w := httptest.NewRecorder()
	IncidentTimelineHandler(&fakeTimeline{detail: detail})(w,
		withURLParam(httptest.NewRequest(http.MethodGet, "/views/incidents/"+testIncidentID, nil), "id", testIncidentID))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if w.Body.Len() > maxIncidentTimelineResponseBytes {
		t.Fatalf("encoded response=%d ceiling=%d", w.Body.Len(), maxIncidentTimelineResponseBytes)
	}
	var got IncidentDetail
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !got.UpdatesTruncated || len(got.Updates) == 0 || len(got.Updates) >= len(updates) {
		t.Fatalf("expected a non-empty truncated suffix, got len=%d truncated=%v", len(got.Updates), got.UpdatesTruncated)
	}
	if got.NextBefore != got.Updates[0].ID {
		t.Fatalf("next cursor=%q, want oldest retained update %q", got.NextBefore, got.Updates[0].ID)
	}
	if got.Updates[len(got.Updates)-1].ID != "update-099" {
		t.Fatalf("newest update was not retained: last=%q", got.Updates[len(got.Updates)-1].ID)
	}
	for i := 1; i < len(got.Updates); i++ {
		if got.Updates[i-1].CreatedAt.After(got.Updates[i].CreatedAt) {
			t.Fatal("retained suffix is not chronological")
		}
	}
}

type fakeTimeline struct {
	detail *IncidentDetail
	err    error
	before string
	calls  int
}

func (f *fakeTimeline) IncidentTimeline(_ context.Context, _, before string) (*IncidentDetail, error) {
	f.calls++
	f.before = before
	return f.detail, f.err
}

func assertViewHeaders(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options=%q", got)
	}
}
