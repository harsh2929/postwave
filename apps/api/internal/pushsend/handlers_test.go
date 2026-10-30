// SPDX-License-Identifier: AGPL-3.0-only
package pushsend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// fakeDeviceStore is an in-memory DeviceUpserter so handler tests exercise
// RegisterDevice's HTTP contract (validation, status codes, response shape)
// without a database.
type fakeDeviceStore struct {
	rows map[string]DeviceRow // token -> row
	err  error
}

func (f *fakeDeviceStore) UpsertDevice(_ context.Context, tenantID string, in UpsertDeviceInput) (DeviceRow, error) {
	if f.err != nil {
		return DeviceRow{}, f.err
	}
	if f.rows == nil {
		f.rows = map[string]DeviceRow{}
	}
	row, existed := f.rows[in.Token]
	if !existed {
		row.ID = "dev-" + in.Token
	}
	row.SubscriberID = in.SubscriberID
	row.Platform = in.Platform
	row.Token = in.Token
	row.AppID = in.AppID
	row.Enabled = in.Enabled
	f.rows[in.Token] = row
	return row, nil
}

func withTenant(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t-1"})
	return req.WithContext(ctx)
}

func TestRegisterDevice_Upserts(t *testing.T) {
	store := &fakeDeviceStore{}
	d := &Deps{Store: store}

	rec := httptest.NewRecorder()
	d.RegisterDevice(rec, withTenant(http.MethodPost, "/api/v1/push/devices",
		`{"subscriber_id":"sub-1","platform":"ios","token":"token-012345678901234","app_id":"com.moosewave.app"}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var row DeviceRow
	if err := json.Unmarshal(rec.Body.Bytes(), &row); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if row.Token != "token-012345678901234" || row.Platform != "ios" || !row.Enabled {
		t.Fatalf("unexpected row in response: %+v", row)
	}
	if got := store.rows["token-012345678901234"]; got.SubscriberID != "sub-1" {
		t.Fatalf("device was not upserted into the store: %+v", got)
	}
}

func TestRegisterDevice_ReRegisteringSameToken_IsIdempotentUpdate(t *testing.T) {
	store := &fakeDeviceStore{}
	d := &Deps{Store: store}

	first := httptest.NewRecorder()
	d.RegisterDevice(first, withTenant(http.MethodPost, "/api/v1/push/devices",
		`{"subscriber_id":"sub-1","platform":"ios","token":"token-012345678901234"}`))
	if first.Code != http.StatusOK {
		t.Fatalf("first registration failed: %d %s", first.Code, first.Body.String())
	}

	// Re-register the same token for a different subscriber (e.g. device
	// changed hands) — must update in place, not create a second row.
	second := httptest.NewRecorder()
	d.RegisterDevice(second, withTenant(http.MethodPost, "/api/v1/push/devices",
		`{"subscriber_id":"sub-2","platform":"ios","token":"token-012345678901234"}`))
	if second.Code != http.StatusOK {
		t.Fatalf("second registration failed: %d %s", second.Code, second.Body.String())
	}
	if len(store.rows) != 1 {
		t.Fatalf("expected exactly one row for the reused token, got %d", len(store.rows))
	}
	if got := store.rows["token-012345678901234"]; got.SubscriberID != "sub-2" {
		t.Fatalf("re-registration must update subscriber_id in place, got %+v", got)
	}
}

func TestRegisterDevice_ValidationRejections(t *testing.T) {
	d := &Deps{Store: &fakeDeviceStore{}}
	cases := []struct {
		name string
		body string
	}{
		{"missing subscriber_id", `{"platform":"ios","token":"tok"}`},
		{"missing token", `{"subscriber_id":"sub-1","platform":"ios"}`},
		{"bad platform", `{"subscriber_id":"sub-1","platform":"windows","token":"tok"}`},
		{"leading whitespace is not normalized", `{"subscriber_id":"sub-1","platform":"ios","token":" token-012345678901234"}`},
		{"unicode whitespace is rejected", `{"subscriber_id":"sub-1","platform":"ios","token":"token-012345678901234\u00a0"}`},
		{"malformed json", `{not json`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			d.RegisterDevice(rec, withTenant(http.MethodPost, "/api/v1/push/devices", c.body))
			if rec.Code < 400 || rec.Code >= 500 {
				t.Fatalf("%s: expected a 4xx rejection, got %d (body=%s)", c.name, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestRegisterDevice_NoTenant_Unauthorized(t *testing.T) {
	d := &Deps{Store: &fakeDeviceStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/devices", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	d.RegisterDevice(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no tenant in context, got %d", rec.Code)
	}
}

func TestRegisterDevice_UnknownSubscriber_Rejected(t *testing.T) {
	store := &fakeDeviceStore{err: ErrSubscriberNotFound}
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.RegisterDevice(rec, withTenant(http.MethodPost, "/api/v1/push/devices",
		`{"subscriber_id":"ghost","platform":"ios","token":"token-012345678901234"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for an unknown subscriber, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestRegisterDevice_StoreNotConfigured(t *testing.T) {
	d := &Deps{} // Store is nil
	rec := httptest.NewRecorder()
	d.RegisterDevice(rec, withTenant(http.MethodPost, "/api/v1/push/devices",
		`{"subscriber_id":"sub-1","platform":"ios","token":"tok"}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when Store is nil, got %d", rec.Code)
	}
}
