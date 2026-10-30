// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

// honestRows constructs a small in-memory chain and the matching
// proofJSON the verifier would receive from /inclusion-proof, then
// asserts verify() accepts it.
func honestChain(n int) (proofJSON, map[int64]rowRec) {
	rows := map[int64]rowRec{}
	hashes := map[int64][]byte{}
	prev := make([]byte, 32)
	for i := int64(1); i <= int64(n); i++ {
		r := rowRec{
			id:           i,
			tenantID:     "t-1",
			userID:       "u-1",
			action:       "test.action",
			resourceType: "thing",
			resourceID:   "abc",
			metaJSON:     "{}",
			ip:           "10.0.0.1",
			userAgent:    "go-test",
			actorType:    "human",
			actorLabel:   "alice",
			at:           time.Unix(1_700_000_000+i, 0).UTC(),
		}
		rows[i] = r
		h := sha256.New()
		h.Write(canonicalBytes(r))
		h.Write(prev)
		hh := h.Sum(nil)
		hashes[i] = hh
		prev = hh
	}
	// Leaf is row 1; path is rows 2..n
	path := []string{}
	for i := int64(2); i <= int64(n); i++ {
		path = append(path, hex.EncodeToString(hashes[i]))
	}
	p := proofJSON{
		LeafID:    1,
		LeafHash:  hex.EncodeToString(hashes[1]),
		AuditPath: path,
		TreeSize:  int64(n),
		RootHash:  hex.EncodeToString(hashes[int64(n)]),
	}
	return p, rows
}

func TestVerify_Honest(t *testing.T) {
	p, rows := honestChain(8)
	if err := verify(p, rows); err != nil {
		t.Fatalf("honest chain failed: %v", err)
	}
}

func TestVerify_TamperedHashFails(t *testing.T) {
	p, rows := honestChain(5)
	// Flip one byte of the second path element.
	tampered := []byte(p.AuditPath[1])
	if tampered[0] == 'a' {
		tampered[0] = 'b'
	} else {
		tampered[0] = 'a'
	}
	p.AuditPath[1] = string(tampered)
	if err := verify(p, rows); err == nil {
		t.Fatalf("tampered path passed verification — chain is not tamper-evident")
	}
}

func TestVerify_MissingRowFails(t *testing.T) {
	p, rows := honestChain(4)
	delete(rows, 3) // remove a row referenced by the path
	if err := verify(p, rows); err == nil {
		t.Fatalf("missing row passed verification")
	}
}

func TestVerify_WrongRootFails(t *testing.T) {
	p, rows := honestChain(3)
	// Replace the root with an unrelated 32-byte string.
	p.RootHash = hex.EncodeToString(sha256.New().Sum(nil))
	if err := verify(p, rows); err == nil {
		t.Fatalf("wrong root passed verification")
	}
}

func TestVerify_SingleRow(t *testing.T) {
	// Chain with one row only — leaf == root, path is empty.
	p, rows := honestChain(1)
	if len(p.AuditPath) != 0 {
		t.Fatalf("expected empty path for single-row chain, got %v", p.AuditPath)
	}
	if err := verify(p, rows); err != nil {
		t.Fatalf("single-row chain failed: %v", err)
	}
}

func TestVerify_AlteredRowFails(t *testing.T) {
	p, rows := honestChain(4)
	// Mutate one of the source rows so the recomputed hash diverges.
	r := rows[3]
	r.action = "tampered.action"
	rows[3] = r
	if err := verify(p, rows); err == nil {
		t.Fatalf("mutated row passed verification — canonical bytes are not sensitive to action")
	}
}

func TestBytesEqual(t *testing.T) {
	cases := []struct {
		a, b []byte
		want bool
	}{
		{nil, nil, true},
		{[]byte{1, 2, 3}, []byte{1, 2, 3}, true},
		{[]byte{1, 2}, []byte{1, 2, 3}, false},
		{[]byte{1, 2, 3}, []byte{1, 2, 4}, false},
	}
	for _, c := range cases {
		if got := bytesEqual(c.a, c.b); got != c.want {
			t.Errorf("bytesEqual(%v, %v) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
