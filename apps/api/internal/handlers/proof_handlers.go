// SPDX-License-Identifier: AGPL-3.0-only
//
// proof_handlers.go — HTTP front for the customer-callable Merkle
// inclusion + consistency proof endpoints.
//
//   GET /api/v1/audit/{id}/inclusion-proof
//   GET /api/v1/audit/consistency-proof?from=N&to=M
//   GET /api/v1/audit/checkpoint/latest
//
// The math + DB reads live in apps/api/internal/auditsink/proof.go;
// this file only translates HTTP envelope shapes.

package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ProofHandlers wires the proof endpoints. Construction is intentionally
// trivial — the repo does all the work and tests can inject a fake.
type ProofHandlers struct {
	Repo auditsink.ProofRepo
	// Logger is used by httperror.WriteInternal for structured server-side
	// logging of unexpected failures. nil-safe — tests can omit it and
	// the internal-error envelope is still emitted without a log line.
	Logger *slog.Logger
}

// NewProofHandlers wires a PgProofRepo over the pool.
func NewProofHandlers(pool *db.Pool) *ProofHandlers {
	return &ProofHandlers{Repo: &auditsink.PgProofRepo{Pool: pool}}
}

// InclusionProof GET /api/v1/audit/{id}/inclusion-proof
func (h *ProofHandlers) InclusionProof(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	idStr := chi.URLParam(r, "id")
	leafID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || leafID <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "id must be a positive integer")
		return
	}
	proof, err := h.Repo.BuildInclusionProof(r.Context(), t.ID, leafID)
	if err != nil {
		switch {
		case errors.Is(err, auditsink.ErrAuditRowNotFound):
			writeJSONErr(w, http.StatusNotFound, "not_found", "audit event not found")
		case errors.Is(err, auditsink.ErrNoCheckpoint):
			// 425 Too Early is the cleanest semantic: the row exists
			// but the periodic Merkle worker hasn't rooted it yet.
			// Clients should retry in ~60s.
			writeJSONErr(w, http.StatusTooEarly, "no_checkpoint",
				"no signed root covers this audit event yet — try again in a minute")
		default:
			httperror.WriteInternal(w, h.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, proof)
}

// ConsistencyProof GET /api/v1/audit/consistency-proof?from=N&to=M
func (h *ProofHandlers) ConsistencyProof(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	from, errFrom := strconv.ParseInt(q.Get("from"), 10, 64)
	to, errTo := strconv.ParseInt(q.Get("to"), 10, 64)
	if errFrom != nil || errTo != nil || from <= 0 || to <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "bad_range",
			"from and to must be positive integers (tree sizes)")
		return
	}
	if from > to {
		writeJSONErr(w, http.StatusBadRequest, "bad_range",
			"from must be <= to (backward consistency proofs are not defined)")
		return
	}
	proof, err := h.Repo.BuildConsistencyProof(r.Context(), t.ID, from, to)
	if err != nil {
		if errors.Is(err, auditsink.ErrBadRange) {
			writeJSONErr(w, http.StatusBadRequest, "bad_range",
				"no checkpoint covers the requested tree size — wait for the next root")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, proof)
}

// LatestCheckpoint GET /api/v1/audit/checkpoint/latest
//
// Returned shape matches the {root_hash, signature, kid, tree_size,
// upto_audit_id, rooted_at} fields a verifier needs to bootstrap a
// trust anchor.
func (h *ProofHandlers) LatestCheckpoint(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	ck, err := h.Repo.LatestCheckpoint(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, auditsink.ErrNoCheckpoint) {
			writeJSONErr(w, http.StatusNotFound, "no_checkpoint",
				"no Merkle root has been published yet for this tenant")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"checkpoint_id":  ck.ID,
		"tree_size":      ck.TreeSize,
		"upto_audit_id":  ck.UptoAuditID,
		"root_hash":      hexEncode(ck.RootHash),
		"root_signature": hexEncode(ck.Signature),
		"root_kid":       ck.SignatureKid,
		"anchored_at":    ck.RootedAt.UTC(),
	})
}

// hexEncode is a tiny adapter so we can return bytea blobs as hex
// strings without importing encoding/hex at the top of this file
// twice (the handlers file otherwise has no need for it).
func hexEncode(b []byte) string {
	const hexdigits = "0123456789abcdef"
	if len(b) == 0 {
		return ""
	}
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = hexdigits[v>>4]
		out[i*2+1] = hexdigits[v&0x0f]
	}
	return string(out)
}
