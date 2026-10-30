// SPDX-License-Identifier: AGPL-3.0-only
package auth

import "testing"

func TestStartSignupVerificationFailsClosedAtCapacity(t *testing.T) {
	for range maxSignupVerificationFanout {
		signupVerificationSlots <- struct{}{}
	}
	defer func() {
		for range maxSignupVerificationFanout {
			<-signupVerificationSlots
		}
	}()
	if startSignupVerification(func() { t.Error("saturated fanout must not run") }) {
		t.Fatal("saturated fanout was accepted")
	}
}
