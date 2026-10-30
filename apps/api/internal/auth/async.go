// SPDX-License-Identifier: AGPL-3.0-only
package auth

// Verification delivery is best-effort because signup must not wait on an
// email provider. Bound detached work so an unhealthy provider cannot turn a
// burst of otherwise rate-limited signups into unbounded goroutines.
const maxSignupVerificationFanout = 32

var signupVerificationSlots = make(chan struct{}, maxSignupVerificationFanout)

func startSignupVerification(run func()) bool {
	select {
	case signupVerificationSlots <- struct{}{}:
	default:
		return false
	}
	go func() {
		defer func() { <-signupVerificationSlots }()
		run()
	}()
	return true
}
