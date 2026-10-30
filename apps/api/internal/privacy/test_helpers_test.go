package privacy

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// addRouteCtx returns a request context with chi route params attached
// so handlers calling chi.URLParam find them in unit tests.
func addRouteCtx(r *http.Request, rctx *chi.Context) context.Context {
	return context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
}

// addTenantCtx attaches a synthetic tenant identity so handlers that
// guard on TenantFromContext proceed past the no_tenant 401 to the
// validation logic we want to test.
func addTenantCtx(r *http.Request) context.Context {
	return middleware.WithTenant(r.Context(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
		Name: "Test Tenant",
	})
}
