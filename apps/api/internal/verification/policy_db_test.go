// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the enforcement policy and the signup gate.

package verification

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestGateSignupAttemptRejectsRawControlsBeforeTrimming(t *testing.T) {
	s := &Store{}
	for _, raw := range []string{
		"reader@example.com\v",
		"reader@example.com\f",
		"reader@example.com\u0085",
		"reader@example.com\u009f",
		string([]byte("reader@example.com\xff")),
	} {
		d, err := s.GateSignupAttempt(
			context.Background(), "tenant", "", raw, "", nil,
		)
		if err != nil {
			t.Fatalf("GateSignupAttempt(%q): %v", raw, err)
		}
		if d.Allow || !d.Checked || d.Status != StatusInvalid || d.SubStatus != SubStatusSyntaxInvalid {
			t.Errorf("GateSignupAttempt(%q) = %+v, want local syntax rejection", raw, d)
		}
	}
}

func TestDBPolicyDefaultsToOffForAnUnconfiguredTenant(t *testing.T) {
	// Deploying this feature must not change who is allowed to sign up.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	p, err := s.Policy(context.Background(), tenant)
	if err != nil {
		t.Fatalf("Policy: %v", err)
	}
	if p.FormsMode != ModeOff || p.ImportMode != ModeOff {
		t.Fatalf("defaults = %+v, want both modes off", p)
	}
}

func TestDBPolicyDefaultRetainsCompleteTerminalSetWhenEnabledLater(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	// Model an operator who saved an otherwise-default off policy and enables
	// it later. Migration 1997 advances both the DB default and every exact
	// historical default, including off rows, so this transition cannot retain
	// the old incomplete invalid+spamtrap set.
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin policy default insert: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO verification_policy (tenant_id) VALUES ($1::uuid)`, tenant); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert default policy: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit default policy: %v", err)
	}

	p, err := s.Policy(ctx, tenant)
	if err != nil {
		t.Fatalf("Policy: %v", err)
	}
	p.FormsMode = ModeLocal
	saved, err := s.SetPolicy(ctx, tenant, p)
	if err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	want := []string{
		string(StatusInvalid), string(StatusSpamtrap),
		string(StatusAbuse), string(StatusDoNotMail),
	}
	if !reflect.DeepEqual(saved.FormsRejectStatuses, want) {
		t.Fatalf("enabled default rejection set = %v, want %v", saved.FormsRejectStatuses, want)
	}
}

func TestDBPolicyRoundTrips(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	saved, err := s.SetPolicy(ctx, tenant, Policy{
		FormsMode:           ModeLocal,
		FormsRejectStatuses: []string{string(StatusInvalid), string(StatusDoNotMail)},
		FormsSuggestTypos:   BoolPtr(false),
		ImportMode:          ModeFull,
	})
	if err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	if saved.FormsMode != ModeLocal || saved.ImportMode != ModeFull {
		t.Fatalf("saved = %+v", saved)
	}
	if saved.SuggestTypos() {
		t.Fatal("FormsSuggestTypos did not persist as false")
	}

	got, err := s.Policy(ctx, tenant)
	if err != nil {
		t.Fatalf("Policy: %v", err)
	}
	if len(got.FormsRejectStatuses) != 2 {
		t.Fatalf("FormsRejectStatuses = %v", got.FormsRejectStatuses)
	}
}

func TestDBPolicyRejectsUnknownMode(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	if _, err := s.SetPolicy(context.Background(), tenant, Policy{FormsMode: "aggressive"}); err == nil {
		t.Fatal("expected an error for an unknown mode")
	}
}

func TestDBPolicyRejectsStatusOutsideTheClosedSet(t *testing.T) {
	// A typo'd status would silently never match, leaving the gate
	// looking configured while enforcing nothing.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	_, err := s.SetPolicy(context.Background(), tenant, Policy{
		FormsMode: ModeLocal, FormsRejectStatuses: []string{"invalid", "bogus"},
	})
	if err == nil {
		t.Fatal("expected an error for a status outside the canonical set")
	}
}

func TestPolicyRejectsValidAsARejectionRule(t *testing.T) {
	_, err := (Policy{
		FormsMode:           ModeLocal,
		FormsRejectStatuses: []string{string(StatusValid)},
	}).Normalize()
	if err == nil {
		t.Fatal("valid evidence was accepted as a signup rejection rule")
	}
}

func TestPolicyNormalizesDuplicateRejectionRules(t *testing.T) {
	got, err := (Policy{
		FormsMode: ModeLocal,
		FormsRejectStatuses: []string{
			string(StatusInvalid), string(StatusInvalid), string(StatusCatchAll),
		},
	}).Normalize()
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	want := []string{string(StatusInvalid), string(StatusCatchAll)}
	if !reflect.DeepEqual(got.FormsRejectStatuses, want) {
		t.Fatalf("normalized statuses = %v, want %v", got.FormsRejectStatuses, want)
	}
}

func TestStoredPolicyWithValidRejectionFailsClosed(t *testing.T) {
	_, err := normalizeStoredVerificationPolicy(Policy{
		FormsMode:           ModeLocal,
		FormsRejectStatuses: []string{string(StatusValid)},
		ImportMode:          ModeOff,
	})
	if !errors.Is(err, errInvalidStoredVerificationPolicy) ||
		err.Error() != errInvalidStoredVerificationPolicy.Error() {
		t.Fatalf("stored policy error = %v, want constant non-reflective sentinel", err)
	}
}

func TestDBPolicyIsTenantIsolated(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if _, err := s.SetPolicy(ctx, tenantA, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	got, err := s.Policy(ctx, tenantB)
	if err != nil {
		t.Fatalf("Policy(B): %v", err)
	}
	if got.FormsMode != ModeOff {
		t.Fatalf("tenant B saw tenant A's policy: %+v", got)
	}
}

// --- the signup gate ---

func TestDBGateSignupAllowsEverythingWhenModeIsOff(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	// A local verifier that would reject, to prove the gate never ran.
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return false, "", nil
	}}

	d, err := s.GateSignup(context.Background(), tenant, "anything@nowhere.invalid")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow {
		t.Fatalf("mode=off must allow everything, got %+v", d)
	}
	if d.Checked {
		t.Fatal("mode=off must not perform any verification work")
	}
}

func TestDBGateSignupRejectsUndeliverableAddressInLocalMode(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return false, "", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenant, Policy{FormsMode: ModeLocal}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(context.Background(), tenant, "nobody@nonexistent.invalid")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if d.Allow {
		t.Fatalf("an address with no MX should be refused, got %+v", d)
	}
	if d.Status != StatusInvalid {
		t.Fatalf("Status = %q", d.Status)
	}
	if d.Billable {
		t.Fatal("local mode must never bill")
	}
}

func TestDBGateSignupAllowsDeliverableAddressInLocalMode(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenant, Policy{FormsMode: ModeLocal}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(context.Background(), tenant, "real.person@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow {
		t.Fatalf("a deliverable address must be allowed, got %+v", d)
	}
	if !d.Checked {
		t.Fatal("Checked = false")
	}
}

func TestDBGateSignupSurfacesTypoCorrection(t *testing.T) {
	// A recoverable signup is worth far more than a clean rejection.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return false, "", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenant, Policy{FormsMode: ModeLocal}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(context.Background(), tenant, "someone@gmial.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if d.Allow {
		t.Fatal("a non-resolving domain should be refused")
	}
	if d.DidYouMean != "someone@gmail.com" {
		t.Fatalf("DidYouMean = %q", d.DidYouMean)
	}
}

func TestDBGateSignupHonoursTypoSuppression(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return false, "", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenant, Policy{
		FormsMode: ModeLocal, FormsSuggestTypos: BoolPtr(false),
	}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(context.Background(), tenant, "someone@gmial.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if d.DidYouMean != "" {
		t.Fatalf("DidYouMean = %q, want suppressed", d.DidYouMean)
	}
}

func TestDBGateSignupDoesNotRejectRoleAccountsByDefault(t *testing.T) {
	// info@ and sales@ are real businesses signing up. Dropping them
	// is a revenue decision the operator must make deliberately.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenant, Policy{FormsMode: ModeLocal}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(context.Background(), tenant, "sales@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow {
		t.Fatalf("role accounts must be allowed unless explicitly configured otherwise: %+v", d)
	}
	if d.Status != StatusUnknown || d.SubStatus != SubStatusRoleBased {
		t.Fatalf("decision = %+v, want cautionary role classification", d)
	}
}

func TestDBGateSignupDoesNotConflateRoleWithConfiguredDoNotMail(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenant, Policy{
		FormsMode:           ModeLocal,
		FormsRejectStatuses: []string{string(StatusInvalid), string(StatusDoNotMail)},
	}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(context.Background(), tenant, "sales@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow || d.Status != StatusUnknown || d.SubStatus != SubStatusRoleBased {
		t.Fatalf("role mailbox was conflated with terminal do_not_mail: %+v", d)
	}
}

func TestDBGateSignupNeverCallsTheVendorInLocalMode(t *testing.T) {
	// local mode must be free and add no signup latency, even when a
	// paid provider is configured.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secrets := &fakeSecrets{values: map[string]string{
		mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "zb-primary"): "key",
	}}
	s := newStore(t, pool, secrets)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	ctx := context.Background()
	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	if _, err := s.SetPolicy(ctx, tenant, Policy{FormsMode: ModeLocal}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(ctx, tenant, "person@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if d.Billable {
		t.Fatal("local mode billed a credit")
	}
	if d.Provider != ProviderLocal {
		t.Fatalf("Provider = %q, want %q", d.Provider, ProviderLocal)
	}
}

func TestDBGateSignupFailsOpenWhenTheVendorIsUnreachable(t *testing.T) {
	// THE most important behaviour here. Refusing real signups because
	// a third party is down is far worse than letting a few bad
	// addresses through — the gate is an optimisation, not a
	// correctness boundary.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	ctx := context.Background()
	if _, err := s.SetPolicy(ctx, tenant, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	// Force the vendor tier to be a hard failure.
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{
			Local:  s.Local,
			Vendor: &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderUnavailable},
		}, nil
	}

	d, err := s.GateSignup(ctx, tenant, "person@example.com")
	if err != nil {
		t.Fatalf("GateSignup returned an error; it must fail open: %v", err)
	}
	if !d.Allow {
		t.Fatalf("gate closed on a vendor outage: %+v", d)
	}
	if !d.Degraded {
		t.Fatal("Degraded = false; a fail-open decision must be visible to the caller")
	}
}

func TestDBGateSignupFullModeOverridesBulkVendorDegradation(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	ctx := context.Background()
	if _, err := s.SetPolicy(ctx, tenant, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{
			Local: s.Local, Vendor: &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderUnavailable},
			DegradeOnVendorFailure: true,
		}, nil
	}

	d, err := s.GateSignup(ctx, tenant, "person@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow || !d.Checked || !d.Degraded || d.SubStatus != SubStatusNoMailboxProbe {
		t.Fatalf("full-mode outage was silently degraded by bulk setting: %+v", d)
	}
}

func TestDBGateSignupFullModeWithoutProviderIsExplicitlyDegraded(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	ctx := context.Background()
	if _, err := s.SetPolicy(ctx, tenant, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	d, err := s.GateSignup(ctx, tenant, "person@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow || !d.Degraded || !d.Checked || d.Provider != ProviderLocal {
		t.Fatalf("unconfigured full mode = %+v, want explicit local-only degradation", d)
	}
}

func TestDBGateSignupFailsOpenWhenCreditsAreExhausted(t *testing.T) {
	// Running out of credits must not take the signup form offline.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	ctx := context.Background()
	if _, err := s.SetPolicy(ctx, tenant, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{
			Local:  s.Local,
			Vendor: &fakeVerifier{name: ProviderZeroBounce, err: ErrNoCredits},
		}, nil
	}

	d, err := s.GateSignup(ctx, tenant, "person@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow || !d.Degraded {
		t.Fatalf("credit exhaustion must fail open and be flagged: %+v", d)
	}
}

func TestDBGateSignupStillRejectsLocallyDecidedAddressesDuringAVendorOutage(t *testing.T) {
	// Failing open on the VENDOR must not discard what the free tier
	// already proved on its own.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return false, "", nil
	}}
	ctx := context.Background()
	if _, err := s.SetPolicy(ctx, tenant, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{
			Local:  s.Local,
			Vendor: &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderUnavailable},
		}, nil
	}

	d, err := s.GateSignup(ctx, tenant, "nobody@nonexistent.invalid")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if d.Allow {
		t.Fatalf("the local tier already disproved this address: %+v", d)
	}
}

func TestDBGateSignupRejectsBlankAddressWithoutTouchingPolicy(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	d, err := s.GateSignup(context.Background(), tenant, "   ")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if d.Allow {
		t.Fatal("a blank address must not be allowed")
	}
}

func TestGateDecisionReasonIsHumanReadable(t *testing.T) {
	cases := []struct {
		status Status
		sub    SubStatus
	}{
		{StatusInvalid, SubStatusNoDNSEntries},
		{StatusInvalid, SubStatusSyntaxInvalid},
		{StatusSpamtrap, SubStatusPossibleTrap},
		{StatusDoNotMail, SubStatusDisposable},
		{StatusDoNotMail, SubStatusRoleBased},
	}
	for _, tc := range cases {
		got := rejectionReason(tc.status, tc.sub)
		if got == "" {
			t.Errorf("rejectionReason(%q,%q) is empty", tc.status, tc.sub)
		}
		if len(got) > 160 {
			t.Errorf("rejectionReason(%q,%q) is too long for a form error: %q", tc.status, tc.sub, got)
		}
	}
}

func TestGateDecisionNeverLeaksProviderInternals(t *testing.T) {
	// The reason string is shown to an anonymous visitor on a public
	// form. It must not name our vendor or expose our stack.
	for _, s := range AllStatuses {
		r := rejectionReason(s, SubStatusMailboxNotFound)
		for _, leak := range []string{"zerobounce", "kickbox", "postwave", "sql", "http"} {
			if containsFold(r, leak) {
				t.Errorf("rejectionReason(%q) leaks %q: %q", s, leak, r)
			}
		}
	}
}

var _ = errors.Is
