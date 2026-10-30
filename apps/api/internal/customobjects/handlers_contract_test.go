// SPDX-License-Identifier: AGPL-3.0-only

package customobjects

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	contractTenant = "11111111-1111-4111-8111-111111111111"
	contractUser   = "22222222-2222-4222-8222-222222222222"
)

type customObjectHarness struct {
	store *MemoryStore
	deps  *Deps
}

func newCustomObjectHarness() *customObjectHarness {
	clock := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	store := NewMemoryStore(func() time.Time {
		clock = clock.Add(time.Microsecond)
		return clock
	})
	return &customObjectHarness{
		store: store,
		deps: &Deps{
			Store:  store,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
	}
}

func (h *customObjectHarness) serve(role, method, path, body string) *httptest.ResponseRecorder {
	return h.serveRoles(role, role, method, path, body)
}

func (h *customObjectHarness) serveRoles(durableRole, effectiveRole, method, path, body string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: contractTenant})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID: contractUser, TenantID: contractTenant, Role: durableRole, EffectiveRole: effectiveRole,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	h.deps.MountRoutes(router)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func decodeContractBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode response %d %q: %v", recorder.Code, recorder.Body.String(), err)
	}
	return value
}

func errorCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	body := decodeContractBody(t, recorder)
	errorValue, _ := body["error"].(map[string]any)
	code, _ := errorValue["code"].(string)
	return code
}

func createTypeThroughAPI(t *testing.T, h *customObjectHarness, schema string) ObjectType {
	t.Helper()
	body := `{"key":"order","label":"Order","primaryKey":"external_id","schema":` + schema + `}`
	recorder := h.serve("admin", http.MethodPost, "/api/v1/custom-objects/types", body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var objectType ObjectType
	if err := json.Unmarshal(recorder.Body.Bytes(), &objectType); err != nil {
		t.Fatalf("decode type: %v", err)
	}
	return objectType
}

func TestCustomObjectRoutesEnforceRoleAndSensitiveResponseBoundary(t *testing.T) {
	h := newCustomObjectHarness()
	viewerRead := h.serve("viewer", http.MethodGet, "/api/v1/custom-objects/types", "")
	if viewerRead.Code != http.StatusOK {
		t.Fatalf("viewer read status=%d body=%s", viewerRead.Code, viewerRead.Body.String())
	}
	for header, want := range map[string]string{
		"Cache-Control":          "private, no-store, max-age=0",
		"Pragma":                 "no-cache",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
	} {
		if got := viewerRead.Header().Get(header); got != want {
			t.Errorf("%s=%q want %q", header, got, want)
		}
	}

	viewerWrite := h.serve("viewer", http.MethodPost, "/api/v1/custom-objects/types", `{"key":"order","label":"Order","schema":{}}`)
	if viewerWrite.Code != http.StatusForbidden {
		t.Fatalf("viewer write status=%d body=%s", viewerWrite.Code, viewerWrite.Body.String())
	}
	if len(h.store.types) != 0 {
		t.Fatal("viewer write reached the store")
	}

	viewAsWrite := h.serveRoles("admin", "viewer", http.MethodPost, "/api/v1/custom-objects/types", `{"key":"order","label":"Order","schema":{}}`)
	if viewAsWrite.Code != http.StatusForbidden {
		t.Fatalf("effective viewer write status=%d", viewAsWrite.Code)
	}
}

func TestCustomObjectTypeWritesAreExactVersionedAndIntentBound(t *testing.T) {
	h := newCustomObjectHarness()
	objectType := createTypeThroughAPI(t, h, `{}`)
	if objectType.Version != 1 {
		t.Fatalf("created version=%d", objectType.Version)
	}

	missingVersion := h.serve("admin", http.MethodPut,
		"/api/v1/custom-objects/types/"+objectType.ID,
		`{"label":"Changed","schema":{},"status":"active","expectedVersion":0}`)
	if missingVersion.Code != http.StatusPreconditionRequired || errorCode(t, missingVersion) != "precondition_required" {
		t.Fatalf("missing precondition status=%d body=%s", missingVersion.Code, missingVersion.Body.String())
	}

	updateBody := `{"label":"Order v2","schema":{"type":"object"},"status":"deprecated","expectedVersion":1}`
	updated := h.serve("admin", http.MethodPut, "/api/v1/custom-objects/types/"+objectType.ID, updateBody)
	if updated.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updated.Code, updated.Body.String())
	}
	var current ObjectType
	if err := json.Unmarshal(updated.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if current.Version != 2 || current.Label != "Order v2" || current.Key != objectType.Key {
		t.Fatalf("updated type=%+v", current)
	}

	stale := h.serve("admin", http.MethodPut, "/api/v1/custom-objects/types/"+objectType.ID, updateBody)
	if stale.Code != http.StatusConflict || errorCode(t, stale) != "stale_version" {
		t.Fatalf("stale status=%d body=%s", stale.Code, stale.Body.String())
	}
	stored, _ := h.store.GetType(t.Context(), contractTenant, objectType.ID)
	if stored.Version != 2 || stored.Label != "Order v2" {
		t.Fatalf("stale write changed store: %+v", stored)
	}

	wrongConfirmation := h.serve("admin", http.MethodDelete,
		"/api/v1/custom-objects/types/"+objectType.ID,
		`{"expectedVersion":2,"confirmationKey":"orders"}`)
	if wrongConfirmation.Code != http.StatusConflict || errorCode(t, wrongConfirmation) != "confirmation_mismatch" {
		t.Fatalf("confirmation status=%d body=%s", wrongConfirmation.Code, wrongConfirmation.Body.String())
	}
	deleted := h.serve("admin", http.MethodDelete,
		"/api/v1/custom-objects/types/"+objectType.ID,
		`{"expectedVersion":2,"confirmationKey":"order"}`)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	if _, err := h.store.GetType(t.Context(), contractTenant, objectType.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted type still present: %v", err)
	}
}

func TestCustomObjectRecordLifecycleUsesSafeSearchAndCAS(t *testing.T) {
	h := newCustomObjectHarness()
	objectType := createTypeThroughAPI(t, h, `{"type":"object","required":["status"],"properties":{"status":{"type":"string","enum":["open","closed"]}}}`)

	missingType := h.serve("viewer", http.MethodGet,
		"/api/v1/custom-objects/types/33333333-3333-4333-8333-333333333333/records", "")
	if missingType.Code != http.StatusNotFound {
		t.Fatalf("missing type list status=%d body=%s", missingType.Code, missingType.Body.String())
	}
	unsafeURL := h.serve("viewer", http.MethodGet,
		"/api/v1/custom-objects/types/"+objectType.ID+"/records?property=status&value=open", "")
	if unsafeURL.Code != http.StatusBadRequest || errorCode(t, unsafeURL) != "unsafe_filter_transport" {
		t.Fatalf("unsafe filter status=%d body=%s", unsafeURL.Code, unsafeURL.Body.String())
	}

	invalidRecord := h.serve("admin", http.MethodPost,
		"/api/v1/custom-objects/types/"+objectType.ID+"/records",
		`{"externalId":"secret-customer-id","properties":{"status":"secret-enum-value"},"expectedVersion":0}`)
	if invalidRecord.Code != http.StatusUnprocessableEntity || errorCode(t, invalidRecord) != "validation_failed" {
		t.Fatalf("invalid record status=%d body=%s", invalidRecord.Code, invalidRecord.Body.String())
	}
	if strings.Contains(invalidRecord.Body.String(), "secret-customer-id") || strings.Contains(invalidRecord.Body.String(), "secret-enum-value") || strings.Contains(invalidRecord.Body.String(), "open") {
		t.Fatalf("validation response reflected record/schema values: %s", invalidRecord.Body.String())
	}

	create := h.serve("admin", http.MethodPost,
		"/api/v1/custom-objects/types/"+objectType.ID+"/records",
		`{"externalId":"ord_1","properties":{"status":"open"},"expectedVersion":0}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("record create status=%d body=%s", create.Code, create.Body.String())
	}
	var record Record
	if err := json.Unmarshal(create.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record.Version != 1 {
		t.Fatalf("record version=%d", record.Version)
	}

	duplicateCreate := h.serve("admin", http.MethodPost,
		"/api/v1/custom-objects/types/"+objectType.ID+"/records",
		`{"externalId":"ord_1","properties":{"status":"closed"},"expectedVersion":0}`)
	if duplicateCreate.Code != http.StatusConflict || errorCode(t, duplicateCreate) != "stale_version" {
		t.Fatalf("duplicate create status=%d body=%s", duplicateCreate.Code, duplicateCreate.Body.String())
	}

	update := h.serve("admin", http.MethodPost,
		"/api/v1/custom-objects/types/"+objectType.ID+"/records",
		`{"externalId":"ord_1","properties":{"status":"closed"},"expectedVersion":1}`)
	if update.Code != http.StatusOK {
		t.Fatalf("record update status=%d body=%s", update.Code, update.Body.String())
	}
	if err := json.Unmarshal(update.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record.Version != 2 {
		t.Fatalf("record update version=%d", record.Version)
	}

	search := h.serve("viewer", http.MethodPost,
		"/api/v1/custom-objects/types/"+objectType.ID+"/records/search",
		`{"property":"status","value":"closed","limit":25}`)
	if search.Code != http.StatusOK {
		t.Fatalf("search status=%d body=%s", search.Code, search.Body.String())
	}
	var page RecordPage
	if err := json.Unmarshal(search.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != record.ID || page.Limit != 25 || page.HasMore {
		t.Fatalf("search page=%+v", page)
	}

	staleDelete := h.serve("admin", http.MethodDelete, "/api/v1/custom-objects/records/"+record.ID,
		`{"expectedVersion":1,"confirmationExternalId":"ord_1"}`)
	if staleDelete.Code != http.StatusConflict || errorCode(t, staleDelete) != "stale_version" {
		t.Fatalf("stale delete status=%d body=%s", staleDelete.Code, staleDelete.Body.String())
	}
	deleteRecord := h.serve("admin", http.MethodDelete, "/api/v1/custom-objects/records/"+record.ID,
		`{"expectedVersion":2,"confirmationExternalId":"ord_1"}`)
	if deleteRecord.Code != http.StatusOK {
		t.Fatalf("delete record status=%d body=%s", deleteRecord.Code, deleteRecord.Body.String())
	}
}

func TestCustomObjectRequestValidationRejectsAmbiguousShapes(t *testing.T) {
	h := newCustomObjectHarness()
	for _, test := range []struct {
		name   string
		method string
		path   string
		body   string
		status int
	}{
		{"noncanonical id", http.MethodGet, "/api/v1/custom-objects/types/not-an-id", "", http.StatusBadRequest},
		{"unknown field", http.MethodPost, "/api/v1/custom-objects/types", `{"key":"order","label":"Order","schema":{},"typo":true}`, http.StatusBadRequest},
		{"unsafe key", http.MethodPost, "/api/v1/custom-objects/types", `{"key":"Order","label":"Order","schema":{}}`, http.StatusBadRequest},
		{"missing schema", http.MethodPost, "/api/v1/custom-objects/types", `{"key":"order","label":"Order"}`, http.StatusBadRequest},
		{"schema mismatch", http.MethodPost, "/api/v1/custom-objects/types", `{"key":"order","label":"Order","schema":{"type":"string"}}`, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := h.serve("admin", test.method, test.path, test.body)
			if recorder.Code != test.status {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
