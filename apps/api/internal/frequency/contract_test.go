// SPDX-License-Identifier: AGPL-3.0-only

package frequency

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	frequencyTestTenantID = "00000000-0000-4000-8000-000000000001"
	frequencyTestUserID   = "00000000-0000-4000-8000-000000000002"
	frequencyTestRuleID   = "00000000-0000-4000-8000-000000000003"
)

type fakeRuleRow struct {
	rule Rule
	err  error
}

func (r *fakeRuleRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != 8 {
		return errors.New("unexpected frequency rule scan width")
	}
	*(dest[0].(*string)) = r.rule.ID
	*(dest[1].(*string)) = r.rule.Label
	*(dest[2].(*int)) = r.rule.MaxSends
	*(dest[3].(*int)) = r.rule.WindowHours
	*(dest[4].(*bool)) = r.rule.Active
	*(dest[5].(*[]string)) = append([]string(nil), r.rule.Channels...)
	*(dest[6].(*time.Time)) = r.rule.CreatedAt
	*(dest[7].(*time.Time)) = r.rule.UpdatedAt
	return nil
}

type fakeRuleRows struct {
	pgx.Rows
	rules      []Rule
	scanErrors []error
	rowErr     error
	index      int
}

func (r *fakeRuleRows) Close() {}

func (r *fakeRuleRows) Next() bool {
	return r.index < len(r.rules) || r.index < len(r.scanErrors)
}

func (r *fakeRuleRows) Scan(dest ...any) error {
	index := r.index
	r.index++
	if index < len(r.scanErrors) && r.scanErrors[index] != nil {
		return r.scanErrors[index]
	}
	if index >= len(r.rules) {
		return errors.New("scripted row has no projection")
	}
	return (&fakeRuleRow{rule: r.rules[index]}).Scan(dest...)
}

func (r *fakeRuleRows) Err() error { return r.rowErr }

type fakeEmailRows struct {
	pgx.Rows
	emails     []string
	scanErrors []error
	rowErr     error
	index      int
}

func (r *fakeEmailRows) Close() {}

func (r *fakeEmailRows) Next() bool {
	return r.index < len(r.emails) || r.index < len(r.scanErrors)
}

func (r *fakeEmailRows) Scan(dest ...any) error {
	index := r.index
	r.index++
	if index < len(r.scanErrors) && r.scanErrors[index] != nil {
		return r.scanErrors[index]
	}
	if len(dest) != 1 || index >= len(r.emails) {
		return errors.New("unexpected over-cap email scan")
	}
	*(dest[0].(*string)) = r.emails[index]
	return nil
}

func (r *fakeEmailRows) Err() error { return r.rowErr }

type fakeFrequencyTx struct {
	pgx.Tx
	rowResults  []pgx.Row
	rowQueries  []string
	rowArgs     [][]any
	queryRows   pgx.Rows
	queryErr    error
	queries     []string
	execTag     pgconn.CommandTag
	execErr     error
	execQueries []string
	execArgs    [][]any
	commits     int
	rollbacks   int
	events      []string
}

func (tx *fakeFrequencyTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	tx.rowQueries = append(tx.rowQueries, query)
	tx.rowArgs = append(tx.rowArgs, append([]any(nil), args...))
	tx.events = append(tx.events, "query-row")
	index := len(tx.rowQueries) - 1
	if index >= len(tx.rowResults) {
		return &fakeRuleRow{err: errors.New("unexpected QueryRow")}
	}
	return tx.rowResults[index]
}

func (tx *fakeFrequencyTx) Query(_ context.Context, query string, _ ...any) (pgx.Rows, error) {
	tx.queries = append(tx.queries, query)
	return tx.queryRows, tx.queryErr
}

func (tx *fakeFrequencyTx) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tx.execQueries = append(tx.execQueries, query)
	tx.execArgs = append(tx.execArgs, append([]any(nil), args...))
	tx.events = append(tx.events, "exec")
	return tx.execTag, tx.execErr
}

func (tx *fakeFrequencyTx) Commit(context.Context) error {
	tx.commits++
	tx.events = append(tx.events, "commit")
	return nil
}

func (tx *fakeFrequencyTx) Rollback(context.Context) error {
	tx.rollbacks++
	tx.events = append(tx.events, "rollback")
	return nil
}

type capturedFrequencyAudit struct {
	meta         db.AuditMeta
	action       string
	resourceType string
	resourceID   string
	details      map[string]any
}

func frequencyRuleAt(updatedAt time.Time) Rule {
	return Rule{
		ID:          frequencyTestRuleID,
		Label:       "Daily cap",
		MaxSends:    3,
		WindowHours: 24,
		Active:      true,
		Channels:    []string{"email"},
		CreatedAt:   updatedAt.Add(-time.Hour),
		UpdatedAt:   updatedAt,
	}
}

func frequencyRequest(method, path, body, role string) *http.Request {
	var requestBody *strings.Reader
	if body == "" {
		requestBody = strings.NewReader("")
	} else {
		requestBody = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, path, requestBody)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: frequencyTestTenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:            frequencyTestUserID,
		TenantID:      frequencyTestTenantID,
		Role:          role,
		EffectiveRole: role,
	})
	return r.WithContext(ctx)
}

func depsForFrequencyTx(tx *fakeFrequencyTx, calls *[]capturedFrequencyAudit, auditErr error) *Deps {
	return &Deps{
		beginTenant: func(_ context.Context, tenantID string) (pgx.Tx, error) {
			if tenantID != frequencyTestTenantID {
				return nil, errors.New("wrong tenant")
			}
			return tx, nil
		},
		auditMutation: func(_ context.Context, _ pgx.Tx, meta db.AuditMeta, action, resourceType, resourceID string, details map[string]any) error {
			tx.events = append(tx.events, "audit")
			*calls = append(*calls, capturedFrequencyAudit{
				meta: meta, action: action, resourceType: resourceType,
				resourceID: resourceID, details: details,
			})
			return auditErr
		},
	}
}

func TestMountRoutesRejectsDelegatedFrequencyCapAdminAuthority(t *testing.T) {
	previousResolver := apikeys.StoredScopeResolver
	apikeys.StoredScopeResolver = func(context.Context, string, string) ([]apikeys.Scope, error) {
		return []apikeys.Scope{apikeys.ScopeAdmin}, nil
	}
	t.Cleanup(func() { apikeys.StoredScopeResolver = previousResolver })

	routes := []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/sending/frequency-caps"},
		{method: http.MethodPost, path: "/api/v1/sending/frequency-caps"},
		{method: http.MethodPatch, path: "/api/v1/sending/frequency-caps/" + frequencyTestRuleID},
		{method: http.MethodDelete, path: "/api/v1/sending/frequency-caps/" + frequencyTestRuleID},
	}
	principals := []struct {
		name string
		bind func(context.Context) context.Context
	}{
		{
			name: "custom role with stored admin grant",
			bind: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{
					ID: frequencyTestUserID, TenantID: frequencyTestTenantID,
					Role: "custom-operator", EffectiveRole: "custom-operator",
				})
			},
		},
		{
			name: "admin viewing as custom role",
			bind: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{
					ID: frequencyTestUserID, TenantID: frequencyTestTenantID,
					Role: "admin", EffectiveRole: "custom-operator",
				})
			},
		},
		{
			name: "non-admin API key",
			bind: func(ctx context.Context) context.Context {
				ctx = middleware.WithAPIKeyAuth(ctx)
				return apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
			},
		},
	}

	for _, route := range routes {
		for _, principal := range principals {
			t.Run(principal.name+" "+route.method+" "+route.path, func(t *testing.T) {
				beginCalls := 0
				deps := &Deps{beginTenant: func(context.Context, string) (pgx.Tx, error) {
					beginCalls++
					return nil, errors.New("denied request reached frequency store")
				}}
				router := chi.NewRouter()
				MountRoutes(router, deps)
				request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
				request.Header.Set("Content-Type", "application/json")
				ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: frequencyTestTenantID})
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request.WithContext(principal.bind(ctx)))

				if response.Code != http.StatusForbidden {
					t.Fatalf("response = %d %s", response.Code, response.Body.String())
				}
				if beginCalls != 0 {
					t.Fatalf("delegated denial reached frequency store %d times", beginCalls)
				}
				if response.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
				}
			})
		}
	}
}

func TestMountRoutesAllowsAdminScopedAPIKeyForFrequencyCaps(t *testing.T) {
	tx := &fakeFrequencyTx{queryRows: &fakeRuleRows{}}
	deps := &Deps{beginTenant: func(context.Context, string) (pgx.Tx, error) {
		return tx, nil
	}}
	router := chi.NewRouter()
	MountRoutes(router, deps)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sending/frequency-caps", nil)
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: frequencyTestTenantID})
	ctx = middleware.WithAPIKeyAuth(ctx)
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request.WithContext(ctx))

	if response.Code != http.StatusOK || len(tx.queries) != 1 {
		t.Fatalf("response=%d body=%s queries=%d", response.Code, response.Body.String(), len(tx.queries))
	}
}

func TestParseRequiredExpectedUpdatedAt(t *testing.T) {
	want := time.Date(2026, 8, 30, 10, 15, 16, 123456000, time.UTC)
	parsed, err := parseRequiredExpectedUpdatedAt(json.RawMessage(`"2026-08-30T10:15:16.123456Z"`))
	if err != nil || !parsed.Equal(want) {
		t.Fatalf("valid revision = (%v, %v), want %v", parsed, err, want)
	}
	for _, tc := range []struct {
		name string
		raw  json.RawMessage
		want error
	}{
		{name: "omitted", want: errExpectedUpdatedAtRequired},
		{name: "null", raw: json.RawMessage(`null`), want: errExpectedUpdatedAtInvalid},
		{name: "blank", raw: json.RawMessage(`""`), want: errExpectedUpdatedAtInvalid},
		{name: "whitespace", raw: json.RawMessage(`" 2026-08-30T10:15:16Z"`), want: errExpectedUpdatedAtInvalid},
		{name: "non RFC3339", raw: json.RawMessage(`"2026-08-30"`), want: errExpectedUpdatedAtInvalid},
		{name: "zero", raw: json.RawMessage(`"0001-01-01T00:00:00Z"`), want: errExpectedUpdatedAtInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseRequiredExpectedUpdatedAt(tc.raw); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestFrequencyCapRoutesRequireAdminAndProtectDenials(t *testing.T) {
	beginCalls := 0
	d := &Deps{beginTenant: func(context.Context, string) (pgx.Tx, error) {
		beginCalls++
		return nil, errors.New("viewer must not reach storage")
	}}
	router := chi.NewRouter()
	MountRoutes(router, d)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, frequencyRequest(
		http.MethodGet, "/api/v1/sending/frequency-caps", "", "viewer",
	))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"insufficient_role"`) {
		t.Fatalf("viewer response = %d %s", recorder.Code, recorder.Body.String())
	}
	if beginCalls != 0 {
		t.Fatalf("viewer denial reached storage %d times", beginCalls)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if recorder.Header().Get("Pragma") != "no-cache" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("protection headers = %#v", recorder.Header())
	}

	unrelated := httptest.NewRecorder()
	ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})).ServeHTTP(unrelated, httptest.NewRequest(http.MethodGet, "/api/v1/sending/state", nil))
	if unrelated.Header().Get("Cache-Control") != "" {
		t.Fatalf("unrelated response was marked private: %#v", unrelated.Header())
	}
}

func TestFrequencyCapAdminListReturnsWireRevision(t *testing.T) {
	revision := time.Date(2026, 8, 30, 10, 15, 16, 123456000, time.UTC)
	tx := &fakeFrequencyTx{queryRows: &fakeRuleRows{rules: []Rule{frequencyRuleAt(revision)}}}
	var audits []capturedFrequencyAudit
	router := chi.NewRouter()
	MountRoutes(router, depsForFrequencyTx(tx, &audits, nil))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, frequencyRequest(
		http.MethodGet, "/api/v1/sending/frequency-caps", "", "admin",
	))
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin list = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"updated_at":"2026-08-30T10:15:16.123456Z"`) {
		t.Fatalf("list omitted updated_at: %s", recorder.Body.String())
	}
	if len(audits) != 0 {
		t.Fatalf("read emitted mutation audit: %#v", audits)
	}
}

func TestFrequencyCapMutationPreconditionErrorsDoNotOpenTransaction(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "patch missing", method: http.MethodPatch, body: `{}`, wantStatus: http.StatusPreconditionRequired, wantCode: "precondition_required"},
		{name: "patch malformed", method: http.MethodPatch, body: `{"expected_updated_at":"yesterday"}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_expected_updated_at"},
		{name: "delete missing empty body", method: http.MethodDelete, body: "", wantStatus: http.StatusPreconditionRequired, wantCode: "precondition_required"},
		{name: "delete null", method: http.MethodDelete, body: `{"expected_updated_at":null}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_expected_updated_at"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			beginCalls := 0
			d := &Deps{beginTenant: func(context.Context, string) (pgx.Tx, error) {
				beginCalls++
				return nil, errors.New("invalid input reached storage")
			}}
			router := chi.NewRouter()
			MountRoutes(router, d)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, frequencyRequest(
				tc.method, "/api/v1/sending/frequency-caps/"+frequencyTestRuleID, tc.body, "admin",
			))
			if recorder.Code != tc.wantStatus || !strings.Contains(recorder.Body.String(), `"code":"`+tc.wantCode+`"`) {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
			}
			if beginCalls != 0 {
				t.Fatalf("invalid precondition opened %d transactions", beginCalls)
			}
		})
	}
}

func TestFrequencyCapMutationRejectsMalformedIDBeforeStorage(t *testing.T) {
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			beginCalls := 0
			d := &Deps{beginTenant: func(context.Context, string) (pgx.Tx, error) {
				beginCalls++
				return nil, errors.New("malformed id reached storage")
			}}
			router := chi.NewRouter()
			MountRoutes(router, d)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, frequencyRequest(
				method,
				"/api/v1/sending/frequency-caps/not-a-uuid",
				`{"expected_updated_at":"2026-08-30T10:15:16Z"}`,
				"admin",
			))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_frequency_cap_id"`) {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
			}
			if beginCalls != 0 {
				t.Fatalf("malformed id opened %d transactions", beginCalls)
			}
		})
	}
}

func TestFrequencyCapPatchUsesLockedCASMonotonicRevisionAndAtomicAudit(t *testing.T) {
	beforeRevision := time.Date(2026, 8, 30, 10, 15, 16, 123456000, time.UTC)
	afterRevision := beforeRevision.Add(time.Microsecond)
	before := frequencyRuleAt(beforeRevision)
	after := frequencyRuleAt(afterRevision)
	after.Label = "Weekly cap"
	tx := &fakeFrequencyTx{rowResults: []pgx.Row{
		&fakeRuleRow{rule: before},
		&fakeRuleRow{rule: after},
	}}
	var audits []capturedFrequencyAudit
	router := chi.NewRouter()
	MountRoutes(router, depsForFrequencyTx(tx, &audits, nil))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, frequencyRequest(
		http.MethodPatch,
		"/api/v1/sending/frequency-caps/"+frequencyTestRuleID,
		`{"label":"Weekly cap","expected_updated_at":"2026-08-30T10:15:16.123456Z"}`,
		"admin",
	))
	if recorder.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"updated_at":"2026-08-30T10:15:16.123457Z"`) {
		t.Fatalf("patch omitted new revision: %s", recorder.Body.String())
	}
	if len(tx.rowQueries) != 2 || !strings.Contains(tx.rowQueries[0], "FOR UPDATE") {
		t.Fatalf("row-lock queries = %#v", tx.rowQueries)
	}
	if !strings.Contains(tx.rowQueries[1], "GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')") ||
		!strings.Contains(tx.rowQueries[1], "updated_at = $8::timestamptz") {
		t.Fatalf("update is not monotonic/exact CAS: %s", tx.rowQueries[1])
	}
	if got, ok := tx.rowArgs[1][7].(time.Time); !ok || !got.Equal(beforeRevision) {
		t.Fatalf("update expected revision arg = %#v", tx.rowArgs[1][7])
	}
	if tx.commits != 1 || len(audits) != 1 {
		t.Fatalf("commits=%d audits=%#v", tx.commits, audits)
	}
	audit := audits[0]
	if audit.action != "settings.sending.frequency_cap.updated" || audit.resourceType != "frequency_cap_rules" || audit.resourceID != frequencyTestRuleID {
		t.Fatalf("audit identity = %#v", audit)
	}
	if audit.meta.UserID == nil || *audit.meta.UserID != frequencyTestUserID {
		t.Fatalf("audit actor = %+v", audit.meta)
	}
	if audit.details["before"] == nil || audit.details["after"] == nil {
		t.Fatalf("audit lacks bounded before/after: %#v", audit.details)
	}
	if len(tx.events) < 2 || tx.events[len(tx.events)-2] != "commit" || tx.events[len(tx.events)-3] != "audit" {
		t.Fatalf("mutation/audit/commit order = %v", tx.events)
	}
}

func TestFrequencyCapStaleMutationsReturnTypedConflictWithoutWrite(t *testing.T) {
	currentRevision := time.Date(2026, 8, 30, 10, 15, 17, 0, time.UTC)
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			tx := &fakeFrequencyTx{rowResults: []pgx.Row{&fakeRuleRow{rule: frequencyRuleAt(currentRevision)}}}
			var audits []capturedFrequencyAudit
			router := chi.NewRouter()
			MountRoutes(router, depsForFrequencyTx(tx, &audits, nil))
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, frequencyRequest(
				method,
				"/api/v1/sending/frequency-caps/"+frequencyTestRuleID,
				`{"expected_updated_at":"2026-08-30T10:15:16Z"}`,
				"admin",
			))
			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"frequency_cap_revision_conflict"`) {
				t.Fatalf("stale response = %d %s", recorder.Code, recorder.Body.String())
			}
			if len(tx.rowQueries) != 1 || !strings.Contains(tx.rowQueries[0], "FOR UPDATE") ||
				len(tx.execQueries) != 0 || tx.commits != 0 || len(audits) != 0 {
				t.Fatalf("stale mutation side effects: rows=%d exec=%d commits=%d audits=%d", len(tx.rowQueries), len(tx.execQueries), tx.commits, len(audits))
			}
		})
	}
}

func TestFrequencyCapMissingRuleRemainsNotFound(t *testing.T) {
	tx := &fakeFrequencyTx{rowResults: []pgx.Row{&fakeRuleRow{err: pgx.ErrNoRows}}}
	var audits []capturedFrequencyAudit
	router := chi.NewRouter()
	MountRoutes(router, depsForFrequencyTx(tx, &audits, nil))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, frequencyRequest(
		http.MethodPatch,
		"/api/v1/sending/frequency-caps/"+frequencyTestRuleID,
		`{"expected_updated_at":"2026-08-30T10:15:16Z"}`,
		"admin",
	))
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"code":"not_found"`) {
		t.Fatalf("missing response = %d %s", recorder.Code, recorder.Body.String())
	}
	if tx.commits != 0 || len(audits) != 0 {
		t.Fatalf("missing mutation side effects: commits=%d audits=%d", tx.commits, len(audits))
	}
}

func TestFrequencyCapCreateAndDeleteAuditBeforeCommit(t *testing.T) {
	revision := time.Date(2026, 8, 30, 10, 15, 16, 0, time.UTC)
	tests := []struct {
		name       string
		method     string
		path       string
		body       string
		rowResults []pgx.Row
		execTag    pgconn.CommandTag
		wantStatus int
		wantAction string
	}{
		{
			name: "create", method: http.MethodPost, path: "/api/v1/sending/frequency-caps",
			body:       `{"label":"Daily cap","max_sends":3,"window_hours":24}`,
			rowResults: []pgx.Row{&fakeRuleRow{rule: frequencyRuleAt(revision)}},
			wantStatus: http.StatusCreated, wantAction: "settings.sending.frequency_cap.created",
		},
		{
			name: "delete", method: http.MethodDelete, path: "/api/v1/sending/frequency-caps/" + frequencyTestRuleID,
			body:       `{"expected_updated_at":"2026-08-30T10:15:16Z"}`,
			rowResults: []pgx.Row{&fakeRuleRow{rule: frequencyRuleAt(revision)}},
			execTag:    pgconn.NewCommandTag("DELETE 1"),
			wantStatus: http.StatusNoContent, wantAction: "settings.sending.frequency_cap.deleted",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tx := &fakeFrequencyTx{rowResults: tc.rowResults, execTag: tc.execTag}
			var audits []capturedFrequencyAudit
			router := chi.NewRouter()
			MountRoutes(router, depsForFrequencyTx(tx, &audits, nil))
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, frequencyRequest(tc.method, tc.path, tc.body, "admin"))
			if recorder.Code != tc.wantStatus {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
			}
			if tx.commits != 1 || len(audits) != 1 || audits[0].action != tc.wantAction {
				t.Fatalf("commits=%d audits=%#v", tx.commits, audits)
			}
			if audits[0].resourceType != "frequency_cap_rules" || audits[0].resourceID != frequencyTestRuleID {
				t.Fatalf("audit resource = %#v", audits[0])
			}
			if len(tx.events) < 3 || tx.events[len(tx.events)-3] != "audit" || tx.events[len(tx.events)-2] != "commit" {
				t.Fatalf("audit was not before commit: %v", tx.events)
			}
		})
	}
}

func TestFrequencyCapAuditFailureRollsBackMutation(t *testing.T) {
	revision := time.Date(2026, 8, 30, 10, 15, 16, 0, time.UTC)
	updated := frequencyRuleAt(revision.Add(time.Microsecond))
	tx := &fakeFrequencyTx{rowResults: []pgx.Row{
		&fakeRuleRow{rule: frequencyRuleAt(revision)},
		&fakeRuleRow{rule: updated},
	}}
	var audits []capturedFrequencyAudit
	d := depsForFrequencyTx(tx, &audits, errors.New("audit unavailable"))
	router := chi.NewRouter()
	MountRoutes(router, d)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, frequencyRequest(
		http.MethodPatch,
		"/api/v1/sending/frequency-caps/"+frequencyTestRuleID,
		`{"active":false,"expected_updated_at":"2026-08-30T10:15:16Z"}`,
		"admin",
	))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure response = %d %s", recorder.Code, recorder.Body.String())
	}
	if tx.commits != 0 || tx.rollbacks != 1 || len(audits) != 1 {
		t.Fatalf("audit failure transaction = commits:%d rollbacks:%d audits:%d", tx.commits, tx.rollbacks, len(audits))
	}
}

func TestFrequencyRuleCursorsReturnScanAndIterationErrors(t *testing.T) {
	scanErr := errors.New("scan failed")
	rowErr := errors.New("cursor failed")
	for _, tc := range []struct {
		name string
		rows pgx.Rows
		call func(context.Context, pgx.Tx) error
		want error
	}{
		{
			name: "active rules scan", rows: &fakeRuleRows{scanErrors: []error{scanErr}}, want: scanErr,
			call: func(ctx context.Context, tx pgx.Tx) error {
				_, err := listActiveRules(ctx, tx, frequencyTestTenantID)
				return err
			},
		},
		{
			name: "active rules cursor", rows: &fakeRuleRows{rowErr: rowErr}, want: rowErr,
			call: func(ctx context.Context, tx pgx.Tx) error {
				_, err := listActiveRules(ctx, tx, frequencyTestTenantID)
				return err
			},
		},
		{
			name: "over cap scan", rows: &fakeEmailRows{scanErrors: []error{scanErr}}, want: scanErr,
			call: func(ctx context.Context, tx pgx.Tx) error {
				_, err := overCapEmails(ctx, tx, frequencyTestTenantID, []string{"a@example.test"}, Rule{MaxSends: 1, WindowHours: 24})
				return err
			},
		},
		{
			name: "over cap cursor", rows: &fakeEmailRows{rowErr: rowErr}, want: rowErr,
			call: func(ctx context.Context, tx pgx.Tx) error {
				_, err := overCapEmails(ctx, tx, frequencyTestTenantID, []string{"a@example.test"}, Rule{MaxSends: 1, WindowHours: 24})
				return err
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &fakeFrequencyTx{queryRows: tc.rows}
			if err := tc.call(context.Background(), tx); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want wrapped %v", err, tc.want)
			}
		})
	}
}
