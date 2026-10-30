// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the optional verification gate on the PUBLIC form-submit
// path.
//
// The gate sits in front of every anonymous signup, so the properties
// that matter most are the negative ones: it must be inert unless
// configured, and it must never take the form offline when the thing
// behind it breaks.

package forms

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// stubGate is a scripted SignupGate.
type stubGate struct {
	decision   SignupDecision
	err        error
	calls      int
	lastEmail  string
	authorized bool
}

func (s *stubGate) GateSignup(
	_ context.Context,
	_, _, email, _ string,
	_ []byte,
	antiAbuseAuthorized bool,
) (SignupDecision, error) {
	s.calls++
	s.lastEmail = email
	s.authorized = antiAbuseAuthorized
	return s.decision, s.err
}

func TestSignupGatePassesExplicitAntiAbuseAuthorization(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{Allow: true}}
	d := &Deps{SignupGate: gate}

	d.checkSignupVerification(
		context.Background(), "t1", "f1", "person@example.com",
		"opaque-attempt-1234", make([]byte, 32), true,
	)
	if !gate.authorized {
		t.Fatal("successful CAPTCHA authorization was not passed to the paid gate")
	}
}

func TestSignupGatePreservesRetryableNoMutationDecision(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{Allow: false, Checked: true, Degraded: true, Retryable: true}}
	d := &Deps{SignupGate: gate}

	allow, decision := d.checkSignupVerification(
		context.Background(), "t1", "f1", "person@example.com",
		"opaque-attempt-1234", make([]byte, 32), true,
	)
	if allow || !decision.Retryable {
		t.Fatalf("retryable decision = allow %v, %+v", allow, decision)
	}
}

func TestSignupGateIsInertWhenNotWired(t *testing.T) {
	// A deployment that never configures verification must behave
	// exactly as it did before this code existed.
	d := &Deps{}
	allow, _ := d.checkSignupVerification(context.Background(), "t1", "f1", "person@example.com", "", nil, false)
	if !allow {
		t.Fatal("a nil gate must allow the submission")
	}
}

func TestSignupGateAllowsWhenDecisionAllows(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{Allow: true, Checked: true}}
	d := &Deps{SignupGate: gate}

	allow, _ := d.checkSignupVerification(context.Background(), "t1", "f1", "person@example.com", "", nil, false)
	if !allow {
		t.Fatal("allow decision was not honoured")
	}
	if gate.calls != 1 {
		t.Fatalf("gate calls = %d, want 1", gate.calls)
	}
}

func TestSignupGateBlocksWhenDecisionRefuses(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{
		Allow: false, Checked: true, Reason: "That email domain does not accept mail.",
	}}
	d := &Deps{SignupGate: gate}

	allow, decision := d.checkSignupVerification(context.Background(), "t1", "f1", "nobody@nowhere.invalid", "", nil, false)
	if allow {
		t.Fatal("refusal decision was not honoured")
	}
	if decision.Reason == "" {
		t.Fatal("a refusal must carry a visitor-facing reason")
	}
}

func TestSignupGateFailsOpenWhenTheGateItselfErrors(t *testing.T) {
	// The gate is an optimisation, not a correctness boundary. A bug or
	// outage inside it must never stop real people subscribing.
	gate := &stubGate{err: errors.New("store exploded")}
	d := &Deps{SignupGate: gate}

	metric := signupVerificationDecisions.WithLabelValues("error_allowed")
	before := testutil.ToFloat64(metric)
	allow, decision := d.checkSignupVerification(context.Background(), "t1", "f1", "person@example.com", "", nil, false)
	if !allow {
		t.Fatal("an error from the gate must fail open")
	}
	if !decision.Degraded {
		t.Fatal("an error admission must be visibly degraded")
	}
	if after := testutil.ToFloat64(metric); after != before+1 {
		t.Fatalf("error_allowed metric = %v, want %v", after, before+1)
	}
}

func TestSignupGateErrorLogDoesNotContainSubmittedAddressOrRawError(t *testing.T) {
	var logs bytes.Buffer
	private := "private-recipient@example.com"
	gate := &stubGate{err: errors.New("constraint rejected row for " + private)}
	d := &Deps{
		SignupGate: gate,
		Logger:     slog.New(slog.NewJSONHandler(&logs, nil)),
	}

	allow, decision := d.checkSignupVerification(
		context.Background(), "00000000-0000-0000-0000-000000000001", "f1",
		private, "", nil, false,
	)
	if !allow || !decision.Degraded {
		t.Fatalf("error admission = allow %v, decision %+v", allow, decision)
	}
	got := logs.String()
	if strings.Contains(got, private) || strings.Contains(got, "constraint rejected row") {
		t.Fatalf("verification gate log exposed raw error or address: %s", got)
	}
	if !strings.Contains(got, `"error_class":"verification_gate_failed"`) {
		t.Fatalf("verification gate log omitted bounded error class: %s", got)
	}
}

func TestSignupGateObservesDegradedDecisionWithoutPIILabels(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{Allow: true, Checked: true, Degraded: true}}
	d := &Deps{SignupGate: gate}
	metric := signupVerificationDecisions.WithLabelValues("degraded_allowed")
	before := testutil.ToFloat64(metric)

	allow, _ := d.checkSignupVerification(context.Background(), "t1", "f1", "private@example.com", "", nil, false)
	if !allow {
		t.Fatal("degraded fail-open decision was not honoured")
	}
	if after := testutil.ToFloat64(metric); after != before+1 {
		t.Fatalf("degraded_allowed metric = %v, want %v", after, before+1)
	}
}

func TestSignupGatePassesTheNormalizedAddress(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{Allow: true}}
	d := &Deps{SignupGate: gate}

	if _, _ = d.checkSignupVerification(context.Background(), "t1", "f1", "Person@Example.COM", "", nil, false); gate.calls != 1 {
		t.Fatalf("gate calls = %d", gate.calls)
	}
	if gate.lastEmail != "Person@Example.COM" {
		// The submit handler lowercases before calling; the gate itself
		// normalizes again. Either way the address must arrive intact.
		t.Fatalf("gate saw %q", gate.lastEmail)
	}
}

func TestSignupDecisionSuggestionIsSurfacedForRecoverableTypos(t *testing.T) {
	gate := &stubGate{decision: SignupDecision{
		Allow:      false,
		Checked:    true,
		Reason:     "That email address looks like it has a typo.",
		DidYouMean: "person@gmail.com",
	}}
	d := &Deps{SignupGate: gate}

	allow, decision := d.checkSignupVerification(context.Background(), "t1", "f1", "person@gmial.com", "", nil, false)
	if allow {
		t.Fatal("expected refusal")
	}
	if decision.DidYouMean != "person@gmail.com" {
		t.Fatalf("DidYouMean = %q; a recoverable signup is worth more than a clean rejection", decision.DidYouMean)
	}
}
