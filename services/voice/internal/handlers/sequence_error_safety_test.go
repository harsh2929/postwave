package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

type failingSequenceStore struct {
	err error
}

func (s failingSequenceStore) Save(context.Context, generation.Sequence) error { return s.err }
func (s failingSequenceStore) Get(context.Context, string, string) (generation.Sequence, error) {
	return generation.Sequence{}, s.err
}
func (s failingSequenceStore) List(context.Context, string) ([]generation.Sequence, error) {
	return nil, s.err
}
func (s failingSequenceStore) Delete(context.Context, string, string) error { return s.err }
func (s failingSequenceStore) SaveWithVersion(context.Context, generation.Sequence, int64) (int64, error) {
	return 0, s.err
}
func (s failingSequenceStore) DeleteWithVersion(context.Context, string, string, int64) error {
	return s.err
}

func TestSequenceRoutesNeverExposeRawPersistenceErrors(t *testing.T) {
	const secret = "postgres-secret: invalid input syntax at $2::uuid"
	store := failingSequenceStore{err: errors.New(secret)}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})

	for _, tc := range []struct {
		name   string
		method string
		path   string
		body   string
		want   string
		etag   bool
	}{
		{name: "list", method: http.MethodGet, path: "/sequences", want: "sequence list unavailable"},
		{name: "get", method: http.MethodGet, path: "/sequences/seq-safe", want: "sequence lookup failed"},
		{name: "create", method: http.MethodPost, path: "/sequences", body: `{"name":"Draft"}`, want: "sequence save failed"},
		{name: "update lookup", method: http.MethodPatch, path: "/sequences/seq-safe", body: `{"name":"Changed"}`, want: "sequence lookup failed", etag: true},
		{name: "delete", method: http.MethodDelete, path: "/sequences/seq-safe", want: "sequence delete failed", etag: true},
		{name: "variant lookup", method: http.MethodPost, path: "/sequences/seq-safe/steps/1/variant", body: `{"subscriber_id":"subscriber_1"}`, want: "sequence lookup failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			if tc.etag {
				req.Header.Set("If-Match", `"1"`)
			}
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500: %s", rec.Code, rec.Body.String())
			}
			if got := strings.TrimSpace(rec.Body.String()); got != tc.want {
				t.Fatalf("body = %q, want stable %q", got, tc.want)
			}
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("response exposed persistence details: %q", rec.Body.String())
			}
		})
	}
}
