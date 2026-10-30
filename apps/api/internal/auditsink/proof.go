// SPDX-License-Identifier: AGPL-3.0-only
//
// proof.go — customer-callable Merkle inclusion + consistency proofs
// over the audit_log hash chain. Reads:
//
//   * audit_log.{id, row_hash, prev_hash}    — per-row chain links.
//   * audit_merkle_roots.{tree_size, root_hash, signature, kid,
//     rooted_at, upto_audit_id}             — periodic checkpoints.
//
// Why this exists: SOC2/HIPAA auditors and security-minded customers
// want to prove "row N is committed under root R" without trusting
// Moosewave. The hash-chain we already maintain (sha256(row || prev))
// gives us this for free — we just need to expose:
//
//   1. The leaf hash of the row they're verifying.
//   2. The sibling/audit-path the verifier walks to reach the root.
//      For a chain (vs. a binary tree) the "path" is the ordered list
//      of intermediate row_hashes from the row of interest up to the
//      checkpoint's tip. A verifier re-walks them with prev_hash
//      threading and confirms the final hash matches root_hash.
//   3. The signed root checkpoint itself (so they don't have to trust
//      the path bytes either — if even one byte is tampered the final
//      hash will not match the signed value).
//
// For consistency proofs (RFC 9162 §2.1.4 adapted to a linear chain),
// we return the list of intermediate row_hashes between two
// checkpoints so a verifier with the old root can confirm the new root
// is an extension of the same chain.

package auditsink

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrAuditRowNotFound is returned when an inclusion-proof request
// targets an id that doesn't exist (or belongs to another tenant).
var ErrAuditRowNotFound = errors.New("auditsink: audit row not found")

// ErrNoCheckpoint signals that the requested audit row exists but no
// signed root has been produced yet (Merkle worker hasn't ticked, or
// the row is newer than the latest checkpoint). The verifier can
// retry in a minute.
var ErrNoCheckpoint = errors.New("auditsink: no checkpoint covers this row yet")

// ErrBadRange signals a malformed consistency-proof range (from >= to
// or to > latest tree_size).
var ErrBadRange = errors.New("auditsink: invalid checkpoint range")

// Checkpoint mirrors one audit_merkle_roots row in domain terms.
// RootHash / Signature are returned hex-encoded by the HTTP handler.
type Checkpoint struct {
	ID           int64
	UptoAuditID  int64
	TreeSize     int64
	RootHash     []byte
	Signature    []byte
	SignatureKid string
	RootedAt     time.Time
}

// InclusionProof is the wire-shape returned by GET
// /api/v1/audit/{id}/inclusion-proof. All hash fields are hex strings
// (lower-case, no 0x prefix) so a Python / curl verifier can compare
// byte-for-byte.
type InclusionProof struct {
	LeafID        int64     `json:"leaf_id"`
	LeafHash      string    `json:"leaf_hash"`
	AuditPath     []string  `json:"audit_path"`
	TreeSize      int64     `json:"tree_size"`
	RootHash      string    `json:"root_hash"`
	RootSignature string    `json:"root_signature,omitempty"`
	RootKid       string    `json:"root_kid,omitempty"`
	AnchoredAt    time.Time `json:"anchored_at"`
}

// ConsistencyProof is the wire-shape returned by GET
// /api/v1/audit/consistency-proof?from=N&to=M.
type ConsistencyProof struct {
	OldSize           int64    `json:"old_size"`
	NewSize           int64    `json:"new_size"`
	OldRootHash       string   `json:"old_root_hash"`
	NewRootHash       string   `json:"new_root_hash"`
	ConsistencyHashes []string `json:"consistency_hashes"`
}

// ProofRepo is the narrow DB surface this package needs. Implemented
// by *db.Pool via the helper functions below; tests can pass a fake.
type ProofRepo interface {
	BuildInclusionProof(ctx context.Context, tenantID string, leafID int64) (*InclusionProof, error)
	BuildConsistencyProof(ctx context.Context, tenantID string, fromSize, toSize int64) (*ConsistencyProof, error)
	LatestCheckpoint(ctx context.Context, tenantID string) (*Checkpoint, error)
}

// PgProofRepo is the production implementation.
type PgProofRepo struct {
	Pool *db.Pool
}

// LatestCheckpoint returns the most recent signed root for the tenant.
// Used by both the inclusion-proof builder (to pick a covering root)
// and by the POST /api/v1/audit/checkpoint/latest endpoint.
func (p *PgProofRepo) LatestCheckpoint(ctx context.Context, tenantID string) (*Checkpoint, error) {
	tx, err := db.WithTenant(ctx, p.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return latestCheckpointTx(ctx, tx, tenantID)
}

// findCoveringCheckpoint picks the smallest checkpoint whose
// upto_audit_id >= leafID. That root proves the leaf is committed.
func findCoveringCheckpoint(ctx context.Context, tx pgx.Tx, tenantID string, leafID int64) (*Checkpoint, error) {
	row := tx.QueryRow(ctx, `
SELECT id, upto_audit_id, tree_size,
       root_hash,
       COALESCE(signature, ''::bytea),
       COALESCE(signature_kid, ''),
       rooted_at
  FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid AND upto_audit_id >= $2
 ORDER BY upto_audit_id ASC
 LIMIT 1`, tenantID, leafID)
	var c Checkpoint
	if err := row.Scan(&c.ID, &c.UptoAuditID, &c.TreeSize,
		&c.RootHash, &c.Signature, &c.SignatureKid, &c.RootedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNoCheckpoint
		}
		return nil, fmt.Errorf("covering checkpoint: %w", err)
	}
	return &c, nil
}

// latestCheckpointTx returns the most recent checkpoint inside an
// existing tenant-bound tx.
func latestCheckpointTx(ctx context.Context, tx pgx.Tx, tenantID string) (*Checkpoint, error) {
	row := tx.QueryRow(ctx, `
SELECT id, upto_audit_id, tree_size,
       root_hash,
       COALESCE(signature, ''::bytea),
       COALESCE(signature_kid, ''),
       rooted_at
  FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid
 ORDER BY id DESC
 LIMIT 1`, tenantID)
	var c Checkpoint
	if err := row.Scan(&c.ID, &c.UptoAuditID, &c.TreeSize,
		&c.RootHash, &c.Signature, &c.SignatureKid, &c.RootedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNoCheckpoint
		}
		return nil, fmt.Errorf("latest checkpoint: %w", err)
	}
	return &c, nil
}

// BuildInclusionProof returns the proof for audit_log.id == leafID
// against the smallest checkpoint that covers it.
func (p *PgProofRepo) BuildInclusionProof(ctx context.Context, tenantID string, leafID int64) (*InclusionProof, error) {
	tx, err := db.WithTenant(ctx, p.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Verify the row exists for this tenant + read its row_hash.
	var leafHash []byte
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(row_hash, ''::bytea)
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id = $2`, tenantID, leafID).Scan(&leafHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAuditRowNotFound
		}
		return nil, fmt.Errorf("read leaf: %w", err)
	}
	if len(leafHash) == 0 {
		// The Merkle worker hasn't backfilled this row yet — no
		// proof can be generated. Treat the same as "no checkpoint".
		return nil, ErrNoCheckpoint
	}

	// 2. Find the smallest covering checkpoint.
	ck, err := findCoveringCheckpoint(ctx, tx, tenantID, leafID)
	if err != nil {
		return nil, err
	}

	// 3. Read the intermediate row_hashes between the leaf and the
	// covering root's upto_audit_id. The audit-path is the ordered
	// list of row_hashes for rows with id > leafID AND id <= upto.
	// Verifier walks: starting from leaf_hash, for each path element
	// confirm path[k] == sha256(canonical_bytes(row_k) || path[k-1])
	// (with path[-1] = leaf_hash). The last element must equal root_hash.
	rows, err := tx.Query(ctx, `
SELECT row_hash
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id > $2 AND id <= $3 AND row_hash IS NOT NULL
 ORDER BY id ASC`, tenantID, leafID, ck.UptoAuditID)
	if err != nil {
		return nil, fmt.Errorf("read audit path: %w", err)
	}
	defer rows.Close()
	path := []string{}
	for rows.Next() {
		var h []byte
		if err := rows.Scan(&h); err != nil {
			return nil, fmt.Errorf("scan path: %w", err)
		}
		path = append(path, hex.EncodeToString(h))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("path rows: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return &InclusionProof{
		LeafID:        leafID,
		LeafHash:      hex.EncodeToString(leafHash),
		AuditPath:     path,
		TreeSize:      ck.TreeSize,
		RootHash:      hex.EncodeToString(ck.RootHash),
		RootSignature: hex.EncodeToString(ck.Signature),
		RootKid:       ck.SignatureKid,
		AnchoredAt:    ck.RootedAt.UTC(),
	}, nil
}

// BuildConsistencyProof returns the ordered list of intermediate
// row_hashes a verifier needs to extend an old root (tree_size ==
// fromSize) to a new root (tree_size == toSize). For a linear hash
// chain, "consistency" reduces to: every leaf in the old tree also
// appears in the new tree, and the new tip is reachable by re-hashing
// each new row on top of the old tip.
//
// The returned list is the row_hashes (in id ASC order) of the rows
// added between the two checkpoints. A verifier reconstructs the new
// root by, for each hash, asserting it == sha256(canonical(row) ||
// prev) — but for an external verifier that doesn't have the canonical
// row bytes, the simpler check is: the last element MUST equal
// new_root_hash, and the first element's prev_hash field MUST equal
// old_root_hash. (The per-row recomputation requires CSV export of
// the new rows — that's the offline-verifier flow documented in
// docs/audit/verify-proofs.md.)
func (p *PgProofRepo) BuildConsistencyProof(ctx context.Context, tenantID string, fromSize, toSize int64) (*ConsistencyProof, error) {
	if fromSize <= 0 || toSize <= 0 || fromSize > toSize {
		return nil, ErrBadRange
	}
	tx, err := db.WithTenant(ctx, p.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	oldCk, err := checkpointAtSize(ctx, tx, tenantID, fromSize)
	if err != nil {
		return nil, err
	}
	newCk, err := checkpointAtSize(ctx, tx, tenantID, toSize)
	if err != nil {
		return nil, err
	}
	// Empty proof: same checkpoint asked twice.
	if oldCk.ID == newCk.ID {
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit: %w", err)
		}
		return &ConsistencyProof{
			OldSize:           oldCk.TreeSize,
			NewSize:           newCk.TreeSize,
			OldRootHash:       hex.EncodeToString(oldCk.RootHash),
			NewRootHash:       hex.EncodeToString(newCk.RootHash),
			ConsistencyHashes: []string{},
		}, nil
	}

	rows, err := tx.Query(ctx, `
SELECT row_hash
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id > $2 AND id <= $3 AND row_hash IS NOT NULL
 ORDER BY id ASC`, tenantID, oldCk.UptoAuditID, newCk.UptoAuditID)
	if err != nil {
		return nil, fmt.Errorf("read consistency hashes: %w", err)
	}
	defer rows.Close()
	hashes := []string{}
	for rows.Next() {
		var h []byte
		if err := rows.Scan(&h); err != nil {
			return nil, fmt.Errorf("scan consistency: %w", err)
		}
		hashes = append(hashes, hex.EncodeToString(h))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("consistency rows: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return &ConsistencyProof{
		OldSize:           oldCk.TreeSize,
		NewSize:           newCk.TreeSize,
		OldRootHash:       hex.EncodeToString(oldCk.RootHash),
		NewRootHash:       hex.EncodeToString(newCk.RootHash),
		ConsistencyHashes: hashes,
	}, nil
}

// checkpointAtSize returns the smallest checkpoint with tree_size >= n.
// Returns ErrBadRange when n is larger than any existing checkpoint.
func checkpointAtSize(ctx context.Context, tx pgx.Tx, tenantID string, n int64) (*Checkpoint, error) {
	row := tx.QueryRow(ctx, `
SELECT id, upto_audit_id, tree_size,
       root_hash,
       COALESCE(signature, ''::bytea),
       COALESCE(signature_kid, ''),
       rooted_at
  FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid AND tree_size >= $2
 ORDER BY tree_size ASC
 LIMIT 1`, tenantID, n)
	var c Checkpoint
	if err := row.Scan(&c.ID, &c.UptoAuditID, &c.TreeSize,
		&c.RootHash, &c.Signature, &c.SignatureKid, &c.RootedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrBadRange
		}
		return nil, fmt.Errorf("checkpoint at size %d: %w", n, err)
	}
	return &c, nil
}

// VerifyChainSegment is a stdlib-only re-implementation of the per-row
// hash recomputation a customer's CLI verifier runs. It's exported so
// callers (and tests) can reuse the bit-identical algorithm. Given an
// ordered slice of (canonicalRowBytes, recordedRowHash) pairs and a
// starting prevHash, it returns nil if every recorded hash matches
// sha256(canonical || prev) and the chain reaches finalHash.
func VerifyChainSegment(prevHash []byte, segment []struct {
	Canonical []byte
	RowHash   []byte
}, finalHash []byte) error {
	cur := prevHash
	for i, s := range segment {
		h := sha256.New()
		h.Write(s.Canonical)
		h.Write(cur)
		got := h.Sum(nil)
		if !bytesEqual(got, s.RowHash) {
			return fmt.Errorf("segment %d: hash mismatch (got %x, want %x)", i, got, s.RowHash)
		}
		cur = got
	}
	if finalHash != nil && !bytesEqual(cur, finalHash) {
		return fmt.Errorf("final hash mismatch (got %x, want %x)", cur, finalHash)
	}
	return nil
}

// bytesEqual is a tiny inline helper so this file stays stdlib-only.
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
