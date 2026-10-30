package nbp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestExtendedRoutesDoNotMountVendorSidecarConfiguration(t *testing.T) {
	router := chi.NewRouter()
	MountExtended(router, nil, nil, nil)

	for _, method := range []string{http.MethodGet, http.MethodPut} {
		req := httptest.NewRequest(method, "/nbp/sidecar/personalize", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404 for retired sidecar contract", method, rec.Code)
		}
	}
}

func TestMountUsesCanonicalAPIV1BoundaryAndPreservesOuterMiddleware(t *testing.T) {
	router := chi.NewRouter()
	outerMiddleware := func(next http.Handler) http.Handler { return next }
	router.Group(func(authenticated chi.Router) {
		authenticated.Use(outerMiddleware)
		Mount(authenticated, nil, nil, nil)
	})

	type registration struct {
		method      string
		path        string
		middlewares int
	}
	var registered []registration
	if err := chi.Walk(router, func(method, route string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		registered = append(registered, registration{method: method, path: route, middlewares: len(middlewares)})
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}

	want := map[string]int{
		"GET /api/v1/nbp/settings":       2,
		"PUT /api/v1/nbp/settings":       2,
		"GET /api/v1/nbp/recommend":      2,
		"GET /api/v1/nbp/syntax-example": 1,
	}
	for _, route := range registered {
		key := route.method + " " + route.path
		wantMiddlewares, expected := want[key]
		if !expected {
			t.Errorf("unexpected NBP registration %s", key)
			continue
		}
		if route.middlewares != wantMiddlewares {
			t.Errorf("%s middleware count = %d, want %d", key, route.middlewares, wantMiddlewares)
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Errorf("missing canonical NBP registrations: %#v", want)
	}

	for _, path := range []string{"/nbp/settings", "/nbp/recommend", "/nbp/syntax-example"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404 outside /api/v1 boundary", path, rec.Code)
		}
	}
}

func TestSettingsRejectUnavailableExternalStrategyBeforeDatabaseAccess(t *testing.T) {
	repo := &Repo{}
	_, err := repo.UpsertSettings(context.Background(), "tenant-1", Settings{
		RefresherStrategy: "personalize",
	})
	if !errors.Is(err, ErrUnsupportedStrategy) {
		t.Fatalf("error = %v, want ErrUnsupportedStrategy", err)
	}
	if selectableStrategy("personalize") {
		t.Fatal("retired external strategy must not be advertised as selectable")
	}
}
