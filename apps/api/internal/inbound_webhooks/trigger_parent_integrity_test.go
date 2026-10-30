// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestInboundTriggerParentIntegrityMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1792_inbound_webhook_trigger_parent_integrity.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1792: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1792_inbound_webhook_trigger_parent_integrity",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1792 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"migration-execution: phased",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS",
		"ON inbound_webhook_endpoints (tenant_id, id)",
		"inbound_webhook_triggers_tenant_endpoint_fkey",
		"FOREIGN KEY (tenant_id, webhook_id)",
		"REFERENCES inbound_webhook_endpoints (tenant_id, id)",
		"ON DELETE CASCADE",
		"NOT VALID",
		"VALIDATE CONSTRAINT inbound_webhook_triggers_tenant_endpoint_fkey",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1792 missing contract %q", contract)
		}
	}
	lower := strings.ToLower(sql)
	if strings.Contains(lower, "delete from inbound_webhook_triggers") ||
		strings.Contains(lower, "update inbound_webhook_triggers") {
		t.Fatal("migration must fail on historical ownership corruption, not mutate it")
	}
}

func TestInboundTriggerPlanningRequiresEnabledLiveParentContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	dir := filepath.Dir(source)
	repoRaw, err := os.ReadFile(filepath.Join(dir, "repo.go"))
	if err != nil {
		t.Fatal(err)
	}
	actionRaw, err := os.ReadFile(filepath.Join(dir, "action_outbox_repo.go"))
	if err != nil {
		t.Fatal(err)
	}
	repoSource := string(repoRaw)
	actionSource := string(actionRaw)
	for _, contract := range []string{
		"func lockNondeletedInboundEndpoint(",
		"if err := lockNondeletedInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil",
		"AND endpoint.deleted_at IS NULL",
	} {
		if !strings.Contains(repoSource, contract) {
			t.Errorf("nested admin parent guard missing %q", contract)
		}
	}
	if count := strings.Count(
		repoSource,
		"lockNondeletedInboundEndpoint(ctx, tx, tenantID, webhookID)",
	); count < 4 {
		t.Errorf("trigger admin parent locks = %d, want at least 4", count)
	}
	for _, contract := range []string{
		"func lockEnabledInboundEndpoint(",
		"AND enabled = true",
		"AND deleted_at IS NULL",
		"FOR SHARE",
		"if err := lockEnabledInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil",
	} {
		if !strings.Contains(repoSource, contract) {
			t.Errorf("repository lifecycle guard missing %q", contract)
		}
	}
	for _, contract := range []string{
		"if err := lockEnabledInboundEndpoint(ctx, tx, tenantID, endpointID); err != nil",
		"JOIN inbound_webhook_endpoints AS endpoint",
		"AND endpoint.enabled = true",
		"AND endpoint.deleted_at IS NULL",
		"FOR SHARE OF trigger",
	} {
		if !strings.Contains(actionSource, contract) {
			t.Errorf("durable trigger planner lifecycle guard missing %q", contract)
		}
	}
	if count := strings.Count(
		actionSource,
		"lockEnabledInboundEndpoint(ctx, tx, tenantID, endpointID)",
	); count < 2 {
		t.Errorf("durable receive/replay parent locks = %d, want at least 2", count)
	}
}

type recordingTriggerAdminRepository struct {
	listErr   error
	createErr error
	updateErr error
	deleteErr error

	operation string
	tenantID  string
	webhookID string
	triggerID string
}

func (r *recordingTriggerAdminRepository) record(operation, tenantID, webhookID, triggerID string) {
	r.operation = operation
	r.tenantID = tenantID
	r.webhookID = webhookID
	r.triggerID = triggerID
}

func (r *recordingTriggerAdminRepository) ListTriggers(
	_ context.Context,
	tenantID, webhookID string,
) ([]Trigger, error) {
	r.record("list", tenantID, webhookID, "")
	if r.listErr != nil {
		return nil, r.listErr
	}
	return []Trigger{}, nil
}

func (r *recordingTriggerAdminRepository) CreateTrigger(
	_ context.Context,
	tenantID, webhookID string,
	in Trigger,
) (*Trigger, error) {
	r.record("create", tenantID, webhookID, "")
	if r.createErr != nil {
		return nil, r.createErr
	}
	in.ID = "trigger-created"
	in.TenantID = tenantID
	in.WebhookID = webhookID
	return &in, nil
}

func (r *recordingTriggerAdminRepository) UpdateTrigger(
	_ context.Context,
	tenantID, webhookID, triggerID string,
	_ TriggerPatch,
) (*Trigger, error) {
	r.record("update", tenantID, webhookID, triggerID)
	if r.updateErr != nil {
		return nil, r.updateErr
	}
	return &Trigger{
		ID:        triggerID,
		TenantID:  tenantID,
		WebhookID: webhookID,
	}, nil
}

func (r *recordingTriggerAdminRepository) DeleteTrigger(
	_ context.Context,
	tenantID, webhookID, triggerID string,
) error {
	r.record("delete", tenantID, webhookID, triggerID)
	return r.deleteErr
}

func triggerHandlerRequest(method, path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-a"})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "webhook-parent")
	routeCtx.URLParams.Add("tid", "trigger-child")
	ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

const validTriggerCreateBody = `{
	"name":"Tag paid customer",
	"match_jsonpath":"$.status",
	"match_operator":"equals",
	"match_value":"paid",
	"email_jsonpath":"$.email",
	"action_type":"add_tag",
	"action_target_id":"paid"
}`

func TestTriggerHandlersForwardBothParentAndChildIdentity(t *testing.T) {
	tests := []struct {
		name          string
		method        string
		body          string
		wantOperation string
		wantStatus    int
		invoke        func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{
			name:          "list",
			method:        http.MethodGet,
			wantOperation: "list",
			wantStatus:    http.StatusOK,
			invoke:        (*Deps).ListTriggers,
		},
		{
			name:          "create",
			method:        http.MethodPost,
			body:          validTriggerCreateBody,
			wantOperation: "create",
			wantStatus:    http.StatusCreated,
			invoke:        (*Deps).CreateTrigger,
		},
		{
			name:          "update",
			method:        http.MethodPatch,
			body:          `{"active":false}`,
			wantOperation: "update",
			wantStatus:    http.StatusOK,
			invoke:        (*Deps).UpdateTrigger,
		},
		{
			name:          "delete",
			method:        http.MethodDelete,
			wantOperation: "delete",
			wantStatus:    http.StatusOK,
			invoke:        (*Deps).DeleteTrigger,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &recordingTriggerAdminRepository{}
			deps := &Deps{triggerAdminRepo: repo}
			rec := httptest.NewRecorder()
			req := triggerHandlerRequest(tt.method, "/api/v1/inbound-webhooks/webhook-parent/triggers/trigger-child", tt.body)

			tt.invoke(deps, rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if repo.operation != tt.wantOperation ||
				repo.tenantID != "tenant-a" ||
				repo.webhookID != "webhook-parent" {
				t.Fatalf(
					"forwarded operation/tenant/parent = %q/%q/%q",
					repo.operation,
					repo.tenantID,
					repo.webhookID,
				)
			}
			if (tt.wantOperation == "update" || tt.wantOperation == "delete") &&
				repo.triggerID != "trigger-child" {
				t.Fatalf("forwarded child = %q, want trigger-child", repo.triggerID)
			}
		})
	}
}

func TestTriggerHandlersReturn404ForMissingParentOrChild(t *testing.T) {
	tests := []struct {
		name   string
		method string
		body   string
		invoke func(*Deps, http.ResponseWriter, *http.Request)
		setup  func(*recordingTriggerAdminRepository)
	}{
		{
			name:   "list missing parent",
			method: http.MethodGet,
			invoke: (*Deps).ListTriggers,
			setup:  func(r *recordingTriggerAdminRepository) { r.listErr = ErrNotFound },
		},
		{
			name:   "create missing parent",
			method: http.MethodPost,
			body:   validTriggerCreateBody,
			invoke: (*Deps).CreateTrigger,
			setup:  func(r *recordingTriggerAdminRepository) { r.createErr = ErrNotFound },
		},
		{
			name:   "update wrong parent or child",
			method: http.MethodPatch,
			body:   `{"active":false}`,
			invoke: (*Deps).UpdateTrigger,
			setup:  func(r *recordingTriggerAdminRepository) { r.updateErr = ErrNotFound },
		},
		{
			name:   "delete wrong parent or child",
			method: http.MethodDelete,
			invoke: (*Deps).DeleteTrigger,
			setup:  func(r *recordingTriggerAdminRepository) { r.deleteErr = ErrNotFound },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &recordingTriggerAdminRepository{}
			tt.setup(repo)
			deps := &Deps{triggerAdminRepo: repo}
			rec := httptest.NewRecorder()
			req := triggerHandlerRequest(tt.method, "/api/v1/inbound-webhooks/webhook-parent/triggers/trigger-child", tt.body)

			tt.invoke(deps, rec, req)

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"not_found"`) {
				t.Fatalf("response does not contain stable not_found code: %s", rec.Body.String())
			}
		})
	}
}

func TestTriggerRepositoryRejectsMalformedNestedIDsBeforeDatabaseUse(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.ListTriggers(t.Context(), "tenant", "not-a-uuid"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed list parent error = %v", err)
	}
	if _, err := repo.CreateTrigger(t.Context(), "tenant", "not-a-uuid", Trigger{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed create parent error = %v", err)
	}
	if _, err := repo.UpdateTrigger(
		t.Context(),
		"tenant",
		"not-a-uuid",
		"also-not-a-uuid",
		TriggerPatch{},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed update identity error = %v", err)
	}
	if err := repo.DeleteTrigger(
		t.Context(),
		"tenant",
		"not-a-uuid",
		"also-not-a-uuid",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed delete identity error = %v", err)
	}
}

func TestInboundTriggerParentIntegrityDatabase(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping inbound trigger parent-integrity database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var migrationPresent bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'inbound_webhook_triggers'::regclass
       AND conname = 'inbound_webhook_triggers_tenant_endpoint_fkey'
       AND convalidated
)`).Scan(&migrationPresent); err != nil || !migrationPresent {
		t.Fatalf("migration 1792 is not applied")
	}

	tenantA := createInboundWebhookTestTenant(t, ctx, pool)
	tenantB := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	prefix := "trigger-parent-" + randHex4IW(t)
	endpointA, err := repo.Create(ctx, tenantA, prefix+"-a")
	if err != nil {
		t.Fatal(err)
	}
	endpointAOther, err := repo.Create(ctx, tenantA, prefix+"-a-other")
	if err != nil {
		t.Fatal(err)
	}
	endpointB, err := repo.Create(ctx, tenantB, prefix+"-b")
	if err != nil {
		t.Fatal(err)
	}

	expected := "paid"
	input := Trigger{
		Name:           "Tag paid customer",
		Active:         true,
		MatchJSONPath:  "$.status",
		MatchOperator:  OpEquals,
		MatchValue:     &expected,
		EmailJSONPath:  "$.email",
		ActionType:     ActionAddTag,
		ActionTargetID: "paid",
	}
	if _, err := repo.CreateTrigger(ctx, tenantA, endpointB.Endpoint.ID, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant parent create error = %v, want ErrNotFound", err)
	}

	// The schema must reject the same corruption even if application repository
	// checks are bypassed.
	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	_, directErr := tx.Exec(ctx, `
INSERT INTO inbound_webhook_triggers (
    tenant_id, webhook_id, name, active, match_jsonpath, match_operator,
    match_value, email_jsonpath, action_type, action_target_id
) VALUES (
    $1::uuid, $2::uuid, 'cross-tenant direct insert', true, '$.status',
    'equals', 'paid', '$.email', 'add_tag', 'paid'
)`, tenantA, endpointB.Endpoint.ID)
	_ = tx.Rollback(ctx)
	var pgErr *pgconn.PgError
	if !errors.As(directErr, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("direct cross-tenant insert error = %v, want foreign-key violation", directErr)
	}

	trigger, err := repo.CreateTrigger(ctx, tenantA, endpointA.Endpoint.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if trigger.TenantID != tenantA || trigger.WebhookID != endpointA.Endpoint.ID {
		t.Fatalf("created trigger ownership = %s/%s", trigger.TenantID, trigger.WebhookID)
	}

	invalidCreate := input
	invalidCreate.MatchOperator = OpRegex
	invalidRegex := "["
	invalidCreate.MatchValue = &invalidRegex
	if _, err := repo.CreateTrigger(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		invalidCreate,
	); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("invalid regex create error = %v, want ErrInvalidTrigger", err)
	}

	regexOperator := OpRegex
	if _, err := repo.UpdateTrigger(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		trigger.ID,
		TriggerPatch{
			MatchOperator: &regexOperator,
			MatchValue:    &invalidRegex,
		},
	); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("invalid regex update error = %v, want ErrInvalidTrigger", err)
	}
	startAutomation := ActionStartAutomation
	if _, err := repo.UpdateTrigger(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		trigger.ID,
		TriggerPatch{ActionType: &startAutomation},
	); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("invalid action target update error = %v, want ErrInvalidTrigger", err)
	}

	activeItems, err := repo.ListActive(ctx, tenantA, endpointA.Endpoint.ID)
	if err != nil || len(activeItems) != 1 || activeItems[0].ID != trigger.ID {
		t.Fatalf("enabled parent active triggers = %#v, err=%v", activeItems, err)
	}
	disabled := false
	if _, err := repo.UpdateEndpoint(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		EndpointPatch{Enabled: &disabled},
	); err != nil {
		t.Fatalf("disable parent: %v", err)
	}
	if _, err := repo.ListActive(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("disabled parent ListActive error = %v, want ErrNotFound", err)
	}
	header := http.Header{
		"X-Postwave-Event-Id": []string{"disabled-parent-" + randHex4IW(t)},
	}
	replayKey, err := inboundWebhookReplayKey(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := repo.RecordEventWithActions(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		[]byte(`{}`),
		[]byte(`{"status":"paid","email":"blocked@example.com"}`),
		true,
		replayKey,
		RecordEventOptions{},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("disabled parent action planning error = %v, want ErrNotFound", err)
	}
	enabled := true
	if _, err := repo.UpdateEndpoint(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		EndpointPatch{Enabled: &enabled},
	); err != nil {
		t.Fatalf("re-enable parent: %v", err)
	}

	if _, err := repo.ListTriggers(ctx, tenantA, endpointB.Endpoint.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant list error = %v, want ErrNotFound", err)
	}
	if _, err := repo.ListTriggers(ctx, tenantA, "not-a-uuid"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed parent list error = %v, want ErrNotFound", err)
	}

	renamed := "must not apply"
	if _, err := repo.UpdateTrigger(
		ctx,
		tenantA,
		endpointAOther.Endpoint.ID,
		trigger.ID,
		TriggerPatch{Name: &renamed},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-parent update error = %v, want ErrNotFound", err)
	}
	if err := repo.DeleteTrigger(
		ctx,
		tenantA,
		endpointAOther.Endpoint.ID,
		trigger.ID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-parent delete error = %v, want ErrNotFound", err)
	}
	if err := repo.DeleteTrigger(
		ctx,
		tenantB,
		endpointB.Endpoint.ID,
		trigger.ID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant child delete error = %v, want ErrNotFound", err)
	}

	items, err := repo.ListTriggers(ctx, tenantA, endpointA.Endpoint.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != trigger.ID || items[0].Name != input.Name {
		t.Fatalf("wrong-parent mutations changed trigger: %#v", items)
	}

	renamed = "Scoped update"
	if _, err := repo.UpdateTrigger(
		ctx,
		tenantA,
		endpointA.Endpoint.ID,
		trigger.ID,
		TriggerPatch{Name: &renamed},
	); err != nil {
		t.Fatalf("valid parent-scoped update: %v", err)
	}
	if err := repo.DeleteTrigger(ctx, tenantA, endpointA.Endpoint.ID, trigger.ID); err != nil {
		t.Fatalf("valid parent-scoped delete: %v", err)
	}
}
