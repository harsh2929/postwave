// SPDX-License-Identifier: AGPL-3.0-only
//
// Validation-path tests for the password-reset handlers. Same shape as
// magiclink_test.go: cover only the branches that short-circuit before
// the DB call.
package auth

import (
	"net/http"
	"strings"
	"testing"
)

func TestPasswordResetStart_BadJSON(t *testing.T) {
	d := emptyDeps()
	rec := postRaw(t, d.PasswordResetStart, "not json")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "bad_json" {
		t.Errorf("code: got %q, want bad_json", got)
	}
}

func TestPasswordResetStart_InvalidEmail(t *testing.T) {
	d := emptyDeps()
	cases := []struct{ name, email string }{
		{"empty", ""},
		{"missing-at", "foo"},
		{"only-spaces", "    "},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := postJSON(t, d.PasswordResetStart, PasswordResetStartInput{Email: tc.email})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: got %d, want 400", rec.Code)
			}
			if got := readErrCode(t, rec.Body); got != "invalid_email" {
				t.Errorf("code: got %q, want invalid_email", got)
			}
		})
	}
}

func TestPasswordResetConfirm_BadJSON(t *testing.T) {
	d := emptyDeps()
	rec := postRaw(t, d.PasswordResetConfirm, "}}}")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "bad_json" {
		t.Errorf("code: got %q, want bad_json", got)
	}
}

func TestPasswordResetConfirm_MissingToken(t *testing.T) {
	d := emptyDeps()
	rec := postJSON(t, d.PasswordResetConfirm, PasswordResetConfirmInput{
		Token:       "",
		NewPassword: "long-enough-password",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "missing_token" {
		t.Errorf("code: got %q, want missing_token", got)
	}
}

func TestPasswordResetConfirm_WeakPassword(t *testing.T) {
	d := emptyDeps()
	cases := []string{"", "short", "11char-only", strings.Repeat("a", 11)}
	for _, pw := range cases {
		t.Run(pw, func(t *testing.T) {
			rec := postJSON(t, d.PasswordResetConfirm, PasswordResetConfirmInput{
				Token:       "any-token",
				NewPassword: pw,
			})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: got %d, want 400", rec.Code)
			}
			if got := readErrCode(t, rec.Body); got != "weak_password" {
				t.Errorf("code: got %q, want weak_password", got)
			}
		})
	}
}

// Lock the TTL constant so accidental edits don't extend the reset
// window unnoticed.
func TestPasswordResetTTL_Constant(t *testing.T) {
	if passwordResetTTL.Hours() != 1 {
		t.Errorf("passwordResetTTL drifted: got %v, want 1h", passwordResetTTL)
	}
}

// Order-of-validation guard: token must be checked BEFORE password
// length. (Otherwise an attacker probing whether a token is valid
// could observe weak_password vs invalid_token codes.) The current
// handler short-circuits on missing_token first, then weak_password,
// then attempts ConsumeToken — so a non-empty token + weak password
// returns weak_password without consulting the DB.
func TestPasswordResetConfirm_TokenMissingBeatsWeakPassword(t *testing.T) {
	d := emptyDeps()
	rec := postJSON(t, d.PasswordResetConfirm, PasswordResetConfirmInput{
		Token:       "",
		NewPassword: "short", // also weak
	})
	if got := readErrCode(t, rec.Body); got != "missing_token" {
		t.Errorf("expected missing_token to short-circuit, got %q", got)
	}
}
