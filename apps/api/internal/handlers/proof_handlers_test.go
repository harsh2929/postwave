// SPDX-License-Identifier: AGPL-3.0-only
//
// proof_handlers_test.go — HTTP-level tests for the inclusion /
// consistency proof endpoints. Uses a fake ProofRepo so the test
// doesn't need a live database; the DB-backed math is covered by
// merkle_db_test.go in the auditsink package.

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeProofRepo struct {
	inclusion        *auditsink.InclusionProof
	inclusionErr     error
	consistency      *auditsink.ConsistencyProof
	consistencyErr   error
	latest           *auditsink.Checkpoint
	latestErr        error
	lastTenantID     string
	lastLeafID       int64
	lastFrom, lastTo int64
}

func (f *fakeProofRepo) BuildInclusionProof(ctx context.Context, tenantID string, leafID int64) (*auditsink.InclusionProof, error) {
	f.lastTenantID = tenantID
	f.lastLeafID = leafID
	return f.inclusion, f.inclusionErr
}

func (f *fakeProofRepo) BuildConsistencyProof(ctx context.Context, tenantID string, from, to int64) (*auditsink.ConsistencyProof, error) {
	f.lastTenantID = tenantID
	f.lastFrom = from
	f.lastTo = to
	return f.consistency, f.consistencyErr
}

func (f *fakeProofRepo) LatestCheckpoint(ctx context.Context, tenantID string) (*auditsink.Checkpoint, error) {
	f.lastTenantID = tenantID
	return f.latest, f.latestErr
}

// withTenantCtx attaches a tenant to the request context the way the
// real middleware would.
func withTenantCtx(r *http.Request, tenantID string) *http.Request {
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})
	return r.WithContext(ctx)
}

// mountTestRouter wires a chi router with the proof endpoints so we
// can exercise URL-param extraction the same way main.go does.
func mountTestRouter(h *ProofHandlers) *chi.Mux {
	r := chi.NewRouter()
	r.Get("/api/v1/audit/{id}/inclusion-proof", h.InclusionProof)
	r.Get("/api/v1/audit/consistency-proof", h.ConsistencyProof)
	r.Get("/api/v1/audit/checkpoint/latest", h.LatestCheckpoint)
	return r
}

func TestInclusionProof_Success(t *testing.T) {
	fake := &fakeProofRepo{
		inclusion: &auditsink.InclusionProof{
			LeafID:     42,
			LeafHash:   "deadbeef",
			AuditPath:  []string{"aa", "bb"},
			TreeSize:   100,
			RootHash:   "cafebabe",
			AnchoredAt: time.Now().UTC(),
		},
	}
	h := &ProofHandlers{Repo: fake}
	router := mountTestRouter(h)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/42/inclusion-proof", nil)
	req = withTenantCtx(req, "tenant-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if fake.lastLeafID != 42 {
		t.Errorf("expected leafID=42 forwarded, got %d", fake.lastLeafID)
	}
	if fake.lastTenantID != "tenant-1" {
		t.Errorf("expected tenant forwarded, got %q", fake.lastTenantID)
	}
	var out auditsink.InclusionProof
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.LeafHash != "deadbeef" || out.RootHash != "cafebabe" {
		t.Errorf("response shape drift: %+v", out)
	}
	if len(out.AuditPath) != 2 {
		t.Errorf("expected 2-element path, got %v", out.AuditPath)
	}
}

func TestInclusionProof_NotFound(t *testing.T) {
	fake := &fakeProofRepo{inclusionErr: auditsink.ErrAuditRowNotFound}
	router := mountTestRouter(&ProofHandlers{Repo: fake})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/999/inclusion-proof", nil)
	req = withTenantCtx(req, "tenant-x")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestInclusionProof_NoCheckpoint(t *testing.T) {
	fake := &fakeProofRepo{inclusionErr: auditsink.ErrNoCheckpoint}
	router := mountTestRouter(&ProofHandlers{Repo: fake})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/1/inclusion-proof", nil)
	req = withTenantCtx(req, "t-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusTooEarly {
		t.Fatalf("expected 425 Too Early, got %d", w.Code)
	}
}

func TestInclusionProof_NoTenant(t *testing.T) {
	router := mountTestRouter(&ProofHandlers{Repo: &fakeProofRepo{}})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/1/inclusion-proof", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without tenant, got %d", w.Code)
	}
}

func TestInclusionProof_BadID(t *testing.T) {
	router := mountTestRouter(&ProofHandlers{Repo: &fakeProofRepo{}})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/abc/inclusion-proof", nil)
	req = withTenantCtx(req, "t-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-numeric id, got %d", w.Code)
	}
}

func TestConsistencyProof_Success(t *testing.T) {
	fake := &fakeProofRepo{
		consistency: &auditsink.ConsistencyProof{
			OldSize:           5,
			NewSize:           10,
			OldRootHash:       "aa",
			NewRootHash:       "bb",
			ConsistencyHashes: []string{"cc", "dd"},
		},
	}
	router := mountTestRouter(&ProofHandlers{Repo: fake})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/consistency-proof?from=5&to=10", nil)
	req = withTenantCtx(req, "t-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if fake.lastFrom != 5 || fake.lastTo != 10 {
		t.Errorf("expected from=5 to=10, got %d/%d", fake.lastFrom, fake.lastTo)
	}
}

func TestConsistencyProof_BadParams(t *testing.T) {
	router := mountTestRouter(&ProofHandlers{Repo: &fakeProofRepo{}})
	cases := []string{
		"/api/v1/audit/consistency-proof",
		"/api/v1/audit/consistency-proof?from=0&to=5",
		"/api/v1/audit/consistency-proof?from=10&to=5",
		"/api/v1/audit/consistency-proof?from=abc&to=5",
	}
	for _, url := range cases {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req = withTenantCtx(req, "t-1")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for %s, got %d", url, w.Code)
		}
	}
}

func TestConsistencyProof_BadRange(t *testing.T) {
	fake := &fakeProofRepo{consistencyErr: auditsink.ErrBadRange}
	router := mountTestRouter(&ProofHandlers{Repo: fake})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/consistency-proof?from=1&to=999999", nil)
	req = withTenantCtx(req, "t-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ErrBadRange, got %d", w.Code)
	}
}

func TestLatestCheckpoint_Success(t *testing.T) {
	fake := &fakeProofRepo{
		latest: &auditsink.Checkpoint{
			ID:           7,
			UptoAuditID:  100,
			TreeSize:     100,
			RootHash:     []byte{0xde, 0xad, 0xbe, 0xef},
			Signature:    []byte{0x01, 0x02},
			SignatureKid: "kms-key-1",
			RootedAt:     time.Now().UTC(),
		},
	}
	router := mountTestRouter(&ProofHandlers{Repo: fake})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/checkpoint/latest", nil)
	req = withTenantCtx(req, "t-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["root_hash"] != "deadbeef" {
		t.Errorf("expected hex-encoded root_hash, got %v", body["root_hash"])
	}
	if body["root_kid"] != "kms-key-1" {
		t.Errorf("expected kid forwarded, got %v", body["root_kid"])
	}
}

func TestLatestCheckpoint_None(t *testing.T) {
	fake := &fakeProofRepo{latestErr: auditsink.ErrNoCheckpoint}
	router := mountTestRouter(&ProofHandlers{Repo: fake})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/checkpoint/latest", nil)
	req = withTenantCtx(req, "t-1")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

// TestHexEncode_Basic sanity-checks the inlined hex encoder used by
// LatestCheckpoint (avoids pulling encoding/hex into this file).
func TestHexEncode_Basic(t *testing.T) {
	cases := []struct {
		in   []byte
		want string
	}{
		{nil, ""},
		{[]byte{}, ""},
		{[]byte{0x00}, "00"},
		{[]byte{0xff}, "ff"},
		{[]byte{0xde, 0xad, 0xbe, 0xef}, "deadbeef"},
	}
	for _, c := range cases {
		got := hexEncode(c.in)
		if got != c.want {
			t.Errorf("hexEncode(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
