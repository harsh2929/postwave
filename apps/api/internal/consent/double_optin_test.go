package consent

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func TestNewDoubleOptInTokenIsUnique(t *testing.T) {
	a, err := newDoubleOptInToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := newDoubleOptInToken()
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Errorf("two tokens collided: %s == %s", a, b)
	}
	if len(a) != 64 {
		t.Errorf("token should be 64 hex chars (32 bytes), got %d", len(a))
	}
}

func TestNewDoubleOptInTokenHashIsDeterministic(t *testing.T) {
	tok := "deadbeef"
	hash1 := sha256.Sum256([]byte(tok))
	hash2 := sha256.Sum256([]byte(tok))
	if hex.EncodeToString(hash1[:]) != hex.EncodeToString(hash2[:]) {
		t.Fatalf("sha256 should be deterministic")
	}
}

func TestDefaultDoubleOptInTTLMatchesMailchimp(t *testing.T) {
	// 60 days is the parity benchmark; if this ever changes, the
	// purger SQL window changes too.
	if DefaultDoubleOptInTTL != 60*24*time.Hour {
		t.Fatalf("TTL drifted from 60d: %s", DefaultDoubleOptInTTL)
	}
}

func TestPurgerNilPoolSweepNoop(t *testing.T) {
	p := &Purger{}
	n, err := p.SweepOnce(t.Context())
	if err != nil {
		t.Fatalf("nil pool should be a noop, got %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 purged with nil pool, got %d", n)
	}
}
