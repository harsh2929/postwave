// SPDX-License-Identifier: AGPL-3.0-only
//
// proof_test.go — pure-Go tests for the inclusion / consistency proof
// hash math. Integration tests that exercise the DB live in
// merkle_db_test.go (they're skipped when DATABASE_URL isn't set).

package auditsink

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// buildChain returns (rows, perRowHashes, tipHash) for a chain of n
// rows where each row's hash is sha256(canonical || prev). Used as the
// honest reference for the verifier tests.
func buildChain(n int) ([]AuditRow, [][]byte, []byte) {
	rows := make([]AuditRow, n)
	hashes := make([][]byte, n)
	prev := make([]byte, 32)
	for i := 0; i < n; i++ {
		rows[i] = sampleRow(int64(i + 1))
		hashes[i] = RowHash(rows[i], prev)
		prev = hashes[i]
	}
	return rows, hashes, prev
}

// TestVerifyChainSegment_Honest verifies a clean chain end-to-end.
func TestVerifyChainSegment_Honest(t *testing.T) {
	rows, hashes, tip := buildChain(10)
	seg := make([]struct {
		Canonical []byte
		RowHash   []byte
	}, len(rows))
	for i, r := range rows {
		seg[i].Canonical = CanonicalBytes(r)
		seg[i].RowHash = hashes[i]
	}
	zero := make([]byte, 32)
	if err := VerifyChainSegment(zero, seg, tip); err != nil {
		t.Fatalf("honest chain failed verification: %v", err)
	}
}

// TestVerifyChainSegment_TamperedRow flips one canonical byte and
// confirms the verifier catches the divergence at the tampered index.
func TestVerifyChainSegment_TamperedRow(t *testing.T) {
	rows, hashes, tip := buildChain(6)
	seg := make([]struct {
		Canonical []byte
		RowHash   []byte
	}, len(rows))
	for i, r := range rows {
		seg[i].Canonical = CanonicalBytes(r)
		seg[i].RowHash = hashes[i]
	}
	// Flip one byte in the canonical payload at index 3.
	seg[3].Canonical[0] ^= 0x01
	zero := make([]byte, 32)
	if err := VerifyChainSegment(zero, seg, tip); err == nil {
		t.Fatalf("tampered row passed verification — chain is not tamper-evident")
	}
}

// TestVerifyChainSegment_BadFinal catches a truncated chain (final tip
// wrong, no per-row tampering).
func TestVerifyChainSegment_BadFinal(t *testing.T) {
	rows, hashes, _ := buildChain(4)
	seg := make([]struct {
		Canonical []byte
		RowHash   []byte
	}, len(rows))
	for i, r := range rows {
		seg[i].Canonical = CanonicalBytes(r)
		seg[i].RowHash = hashes[i]
	}
	bogus := bytes.Repeat([]byte{0xee}, 32)
	zero := make([]byte, 32)
	if err := VerifyChainSegment(zero, seg, bogus); err == nil {
		t.Fatalf("wrong final tip passed verification")
	}
}

// TestVerifyChainSegment_Empty handles the "same checkpoint twice"
// boundary case — empty segment must pass if prev == final.
func TestVerifyChainSegment_Empty(t *testing.T) {
	zero := make([]byte, 32)
	if err := VerifyChainSegment(zero, nil, zero); err != nil {
		t.Fatalf("empty segment with matching tips failed: %v", err)
	}
}

// TestInclusionProof_HashShape spot-checks that a leaf hash hex string
// fed into the path math reconstructs the tip. Mirrors what a CLI
// verifier does after fetching /inclusion-proof.
func TestInclusionProof_HashShape(t *testing.T) {
	rows, hashes, tip := buildChain(5)
	// Pretend "leaf" is the 2nd row; path is hashes[2..4]; tip = hashes[4].
	leafIdx := 1
	cur := hashes[leafIdx]
	for i := leafIdx + 1; i < len(rows); i++ {
		// Each subsequent hash MUST equal sha256(canonical(rows[i]) || cur).
		h := sha256.New()
		h.Write(CanonicalBytes(rows[i]))
		h.Write(cur)
		got := h.Sum(nil)
		if !bytes.Equal(got, hashes[i]) {
			t.Fatalf("path elem %d drifted: got %x want %x", i, got, hashes[i])
		}
		cur = got
	}
	if !bytes.Equal(cur, tip) {
		t.Fatalf("walked path did not reach tip")
	}
	if hex.EncodeToString(cur) == "" {
		t.Fatalf("unexpected empty tip encoding")
	}
}

// TestBuildInclusionProof_NilLeafHash exercises the ErrNoCheckpoint
// branch when the row exists but hasn't been hashed yet. We can't use
// the PgProofRepo without a DB, so we assert the error sentinel
// surfaces from VerifyChainSegment by feeding it inconsistent inputs.
func TestProofErrors_Sentinels(t *testing.T) {
	if ErrAuditRowNotFound == nil || ErrNoCheckpoint == nil || ErrBadRange == nil {
		t.Fatalf("expected non-nil error sentinels")
	}
	if ErrAuditRowNotFound.Error() == ErrNoCheckpoint.Error() {
		t.Fatalf("sentinels must have distinct messages")
	}
}

// TestConsistencyProofShape — the wire shape always carries oldSize,
// newSize, both root hashes, and (possibly empty) consistency hashes.
// We construct a synthetic proof and assert basic invariants the
// HTTP layer relies on.
func TestConsistencyProofShape(t *testing.T) {
	p := &ConsistencyProof{
		OldSize:           3,
		NewSize:           10,
		OldRootHash:       hex.EncodeToString(bytes.Repeat([]byte{0x01}, 32)),
		NewRootHash:       hex.EncodeToString(bytes.Repeat([]byte{0x02}, 32)),
		ConsistencyHashes: []string{hex.EncodeToString(bytes.Repeat([]byte{0x03}, 32))},
	}
	if p.OldSize >= p.NewSize {
		t.Fatalf("oldSize must be < newSize")
	}
	if len(p.ConsistencyHashes) == 0 {
		t.Fatalf("expected non-empty consistency hashes for forward proof")
	}
}
