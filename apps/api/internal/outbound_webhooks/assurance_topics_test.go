// SPDX-License-Identifier: AGPL-3.0-only

package outbound_webhooks

import "testing"

// Campaign Assurance is a gate on sending, so its outcome is something an
// integrator has to be able to react to without polling: a blocked run means a
// campaign will not go out until someone acts. These are the only two assurance
// topics — the run's terminal outcome, and the subset of it that stops a send.
//
// Deliberately NOT topics: run started, extraction progress, per-finding
// events. They fire at model-fanout rates, carry no decision, and would make
// the useful signal harder to find.

func TestAssuranceOutcomeTopicsAreSubscribable(t *testing.T) {
	for _, event := range []string{EventAssuranceRunCompleted, EventAssuranceRunBlocked} {
		if !IsAllowedEvent(event) {
			t.Errorf("%q must be subscribable", event)
		}
	}
}

// The prefix is load-bearing: `assurance.` groups these with each other rather
// than with the campaign topics, the same way `email.` separates transactional
// outcomes from campaign outcomes in this catalog.
func TestAssuranceTopicsShareTheAssurancePrefix(t *testing.T) {
	for _, event := range []string{EventAssuranceRunCompleted, EventAssuranceRunBlocked} {
		if len(event) < 10 || event[:10] != "assurance." {
			t.Errorf("%q must use the assurance. prefix", event)
		}
	}
}

// A run that finished without complete evidence is not a pass. If it were
// subscribable as its own "ok" topic, an integrator could wire it as success —
// so incomplete stays inside the completed payload's decision, not a topic.
func TestNoTopicImpliesAnUnevidencedPass(t *testing.T) {
	for _, forbidden := range []string{
		"assurance.run.passed",
		"assurance.run.ok",
		"assurance.run.incomplete",
	} {
		if IsAllowedEvent(forbidden) {
			t.Errorf("%q must not be subscribable: it invites reading an unevidenced run as success", forbidden)
		}
	}
}
