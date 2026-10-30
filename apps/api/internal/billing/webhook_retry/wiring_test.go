// SPDX-License-Identifier: AGPL-3.0-only
package webhook_retry

import "testing"

// A worker with an AlertEmail but no Mailer can never alert. This is the
// exact shape of the bug that made every dead-lettered Stripe event silent
// in production: main.go set AlertEmail and forgot Mailer, and the send is
// gated on both.
func TestWorker_AlertEmailWithoutMailerIsAMisconfiguration(t *testing.T) {
	w := &Worker{AlertEmail: "ops@example.com"}
	if err := w.Validate(); err == nil {
		t.Fatal("a worker with AlertEmail but no Mailer must be rejected at construction")
	}
}

func TestWorker_NeitherIsFine(t *testing.T) {
	w := &Worker{}
	if err := w.Validate(); err != nil {
		t.Fatalf("alerting is optional; a worker with neither must be valid, got %v", err)
	}
}
