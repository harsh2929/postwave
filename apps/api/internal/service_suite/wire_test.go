// SPDX-License-Identifier: AGPL-3.0-only

package service_suite

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestHelpdeskJSONNumberMatchesExactPostgresBounds(t *testing.T) {
	for _, value := range []string{"0", "-0", "1", "0.1", "4.9406564584124654e-324", "9007199254740991"} {
		if !validHelpdeskJSONNumber(json.Number(value)) {
			t.Errorf("valid number %q rejected", value)
		}
	}
	for _, value := range []string{"1e-400", "-1e-400", "1e309", "9007199254740991.1", "-9007199254740991.1"} {
		if validHelpdeskJSONNumber(json.Number(value)) {
			t.Errorf("out-of-contract number %q accepted", value)
		}
	}
}

func TestHelpdeskDecoderPreservesDecimalsBeforeProjectionValidation(t *testing.T) {
	for _, number := range []string{"1e-400", "9007199254740991.1"} {
		t.Run(number, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/api/v1/service-suite/tickets/00000000-0000-0000-0000-000000000001", strings.NewReader(`{"metadata":{"number":`+number+`}}`))
			req.Header.Set("Content-Type", "application/json")
			var patch TicketPatch
			response := httptest.NewRecorder()
			if err := decodeHelpdeskJSON(response, req, 1<<20, &patch); err != nil {
				t.Fatalf("decode exact decimal: %v", err)
			}
			got, ok := patch.Metadata.Value["number"].(json.Number)
			if !ok || got.String() != number {
				t.Fatalf("decoded number = %#v, want json.Number(%q)", patch.Metadata.Value["number"], number)
			}
			if validHelpdeskJSON(patch.Metadata.Value, helpdeskMetadataMaxBytes, 8, 512) {
				t.Fatalf("out-of-contract exact decimal %q passed projection validation", number)
			}
		})
	}
}

func TestAbsentHubConfigOmitsOutOfRangeTimestamps(t *testing.T) {
	payload, err := json.Marshal(defaultHubConfig("00000000-0000-0000-0000-000000000001"))
	if err != nil {
		t.Fatal(err)
	}
	wire := string(payload)
	for _, forbidden := range []string{`"created_at"`, `"updated_at"`, "0001-01-01"} {
		if strings.Contains(wire, forbidden) {
			t.Fatalf("absent config leaked %q: %s", forbidden, wire)
		}
	}
	for _, required := range []string{`"version":"absent"`, `"storefronts":[]`, `"content_blocks":[]`, `"personalization_rules":{}`, `"support_settings":{}`} {
		if !strings.Contains(wire, required) {
			t.Fatalf("absent config missing %q: %s", required, wire)
		}
	}
}

func TestCatalogV2HandlerMatchesExactWireContract(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Deps{}).Catalog(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/service-suite/catalog", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("catalog status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve service-suite test source path")
	}
	fixturePath := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../apps/web/src/__tests__/fixtures/api/service-suite_catalog.json",
	))
	expected, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read shared service-suite catalog fixture: %v", err)
	}
	var got, want any
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode catalog response: %v", err)
	}
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatalf("decode catalog contract fixture: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.MarshalIndent(got, "", "  ")
		wantJSON, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("catalog wire drifted from exact v2 contract\ngot: %s\nwant: %s", gotJSON, wantJSON)
	}
}

func TestHelpdeskPagedReadsRejectNonExactPaginationBeforeRepositoryAccess(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	conversationID := "20000000-0000-4000-8000-000000000041"
	deps := &Deps{CursorKey: []byte("route41-helpdesk-cursor-key-32-bytes-minimum")}
	router := chi.NewRouter()
	router.Get("/api/v1/service-suite/channels", deps.ListChannels)
	router.Get("/api/v1/service-suite/conversations", deps.ListConversations)
	router.Get("/api/v1/service-suite/conversations/{id}/messages", deps.ListMessages)
	router.Get("/api/v1/service-suite/tickets", deps.ListTickets)
	router.Get("/api/v1/service-suite/views", deps.ListViews)
	router.Get("/api/v1/service-suite/macros", deps.ListMacros)

	paths := []string{
		"/api/v1/service-suite/channels",
		"/api/v1/service-suite/conversations",
		"/api/v1/service-suite/conversations/" + conversationID + "/messages",
		"/api/v1/service-suite/tickets",
		"/api/v1/service-suite/views",
		"/api/v1/service-suite/macros",
	}
	queries := []struct {
		rawQuery string
		code     string
	}{
		{"cursor=%ZZ", "query_invalid"},
		{"limit=%ZZ", "query_invalid"},
		{"cursor=x;y=z", "query_invalid"},
		{"limit=50;x=y", "query_invalid"},
		{"cursor=", "cursor_invalid"},
		{"limit=", "limit_invalid"},
		{"limit=%2B50", "limit_invalid"},
		{"limit=+50", "limit_invalid"},
		{"limit=%2050%20", "limit_invalid"},
		{"limit=01", "limit_invalid"},
		{"limit=1.0", "limit_invalid"},
	}

	for _, path := range paths {
		for _, query := range queries {
			name := strings.TrimPrefix(path, "/api/v1/service-suite/") + "?" + query.rawQuery
			t.Run(name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				req.URL.RawQuery = query.rawQuery
				ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, req.WithContext(ctx))
				if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"`+query.code+`"`) {
					t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
				}
			})
		}
	}
}

func TestHelpdeskReportRejectsMalformedRawQueryBeforeRepositoryAccess(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	deps := &Deps{}
	for _, rawQuery := range []string{"since_days=%ZZ", "since_days=30;x=y"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/service-suite/report", nil)
		req.URL.RawQuery = rawQuery
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		recorder := httptest.NewRecorder()
		deps.SupportReport(recorder, req.WithContext(ctx))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"query_invalid"`) {
			t.Fatalf("query %q status=%d body=%s", rawQuery, recorder.Code, recorder.Body.String())
		}
	}
}

func TestHelpdeskPaginationQueryOmissionAndExactLimits(t *testing.T) {
	for _, tc := range []struct {
		rawQuery string
		want     int
	}{
		{"", 50},
		{"limit=1", 1},
		{"limit=100", 100},
	} {
		req := httptest.NewRequest(http.MethodGet, "/?"+tc.rawQuery, nil)
		got, err := parseListLimit(req.URL.Query())
		if err != nil || got != tc.want {
			t.Fatalf("query %q limit=%d err=%v want=%d", tc.rawQuery, got, err, tc.want)
		}
	}
	for _, rawQuery := range []string{"", "limit=50"} {
		req := httptest.NewRequest(http.MethodGet, "/?"+rawQuery, nil)
		cursor, err := listCursorQueryValue(req.URL.Query())
		if err != nil || cursor != "" {
			t.Fatalf("query %q cursor=%q err=%v, want omitted", rawQuery, cursor, err)
		}
	}
}

type failIfRead struct{ reads int }

func (r *failIfRead) Read([]byte) (int, error) {
	r.reads++
	return 0, errors.New("request body must not be read across a source hold")
}

type seededReplayStore struct {
	record *idempotency.Record
	gets   int
	claims int
}

func (s *seededReplayStore) Get(context.Context, string, string) (*idempotency.Record, error) {
	s.gets++
	if s.record == nil {
		return nil, idempotency.ErrNotFound
	}
	clone := *s.record
	return &clone, nil
}

func (s *seededReplayStore) Claim(context.Context, *idempotency.Record) (bool, error) {
	s.claims++
	return false, nil
}
func (*seededReplayStore) Complete(context.Context, *idempotency.Record) error { return nil }
func (*seededReplayStore) DeletePending(context.Context, string, string) error { return nil }

func TestMutationReplayBypassCoversEveryServiceSuiteMutationExceptInternalNotes(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
		want   bool
	}{
		{http.MethodPut, "/api/v1/service-suite/customer-hub/config", true},
		{http.MethodPost, "/api/v1/service-suite/channels", true},
		{http.MethodPatch, "/api/v1/service-suite/channels/00000000-0000-0000-0000-000000000001", true},
		{http.MethodDelete, "/api/v1/service-suite/macros/00000000-0000-0000-0000-000000000001", true},
		{http.MethodPost, "/api/v1/service-suite/conversations/00000000-0000-0000-0000-000000000001/status", true},
		{http.MethodPost, "/api/v1/service-suite/conversations/00000000-0000-0000-0000-000000000001/messages", true},
		{http.MethodPost, "/api/v1/service-suite/conversations/00000000-0000-0000-0000-000000000001/internal-notes", false},
		{http.MethodGet, "/api/v1/service-suite/conversations", false},
		{http.MethodPost, "/api/v1/other", false},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		if got := MutationReplayBypass(req, nil); got != tc.want {
			t.Errorf("%s %s bypass=%v want=%v", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestSeededSuccessCannotReplayPastDemotedHelpdeskAuthorization(t *testing.T) {
	for _, principalKind := range []string{"session_user", "api_key"} {
		t.Run(principalKind, func(t *testing.T) {
			store := &seededReplayStore{record: &idempotency.Record{
				TenantID: "tenant-1", Key: "legacy-success", Route: "PUT /api/v1/service-suite/customer-hub/config",
				ResponseStatus: http.StatusOK, ResponseBody: []byte(`{"status":"active"}`),
			}}
			authorizationCalls := 0
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				authorizationCalls++
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"code":"forbidden"}}`))
			})
			handler := idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
				store,
				func(*http.Request) (string, bool) { return "tenant-1", true },
				MutationReplayBypass,
				HandlerOwnedInternalNoteReplay,
				InternalNoteReplayBodyLimit,
			)(next)
			req := httptest.NewRequest(http.MethodPut, "/api/v1/service-suite/customer-hub/config", strings.NewReader(`{"status":"draft"}`))
			req.Header.Set(idempotency.HeaderName, "legacy-success")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusForbidden || authorizationCalls != 1 {
				t.Fatalf("status=%d auth_calls=%d body=%s", recorder.Code, authorizationCalls, recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), `"status":"active"`) || recorder.Header().Get(idempotency.ReplayedHeaderName) != "" {
				t.Fatalf("legacy sensitive success replayed after %s demotion: %s", principalKind, recorder.Body.String())
			}
		})
	}
}

func TestHeldHelpdeskMutationsBypassReplayBeforeBodyAndStore(t *testing.T) {
	d := &Deps{}
	for _, tc := range []struct {
		path string
		code string
		call func(http.ResponseWriter, *http.Request)
	}{
		{"/api/v1/service-suite/channels", "helpdesk_channel_create_held", d.CreateChannel},
		{"/api/v1/service-suite/conversations", "helpdesk_conversation_create_held", d.CreateConversation},
		{"/api/v1/service-suite/conversations/00000000-0000-0000-0000-000000000001/messages", "helpdesk_delivery_unavailable", d.CreateMessage},
		{"/api/v1/service-suite/tickets", "helpdesk_ticket_create_held", d.CreateTicket},
		{"/api/v1/service-suite/views", "helpdesk_view_create_held", d.CreateView},
		{"/api/v1/service-suite/macros", "helpdesk_macro_create_held", d.CreateMacro},
		{"/api/v1/service-suite/macros/00000000-0000-0000-0000-000000000001/use", "macro_usage_evidence_unavailable", d.UseMacro},
		{"/api/v1/service-suite/spam-assessments", "spam_assessment_write_held", d.CreateSpamAssessment},
		{"/api/v1/service-suite/agent/draft-reply", "customer_agent_draft_write_held", d.DraftReply},
	} {
		t.Run(tc.code, func(t *testing.T) {
			body := &failIfRead{}
			store := &seededReplayStore{record: &idempotency.Record{ResponseStatus: http.StatusCreated, ResponseBody: []byte(`{"legacy":true}`)}}
			handler := idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
				store,
				func(*http.Request) (string, bool) { return "tenant-1", true },
				MutationReplayBypass,
				HandlerOwnedInternalNoteReplay,
				InternalNoteReplayBodyLimit,
			)(http.HandlerFunc(tc.call))
			req := httptest.NewRequest(http.MethodPost, tc.path, body)
			req.Header.Set(idempotency.HeaderName, "held-effect")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 || store.gets != 0 || store.claims != 0 {
				t.Fatalf("body_reads=%d store_gets=%d store_claims=%d", body.reads, store.gets, store.claims)
			}
		})
	}
}

func TestAmbiguousHelpdeskCreatesAreSourceHeldBeforeBodyOrRepo(t *testing.T) {
	d := &Deps{}
	for _, tc := range []struct {
		name string
		code string
		call func(http.ResponseWriter, *http.Request)
	}{
		{"channel", "helpdesk_channel_create_held", d.CreateChannel},
		{"conversation", "helpdesk_conversation_create_held", d.CreateConversation},
		{"ticket", "helpdesk_ticket_create_held", d.CreateTicket},
		{"view", "helpdesk_view_create_held", d.CreateView},
		{"macro", "helpdesk_macro_create_held", d.CreateMacro},
		{"spam", "spam_assessment_write_held", d.CreateSpamAssessment},
		{"draft", "customer_agent_draft_write_held", d.DraftReply},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &failIfRead{}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/service-suite/"+tc.name, body)
			recorder := httptest.NewRecorder()
			tc.call(recorder, req)
			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 {
				t.Fatalf("held %s handler read request body %d times", tc.name, body.reads)
			}
		})
	}
}
