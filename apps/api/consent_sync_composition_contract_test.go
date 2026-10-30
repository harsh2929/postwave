// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
)

// TestMainKeepsTheConsentSyncLedgerLive pins the composition that makes the
// consent-sync ledger execute at all.
//
// `subscribers.ConsentSyncLedger` is guarded at SEVEN call sites by
// `if ... ConsentSyncLedger != nil` (repo.go:1673,1811, jurisdiction.go:457,
// channel_consent_canonical.go:181, and the three bulk-safety writers). Those
// guards are the whole feature: when the field is nil every one of them is
// false, a subscriber unsubscribes, the local row updates, and nothing
// propagates to the destinations their data was pushed to. The failure is
// silent and total, and it looks exactly like success — which is how it
// survived an audit as "built".
//
// The ledger's own unit and DB tests cannot catch this. They construct a
// ConsentSyncLedger themselves, so they pass identically whether or not any
// composition path ever assigns one. That gap is the reason this test reads
// main.go instead: the only thing that distinguishes a live feature from dead
// code here is a single assignment in the composition root, and nothing else
// in the suite would notice it disappearing.
//
// Three markers, because each alone is insufficient:
//
//   - the assignment makes the seven write-side guards true;
//   - a non-nil Deliverer makes delivery actually attempt — RunRetrySweep fails
//     closed without one (TestRunRetrySweep_NilDelivererFailsClosed), so an
//     assignment with a nil deliverer is still an inert feature;
//   - the sweeper drains retries. Without it the first attempt is the only one
//     that ever happens, and a destination briefly down holds the consent
//     change forever in `retrying` behind a `next_attempt_at` no worker reads.
//
// "We tried once and nobody looked again" is not a materially better answer to
// a data-protection officer than never having tried.
func TestMainKeepsTheConsentSyncLedgerLive(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	source := string(sourceBytes)

	for _, marker := range []struct {
		needle string
		why    string
	}{
		{
			needle: "consentSyncWebhookDeliverer{store: outboundWebhooksStore}",
			why: "the ledger has no deliverer, so RunRetrySweep fails closed and " +
				"no consent change ever reaches a destination",
		},
		{
			needle: "subscriberDeps.Repo.ConsentSyncLedger = consentSyncLedger",
			why: "nothing assigns Repo.ConsentSyncLedger, so all seven " +
				"`if ... != nil` write guards are permanently false and " +
				"unsubscribes propagate nowhere",
		},
		{
			needle: "\"consent-sync-sweeper\"",
			why: "no worker drains the ledger, so a destination that is briefly " +
				"down strands the consent change in `retrying` forever",
		},
	} {
		if !strings.Contains(source, marker.needle) {
			t.Fatalf("main.go is missing consent-sync composition marker %q: %s",
				marker.needle, marker.why)
		}
	}

	// The sweeper must drain the SAME ledger that the write path records into.
	// A second, separately-constructed ledger would compile, run, and quietly
	// use a different deliverer than the one the guards write through.
	if !strings.Contains(source, "Ledger: consentSyncLedger,") {
		t.Fatal("the consent-sync sweeper does not drain the same ledger " +
			"instance the write guards record into")
	}

	// Order matters: the ledger must be constructed and assigned before the
	// sweeper captures it.
	assign := strings.Index(source, "subscriberDeps.Repo.ConsentSyncLedger = consentSyncLedger")
	sweep := strings.Index(source, "\"consent-sync-sweeper\"")
	if assign > sweep {
		t.Fatalf("consent-sync sweeper is launched at %d, before the ledger is "+
			"assigned at %d", sweep, assign)
	}
}
