package auth

import (
	"errors"
	"strings"
	"testing"
)

func TestHashAndVerify_RoundTrip(t *testing.T) {
	// Use weak params for test speed; production uses Recommended.
	weak := Params{Memory: 8 * 1024, Iterations: 1, Threads: 1, SaltLen: 16, KeyLen: 32}
	phc, err := Hash("correct horse battery staple", weak)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(phc, "$argon2id$v=19$") {
		t.Errorf("unexpected PHC prefix: %s", phc)
	}
	if err := Verify(phc, "correct horse battery staple"); err != nil {
		t.Errorf("verify good password: %v", err)
	}
	if err := Verify(phc, "wrong"); !errors.Is(err, ErrMismatch) {
		t.Errorf("verify bad password: got %v, want ErrMismatch", err)
	}
}

func TestHash_RejectsEmpty(t *testing.T) {
	if _, err := Hash("", Recommended); err == nil {
		t.Errorf("expected error on empty password")
	}
}

func TestVerify_MalformedPHC(t *testing.T) {
	cases := []string{
		"",
		"not a phc string",
		"$argon2i$v=19$m=1024,t=1,p=1$AAAA$AAAA", // wrong algo
		"$argon2id$v=99$m=1024,t=1,p=1$AAAA$AAAA", // wrong version
		"$argon2id$v=19$m=bad$AAAA$AAAA",          // bad params
	}
	for _, phc := range cases {
		if err := Verify(phc, "anything"); err == nil {
			t.Errorf("expected error on malformed PHC %q", phc)
		} else if errors.Is(err, ErrMismatch) {
			t.Errorf("malformed PHC should not return ErrMismatch (leaks structure): %q", phc)
		}
	}
}

func TestNeedsRehash(t *testing.T) {
	weak := Params{Memory: 1024, Iterations: 1, Threads: 1, SaltLen: 16, KeyLen: 32}
	weakPHC, err := Hash("password", weak)
	if err != nil {
		t.Fatal(err)
	}
	if !NeedsRehash(weakPHC) {
		t.Errorf("expected weak hash to need rehash")
	}
	strongPHC, err := Hash("password", Recommended)
	if err != nil {
		t.Fatal(err)
	}
	if NeedsRehash(strongPHC) {
		t.Errorf("expected current-recommended hash to NOT need rehash")
	}
	// Malformed should also report as needing rehash (treat as bad row).
	if !NeedsRehash("garbage") {
		t.Errorf("expected malformed PHC to need rehash")
	}
}

func TestHash_DifferentSaltsEachTime(t *testing.T) {
	weak := Params{Memory: 1024, Iterations: 1, Threads: 1, SaltLen: 16, KeyLen: 32}
	a, _ := Hash("same", weak)
	b, _ := Hash("same", weak)
	if a == b {
		t.Errorf("two hashes of the same password should differ (salt randomness)")
	}
}
