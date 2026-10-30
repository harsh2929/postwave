// SPDX-License-Identifier: AGPL-3.0-only
//
// verification_gate.go — the optional email-verification check on the
// PUBLIC form-submit path.
//
// This is the only place in the codebase where verification can refuse
// a real person in real time, so the contract is deliberately narrow
// and defensive:
//
//   - A nil SignupGate is inert. Deployments that never configure
//     verification behave exactly as they did before this file existed.
//   - Any error from the gate FAILS OPEN. The gate improves list
//     quality; it is not an authorization boundary. A bug or a vendor
//     outage inside it must never stop people subscribing.
//   - The refusal message shown to the visitor comes from the gate and
//     is already scrubbed of vendor names and internals.
//
// The interface is declared HERE rather than imported so this package
// keeps a minimal dependency surface: forms is public-facing and
// heavily edited, and a narrow local interface means a change to the
// verification package cannot ripple into it.

package forms

import (
	"context"
	"errors"
)

// SignupDecision mirrors verification.Decision structurally. Declared
// locally so forms does not take a hard dependency on the verification
// package's types.
type SignupDecision struct {
	Allow      bool
	Checked    bool
	Degraded   bool
	Retryable  bool
	Reason     string
	DidYouMean string
}

// SignupGate is the narrow contract the submit path needs.
//
// verification.Store satisfies this via an adapter in internal/server;
// it is not implemented directly here so the coupling stays one-way.
type SignupGate interface {
	GateSignup(
		ctx context.Context,
		tenantID, formID, email, submissionAttemptID string,
		requestFingerprint []byte,
		antiAbuseAuthorized bool,
	) (SignupDecision, error)
}

// checkSignupVerification runs the gate, returning (allow, decision).
//
// It never returns an error: every failure mode collapses to "allow",
// because the alternative is refusing a legitimate subscriber over an
// internal problem they cannot see or fix.
func (d *Deps) checkSignupVerification(
	ctx context.Context,
	tenantID, formID, email, submissionAttemptID string,
	requestFingerprint []byte,
	antiAbuseAuthorized bool,
) (bool, SignupDecision) {
	if d == nil || d.SignupGate == nil {
		return true, SignupDecision{Allow: true}
	}
	decision, err := d.SignupGate.GateSignup(
		ctx, tenantID, formID, email, submissionAttemptID, requestFingerprint,
		antiAbuseAuthorized,
	)
	if err != nil {
		observeSignupVerificationDecision("error_allowed")
		if d.Logger != nil {
			// Database/driver errors can contain the submitted address or rejected
			// row detail. Public-form fail-open telemetry needs only a closed failure
			// class; never copy the raw error into logs.
			d.Logger.Warn("forms: signup verification gate failed; admitting submission",
				"tenant_id", tenantID, "error_class", signupGateErrorClass(err))
		}
		return true, SignupDecision{Allow: true, Degraded: true}
	}
	if decision.Retryable {
		observeSignupVerificationDecision("retryable")
	} else if decision.Degraded {
		outcome := "degraded_allowed"
		if !decision.Allow {
			outcome = "degraded_blocked"
		}
		observeSignupVerificationDecision(outcome)
		if d.Logger != nil {
			d.Logger.Warn("forms: signup verification degraded",
				"tenant_id", tenantID, "allowed", decision.Allow, "checked", decision.Checked)
		}
	} else if !decision.Checked && decision.Allow {
		observeSignupVerificationDecision("bypassed")
	} else if decision.Allow {
		observeSignupVerificationDecision("allowed")
	} else {
		observeSignupVerificationDecision("blocked")
	}
	return decision.Allow, decision
}

func signupGateErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	default:
		return "verification_gate_failed"
	}
}
