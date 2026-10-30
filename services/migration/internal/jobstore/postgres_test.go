package jobstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestMemoryJobStoreTenantScopedGetDoesNotLeakCrossTenantJobs(t *testing.T) {
	store := NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "11111111111111111111111111111111",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := store.Get(WithTenantID(context.Background(), "tenant_b"), job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant get error = %v, want ErrNotFound", err)
	}
	if _, err := store.Get(WithTenantID(context.Background(), "tenant_a"), job.ID); err != nil {
		t.Fatalf("same-tenant get: %v", err)
	}
}

func TestMemoryJobStoreCopiesCursorPointers(t *testing.T) {
	store := NewMemoryJobStore()
	cursor := "page_1"
	job := &canonical.MigrationJob{
		ID:        "22222222222222222222222222222222",
		TenantID:  "tenant_a",
		Source:    canonical.SourceBeehiiv,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{"subscribers": &cursor},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	cursor = "mutated_by_caller"

	stored, err := store.Get(WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got := *stored.Cursor["subscribers"]; got != "page_1" {
		t.Fatalf("stored cursor = %q, want page_1", got)
	}

	*stored.Cursor["subscribers"] = "mutated_after_get"
	again, err := store.Get(WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get again: %v", err)
	}
	if got := *again.Cursor["subscribers"]; got != "page_1" {
		t.Fatalf("second stored cursor = %q, want page_1", got)
	}
}

func TestMemoryJobStoreOAuthStateIsTenantScopedAndSingleUse(t *testing.T) {
	store := NewMemoryJobStore()
	now := time.Now()
	state := OAuthStateRecord{
		State:     "state_abc",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Minute),
	}
	if err := store.SaveOAuthState(context.Background(), state); err != nil {
		t.Fatalf("save oauth state: %v", err)
	}
	if _, err := store.ConsumeOAuthState(context.Background(), "tenant_b", state.State, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant consume error = %v, want ErrNotFound", err)
	}
	got, err := store.ConsumeOAuthState(context.Background(), "tenant_a", state.State, now)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if got.Source != canonical.SourceMailchimp {
		t.Fatalf("source = %q", got.Source)
	}
	if _, err := store.ConsumeOAuthState(context.Background(), "tenant_a", state.State, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second consume error = %v, want ErrNotFound", err)
	}
}

func TestMemoryJobStoreSessionIsTenantScopedAndCopied(t *testing.T) {
	store := NewMemoryJobStore()
	expiresAt := time.Now().Add(time.Hour)
	sess := adapter.Session{
		AccessToken: "token",
		AccountID:   "acct",
		Source:      canonical.SourceBeehiiv,
		Extra:       map[string]string{"publication_id": "pub_1"},
	}
	if err := store.SaveSession(context.Background(), "job_1", "tenant_a", sess, expiresAt); err != nil {
		t.Fatalf("save session: %v", err)
	}
	sess.Extra["publication_id"] = "mutated"

	if _, err := store.GetSession(context.Background(), "tenant_b", "job_1", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant get error = %v, want ErrNotFound", err)
	}
	got, err := store.GetSession(context.Background(), "tenant_a", "job_1", time.Now())
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if got.Extra["publication_id"] != "pub_1" {
		t.Fatalf("stored extra = %q, want pub_1", got.Extra["publication_id"])
	}
	got.Extra["publication_id"] = "mutated_after_get"
	again, err := store.GetSession(context.Background(), "tenant_a", "job_1", time.Now())
	if err != nil {
		t.Fatalf("get session again: %v", err)
	}
	if again.Extra["publication_id"] != "pub_1" {
		t.Fatalf("stored extra after caller mutation = %q", again.Extra["publication_id"])
	}
}

func TestAESSessionCipherRoundTripsAndRejectsTampering(t *testing.T) {
	cipher, err := NewAESSessionCipher("hex:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	ct, err := cipher.Encrypt(context.Background(), []byte("secret-session"))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	pt, err := cipher.Decrypt(context.Background(), ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(pt) != "secret-session" {
		t.Fatalf("plaintext = %q", string(pt))
	}
	ct[len(ct)-1] ^= 0xff
	if _, err := cipher.Decrypt(context.Background(), ct); err == nil {
		t.Fatalf("tampered ciphertext decrypted successfully")
	}
}
