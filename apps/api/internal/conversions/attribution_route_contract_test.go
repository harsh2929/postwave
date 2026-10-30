package conversions

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestAttributionRoutesDoNotAdvertiseSequenceReport(t *testing.T) {
	router := chi.NewRouter()
	Mount(router, &Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversions/attribution/sequences?days=30", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for absent sequence attribution contract", rec.Code)
	}
}
