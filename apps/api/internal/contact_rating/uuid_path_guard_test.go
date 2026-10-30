package contact_rating

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// A non-UUID path segment is a client mistake and must answer 400.
//
// Without the guard the value reaches Postgres, comes back as "invalid input
// syntax for type uuid", and is mapped to 500 — so a bad request presents as a
// server fault. It also hid a routing shadow: GET on the POST-only
// /api/v1/contact-ratings/recompute matches this route with
// subscriber_id="recompute" and reported an internal error rather than saying
// the method was wrong.
func TestGetRejectsNonUUIDSubscriberID(t *testing.T) {
	t.Parallel()

	// %20 rather than a raw space: httptest.NewRequest rejects an
	// unescaped space in the URL, and the guard trims before parsing.
	for _, sid := range []string{"recompute", "not-a-uuid", "123", "%20"} {
		sid := sid
		t.Run(sid, func(t *testing.T) {
			t.Parallel()

			// Deps with a nil Repo: reaching the repo at all would panic, so
			// this also proves the guard returns BEFORE any lookup.
			d := &Deps{}

			r := chi.NewRouter()
			r.Get("/api/v1/contact-ratings/{subscriber_id}", d.Get)

			req := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/contact-ratings/"+sid,
				nil,
			)
			ctx := middleware.WithTenant(
				req.Context(),
				&middleware.Tenant{ID: uuid.NewString()},
			)
			req = req.WithContext(ctx)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("subscriber_id %q: got %d, want 400\nbody: %s",
					sid, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "invalid_subscriber_id") {
				t.Fatalf("subscriber_id %q: body does not name the error: %s",
					sid, rec.Body.String())
			}
		})
	}
}
