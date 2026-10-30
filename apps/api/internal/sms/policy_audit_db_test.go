// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type forbiddenSuppressionQueryReplayStore struct{}

func (forbiddenSuppressionQueryReplayStore) Get(context.Context, string, string) (*idempotency.Record, error) {
	panic("exact suppression query consulted the idempotency store")
}

func (forbiddenSuppressionQueryReplayStore) Claim(context.Context, *idempotency.Record) (bool, error) {
	panic("exact suppression query claimed an idempotency key")
}

func (forbiddenSuppressionQueryReplayStore) Complete(context.Context, *idempotency.Record) error {
	panic("exact suppression query completed an idempotency record")
}

func (forbiddenSuppressionQueryReplayStore) DeletePending(context.Context, string, string) error {
	panic("exact suppression query deleted an idempotency record")
}

func smsPolicyVersionBody(t *testing.T, expected time.Time, changes map[string]any) string {
	t.Helper()
	body := make(map[string]any, len(changes)+1)
	for key, value := range changes {
		body[key] = value
	}
	body["expected_updated_at"] = expected.UTC().Format(time.RFC3339Nano)
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode policy version body: %v", err)
	}
	return string(raw)
}

func countSMSPolicyRows(t *testing.T, pool *db.Pool, tenantID, table string) int {
	t.Helper()
	if table != "sms_quiet_hours" && table != "sms_keyword_responses" {
		t.Fatalf("unexpected policy table %q", table)
	}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*)::int FROM "+table+" WHERE tenant_id=$1::uuid", tenantID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func route42OptOutKeyword(keyword string, enabled bool) KeywordResponse {
	return KeywordResponse{
		Keyword:      keyword,
		ResponseBody: optOutConfirmationBody,
		ResponseText: optOutConfirmationBody,
		Action:       KeywordActionOptOut,
		Enabled:      enabled,
	}
}

func TestSMSPolicyMutationRollsBackWhenAuditAppendFails(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	badAudit := db.AuditMeta{TenantID: f.tenantID, ActorType: "not-a-valid-audit-actor"}

	rule := defaultQuietHoursRule()
	rule.Label = "audit rollback"
	if err := applyQuietHoursInput(&rule, QuietHoursInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateQuietHours(context.Background(), f.tenantID, rule, badAudit); err == nil {
		t.Fatal("quiet-hours policy committed despite audit append failure")
	}
	if got := countSMSPolicyRows(t, pool, f.tenantID, "sms_quiet_hours"); got != 0 {
		t.Fatalf("quiet-hours rows after failed audit = %d, want 0", got)
	}

	keyword := route42OptOutKeyword("AUDITROLLBACK", true)
	if err := applyKeywordResponseInput(&keyword, KeywordResponseInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateKeywordResponse(context.Background(), f.tenantID, keyword, badAudit); err == nil {
		t.Fatal("keyword-response policy committed despite audit append failure")
	}
	if got := countSMSPolicyRows(t, pool, f.tenantID, "sms_keyword_responses"); got != 0 {
		t.Fatalf("keyword-response rows after failed audit = %d, want 0", got)
	}

	goodAudit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "policy-audit-test"}
	quiet, err := store.CreateQuietHours(context.Background(), f.tenantID, rule, goodAudit)
	if err != nil {
		t.Fatalf("seed audited quiet-hours policy: %v", err)
	}
	quiet.Label = "must roll back"
	if _, err := store.UpdateQuietHours(context.Background(), f.tenantID, quiet, quiet.UpdatedAt, badAudit); err == nil {
		t.Fatal("quiet-hours update committed despite audit append failure")
	}
	storedQuiet, err := store.GetQuietHours(context.Background(), f.tenantID, quiet.ID)
	if err != nil || storedQuiet.Label != "audit rollback" {
		t.Fatalf("quiet-hours state after failed update = %#v err=%v", storedQuiet, err)
	}
	if _, err := store.DeleteQuietHours(context.Background(), f.tenantID, quiet.ID, quiet.UpdatedAt, badAudit); err == nil {
		t.Fatal("quiet-hours delete committed despite audit append failure")
	}
	if _, err := store.GetQuietHours(context.Background(), f.tenantID, quiet.ID); err != nil {
		t.Fatalf("quiet-hours row missing after failed delete audit: %v", err)
	}

	createdKeyword, err := store.CreateKeywordResponse(context.Background(), f.tenantID, keyword, goodAudit)
	if err != nil {
		t.Fatalf("seed audited keyword-response policy: %v", err)
	}
	createdKeyword.Enabled = false
	if _, err := store.UpdateKeywordResponse(context.Background(), f.tenantID, createdKeyword, createdKeyword.UpdatedAt, badAudit); err == nil {
		t.Fatal("keyword-response update committed despite audit append failure")
	}
	storedKeyword, err := store.GetKeywordResponse(context.Background(), f.tenantID, createdKeyword.ID)
	if err != nil || !storedKeyword.Enabled || storedKeyword.ResponseBody != optOutConfirmationBody {
		t.Fatalf("keyword-response state after failed update = %#v err=%v", storedKeyword, err)
	}
	if _, err := store.DeleteKeywordResponse(context.Background(), f.tenantID, createdKeyword.ID, createdKeyword.UpdatedAt, badAudit); err == nil {
		t.Fatal("keyword-response delete committed despite audit append failure")
	}
	if _, err := store.GetKeywordResponse(context.Background(), f.tenantID, createdKeyword.ID); err != nil {
		t.Fatalf("keyword-response row missing after failed delete audit: %v", err)
	}
}

func TestSMSPolicyReadAuditFailureReturnsNoPolicyPayload(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	meta := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "policy-read-audit-test"}
	rule := defaultQuietHoursRule()
	rule.Label = "private schedule"
	if err := applyQuietHoursInput(&rule, QuietHoursInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateQuietHours(context.Background(), f.tenantID, rule, meta); err != nil {
		t.Fatalf("seed quiet-hours policy: %v", err)
	}

	keyword := route42OptOutKeyword("PRIVATEPOLICY", true)
	if err := applyKeywordResponseInput(&keyword, KeywordResponseInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateKeywordResponse(context.Background(), f.tenantID, keyword, meta); err != nil {
		t.Fatalf("seed keyword-response policy: %v", err)
	}

	d := &Deps{Store: store}
	for _, tc := range []struct {
		name, path, privateValue string
		handler                  func(http.ResponseWriter, *http.Request)
	}{
		{"quiet hours", "/api/v1/sms/quiet-hours", "private schedule", d.ListQuietHours},
		{"keyword responses", "/api/v1/sms/keyword-responses", "PRIVATEPOLICY", d.ListKeywordResponses},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID})
			ctx = middleware.WithActor(ctx, "not-a-valid-audit-actor", "policy-read-audit-test")
			req = req.WithContext(ctx)
			rec := httptest.NewRecorder()
			tc.handler(rec, req)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500 after fail-closed read audit: %s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), tc.privateValue) || strings.Contains(rec.Body.String(), `"items"`) {
				t.Fatalf("read audit failure leaked policy payload: %s", rec.Body.String())
			}
		})
	}
}

func TestSMSPolicyListEnvelopesAreStrictAndTenantBoundWhenEmpty(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	d := &Deps{Store: store}

	for _, tc := range []struct {
		name, path string
		handler    http.HandlerFunc
	}{
		{"quiet hours", "/api/v1/sms/quiet-hours", d.ListQuietHours},
		{"keyword responses", "/api/v1/sms/keyword-responses", d.ListKeywordResponses},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
			rec := httptest.NewRecorder()
			protectSMSInboxResponse(tc.handler).ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("list status = %d: %s", rec.Code, rec.Body.String())
			}
			var envelope map[string]json.RawMessage
			if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode list envelope: %v", err)
			}
			if len(envelope) != 2 {
				t.Fatalf("list envelope fields = %#v, want exactly tenantId/items", envelope)
			}
			var tenantID string
			var items []json.RawMessage
			if err := json.Unmarshal(envelope["tenantId"], &tenantID); err != nil || tenantID != f.tenantID {
				t.Fatalf("list tenantId = %q err=%v", tenantID, err)
			}
			if err := json.Unmarshal(envelope["items"], &items); err != nil || len(items) != 0 {
				t.Fatalf("empty list items = %#v err=%v", items, err)
			}
			for _, key := range []string{"tenantId", "items"} {
				if _, ok := envelope[key]; !ok {
					t.Fatalf("list envelope missing %q: %#v", key, envelope)
				}
			}
		})
	}
}

func seedHistoricalCountryScopedQuietHours(t *testing.T, pool *db.Pool, tenantID string, enabled bool) string {
	t.Helper()
	ctx := context.Background()
	insert := `INSERT INTO sms_quiet_hours
		(tenant_id,label,country_code,start_local,end_local,days,timezone,enabled)
		VALUES ($1::uuid,$2,'US',time '21:00',time '09:00',ARRAY[1]::int[],'UTC',$3)
		RETURNING id::text`
	label := fmt.Sprintf("historical scoped rule enabled=%t", enabled)

	// A pre-1994 fixture database accepts the historical state directly. A
	// fully migrated database correctly rejects it, so use an admin connection
	// with triggers suspended solely to model a row that predates the guard.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	err = tx.QueryRow(ctx, insert, tenantID, label, enabled).Scan(&id)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit historical scoped rule: %v", err)
		}
		return id
	}
	_ = tx.Rollback(ctx)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" ||
		pgErr.ConstraintName != "sms_quiet_hours_country_scope_write_guard" {
		t.Fatalf("seed historical scoped rule: %v", err)
	}

	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Fatalf("POSTWAVE_TEST_ADMIN_DATABASE_URL is required to seed a pre-guard quiet-hours row on a fully migrated database")
	}
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse admin database URL: %v", err)
	}
	adminConfig.Database = pool.Config().ConnConfig.Database
	admin, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect admin historical fixture: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()
	adminTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin admin historical fixture: %v", err)
	}
	defer func() { _ = adminTx.Rollback(ctx) }()
	if _, err := adminTx.Exec(ctx, `SET LOCAL session_replication_role = 'replica'`); err != nil {
		t.Fatalf("suspend current write guard for historical fixture: %v", err)
	}
	if err := adminTx.QueryRow(ctx, insert, tenantID, label, enabled).Scan(&id); err != nil {
		t.Fatalf("seed historical scoped rule with admin fixture: %v", err)
	}
	if err := adminTx.Commit(ctx); err != nil {
		t.Fatalf("commit admin historical fixture: %v", err)
	}
	return id
}

func TestHistoricalCountryScopeRequiresAtomicDisableAndClear(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	audit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "country-repair-test"}

	unsupportedCreate := defaultQuietHoursRule()
	unsupportedCreate.CountryCode = "US"
	if _, err := store.CreateQuietHours(ctx, f.tenantID, unsupportedCreate, audit); !errors.Is(err, errSMSQuietCountryScopeHeld) {
		t.Fatalf("direct scoped create error = %v, want release hold", err)
	}
	if got := countSMSPolicyRows(t, pool, f.tenantID, "sms_quiet_hours"); got != 0 {
		t.Fatalf("direct scoped create persisted %d rows", got)
	}

	for _, currentEnabled := range []bool{true, false} {
		currentEnabled := currentEnabled
		t.Run(fmt.Sprintf("current_enabled=%t", currentEnabled), func(t *testing.T) {
			id := seedHistoricalCountryScopedQuietHours(t, pool, f.tenantID, currentEnabled)
			legacy, err := store.GetQuietHours(ctx, f.tenantID, id)
			if err != nil {
				t.Fatalf("read historical scoped rule: %v", err)
			}

			clearAndEnable := legacy
			clearAndEnable.CountryCode = ""
			clearAndEnable.Enabled = true
			if _, err := store.UpdateQuietHours(ctx, f.tenantID, clearAndEnable, legacy.UpdatedAt, audit); !errors.Is(err, errSMSQuietCountryScopeHeld) {
				t.Fatalf("direct clear-and-enable error = %v, want release hold", err)
			}
			retainedScope := legacy
			retainedScope.Enabled = false
			if _, err := store.UpdateQuietHours(ctx, f.tenantID, retainedScope, legacy.UpdatedAt, audit); !errors.Is(err, errSMSQuietCountryScopeHeld) {
				t.Fatalf("direct retained-scope update error = %v, want release hold", err)
			}
			directUnchanged, err := store.GetQuietHours(ctx, f.tenantID, id)
			if err != nil || directUnchanged.CountryCode != legacy.CountryCode || directUnchanged.Enabled != legacy.Enabled ||
				directUnchanged.Label != legacy.Label || !directUnchanged.UpdatedAt.Equal(legacy.UpdatedAt) {
				t.Fatalf("direct rejected writes changed historical row: %#v err=%v", directUnchanged, err)
			}

			d := &Deps{Store: store}
			path := "/api/v1/sms/quiet-hours/" + id
			patch := func(changes map[string]any) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(smsPolicyVersionBody(t, legacy.UpdatedAt, changes)))
				req.Header.Set("Content-Type", "application/json")
				req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
				req = withSMSRouteParam(req, "id", id)
				rec := httptest.NewRecorder()
				d.UpdateQuietHours(rec, req)
				return rec
			}
			for name, changes := range map[string]map[string]any{
				"country only":          {"country_code": ""},
				"explicitly enabled":    {"country_code": "", "enabled": true},
				"disable without clear": {"enabled": false},
			} {
				rec := patch(changes)
				if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"code":"country_scope_release_held"`) {
					t.Fatalf("%s status/body = %d %s", name, rec.Code, rec.Body.String())
				}
				unchanged, err := store.GetQuietHours(ctx, f.tenantID, id)
				if err != nil || unchanged.CountryCode != legacy.CountryCode || unchanged.Enabled != legacy.Enabled ||
					unchanged.Label != legacy.Label || !unchanged.UpdatedAt.Equal(legacy.UpdatedAt) {
					t.Fatalf("%s changed historical row: %#v err=%v", name, unchanged, err)
				}
			}

			rec := patch(map[string]any{"country_code": "", "enabled": false})
			if rec.Code != http.StatusOK {
				t.Fatalf("atomic country repair status/body = %d %s", rec.Code, rec.Body.String())
			}
			var receiptFields map[string]json.RawMessage
			if err := json.Unmarshal(rec.Body.Bytes(), &receiptFields); err != nil {
				t.Fatalf("decode atomic country repair receipt: %v", err)
			}
			expectedFields := []string{
				"id", "tenant_id", "label", "country_code", "start_minute", "end_minute",
				"start_local", "end_local", "days", "timezone", "enabled", "created_at", "updated_at",
			}
			if len(receiptFields) != len(expectedFields) {
				t.Fatalf("atomic country repair receipt fields = %#v", receiptFields)
			}
			for _, key := range expectedFields {
				if _, ok := receiptFields[key]; !ok {
					t.Fatalf("atomic country repair receipt missing %q: %#v", key, receiptFields)
				}
			}
			var repaired QuietHoursRule
			if err := json.Unmarshal(rec.Body.Bytes(), &repaired); err != nil {
				t.Fatalf("decode atomic country repair rule: %v", err)
			}
			if repaired.ID != id || repaired.TenantID != f.tenantID || repaired.CountryCode != "" || repaired.Enabled ||
				!repaired.UpdatedAt.After(legacy.UpdatedAt) || !validQuietHoursProjection(repaired) {
				t.Fatalf("atomic country repair receipt = %#v", repaired)
			}
			stored, err := store.GetQuietHours(ctx, f.tenantID, id)
			if err != nil || stored.CountryCode != "" || stored.Enabled || !stored.UpdatedAt.Equal(repaired.UpdatedAt) {
				t.Fatalf("stored atomic country repair = %#v err=%v", stored, err)
			}
		})
	}
}

func TestSuppressionExactLookupAuditNeverPersistsCallerSuppliedPhone(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	if _, err := store.AddSuppression(context.Background(), f.tenantID, f.phone, "manual", nil); err != nil {
		t.Fatalf("seed suppression: %v", err)
	}

	key := []byte("0123456789abcdef0123456789abcdef")
	// An exact unique-key lookup has no cursor and must not depend on cursor
	// encryption configuration. Only the keyed audit fingerprint is required.
	d := &Deps{Store: store, InboxAuditFingerprintKey: key}
	tenantResolverCalls := 0
	query := idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
		forbiddenSuppressionQueryReplayStore{},
		func(*http.Request) (string, bool) {
			tenantResolverCalls++
			return f.tenantID, true
		},
		SuppressionExactQueryReplayBypass,
		nil,
		nil,
	)(middleware.AuditMiddleware(pool)(http.HandlerFunc(d.QuerySuppressions)))
	tests := []struct {
		name string
		keys []string
	}{
		{name: "ordinary auto key", keys: []string{"same-auto-key"}},
		{name: "same auto key retry", keys: []string{"same-auto-key"}},
		{name: "malformed auto key", keys: []string{" malformed "}},
		{name: "duplicate auto key", keys: []string{"duplicate-a", "duplicate-b"}},
	}
	for _, test := range tests {
		req := httptest.NewRequest(http.MethodPost, suppressionExactQueryPath, strings.NewReader(`{"phone":"`+f.phone+`"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Postwave-Audit-Reason", f.phone)
		for _, idempotencyKey := range test.keys {
			req.Header.Add(idempotency.HeaderName, idempotencyKey)
		}
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
		rec := httptest.NewRecorder()
		query.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s exact query status = %d: %s", test.name, rec.Code, rec.Body.String())
		}
		var page SuppressionsResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatalf("%s decode exact suppression page: %v", test.name, err)
		}
		if page.Total != 1 || len(page.Items) != 1 || page.NextCursor != "" {
			t.Fatalf("%s exact suppression page was paginated or incomplete: %#v", test.name, page)
		}
	}
	if tenantResolverCalls != 0 {
		t.Fatalf("exact suppression query reached idempotency tenant resolver %d times", tenantResolverCalls)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var resourceType, resourceID, metadata string
	if err := tx.QueryRow(ctx, `
		SELECT resource_type, resource_id, metadata::text
		  FROM audit_log
		 WHERE tenant_id=$1::uuid AND action='sms.suppressions.query'
		 ORDER BY id DESC LIMIT 1`, f.tenantID).Scan(&resourceType, &resourceID, &metadata); err != nil {
		t.Fatalf("read exact-query audit: %v", err)
	}
	if resourceType != "sms_suppression_registry" || !strings.HasPrefix(resourceID, "hmac-sha256-v1:") {
		t.Fatalf("exact-query audit identity = (%q,%q)", resourceType, resourceID)
	}
	if strings.Contains(resourceID, f.phone) || strings.Contains(metadata, f.phone) {
		t.Fatalf("exact-query audit persisted raw phone: resource=%q metadata=%s", resourceID, metadata)
	}
	if !strings.Contains(metadata, `"reason": "operator_sms_suppression_registry_read"`) &&
		!strings.Contains(metadata, `"reason":"operator_sms_suppression_registry_read"`) {
		t.Fatalf("exact-query audit did not use fixed route reason: %s", metadata)
	}
	var auditCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_log
		WHERE tenant_id=$1::uuid AND action='sms.suppressions.query'`, f.tenantID).Scan(&auditCount); err != nil {
		t.Fatalf("count exact-query audits: %v", err)
	}
	if auditCount != len(tests) {
		t.Fatalf("exact-query audit count=%d, want one fresh audit for each of %d requests", auditCount, len(tests))
	}
	var genericAuditCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_log
		WHERE tenant_id=$1::uuid AND action='http.post.api.v1.sms.suppressions.query'`, f.tenantID).Scan(&genericAuditCount); err != nil {
		t.Fatalf("count generic exact-query audits: %v", err)
	}
	if genericAuditCount != 0 {
		t.Fatalf("read-only exact query emitted %d mutation-shaped generic audit rows", genericAuditCount)
	}
}

func TestKeywordCreateIsCreateOnlyUnderRetryAndConcurrency(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	audit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "keyword-create-test"}

	original := route42OptOutKeyword("CREATEONLY", false)
	created, err := store.CreateKeywordResponse(ctx, f.tenantID, original, audit)
	if err != nil {
		t.Fatalf("create original keyword policy: %v", err)
	}
	staleRetry := original
	staleRetry.Enabled = true
	if _, err := store.CreateKeywordResponse(ctx, f.tenantID, staleRetry, audit); !errors.Is(err, ErrSMSKeywordResponseExists) {
		t.Fatalf("duplicate create error = %v, want typed existing-policy conflict", err)
	}
	stored, err := store.GetKeywordResponse(ctx, f.tenantID, created.ID)
	if err != nil {
		t.Fatalf("reload original keyword policy: %v", err)
	}
	if stored.ResponseBody != original.ResponseBody || stored.Enabled != original.Enabled || !stored.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("duplicate POST overwrote/re-enabled policy: %#v", stored)
	}

	// The handler exposes the conflict without returning the existing private
	// row or accepting the stale values as an update receipt.
	d := &Deps{Store: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/keyword-responses", strings.NewReader(fmt.Sprintf(
		`{"keyword":"CREATEONLY","action":"opt_out","response_body":%q,"enabled":true}`,
		optOutConfirmationBody,
	)))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
	rec := httptest.NewRecorder()
	d.CreateKeywordResponse(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"keyword_response_exists"`) ||
		strings.Contains(rec.Body.String(), original.ResponseBody) {
		t.Fatalf("duplicate create handler status/body = %d %s", rec.Code, rec.Body.String())
	}

	// Concurrent first creates serialize on the tenant inventory lock. Exactly
	// one creates the row; the other receives the same typed conflict.
	concurrent := route42OptOutKeyword("CREATEONRACE", true)
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, createErr := store.CreateKeywordResponse(context.Background(), f.tenantID, concurrent, audit)
			errs <- createErr
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	createdCount, conflictCount := 0, 0
	for createErr := range errs {
		switch {
		case createErr == nil:
			createdCount++
		case errors.Is(createErr, ErrSMSKeywordResponseExists):
			conflictCount++
		default:
			t.Fatalf("concurrent create returned unexpected error: %v", createErr)
		}
	}
	if createdCount != 1 || conflictCount != 1 {
		t.Fatalf("concurrent create outcomes = success:%d conflict:%d", createdCount, conflictCount)
	}
}

func TestLegacyReplyOnlyPolicyRequiresAtomicReleasedConversion(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	// Historical reply_only rows remain readable and deletable, but the public
	// write surface may not extend or re-enable the held auto-reply effect. Seed
	// one directly to model a pre-release policy that the guarded Store would no
	// longer create.
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var legacyID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_keyword_responses
			(tenant_id, keyword, response_body, action, enabled)
		VALUES ($1::uuid, 'LEGACYHOSTED', 'legacy hosted reply', 'reply_only', true)
		RETURNING id::text`, f.tenantID).Scan(&legacyID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed legacy reply-only row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy reply-only row: %v", err)
	}

	legacy, err := store.GetKeywordResponse(ctx, f.tenantID, legacyID)
	if err != nil {
		t.Fatalf("read legacy reply-only row: %v", err)
	}
	if legacy.Action != KeywordActionReplyOnly || legacy.ResponseBody != "legacy hosted reply" || !legacy.Enabled {
		t.Fatalf("legacy row projection changed: %#v", legacy)
	}

	// The repository is a second authority boundary for non-HTTP callers.
	direct := legacy
	direct.Enabled = false
	audit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "legacy-policy-test"}
	if _, err := store.UpdateKeywordResponse(ctx, f.tenantID, direct, legacy.UpdatedAt, audit); !errors.Is(err, errSMSKeywordActionReleaseHeld) {
		t.Fatalf("direct legacy toggle error = %v, want release hold", err)
	}

	d := &Deps{Store: store}
	path := "/api/v1/sms/keyword-responses/" + legacyID
	patch := func(changes map[string]any) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(smsPolicyVersionBody(t, legacy.UpdatedAt, changes)))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
		req = withSMSRouteParam(req, "id", legacyID)
		rec := httptest.NewRecorder()
		d.UpdateKeywordResponse(rec, req)
		return rec
	}

	for name, changes := range map[string]map[string]any{
		"toggle only": {"enabled": false},
		"action only": {"action": KeywordActionOptOut},
		"body only":   {"response_body": optOutConfirmationBody},
	} {
		rec := patch(changes)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"code":"keyword_action_release_held"`) {
			t.Fatalf("%s status/body = %d %s", name, rec.Code, rec.Body.String())
		}
		unchanged, err := store.GetKeywordResponse(ctx, f.tenantID, legacyID)
		if err != nil || unchanged.Action != KeywordActionReplyOnly || unchanged.ResponseBody != legacy.ResponseBody ||
			!unchanged.Enabled || !unchanged.UpdatedAt.Equal(legacy.UpdatedAt) {
			t.Fatalf("%s changed legacy row: %#v err=%v", name, unchanged, err)
		}
	}

	rec := patch(map[string]any{
		"action":        KeywordActionOptOut,
		"response_body": optOutConfirmationBody,
		"enabled":       false,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("atomic legacy conversion status/body = %d %s", rec.Code, rec.Body.String())
	}
	var converted KeywordResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &converted); err != nil {
		t.Fatalf("decode conversion receipt: %v", err)
	}
	if converted.ID != legacyID || converted.TenantID != f.tenantID || converted.Action != KeywordActionOptOut ||
		converted.ResponseBody != optOutConfirmationBody || converted.ResponseText != optOutConfirmationBody ||
		converted.Enabled || !converted.UpdatedAt.After(legacy.UpdatedAt) {
		t.Fatalf("atomic conversion receipt = %#v", converted)
	}
	stored, err := store.GetKeywordResponse(ctx, f.tenantID, legacyID)
	if err != nil || stored.Action != KeywordActionOptOut || stored.ResponseBody != optOutConfirmationBody ||
		stored.Enabled || !stored.UpdatedAt.Equal(converted.UpdatedAt) {
		t.Fatalf("stored converted policy = %#v err=%v", stored, err)
	}
}

func TestSMSPolicyHandlersRejectStalePatchAndDeleteVersions(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	audit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "policy-version-test"}
	d := &Deps{Store: store}

	t.Run("quiet hours", func(t *testing.T) {
		rule := defaultQuietHoursRule()
		rule.Label = "captured quiet row"
		if err := applyQuietHoursInput(&rule, QuietHoursInput{}); err != nil {
			t.Fatal(err)
		}
		created, err := store.CreateQuietHours(ctx, f.tenantID, rule, audit)
		if err != nil {
			t.Fatalf("create quiet policy: %v", err)
		}
		path := "/api/v1/sms/quiet-hours/" + created.ID

		patch := func(body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
			req = withSMSRouteParam(req, "id", created.ID)
			rec := httptest.NewRecorder()
			d.UpdateQuietHours(rec, req)
			return rec
		}
		first := patch(smsPolicyVersionBody(t, created.UpdatedAt, map[string]any{"label": "winning quiet edit"}))
		if first.Code != http.StatusOK {
			t.Fatalf("fresh quiet PATCH status = %d: %s", first.Code, first.Body.String())
		}
		var winner QuietHoursRule
		if err := json.Unmarshal(first.Body.Bytes(), &winner); err != nil {
			t.Fatalf("decode quiet update: %v", err)
		}
		if !winner.UpdatedAt.After(created.UpdatedAt) {
			t.Fatalf("quiet version did not advance: old=%v new=%v", created.UpdatedAt, winner.UpdatedAt)
		}

		stale := patch(smsPolicyVersionBody(t, created.UpdatedAt, map[string]any{"label": "stale overwrite"}))
		if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), `"code":"policy_changed"`) {
			t.Fatalf("stale quiet PATCH status/body = %d %s", stale.Code, stale.Body.String())
		}
		stored, err := store.GetQuietHours(ctx, f.tenantID, created.ID)
		if err != nil || stored.Label != "winning quiet edit" || !stored.UpdatedAt.Equal(winner.UpdatedAt) {
			t.Fatalf("stale quiet PATCH changed row: %#v err=%v", stored, err)
		}

		deleteRequest := func(expected time.Time) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodDelete, path, strings.NewReader(smsPolicyVersionBody(t, expected, nil)))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
			req = withSMSRouteParam(req, "id", created.ID)
			rec := httptest.NewRecorder()
			d.DeleteQuietHours(rec, req)
			return rec
		}
		if rec := deleteRequest(created.UpdatedAt); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"policy_changed"`) {
			t.Fatalf("stale quiet DELETE status/body = %d %s", rec.Code, rec.Body.String())
		}
		if _, err := store.GetQuietHours(ctx, f.tenantID, created.ID); err != nil {
			t.Fatalf("stale quiet DELETE removed row: %v", err)
		}
		if rec := deleteRequest(winner.UpdatedAt); rec.Code != http.StatusOK {
			t.Fatalf("fresh quiet DELETE status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("keyword response and rename collision", func(t *testing.T) {
		firstInput := route42OptOutKeyword("VERSIONONE", true)
		secondInput := route42OptOutKeyword("VERSIONTWO", true)
		for _, row := range []*KeywordResponse{&firstInput, &secondInput} {
			if err := applyKeywordResponseInput(row, KeywordResponseInput{}); err != nil {
				t.Fatal(err)
			}
		}
		created, err := store.CreateKeywordResponse(ctx, f.tenantID, firstInput, audit)
		if err != nil {
			t.Fatalf("create first keyword policy: %v", err)
		}
		collisionTarget, err := store.CreateKeywordResponse(ctx, f.tenantID, secondInput, audit)
		if err != nil {
			t.Fatalf("create collision target: %v", err)
		}
		path := "/api/v1/sms/keyword-responses/" + created.ID
		patch := func(body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
			req = withSMSRouteParam(req, "id", created.ID)
			rec := httptest.NewRecorder()
			d.UpdateKeywordResponse(rec, req)
			return rec
		}

		collision := patch(smsPolicyVersionBody(t, created.UpdatedAt, map[string]any{"keyword": collisionTarget.Keyword}))
		if collision.Code != http.StatusConflict || !strings.Contains(collision.Body.String(), `"code":"keyword_response_exists"`) {
			t.Fatalf("keyword rename collision status/body = %d %s", collision.Code, collision.Body.String())
		}
		unchangedFirst, err := store.GetKeywordResponse(ctx, f.tenantID, created.ID)
		if err != nil || unchangedFirst.Keyword != created.Keyword || !unchangedFirst.UpdatedAt.Equal(created.UpdatedAt) {
			t.Fatalf("rename collision changed source row: %#v err=%v", unchangedFirst, err)
		}
		unchangedTarget, err := store.GetKeywordResponse(ctx, f.tenantID, collisionTarget.ID)
		if err != nil || unchangedTarget.ResponseBody != collisionTarget.ResponseBody || !unchangedTarget.UpdatedAt.Equal(collisionTarget.UpdatedAt) {
			t.Fatalf("rename collision changed target row: %#v err=%v", unchangedTarget, err)
		}

		first := patch(smsPolicyVersionBody(t, created.UpdatedAt, map[string]any{"enabled": false}))
		if first.Code != http.StatusOK {
			t.Fatalf("fresh keyword PATCH status = %d: %s", first.Code, first.Body.String())
		}
		var winner KeywordResponse
		if err := json.Unmarshal(first.Body.Bytes(), &winner); err != nil {
			t.Fatalf("decode keyword update: %v", err)
		}
		if !winner.UpdatedAt.After(created.UpdatedAt) {
			t.Fatalf("keyword version did not advance: old=%v new=%v", created.UpdatedAt, winner.UpdatedAt)
		}
		stale := patch(smsPolicyVersionBody(t, created.UpdatedAt, map[string]any{"keyword": "VERSIONSTALE"}))
		if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), `"code":"policy_changed"`) {
			t.Fatalf("stale keyword PATCH status/body = %d %s", stale.Code, stale.Body.String())
		}
		stored, err := store.GetKeywordResponse(ctx, f.tenantID, created.ID)
		if err != nil || stored.Enabled || stored.ResponseBody != optOutConfirmationBody || !stored.UpdatedAt.Equal(winner.UpdatedAt) {
			t.Fatalf("stale keyword PATCH changed row: %#v err=%v", stored, err)
		}

		deleteRequest := func(expected time.Time) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodDelete, path, strings.NewReader(smsPolicyVersionBody(t, expected, nil)))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
			req = withSMSRouteParam(req, "id", created.ID)
			rec := httptest.NewRecorder()
			d.DeleteKeywordResponse(rec, req)
			return rec
		}
		if rec := deleteRequest(created.UpdatedAt); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"policy_changed"`) {
			t.Fatalf("stale keyword DELETE status/body = %d %s", rec.Code, rec.Body.String())
		}
		if _, err := store.GetKeywordResponse(ctx, f.tenantID, created.ID); err != nil {
			t.Fatalf("stale keyword DELETE removed row: %v", err)
		}
		if rec := deleteRequest(winner.UpdatedAt); rec.Code != http.StatusOK {
			t.Fatalf("fresh keyword DELETE status/body = %d %s", rec.Code, rec.Body.String())
		}
	})
}

func TestSMSPolicyExpectedVersionAllowsOnlyOneConcurrentUpdate(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	audit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "policy-version-race"}

	quietInput := defaultQuietHoursRule()
	quietInput.Label = "quiet race"
	if err := applyQuietHoursInput(&quietInput, QuietHoursInput{}); err != nil {
		t.Fatal(err)
	}
	quiet, err := store.CreateQuietHours(ctx, f.tenantID, quietInput, audit)
	if err != nil {
		t.Fatal(err)
	}
	keywordInput := route42OptOutKeyword("VERSIONRACE", true)
	if err := applyKeywordResponseInput(&keywordInput, KeywordResponseInput{}); err != nil {
		t.Fatal(err)
	}
	keyword, err := store.CreateKeywordResponse(ctx, f.tenantID, keywordInput, audit)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("quiet hours", func(t *testing.T) {
		start := make(chan struct{})
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for _, label := range []string{"quiet winner A", "quiet winner B"} {
			candidate := quiet
			candidate.Label = label
			wg.Add(1)
			go func(row QuietHoursRule) {
				defer wg.Done()
				<-start
				_, updateErr := store.UpdateQuietHours(context.Background(), f.tenantID, row, quiet.UpdatedAt, audit)
				errs <- updateErr
			}(candidate)
		}
		close(start)
		wg.Wait()
		close(errs)
		assertOnePolicyUpdateWinner(t, errs)
	})

	t.Run("keyword response", func(t *testing.T) {
		start := make(chan struct{})
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for _, candidateKeyword := range []string{"VERSIONRACEA", "VERSIONRACEB"} {
			candidate := keyword
			candidate.Keyword = candidateKeyword
			wg.Add(1)
			go func(row KeywordResponse) {
				defer wg.Done()
				<-start
				_, updateErr := store.UpdateKeywordResponse(context.Background(), f.tenantID, row, keyword.UpdatedAt, audit)
				errs <- updateErr
			}(candidate)
		}
		close(start)
		wg.Wait()
		close(errs)
		assertOnePolicyUpdateWinner(t, errs)
	})
}

func assertOnePolicyUpdateWinner(t *testing.T, errs <-chan error) {
	t.Helper()
	successes, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrSMSPolicyConcurrentChange):
			conflicts++
		default:
			t.Fatalf("concurrent policy update error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent policy outcomes = success:%d conflict:%d", successes, conflicts)
	}
}

func TestRoute42DeleteReceiptsAreStrictTenantAndRowBound(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	seedAudit := db.AuditMeta{TenantID: f.tenantID, ActorType: "system", ActorLabel: "route42-receipt-test"}

	suppression, err := store.AddSuppression(ctx, f.tenantID, f.phone, "manual", nil)
	if err != nil {
		t.Fatalf("seed suppression: %v", err)
	}
	quiet := defaultQuietHoursRule()
	quiet.Label = "receipt proof"
	if err := applyQuietHoursInput(&quiet, QuietHoursInput{}); err != nil {
		t.Fatal(err)
	}
	quiet, err = store.CreateQuietHours(ctx, f.tenantID, quiet, seedAudit)
	if err != nil {
		t.Fatalf("seed quiet-hours policy: %v", err)
	}
	keyword := route42OptOutKeyword("RECEIPT", true)
	if err := applyKeywordResponseInput(&keyword, KeywordResponseInput{}); err != nil {
		t.Fatal(err)
	}
	keyword, err = store.CreateKeywordResponse(ctx, f.tenantID, keyword, seedAudit)
	if err != nil {
		t.Fatalf("seed keyword policy: %v", err)
	}

	d := &Deps{Store: store}
	tests := []struct {
		name    string
		path    string
		id      string
		body    string
		handler http.HandlerFunc
	}{
		{"suppression", "/api/v1/sms/suppressions/" + suppression.ID, suppression.ID, "", d.RemoveSuppression},
		{"quiet hours", "/api/v1/sms/quiet-hours/" + quiet.ID, quiet.ID, smsPolicyVersionBody(t, quiet.UpdatedAt, nil), d.DeleteQuietHours},
		{"keyword response", "/api/v1/sms/keyword-responses/" + keyword.ID, keyword.ID, smsPolicyVersionBody(t, keyword.UpdatedAt, nil), d.DeleteKeywordResponse},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodDelete, tc.path, strings.NewReader(tc.body))
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID}))
			req = withSMSRouteParam(req, "id", tc.id)
			rec := httptest.NewRecorder()
			protectSMSInboxResponse(tc.handler).ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("delete status = %d: %s", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "private, no-store" ||
				rec.Header().Get("Pragma") != "no-cache" ||
				rec.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("private response headers = %#v", rec.Header())
			}
			var receipt map[string]json.RawMessage
			if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
				t.Fatalf("decode delete receipt: %v", err)
			}
			if len(receipt) != 3 {
				t.Fatalf("delete receipt fields = %#v, want exactly ok/tenantId/id", receipt)
			}
			var ok bool
			var tenantID, id string
			if err := json.Unmarshal(receipt["ok"], &ok); err != nil || !ok {
				t.Fatalf("delete receipt ok = %s err=%v", receipt["ok"], err)
			}
			if err := json.Unmarshal(receipt["tenantId"], &tenantID); err != nil || tenantID != f.tenantID {
				t.Fatalf("delete receipt tenantId = %q err=%v", tenantID, err)
			}
			if err := json.Unmarshal(receipt["id"], &id); err != nil || id != tc.id {
				t.Fatalf("delete receipt id = %q err=%v", id, err)
			}
			for _, key := range []string{"ok", "tenantId", "id"} {
				if _, exists := receipt[key]; !exists {
					t.Fatalf("delete receipt missing %q: %#v", key, receipt)
				}
			}
		})
	}
}
