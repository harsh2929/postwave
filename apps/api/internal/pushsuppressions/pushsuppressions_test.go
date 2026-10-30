// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	testTenantID = "abcdefab-cdef-1abc-8def-abcdefabcdef"
	testRowID    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testToken    = "0123456789abcdefghij"
)

type fakeAuthorityStore struct {
	listResult       ListResult
	listErr          error
	listTenant       string
	listFilter       ListFilter
	addResult        AddResult
	addErr           error
	addTenant        string
	addInput         ManualAdd
	bulkAddResult    BulkImportResult
	bulkAddErr       error
	bulkAddItems     []ManualAdd
	removeResult     RemoveReceipt
	removeErr        error
	removeTenant     string
	removeInput      RemoveRequest
	bulkRemoveResult BulkRemoveResult
	bulkRemoveErr    error
	bulkRemoveItems  []RemoveRequest
}

func (f *fakeAuthorityStore) List(_ context.Context, tenantID string, filter ListFilter, _ db.AuditMeta) (ListResult, error) {
	f.listTenant, f.listFilter = tenantID, filter
	return f.listResult, f.listErr
}

func (f *fakeAuthorityStore) AddManual(_ context.Context, tenantID string, in ManualAdd, _ db.AuditMeta) (AddResult, error) {
	f.addTenant, f.addInput = tenantID, in
	return f.addResult, f.addErr
}

func (f *fakeAuthorityStore) BulkAddManual(_ context.Context, _ string, items []ManualAdd, _ db.AuditMeta) (BulkImportResult, error) {
	f.bulkAddItems = append([]ManualAdd(nil), items...)
	return f.bulkAddResult, f.bulkAddErr
}

func (f *fakeAuthorityStore) RemoveManual(_ context.Context, tenantID string, in RemoveRequest, _ db.AuditMeta) (RemoveReceipt, error) {
	f.removeTenant, f.removeInput = tenantID, in
	return f.removeResult, f.removeErr
}

func (f *fakeAuthorityStore) BulkRemoveManual(_ context.Context, _ string, items []RemoveRequest, _ db.AuditMeta) (BulkRemoveResult, error) {
	f.bulkRemoveItems = append([]RemoveRequest(nil), items...)
	return f.bulkRemoveResult, f.bulkRemoveErr
}

func withTenant(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: testTenantID})
	return req.WithContext(ctx)
}

func withRouteID(req *http.Request, id string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}

func responseCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope errorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope: %v (body=%s)", err, rec.Body.String())
	}
	return envelope.Error.Code
}

func assertPrivateHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store, max-age=0" {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := rec.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma=%q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options=%q", got)
	}
}

func TestAddValidationRejectsBeforeStore(t *testing.T) {
	store := &fakeAuthorityStore{}
	d := &Deps{AuthorityStore: store, CursorSigningKey: testCursorSigningKey}
	tests := []struct {
		name       string
		target     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "missing token", target: "/api/v1/push/suppressions", body: `{"platform":"apns"}`, wantStatus: 422, wantCode: "validation_failed"},
		{name: "short token", target: "/api/v1/push/suppressions", body: `{"device_token":"abc","platform":"apns"}`, wantStatus: 422, wantCode: "validation_failed"},
		{name: "bad platform", target: "/api/v1/push/suppressions", body: `{"device_token":"0123456789abcdefghij","platform":"ios"}`, wantStatus: 422, wantCode: "validation_failed"},
		{name: "system reason", target: "/api/v1/push/suppressions", body: `{"device_token":"0123456789abcdefghij","platform":"apns","reason":"expired"}`, wantStatus: 422, wantCode: "manual_authority_required"},
		{name: "null reason", target: "/api/v1/push/suppressions", body: `{"device_token":"0123456789abcdefghij","platform":"apns","reason":null}`, wantStatus: 400, wantCode: "bad_json"},
		{name: "leading whitespace preserved and rejected", target: "/api/v1/push/suppressions", body: `{"device_token":" 0123456789abcdefghij","platform":"apns"}`, wantStatus: 422, wantCode: "validation_failed"},
		{name: "unknown field", target: "/api/v1/push/suppressions", body: `{"device_token":"0123456789abcdefghij","platform":"apns","extra":true}`, wantStatus: 400, wantCode: "unknown_field"},
		{name: "trailing JSON", target: "/api/v1/push/suppressions", body: `{"device_token":"0123456789abcdefghij","platform":"apns"}{}`, wantStatus: 400, wantCode: "multiple_json_values"},
		{name: "query refused", target: "/api/v1/push/suppressions?reason=manual", body: `{"device_token":"0123456789abcdefghij","platform":"apns"}`, wantStatus: 400, wantCode: "invalid_query"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			d.Add(rec, withTenant(http.MethodPost, test.target, test.body))
			gotCode := responseCode(t, rec)
			if rec.Code != test.wantStatus || gotCode != test.wantCode {
				t.Fatalf("status=%d code=%q body=%s", rec.Code, gotCode, rec.Body.String())
			}
			assertPrivateHeaders(t, rec)
		})
	}
	if store.addTenant != "" {
		t.Fatalf("invalid input reached store: tenant=%q input=%+v", store.addTenant, store.addInput)
	}
}

func TestAddAcceptsExactRawManualTokenAndReturnsFiniteRow(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	store := &fakeAuthorityStore{addResult: AddResult{Created: true, Row: Row{
		ID: testRowID, TenantID: testTenantID, DeviceTokenHash: "0123456789abcdef",
		Platform: "apns", Reason: "manual", Source: "dashboard", CreatedAt: now,
		UpdatedAt: now, Version: 1, Reversible: true,
	}}}
	d := &Deps{AuthorityStore: store}
	rec := httptest.NewRecorder()
	d.Add(rec, withTenant(http.MethodPost, "/api/v1/push/suppressions", `{"device_token":"`+testToken+`","platform":"apns"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.addTenant != testTenantID || store.addInput != (ManualAdd{DeviceToken: testToken, Platform: "apns"}) {
		t.Fatalf("store input lost exact tenant/token binding: tenant=%q input=%+v", store.addTenant, store.addInput)
	}
	var row map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if row["source"] != "dashboard" || row["device_token_hash"] != "0123456789abcdef" || row["tenant_id"] != testTenantID {
		t.Fatalf("unexpected public row: %#v", row)
	}
	if strings.Contains(rec.Body.String(), testToken) {
		t.Fatalf("raw token leaked in response: %s", rec.Body.String())
	}
	assertPrivateHeaders(t, rec)
}

func TestListStrictQueryAndTenantBinding(t *testing.T) {
	d := &Deps{AuthorityStore: &fakeAuthorityStore{}, CursorSigningKey: testCursorSigningKey}
	for _, target := range []string{
		"/api/v1/push/suppressions?platform=ios",
		"/api/v1/push/suppressions?platform=apns&platform=fcm",
		"/api/v1/push/suppressions?platform=",
		"/api/v1/push/suppressions?unknown=x",
		"/api/v1/push/suppressions?hash_prefix=ABCDEF12",
		"/api/v1/push/suppressions?hash_prefix=abcdef1",
		"/api/v1/push/suppressions?limit=01",
		"/api/v1/push/suppressions?limit=101",
		"/api/v1/push/suppressions?reason=unknown",
	} {
		rec := httptest.NewRecorder()
		d.List(rec, withTenant(http.MethodGet, target, ""))
		if rec.Code != http.StatusBadRequest || responseCode(t, rec) != "invalid_query" {
			t.Fatalf("target=%s status=%d body=%s", target, rec.Code, rec.Body.String())
		}
	}

	badTenant := httptest.NewRequest(http.MethodGet, "/api/v1/push/suppressions", nil)
	badTenant = badTenant.WithContext(middleware.WithTenant(badTenant.Context(), &middleware.Tenant{ID: "t-1"}))
	rec := httptest.NewRecorder()
	d.List(rec, badTenant)
	if rec.Code != http.StatusServiceUnavailable || responseCode(t, rec) != "tenant_identity_unavailable" {
		t.Fatalf("noncanonical tenant must fail before DB cast: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestListFailsClosedWithoutCursorSigningKey(t *testing.T) {
	store := &fakeAuthorityStore{}
	d := &Deps{AuthorityStore: store}
	rec := httptest.NewRecorder()
	d.List(rec, withTenant(http.MethodGet, "/api/v1/push/suppressions", ""))
	if rec.Code != http.StatusServiceUnavailable || responseCode(t, rec) != "push_suppressions_unavailable" {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.listTenant != "" {
		t.Fatal("missing cursor trust root reached the authority store")
	}
	assertPrivateHeaders(t, rec)
}

func TestListSuccessIsSnapshotAndTenantBound(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 123, time.UTC)
	store := &fakeAuthorityStore{listResult: ListResult{
		Items: []Row{{
			ID: testRowID, TenantID: testTenantID, DeviceTokenHash: "abcdef0123456789",
			Platform: "fcm", Reason: "expired", Source: "provider", CreatedAt: now,
			UpdatedAt: now, Version: 1, Reversible: false, LockedReason: "provider_authority",
		}},
		Total: 1, SnapshotAt: now, HasMore: true,
	}}
	d := &Deps{AuthorityStore: store, CursorSigningKey: testCursorSigningKey}
	rec := httptest.NewRecorder()
	d.List(rec, withTenant(http.MethodGet, "/api/v1/push/suppressions?platform=fcm&reason=expired&hash_prefix=abcdef01&limit=1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.listTenant != testTenantID || store.listFilter.Platform != "fcm" || store.listFilter.Reason != "expired" || store.listFilter.HashPrefix != "abcdef01" || store.listFilter.Limit != 1 {
		t.Fatalf("filter was not bound exactly: tenant=%q filter=%+v", store.listTenant, store.listFilter)
	}
	var envelope listEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.TenantID != testTenantID || envelope.Total != 1 || envelope.NextCursor == "" || envelope.SnapshotAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("unexpected envelope: %+v", envelope)
	}
	if len(envelope.Items) != 1 || envelope.Items[0].Source != "provider" || envelope.Items[0].LockedReason != "provider_authority" {
		t.Fatalf("unexpected item projection: %+v", envelope.Items)
	}
	assertPrivateHeaders(t, rec)
}

func TestListMapsInvalidDatabaseRevisionToInvalidCursor(t *testing.T) {
	d := &Deps{AuthorityStore: &fakeAuthorityStore{listErr: errInvalidCursor}, CursorSigningKey: testCursorSigningKey}
	rec := httptest.NewRecorder()
	d.List(rec, withTenant(http.MethodGet, "/api/v1/push/suppressions", ""))
	if rec.Code != http.StatusBadRequest || responseCode(t, rec) != "invalid_cursor" {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertPrivateHeaders(t, rec)
}

func TestDeleteRequiresCASAndMapsTypedOutcomes(t *testing.T) {
	tests := []struct {
		name       string
		id         string
		body       string
		storeErr   error
		wantStatus int
		wantCode   string
	}{
		{name: "bad id", id: testTenantID, body: `{"expected_version":1}`, wantStatus: 422, wantCode: "invalid_push_suppression_id"},
		{name: "missing version", id: testRowID, body: `{}`, wantStatus: 422, wantCode: "invalid_expected_version"},
		{name: "stale", id: testRowID, body: `{"expected_version":1}`, storeErr: ErrStale, wantStatus: 409, wantCode: "push_suppression_stale"},
		{name: "missing", id: testRowID, body: `{"expected_version":1}`, storeErr: ErrNotFound, wantStatus: 404, wantCode: "push_suppression_not_found"},
		{name: "locked", id: testRowID, body: `{"expected_version":1}`, storeErr: &LockedError{Reason: "provider_authority"}, wantStatus: 409, wantCode: "push_suppression_locked"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeAuthorityStore{removeErr: test.storeErr}
			d := &Deps{AuthorityStore: store}
			rec := httptest.NewRecorder()
			req := withRouteID(withTenant(http.MethodDelete, "/api/v1/push/suppressions/"+test.id, test.body), test.id)
			d.Delete(rec, req)
			gotCode := responseCode(t, rec)
			if rec.Code != test.wantStatus || gotCode != test.wantCode {
				t.Fatalf("status=%d code=%q body=%s", rec.Code, gotCode, rec.Body.String())
			}
			if test.name == "locked" {
				var envelope errorEnvelope
				_ = json.Unmarshal(rec.Body.Bytes(), &envelope)
				if envelope.Error.LockedReason != "provider_authority" {
					t.Fatalf("locked reason=%q", envelope.Error.LockedReason)
				}
			}
		})
	}

	store := &fakeAuthorityStore{removeResult: RemoveReceipt{
		OK: true, TenantID: testTenantID, ID: testRowID, Version: 2, StillSuppressed: true,
	}}
	d := &Deps{AuthorityStore: store, CursorSigningKey: testCursorSigningKey}
	rec := httptest.NewRecorder()
	d.Delete(rec, withRouteID(withTenant(http.MethodDelete, "/api/v1/push/suppressions/"+testRowID, `{"expected_version":1}`), testRowID))
	if rec.Code != http.StatusOK || store.removeTenant != testTenantID || store.removeInput != (RemoveRequest{ID: testRowID, ExpectedVersion: 1}) {
		t.Fatalf("delete binding/status: status=%d tenant=%q input=%+v body=%s", rec.Code, store.removeTenant, store.removeInput, rec.Body.String())
	}
	var receipt RemoveReceipt
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.OK || receipt.TenantID != testTenantID || receipt.ID != testRowID || receipt.Version != 2 || !receipt.StillSuppressed {
		t.Fatalf("unbound delete receipt: %+v", receipt)
	}
}

func TestBulkRoutesRejectDuplicatesAndReturnBoundReceipts(t *testing.T) {
	store := &fakeAuthorityStore{}
	d := &Deps{AuthorityStore: store}

	rec := httptest.NewRecorder()
	d.BulkImport(rec, withTenant(http.MethodPost, "/api/v1/push/suppressions/bulk-import", `{"items":[{"device_token":"`+testToken+`","platform":"apns"},{"device_token":"`+testToken+`","platform":"apns"}]}`))
	if rec.Code != 422 || responseCode(t, rec) != "duplicate_bulk_item" || len(store.bulkAddItems) != 0 {
		t.Fatalf("duplicate import reached store: status=%d items=%+v body=%s", rec.Code, store.bulkAddItems, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	d.BulkRemove(rec, withTenant(http.MethodPost, "/api/v1/push/suppressions/bulk-remove", `{"items":[{"id":"`+testRowID+`","expected_version":1},{"id":"`+testRowID+`","expected_version":1}]}`))
	if rec.Code != 422 || responseCode(t, rec) != "duplicate_bulk_item" || len(store.bulkRemoveItems) != 0 {
		t.Fatalf("duplicate removal reached store: status=%d items=%+v body=%s", rec.Code, store.bulkRemoveItems, rec.Body.String())
	}

	store.bulkRemoveResult = BulkRemoveResult{
		Receipts: []RemoveReceipt{{OK: true, TenantID: testTenantID, ID: testRowID, Version: 2, StillSuppressed: false}},
		Removed:  1,
	}
	rec = httptest.NewRecorder()
	d.BulkRemove(rec, withTenant(http.MethodPost, "/api/v1/push/suppressions/bulk-remove", `{"items":[{"id":"`+testRowID+`","expected_version":1}]}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("bulk remove status=%d body=%s", rec.Code, rec.Body.String())
	}
	var receipt bulkRemoveReceipt
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.OK || receipt.TenantID != testTenantID || receipt.Removed != 1 || len(receipt.Items) != 1 || receipt.Items[0].ID != testRowID {
		t.Fatalf("unexpected bulk receipt: %+v", receipt)
	}
}

func TestMountRoutesRequiresExactAdminAndProtectsRefusals(t *testing.T) {
	store := &fakeAuthorityStore{listResult: ListResult{Items: []Row{}, SnapshotAt: time.Now().UTC()}}
	d := &Deps{AuthorityStore: store, CursorSigningKey: testCursorSigningKey}
	router := chi.NewRouter()
	d.MountRoutes(router)

	for _, role := range []string{"viewer", "editor", "custom-admin"} {
		req := withTenant(http.MethodGet, "/api/v1/push/suppressions", "")
		req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{ID: "user-1", Role: role}))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("role=%q status=%d body=%s", role, rec.Code, rec.Body.String())
		}
		assertPrivateHeaders(t, rec)
	}

	req := withTenant(http.MethodGet, "/api/v1/push/suppressions", "")
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{ID: "user-1", Role: "admin"}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertPrivateHeaders(t, rec)

	for _, keyTest := range []struct {
		name   string
		scopes []apikeys.Scope
		want   int
	}{
		{name: "admin key", scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusOK},
		{name: "read-reports key", scopes: []apikeys.Scope{apikeys.ScopeReadReports}, want: http.StatusForbidden},
	} {
		t.Run(keyTest.name, func(t *testing.T) {
			req := withTenant(http.MethodGet, "/api/v1/push/suppressions", "")
			ctx := middleware.WithAPIKeyAuth(req.Context())
			ctx = apikeys.WithScopes(ctx, keyTest.scopes)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req.WithContext(ctx))
			if rec.Code != keyTest.want {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, keyTest.want, rec.Body.String())
			}
			assertPrivateHeaders(t, rec)
		})
	}
}

func TestHandlersNoTenantAreUnauthorizedAndPrivate(t *testing.T) {
	d := &Deps{AuthorityStore: &fakeAuthorityStore{}}
	for _, test := range []struct {
		name string
		fn   http.HandlerFunc
		m    string
		path string
	}{
		{name: "list", fn: d.List, m: http.MethodGet, path: "/api/v1/push/suppressions"},
		{name: "add", fn: d.Add, m: http.MethodPost, path: "/api/v1/push/suppressions"},
		{name: "delete", fn: d.Delete, m: http.MethodDelete, path: "/api/v1/push/suppressions/" + testRowID},
		{name: "bulk import", fn: d.BulkImport, m: http.MethodPost, path: "/api/v1/push/suppressions/bulk-import"},
		{name: "bulk remove", fn: d.BulkRemove, m: http.MethodPost, path: "/api/v1/push/suppressions/bulk-remove"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(test.m, test.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			test.fn(rec, req)
			if rec.Code != http.StatusUnauthorized || responseCode(t, rec) != "no_tenant" {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertPrivateHeaders(t, rec)
		})
	}
}

func TestFinitePublicSourceAndLockedReasonEnums(t *testing.T) {
	wantSources := map[string]string{
		"manual": "dashboard", "provider": "provider", "user": "user",
		"complaint": "complaint", "legacy_unknown": "legacy", "future": "legacy",
	}
	for authority, expected := range wantSources {
		if got := publicSource(authority); got != expected {
			t.Fatalf("publicSource(%q)=%q want %q", authority, got, expected)
		}
	}
	allowedLocked := map[string]bool{
		"provider_authority": true, "user_opt_out_authority": true,
		"complaint_authority": true, "legacy_authority_requires_review": true,
	}
	for _, authority := range []string{"provider", "user", "complaint", "legacy_unknown", "future"} {
		if reason := lockedReason(authority); !allowedLocked[reason] {
			t.Fatalf("authority=%q projected open-ended locked reason %q", authority, reason)
		}
	}
}

func TestValidRequestFailsClosedWhenStoreIsUnconfigured(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	d.Add(rec, withTenant(http.MethodPost, "/api/v1/push/suppressions", `{"device_token":"`+testToken+`","platform":"fcm"}`))
	if rec.Code != http.StatusServiceUnavailable || responseCode(t, rec) != "push_suppressions_unavailable" {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
