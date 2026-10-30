// SPDX-License-Identifier: AGPL-3.0-only

package auditsink

import (
	"bytes"
	"crypto/sha256"
	"testing"
	"time"
)

func sampleRow(id int64) AuditRow {
	return AuditRow{
		ID:           id,
		TenantID:     "t-1",
		UserID:       "u-1",
		Action:       "campaign.send",
		ResourceType: "campaign",
		ResourceID:   "c-1",
		Metadata:     map[string]any{"k": "v"},
		IP:           "10.0.0.1",
		UserAgent:    "go-test/1.0",
		ActorType:    "human",
		ActorLabel:   "alice@example.com",
		At:           time.Unix(1_700_000_000, 0).UTC(),
	}
}

// CanonicalBytes MUST be deterministic across calls for the same input
// — the hash chain depends on byte-identical encoding for verifiers.
func TestCanonicalBytes_Deterministic(t *testing.T) {
	r := sampleRow(42)
	a := CanonicalBytes(r)
	b := CanonicalBytes(r)
	if !bytes.Equal(a, b) {
		t.Fatalf("CanonicalBytes not deterministic\n got=%x\nwant=%x", a, b)
	}
}

// Any single-field mutation should produce different bytes — the
// fields are length-prefixed so a value of "abc" cannot collide with
// a value of "ab" + later field starting "c".
func TestCanonicalBytes_FieldSensitivity(t *testing.T) {
	base := CanonicalBytes(sampleRow(1))
	mutations := []func(r *AuditRow){
		func(r *AuditRow) { r.ID = 2 },
		func(r *AuditRow) { r.TenantID = "t-2" },
		func(r *AuditRow) { r.UserID = "u-2" },
		func(r *AuditRow) { r.Action = "campaign.delete" },
		func(r *AuditRow) { r.ResourceType = "list" },
		func(r *AuditRow) { r.ResourceID = "c-2" },
		func(r *AuditRow) { r.IP = "10.0.0.2" },
		func(r *AuditRow) { r.UserAgent = "x" },
		func(r *AuditRow) { r.ActorType = "service" },
		func(r *AuditRow) { r.ActorLabel = "bob" },
		func(r *AuditRow) { r.At = r.At.Add(time.Second) },
	}
	for i, mut := range mutations {
		r := sampleRow(1)
		mut(&r)
		got := CanonicalBytes(r)
		if bytes.Equal(base, got) {
			t.Errorf("mutation #%d produced identical bytes — field is not in canonical form", i)
		}
	}
}

func TestRowHash_DependsOnPrevHash(t *testing.T) {
	r := sampleRow(1)
	zero := make([]byte, 32)
	other := make([]byte, 32)
	other[0] = 0xff
	h1 := RowHash(r, zero)
	h2 := RowHash(r, other)
	if bytes.Equal(h1, h2) {
		t.Fatalf("RowHash ignored prev_hash; the chain has no tamper resistance")
	}
}

// Walk a small synthetic chain forward and verify each row's hash
// equals sha256(CanonicalBytes(row) || prev). This is the
// verification path a downstream auditor would run.
func TestMerkleChain_FullWalk(t *testing.T) {
	const N = 8
	rows := make([]AuditRow, N)
	for i := 0; i < N; i++ {
		rows[i] = sampleRow(int64(i + 1))
	}
	prev := make([]byte, 32)
	for i, r := range rows {
		got := RowHash(r, prev)
		// Independent recomputation: literally sha256 over the
		// canonical bytes + prev hash.
		h := sha256.New()
		h.Write(CanonicalBytes(r))
		h.Write(prev)
		want := h.Sum(nil)
		if !bytes.Equal(got, want) {
			t.Fatalf("row %d hash drift: got=%x want=%x", i, got, want)
		}
		prev = got
	}
}

// Tampering with a middle row breaks every subsequent row's hash —
// confirms that the chain is non-truncable / non-modifiable.
func TestMerkleChain_DetectsMiddleTamper(t *testing.T) {
	const N = 6
	rows := make([]AuditRow, N)
	for i := 0; i < N; i++ {
		rows[i] = sampleRow(int64(i + 1))
	}
	// Build the honest chain.
	honest := make([][]byte, N)
	prev := make([]byte, 32)
	for i, r := range rows {
		honest[i] = RowHash(r, prev)
		prev = honest[i]
	}
	// Now tamper with row 2 and recompute downstream.
	rows[2].Action = "campaign.delete"
	tampered := make([][]byte, N)
	prev = make([]byte, 32)
	for i, r := range rows {
		tampered[i] = RowHash(r, prev)
		prev = tampered[i]
	}
	// Rows 0 and 1 are unchanged; rows 2..N-1 must differ.
	for i := 0; i < 2; i++ {
		if !bytes.Equal(honest[i], tampered[i]) {
			t.Errorf("row %d should be unchanged but differs", i)
		}
	}
	for i := 2; i < N; i++ {
		if bytes.Equal(honest[i], tampered[i]) {
			t.Errorf("row %d should differ after tamper but does not — chain is broken", i)
		}
	}
}
