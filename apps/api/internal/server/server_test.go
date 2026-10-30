// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

func TestNewAppliesRequestAndHeaderLimits(t *testing.T) {
	router := chi.NewRouter()
	called := false
	router.Post("/upload", func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	srv := New(Deps{Router: router})
	if srv.MaxHeaderBytes != 64<<10 {
		t.Fatalf("MaxHeaderBytes=%d, want %d", srv.MaxHeaderBytes, 64<<10)
	}
	req := httptest.NewRequest(http.MethodPost, "/upload", http.NoBody)
	req.ContentLength = httpbody.DefaultRequestMaxBodyBytes + 1
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, req)
	if called {
		t.Fatal("handler called for oversized request")
	}
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s, want 413", rec.Code, rec.Body.String())
	}
}
