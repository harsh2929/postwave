package intelligent_retry

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type retryEventRow struct {
	event Event
	err   error
}

func (r retryEventRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != 11 {
		return errors.New("unexpected retry event scan width")
	}
	raw, _ := json.Marshal(r.event.Breakdown)
	*(dest[0].(*string)) = r.event.ID
	*(dest[1].(*string)) = r.event.TenantID
	*(dest[2].(*string)) = r.event.CampaignID
	*(dest[3].(*string)) = r.event.SubscriberEmail
	*(dest[4].(*string)) = r.event.Reason
	*(dest[5].(*string)) = r.event.Status
	*(dest[6].(*time.Time)) = r.event.RetryAfter
	*(dest[7].(*int)) = r.event.Attempts
	*(dest[8].(*[]byte)) = raw
	*(dest[9].(*time.Time)) = r.event.CreatedAt
	*(dest[10].(*time.Time)) = r.event.UpdatedAt
	return nil
}

type retryTransitionTx struct {
	pgx.Tx
	rows      []pgx.Row
	rowIndex  int
	queries   []string
	queryArgs [][]any
	commits   int
	rollbacks int
}

func (tx *retryTransitionTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	tx.queries = append(tx.queries, query)
	tx.queryArgs = append(tx.queryArgs, append([]any(nil), args...))
	if tx.rowIndex >= len(tx.rows) {
		return retryEventRow{err: errors.New("unexpected retry QueryRow")}
	}
	row := tx.rows[tx.rowIndex]
	tx.rowIndex++
	return row
}

func (tx *retryTransitionTx) Commit(context.Context) error {
	tx.commits++
	return nil
}

func (tx *retryTransitionTx) Rollback(context.Context) error {
	tx.rollbacks++
	return nil
}

func TestRetryStatusTransitionStateMachine(t *testing.T) {
	for _, tc := range []struct {
		current, target string
		allowed         bool
	}{
		{current: "pending", target: "ready", allowed: true},
		{current: "failed", target: "ready", allowed: true},
		{current: "ready", target: "ready", allowed: true},
		{current: "dismissed", target: "ready"},
		{current: "retrying", target: "ready"},
		{current: "retried", target: "ready"},
		{current: "pending", target: "dismissed", allowed: true},
		{current: "ready", target: "dismissed", allowed: true},
		{current: "failed", target: "dismissed", allowed: true},
		{current: "dismissed", target: "dismissed", allowed: true},
		{current: "retrying", target: "dismissed"},
		{current: "retried", target: "dismissed"},
	} {
		if got := retryTransitionAllowed(tc.current, tc.target); got != tc.allowed {
			t.Errorf("transition %s -> %s allowed=%v, want %v", tc.current, tc.target, got, tc.allowed)
		}
	}
}

func TestRetrySetStatusLocksAuditsAndCommitsTransition(t *testing.T) {
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	current := retryEventFixture("pending", now.Add(time.Hour), now)
	updated := current
	updated.Status = "ready"
	updated.RetryAfter = now
	updated.UpdatedAt = now.Add(time.Second)
	tx := &retryTransitionTx{rows: []pgx.Row{retryEventRow{event: current}, retryEventRow{event: updated}}}
	auditCalls := 0
	queue := &Queue{
		beginTenant: func(_ context.Context, tenantID string) (pgx.Tx, error) {
			if tenantID != current.TenantID {
				t.Fatalf("tenant=%q, want %q", tenantID, current.TenantID)
			}
			return tx, nil
		},
		auditMutation: func(_ context.Context, gotTx pgx.Tx, meta db.AuditMeta, action, resourceType, resourceID string, details map[string]any) error {
			auditCalls++
			if gotTx != tx || meta.TenantID != current.TenantID || action != "intelligent_retry.marked_ready" ||
				resourceType != "intelligent_retry_event" || resourceID != current.ID {
				t.Fatalf("audit identity tx=%T meta=%+v action=%q resource=%s/%s", gotTx, meta, action, resourceType, resourceID)
			}
			if details["before_status"] != "pending" || details["after_status"] != "ready" || details["campaign_id"] != current.CampaignID {
				t.Fatalf("audit details=%v", details)
			}
			return nil
		},
	}
	out, err := queue.SetStatus(context.Background(), current.TenantID, current.ID, "ready", current.UpdatedAt, db.AuditMeta{})
	if err != nil {
		t.Fatalf("set retry ready: %v", err)
	}
	if out.Status != "ready" || !out.RetryAfter.Equal(now) {
		t.Fatalf("updated event=%+v", out)
	}
	if tx.rowIndex != 2 || tx.commits != 1 || auditCalls != 1 {
		t.Fatalf("rows=%d commits=%d audits=%d, want 2/1/1", tx.rowIndex, tx.commits, auditCalls)
	}
	if !strings.Contains(tx.queries[0], "FOR UPDATE") || !strings.Contains(tx.queries[1], "GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')") {
		t.Fatalf("status mutation lost locked monotonic CAS queries: %#v", tx.queries)
	}
}

func TestRetrySetStatusRollsBackWhenAuditFails(t *testing.T) {
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	current := retryEventFixture("pending", now.Add(time.Hour), now)
	updated := current
	updated.Status = "dismissed"
	updated.UpdatedAt = now.Add(time.Microsecond)
	tx := &retryTransitionTx{rows: []pgx.Row{
		retryEventRow{event: current}, retryEventRow{event: updated},
	}}
	sentinel := errors.New("audit insert failed")
	queue := &Queue{
		beginTenant: func(context.Context, string) (pgx.Tx, error) { return tx, nil },
		auditMutation: func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error {
			return sentinel
		},
	}
	_, err := queue.SetStatus(
		context.Background(), current.TenantID, current.ID, "dismissed",
		current.UpdatedAt, db.AuditMeta{},
	)
	if !errors.Is(err, sentinel) || tx.commits != 0 {
		t.Fatalf("audit failure error=%v commits=%d, want rollback", err, tx.commits)
	}
}

func TestRetrySetStatusRejectsWorkerOwnedOrTerminalState(t *testing.T) {
	current := retryEventFixture("retrying", time.Now().UTC(), time.Now().UTC())
	tx := &retryTransitionTx{rows: []pgx.Row{retryEventRow{event: current}}}
	queue := &Queue{
		beginTenant: func(context.Context, string) (pgx.Tx, error) { return tx, nil },
		auditMutation: func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error {
			t.Fatal("invalid transition reached audit")
			return nil
		},
	}
	if _, err := queue.SetStatus(context.Background(), current.TenantID, current.ID, "dismissed", current.UpdatedAt, db.AuditMeta{}); !errors.Is(err, ErrInvalidRetryTransition) {
		t.Fatalf("transition error=%v, want conflict", err)
	}
	if tx.rowIndex != 1 || tx.commits != 0 {
		t.Fatalf("rows=%d commits=%d, want 1/0", tx.rowIndex, tx.commits)
	}
}

func TestRetrySetStatusRejectsStaleRevisionUnderRowLock(t *testing.T) {
	now := time.Date(2026, time.August, 30, 12, 0, 0, 123000, time.UTC)
	current := retryEventFixture("pending", now.Add(time.Hour), now)
	tx := &retryTransitionTx{rows: []pgx.Row{retryEventRow{event: current}}}
	queue := &Queue{
		beginTenant: func(context.Context, string) (pgx.Tx, error) { return tx, nil },
		auditMutation: func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error {
			t.Fatal("stale revision reached audit")
			return nil
		},
	}
	_, err := queue.SetStatus(
		context.Background(), current.TenantID, current.ID, "ready",
		current.UpdatedAt.Add(-time.Microsecond), db.AuditMeta{},
	)
	if !errors.Is(err, ErrRetryRevisionConflict) {
		t.Fatalf("stale revision error=%v, want ErrRetryRevisionConflict", err)
	}
	if tx.rowIndex != 1 || tx.commits != 0 || len(tx.queries) != 1 || !strings.Contains(tx.queries[0], "FOR UPDATE") {
		t.Fatalf("stale CAS rows=%d commits=%d queries=%#v, want one locked read and no commit", tx.rowIndex, tx.commits, tx.queries)
	}
}

func TestRetryExpectedUpdatedAtParser(t *testing.T) {
	want := time.Date(2026, time.August, 30, 12, 0, 0, 123456000, time.UTC)
	for _, tc := range []struct {
		name string
		raw  json.RawMessage
		err  error
	}{
		{name: "valid", raw: json.RawMessage(`"2026-08-30T12:00:00.123456Z"`)},
		{name: "omitted", err: errRetryExpectedUpdatedAtRequired},
		{name: "null", raw: json.RawMessage(`null`), err: errRetryExpectedUpdatedAtInvalid},
		{name: "non string", raw: json.RawMessage(`123`), err: errRetryExpectedUpdatedAtInvalid},
		{name: "blank", raw: json.RawMessage(`""`), err: errRetryExpectedUpdatedAtInvalid},
		{name: "whitespace", raw: json.RawMessage(`" 2026-08-30T12:00:00Z"`), err: errRetryExpectedUpdatedAtInvalid},
		{name: "malformed", raw: json.RawMessage(`"yesterday"`), err: errRetryExpectedUpdatedAtInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRetryExpectedUpdatedAt(tc.raw)
			if tc.err != nil {
				if !errors.Is(err, tc.err) {
					t.Fatalf("parse error=%v, want %v", err, tc.err)
				}
				return
			}
			if err != nil || !got.Equal(want) {
				t.Fatalf("parsed=%s error=%v, want %s", got, err, want)
			}
		})
	}
}

func TestRetryMutationPreconditionsFailBeforeStorage(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "empty", wantStatus: http.StatusPreconditionRequired, wantCode: "precondition_required"},
		{name: "omitted", body: `{}`, wantStatus: http.StatusPreconditionRequired, wantCode: "precondition_required"},
		{name: "null", body: `{"expected_updated_at":null}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_expected_updated_at"},
		{name: "malformed", body: `{"expected_updated_at":"yesterday"}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_expected_updated_at"},
		{name: "oversized", body: strings.Repeat(" ", int(retryMutationJSONMaxBodyBytes)+1), wantStatus: http.StatusRequestEntityTooLarge, wantCode: "payload_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			beginCalls := 0
			queue := &Queue{beginTenant: func(context.Context, string) (pgx.Tx, error) {
				beginCalls++
				return nil, errors.New("invalid precondition reached storage")
			}}
			router := chi.NewRouter()
			MountRoutes(router, &Deps{Queue: queue})
			request := httptest.NewRequest(http.MethodPost, "/api/v1/intelligent-retry/events/event-1/mark-ready", nil)
			if tc.body != "" {
				request = httptest.NewRequest(
					http.MethodPost,
					"/api/v1/intelligent-retry/events/event-1/mark-ready",
					strings.NewReader(tc.body),
				)
				request.Header.Set("Content-Type", "application/json")
			}
			ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID: "admin-1", TenantID: "tenant-1", Role: "admin", EffectiveRole: "admin",
			})
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request.WithContext(ctx))
			if recorder.Code != tc.wantStatus || !strings.Contains(recorder.Body.String(), `"code":"`+tc.wantCode+`"`) {
				t.Fatalf("response=%d %s, want %d/%s", recorder.Code, recorder.Body.String(), tc.wantStatus, tc.wantCode)
			}
			if beginCalls != 0 {
				t.Fatalf("invalid precondition opened %d transactions", beginCalls)
			}
			if recorder.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("precondition Cache-Control=%q", recorder.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestRetryListRejectsAmbiguousFilters(t *testing.T) {
	queue := &Queue{beginTenant: func(context.Context, string) (pgx.Tx, error) {
		t.Fatal("invalid list filter reached storage")
		return nil, nil
	}}
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Queue: queue})
	for _, tc := range []struct {
		name string
		path string
		code string
	}{
		{name: "limit text", path: "/api/v1/intelligent-retry/events?limit=lots", code: "invalid_limit"},
		{name: "limit zero", path: "/api/v1/intelligent-retry/events?limit=0", code: "invalid_limit"},
		{name: "limit too large", path: "/api/v1/intelligent-retry/events?limit=501", code: "invalid_limit"},
		{name: "limit repeated", path: "/api/v1/intelligent-retry/events?limit=1&limit=2", code: "invalid_limit"},
		{name: "status empty", path: "/api/v1/intelligent-retry/events?status=", code: "invalid_status"},
		{name: "status unknown", path: "/api/v1/intelligent-retry/events?status=queued", code: "invalid_status"},
		{name: "status case", path: "/api/v1/intelligent-retry/events?status=READY", code: "invalid_status"},
		{name: "status repeated", path: "/api/v1/intelligent-retry/events?status=ready&status=pending", code: "invalid_status"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.path, nil)
			ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID: "admin-1", TenantID: "tenant-1", Role: "admin", EffectiveRole: "admin",
			})
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request.WithContext(ctx))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("response=%d %s, want 400/%s", recorder.Code, recorder.Body.String(), tc.code)
			}
			if recorder.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("invalid filter Cache-Control=%q", recorder.Header().Get("Cache-Control"))
			}
		})
	}
	for _, status := range []string{"pending", "ready", "retrying", "retried", "failed", "dismissed"} {
		if !validRetryListStatus(status) {
			t.Errorf("supported retry status %q was rejected", status)
		}
	}
}

func TestRetryMutationRoutesRequireAdminAndNeverCacheDenials(t *testing.T) {
	beginCalls := 0
	queue := &Queue{beginTenant: func(context.Context, string) (pgx.Tx, error) {
		beginCalls++
		return nil, errors.New("viewer reached storage")
	}}
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Queue: queue})
	for _, tc := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/intelligent-retry/events"},
		{method: http.MethodPost, path: "/api/v1/intelligent-retry/events/event-1/mark-ready"},
	} {
		request := httptest.NewRequest(tc.method, tc.path, nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
		ctx = middleware.WithUser(ctx, &middleware.User{
			ID: "user-1", TenantID: "tenant-1", Role: "viewer", EffectiveRole: "viewer",
		})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request.WithContext(ctx))
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("viewer %s %s status=%d body=%s, want 403", tc.method, tc.path, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("viewer %s Cache-Control=%q, want private, no-store", tc.path, got)
		}
	}
	if beginCalls != 0 {
		t.Fatalf("viewer reached storage %d times", beginCalls)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/intelligent-retry/events", nil)
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
	ctx = middleware.WithAPIKeyAuth(ctx)
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request.WithContext(ctx))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("read:reports API key status=%d body=%s, want 403", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("read:reports denial Cache-Control=%q", recorder.Header().Get("Cache-Control"))
	}
}

func TestRetryMutationRouteReturnsTypedConflictForUnsafeTransition(t *testing.T) {
	current := retryEventFixture("retrying", time.Now().UTC(), time.Now().UTC())
	tx := &retryTransitionTx{rows: []pgx.Row{retryEventRow{event: current}}}
	queue := &Queue{
		beginTenant: func(context.Context, string) (pgx.Tx, error) { return tx, nil },
		auditMutation: func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error {
			t.Fatal("unsafe transition reached audit")
			return nil
		},
	}
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Queue: queue})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/intelligent-retry/events/event-1/dismiss",
		strings.NewReader(`{"expected_updated_at":"`+current.UpdatedAt.Format(time.RFC3339Nano)+`"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: current.TenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "admin-1", TenantID: current.TenantID, Role: "admin", EffectiveRole: "admin",
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request.WithContext(ctx))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s, want 409", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"retry_transition_conflict"`) {
		t.Fatalf("conflict body=%s, want typed code", recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("conflict Cache-Control=%q", recorder.Header().Get("Cache-Control"))
	}
}

func TestRetryMutationRouteReturnsTypedConflictForStaleRevision(t *testing.T) {
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	current := retryEventFixture("pending", now.Add(time.Hour), now)
	tx := &retryTransitionTx{rows: []pgx.Row{retryEventRow{event: current}}}
	queue := &Queue{
		beginTenant: func(context.Context, string) (pgx.Tx, error) { return tx, nil },
		auditMutation: func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error {
			t.Fatal("stale route mutation reached audit")
			return nil
		},
	}
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Queue: queue})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/intelligent-retry/events/event-1/mark-ready",
		strings.NewReader(`{"expected_updated_at":"`+now.Add(-time.Second).Format(time.RFC3339Nano)+`"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: current.TenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "admin-1", TenantID: current.TenantID, Role: "admin", EffectiveRole: "admin",
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request.WithContext(ctx))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"retry_revision_conflict"`) {
		t.Fatalf("stale response=%d %s, want typed 409", recorder.Code, recorder.Body.String())
	}
	if tx.rowIndex != 1 || tx.commits != 0 {
		t.Fatalf("stale response read rows=%d commits=%d, want 1/0", tx.rowIndex, tx.commits)
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("stale Cache-Control=%q", recorder.Header().Get("Cache-Control"))
	}
}

func TestRetryResponseProtectionCoversUnmatchedChildPaths(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/intelligent-retry/events/missing", nil)
	ProtectResponses(http.NotFoundHandler()).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("protected response status=%d headers=%v", recorder.Code, recorder.Header())
	}
}

func TestRetryResponseProtectionIsMountedBeforeAuthentication(t *testing.T) {
	source, err := os.ReadFile("../../main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "r.Use(intelligent_retry.ProtectResponses)") {
		t.Fatal("intelligent-retry privacy boundary is not mounted at the root before authentication")
	}
}

func retryEventFixture(status string, retryAfter, updatedAt time.Time) Event {
	return Event{
		ID: "event-1", TenantID: "tenant-1", CampaignID: "campaign-1",
		SubscriberEmail: "person@example.test", Reason: "frequency_cap",
		Status: status, RetryAfter: retryAfter, Breakdown: []Breakdown{},
		CreatedAt: updatedAt.Add(-time.Hour), UpdatedAt: updatedAt,
	}
}
