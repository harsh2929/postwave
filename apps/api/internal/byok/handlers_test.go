// SPDX-License-Identifier: AGPL-3.0-only
package byok

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	pwkms "github.com/postwave/postwave/packages/kms"
)

type fakeAdminKeyStore struct {
	key            *Key
	getErr         error
	activateCalled bool
	createCalled   bool
	deleted        bool
	healthOK       *bool
	healthErr      string
}

func (f *fakeAdminKeyStore) List(context.Context, string) ([]Key, error) { return nil, nil }
func (f *fakeAdminKeyStore) Create(_ context.Context, tenantID string, in CreateInput) (*Key, error) {
	f.createCalled = true
	return &Key{ID: "key-1", TenantID: tenantID, Provider: in.Provider, KeyRef: in.KeyRef}, nil
}
func (f *fakeAdminKeyStore) Get(context.Context, string, string) (*Key, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.key, nil
}
func (f *fakeAdminKeyStore) Activate(context.Context, string, string) (*Key, error) {
	f.activateCalled = true
	return f.key, nil
}
func (f *fakeAdminKeyStore) MarkDeleted(context.Context, string, string) error {
	f.deleted = true
	return nil
}
func (f *fakeAdminKeyStore) RecordHealthCheck(_ context.Context, _ string, _ string, ok bool, msg string) error {
	f.healthOK, f.healthErr = &ok, msg
	return nil
}

type fakeProvider struct {
	name      string
	healthErr error
	healthN   int
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) WrapDEK(context.Context, string, []byte) ([]byte, error) {
	return nil, nil
}
func (f *fakeProvider) UnwrapDEK(context.Context, string, []byte) ([]byte, error) {
	return nil, nil
}
func (f *fakeProvider) HealthCheck(context.Context, string) error {
	f.healthN++
	return f.healthErr
}

type fakeRetirementChecker struct {
	references int64
	err        error
}

func (f fakeRetirementChecker) CountKeyReferences(context.Context, string, string) (int64, error) {
	return f.references, f.err
}

func byokHandlerRequest(method, path, keyID, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
	if keyID != "" {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", keyID)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return req.WithContext(ctx)
}

func registryWith(providers ...pwkms.Provider) *pwkms.Registry {
	r := pwkms.NewRegistry()
	for _, p := range providers {
		r.Register(p)
	}
	return r
}

func TestActivateRequiresLiveHealthCheck(t *testing.T) {
	key := &Key{ID: "key-1", TenantID: "tenant-1", Provider: "aws", KeyRef: "arn:test"}

	t.Run("failure never activates", func(t *testing.T) {
		store := &fakeAdminKeyStore{key: key}
		provider := &fakeProvider{name: "aws", healthErr: errors.New("kms denied")}
		d := &Deps{Repo: store, Registry: registryWith(provider)}
		w := httptest.NewRecorder()
		d.Activate(w, byokHandlerRequest(http.MethodPost, "/api/v1/byok/keys/key-1/activate", "key-1", ""))
		if w.Code != http.StatusBadGateway || store.activateCalled {
			t.Fatalf("code=%d activateCalled=%v body=%s", w.Code, store.activateCalled, w.Body.String())
		}
		if provider.healthN != 1 || store.healthOK == nil || *store.healthOK {
			t.Fatalf("health check was not recorded as failed: calls=%d ok=%v", provider.healthN, store.healthOK)
		}
	})

	t.Run("success records proof then activates", func(t *testing.T) {
		store := &fakeAdminKeyStore{key: key}
		provider := &fakeProvider{name: "aws"}
		d := &Deps{Repo: store, Registry: registryWith(provider)}
		w := httptest.NewRecorder()
		d.Activate(w, byokHandlerRequest(http.MethodPost, "/api/v1/byok/keys/key-1/activate", "key-1", ""))
		if w.Code != http.StatusOK || !store.activateCalled {
			t.Fatalf("code=%d activateCalled=%v body=%s", w.Code, store.activateCalled, w.Body.String())
		}
		if provider.healthN != 1 || store.healthOK == nil || !*store.healthOK {
			t.Fatalf("health proof missing: calls=%d ok=%v", provider.healthN, store.healthOK)
		}
	})
}

func TestCreateAndProvidersAdvertiseOnlyWiredBackends(t *testing.T) {
	store := &fakeAdminKeyStore{}
	d := &Deps{Repo: store, Registry: registryWith(&fakeProvider{name: "aws"})}

	w := httptest.NewRecorder()
	d.Providers(w, byokHandlerRequest(http.MethodGet, "/api/v1/byok/providers", "", ""))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"supported":["aws"]`) || strings.Contains(w.Body.String(), "gcp") {
		t.Fatalf("providers response advertises unavailable backend: %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	d.Create(w, byokHandlerRequest(http.MethodPost, "/api/v1/byok/keys", "", `{"provider":"gcp","key_ref":"projects/p/keys/k"}`))
	if w.Code != http.StatusBadRequest || store.createCalled {
		t.Fatalf("unwired provider was accepted: code=%d createCalled=%v body=%s", w.Code, store.createCalled, w.Body.String())
	}
}

func TestDeleteRequiresZeroCiphertextReferences(t *testing.T) {
	store := &fakeAdminKeyStore{}
	d := &Deps{Repo: store, Retirement: fakeRetirementChecker{references: 2}}
	w := httptest.NewRecorder()
	d.Delete(w, byokHandlerRequest(http.MethodDelete, "/api/v1/byok/keys/key-1", "key-1", ""))
	if w.Code != http.StatusConflict || store.deleted {
		t.Fatalf("referenced key was retired: code=%d deleted=%v body=%s", w.Code, store.deleted, w.Body.String())
	}

	d.Retirement = fakeRetirementChecker{}
	w = httptest.NewRecorder()
	d.Delete(w, byokHandlerRequest(http.MethodDelete, "/api/v1/byok/keys/key-1", "key-1", ""))
	if w.Code != http.StatusNoContent || !store.deleted {
		t.Fatalf("unreferenced key was not retired: code=%d deleted=%v body=%s", w.Code, store.deleted, w.Body.String())
	}
}
