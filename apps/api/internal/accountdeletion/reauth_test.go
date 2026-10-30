// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/auth"
)

type fakeAuthRepo struct {
	session         *auth.Session
	credential      *auth.Credential
	hasTOTP         bool
	encryptedTOTP   []byte
	err             error
	failureRecorded bool
	countersReset   bool
}

func (f *fakeAuthRepo) LookupSession(context.Context, string, string) (*auth.Session, error) {
	return f.session, f.err
}
func (f *fakeAuthRepo) LookupCredential(context.Context, string) (*auth.Credential, error) {
	if f.credential == nil {
		return nil, auth.ErrNotFound
	}
	return f.credential, f.err
}
func (f *fakeAuthRepo) RecordLoginFailure(context.Context, string) error {
	f.failureRecorded = true
	return nil
}
func (f *fakeAuthRepo) ResetLoginCounters(context.Context, string) error {
	f.countersReset = true
	return nil
}
func (f *fakeAuthRepo) HasTOTPSecret(context.Context, string) (bool, error) {
	return f.hasTOTP, f.err
}
func (f *fakeAuthRepo) GetTOTPSecret(context.Context, string) ([]byte, [][]byte, error) {
	return f.encryptedTOTP, nil, f.err
}

type plainCipher struct{ secret []byte }

func (p plainCipher) Decrypt(context.Context, []byte, []byte) ([]byte, error) { return p.secret, nil }

func TestSessionReauth_PasswordUsesCurrentCredential(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	phc, err := auth.Hash("correct horse", auth.Params{Memory: 8, Iterations: 1, Threads: 1, SaltLen: 8, KeyLen: 16})
	if err != nil {
		t.Fatal(err)
	}
	repo := &fakeAuthRepo{
		session:    &auth.Session{UserID: "user-1", TenantID: "tenant-1", AuthMethod: "password", IssuedAt: now.Add(-time.Hour)},
		credential: &auth.Credential{UserID: "user-1", TenantID: "tenant-1", PasswordPHC: phc},
	}
	reauth := &SessionReauth{Repo: repo, Now: func() time.Time { return now }}
	method, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{Password: "correct horse"})
	if err != nil || method != "password" || !repo.countersReset {
		t.Fatalf("method=%q err=%v reset=%v", method, err, repo.countersReset)
	}
	_, err = reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{Password: "wrong"})
	if !errors.Is(err, ErrReauthFailed) || !repo.failureRecorded {
		t.Fatalf("err=%v failureRecorded=%v", err, repo.failureRecorded)
	}
}

func TestSessionReauth_ExternalProviderRequiresFreshSession(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	repo := &fakeAuthRepo{session: &auth.Session{
		UserID: "user-1", TenantID: "tenant-1", AuthMethod: "google", IssuedAt: now.Add(-6 * time.Minute),
	}}
	reauth := &SessionReauth{Repo: repo, Now: func() time.Time { return now }, Freshness: 5 * time.Minute}
	if _, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{}); !errors.Is(err, ErrFreshAuth) {
		t.Fatalf("stale session err=%v", err)
	}
	repo.session.IssuedAt = now.Add(-2 * time.Minute)
	if method, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{}); err != nil || method != "google" {
		t.Fatalf("fresh session method=%q err=%v", method, err)
	}
}

func TestSessionReauth_ConfirmedTOTPRequiresCurrentCode(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	secret := []byte("12345678901234567890")
	repo := &fakeAuthRepo{
		session:       &auth.Session{UserID: "user-1", TenantID: "tenant-1", AuthMethod: "magic_link", IssuedAt: now},
		hasTOTP:       true,
		encryptedTOTP: []byte("ciphertext"),
	}
	reauth := &SessionReauth{Repo: repo, Cipher: plainCipher{secret: secret}, Now: func() time.Time { return now }}
	if _, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{}); !errors.Is(err, ErrMFARequired) {
		t.Fatalf("missing code err=%v", err)
	}
	code := auth.Code(secret, now)
	if _, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{MFACode: code}); err != nil {
		t.Fatalf("current code err=%v", err)
	}
	if _, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{MFACode: "000000"}); !errors.Is(err, ErrReauthFailed) {
		t.Fatalf("bad code err=%v", err)
	}
}

func TestSessionReauth_RefusesCrossIdentitySession(t *testing.T) {
	repo := &fakeAuthRepo{session: &auth.Session{UserID: "someone-else", TenantID: "tenant-1", AuthMethod: "google", IssuedAt: time.Now()}}
	reauth := &SessionReauth{Repo: repo}
	if _, err := reauth.Verify(context.Background(), "id.verifier", "tenant-1", "user-1", ReauthInput{}); !errors.Is(err, ErrNoSession) {
		t.Fatalf("err=%v", err)
	}
}
