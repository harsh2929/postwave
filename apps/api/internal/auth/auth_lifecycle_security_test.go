// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type fakeLoginRepository struct {
	users      []User
	lookupErr  error
	credential *Credential
	credErr    error
}

func (f *fakeLoginRepository) LookupUserByEmail(context.Context, string) ([]User, error) {
	return f.users, f.lookupErr
}
func (f *fakeLoginRepository) LookupCredential(context.Context, string) (*Credential, error) {
	return f.credential, f.credErr
}
func (*fakeLoginRepository) RecordLoginFailure(context.Context, string) error { return nil }
func (*fakeLoginRepository) ResetLoginCounters(context.Context, string) error { return nil }
func (*fakeLoginRepository) UpdatePassword(context.Context, string, string, string) error {
	return nil
}

func TestPasswordLoginDoesNotDiscloseMissingCredentialOrLockState(t *testing.T) {
	request := LoginInput{Email: "person@example.com", Password: "incorrect-password"}
	lockedUntil := time.Now().Add(time.Hour)
	cases := []struct {
		name string
		repo *fakeLoginRepository
	}{
		{
			name: "email absent",
			repo: &fakeLoginRepository{lookupErr: ErrNotFound},
		},
		{
			name: "oauth only account",
			repo: &fakeLoginRepository{
				users:   []User{{ID: "user-oauth", TenantID: "tenant-1"}},
				credErr: ErrNotFound,
			},
		},
		{
			name: "locked password account",
			repo: &fakeLoginRepository{
				users: []User{{ID: "user-locked", TenantID: "tenant-1"}},
				credential: &Credential{
					UserID:      "user-locked",
					TenantID:    "tenant-1",
					PasswordPHC: dummyPasswordPHC,
					LockedUntil: &lockedUntil,
				},
			},
		},
	}

	var canonicalBody string
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{LoginRepo: tc.repo}
			rec := postJSON(t, d.Login, request)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
			}
			if code := readErrCode(t, strings.NewReader(rec.Body.String())); code != "invalid_credentials" {
				t.Fatalf("error code = %q, want invalid_credentials", code)
			}
			if strings.Contains(rec.Body.String(), "no_password_set") || strings.Contains(rec.Body.String(), "account_locked") {
				t.Fatalf("response disclosed account state: %s", rec.Body.String())
			}
			if canonicalBody == "" {
				canonicalBody = rec.Body.String()
			} else if rec.Body.String() != canonicalBody {
				t.Fatalf("failure response differs by account state:\n got %s\nwant %s", rec.Body.String(), canonicalBody)
			}
		})
	}
}

func TestPasswordLoginUnknownWorkspaceMatchesAbsentAccountResponse(t *testing.T) {
	request := LoginInput{
		Email:       "person@example.com",
		Password:    "incorrect-password",
		WorkspaceID: "unknown-tenant",
	}
	absent := postJSON(t, (&Deps{LoginRepo: &fakeLoginRepository{lookupErr: ErrNotFound}}).Login, request)
	existing := postJSON(t, (&Deps{LoginRepo: &fakeLoginRepository{
		users: []User{{ID: "user-1", TenantID: "real-tenant"}},
	}}).Login, request)

	if absent.Code != http.StatusUnauthorized || existing.Code != http.StatusUnauthorized {
		t.Fatalf("statuses = absent:%d existing:%d, want both 401", absent.Code, existing.Code)
	}
	if absent.Body.String() != existing.Body.String() {
		t.Fatalf("unknown workspace disclosed account state:\n absent %s\nexisting %s",
			absent.Body.String(), existing.Body.String())
	}
}

type fakePasswordResetRepository struct {
	users         []User
	lookupErr     error
	credential    *Credential
	credentialErr error
	issuedTokens  int
	resetCalls    int
	resetToken    string
	resetPHC      string
	resetErr      error
}

func (f *fakePasswordResetRepository) LookupUserByEmail(context.Context, string) ([]User, error) {
	return f.users, f.lookupErr
}
func (f *fakePasswordResetRepository) LookupCredential(context.Context, string) (*Credential, error) {
	return f.credential, f.credentialErr
}
func (f *fakePasswordResetRepository) IssueToken(context.Context, string, string, string, time.Duration) (string, error) {
	f.issuedTokens++
	return "reset-token", nil
}
func (f *fakePasswordResetRepository) ResetPassword(_ context.Context, token, phc string) error {
	f.resetCalls++
	f.resetToken = token
	f.resetPHC = phc
	return f.resetErr
}

func TestPasswordResetConfirmReportsSuccessOnlyAfterAtomicReset(t *testing.T) {
	repo := &fakePasswordResetRepository{}
	key := []byte("test-auth-link-signing-key-32-bytes-minimum")
	d := &Deps{PasswordResetRepo: repo, AuthLinkSigningKey: key}
	proof := testAuthLinkProof(t, key, "single-use-token", authLinkFlowReset, authLinkAudienceWeb, "")
	rec := postJSON(t, d.PasswordResetConfirm, PasswordResetConfirmInput{
		Token:               "single-use-token",
		NewPassword:         "a-production-password",
		AuthLinkProofFields: proof,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if repo.resetCalls != 1 || repo.resetToken != "single-use-token" {
		t.Fatalf("atomic reset call = %d token=%q", repo.resetCalls, repo.resetToken)
	}
	if !strings.HasPrefix(repo.resetPHC, "$argon2id$") {
		t.Fatalf("reset received non-Argon2id credential: %q", repo.resetPHC)
	}
}

func TestPasswordResetConfirmFailsClosedWhenAtomicResetRollsBack(t *testing.T) {
	repo := &fakePasswordResetRepository{resetErr: errors.New("session revoke failed")}
	key := []byte("test-auth-link-signing-key-32-bytes-minimum")
	d := &Deps{PasswordResetRepo: repo, AuthLinkSigningKey: key}
	proof := testAuthLinkProof(t, key, "retryable-token", authLinkFlowReset, authLinkAudienceWeb, "")
	rec := postJSON(t, d.PasswordResetConfirm, PasswordResetConfirmInput{
		Token:               "retryable-token",
		NewPassword:         "a-production-password",
		AuthLinkProofFields: proof,
	})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if code := readErrCode(t, rec.Body); code != "update_failed" {
		t.Fatalf("error code = %q, want update_failed", code)
	}
	if repo.resetCalls != 1 {
		t.Fatalf("atomic reset calls = %d, want 1", repo.resetCalls)
	}
	if strings.Contains(rec.Body.String(), `"reset":true`) {
		t.Fatalf("failure path reported reset success: %s", rec.Body.String())
	}
}

func TestPasswordResetStartDoesNotIssueTokenForOAuthOnlyAccount(t *testing.T) {
	repo := &fakePasswordResetRepository{
		users:         []User{{ID: "oauth-user", TenantID: "tenant-1", Email: "person@example.com"}},
		credentialErr: ErrNotFound,
	}
	d := &Deps{PasswordResetRepo: repo}
	rec := postJSON(t, d.PasswordResetStart, PasswordResetStartInput{Email: "person@example.com"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if repo.issuedTokens != 0 {
		t.Fatalf("issued reset tokens = %d, want 0", repo.issuedTokens)
	}
	if got := rec.Header().Get("X-Postwave-Mailer-Status"); got != "" {
		t.Fatalf("response leaked delivery/account state in header: %q", got)
	}
}

type fakePasswordResetRow struct {
	err error
}

func (r fakePasswordResetRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*string)) = "user-1"
	*(dest[1].(*string)) = "tenant-1"
	return nil
}

type fakePasswordResetTransaction struct {
	rowErr             error
	revokeErr          error
	trustRevokeErr     error
	credentialRows     int64
	executedStatements []string
	committed          bool
}

func (f *fakePasswordResetTransaction) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakePasswordResetRow{err: f.rowErr}
}

func (f *fakePasswordResetTransaction) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	f.executedStatements = append(f.executedStatements, sql)
	switch {
	case strings.Contains(sql, "UPDATE auth_trusted_devices"):
		if f.trustRevokeErr != nil {
			return pgconn.CommandTag{}, f.trustRevokeErr
		}
		return pgconn.NewCommandTag("UPDATE 1"), nil
	case strings.Contains(sql, "UPDATE auth_sessions"):
		if f.revokeErr != nil {
			return pgconn.CommandTag{}, f.revokeErr
		}
		return pgconn.NewCommandTag("UPDATE 2"), nil
	case strings.Contains(sql, "UPDATE auth_credentials"):
		return pgconn.NewCommandTag("UPDATE " + string(rune('0'+f.credentialRows))), nil
	default:
		return pgconn.NewCommandTag("SELECT 1"), nil
	}
}

func (f *fakePasswordResetTransaction) Commit(context.Context) error {
	f.committed = true
	return nil
}

func TestResetPasswordTransactionDoesNotCommitWhenSessionRevocationFails(t *testing.T) {
	tx := &fakePasswordResetTransaction{
		credentialRows: 1,
		revokeErr:      errors.New("database unavailable during session revoke"),
	}
	err := resetPasswordInTransaction(context.Background(), tx, []byte("token-hash"), "new-phc")
	if err == nil || !strings.Contains(err.Error(), "revoke password reset sessions") {
		t.Fatalf("error = %v, want session-revocation failure", err)
	}
	if tx.committed {
		t.Fatal("transaction committed after session revocation failure")
	}
	if len(tx.executedStatements) != 3 {
		t.Fatalf("executed statements = %d, want tenant bind + credential update + revoke", len(tx.executedStatements))
	}
}

func TestResetPasswordTransactionCommitsOnlyAfterCredentialAndSessionWrites(t *testing.T) {
	tx := &fakePasswordResetTransaction{credentialRows: 1}
	if err := resetPasswordInTransaction(context.Background(), tx, []byte("token-hash"), "new-phc"); err != nil {
		t.Fatal(err)
	}
	if !tx.committed {
		t.Fatal("successful atomic reset did not commit")
	}
	if len(tx.executedStatements) != 4 ||
		!strings.Contains(tx.executedStatements[1], "UPDATE auth_credentials") ||
		!strings.Contains(tx.executedStatements[2], "UPDATE auth_sessions") ||
		!strings.Contains(tx.executedStatements[3], "UPDATE auth_trusted_devices") {
		t.Fatalf("unexpected write ordering: %#v", tx.executedStatements)
	}
}

// AUTH#48. A password reset promises to end every way back in. Ending the
// SESSIONS but leaving the device-trust records would mean the standard
// compromise response quietly left an MFA bypass running, so the trust revoke
// is part of the same atomic unit — if it cannot be applied, the new password
// is not committed either.
func TestResetPasswordTransactionDoesNotCommitWhenTrustRevocationFails(t *testing.T) {
	tx := &fakePasswordResetTransaction{
		credentialRows: 1,
		trustRevokeErr: errors.New("database unavailable during trust revoke"),
	}
	err := resetPasswordInTransaction(context.Background(), tx, []byte("token-hash"), "new-phc")
	if err == nil || !strings.Contains(err.Error(), "revoke password reset trusted devices") {
		t.Fatalf("error = %v, want trusted-device revocation failure", err)
	}
	if tx.committed {
		t.Fatal("transaction committed after trusted-device revocation failure — the reset would have left an MFA bypass alive")
	}
}

func TestResetPasswordTransactionLeavesInvalidTokenUnconsumed(t *testing.T) {
	tx := &fakePasswordResetTransaction{rowErr: pgx.ErrNoRows, credentialRows: 1}
	err := resetPasswordInTransaction(context.Background(), tx, []byte("unknown-token"), "new-phc")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if tx.committed || len(tx.executedStatements) != 0 {
		t.Fatalf("invalid token changed state: committed=%v statements=%d", tx.committed, len(tx.executedStatements))
	}
}
