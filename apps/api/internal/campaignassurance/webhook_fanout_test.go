// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import "testing"

// A blocked run stops a campaign from being sent. If an integrator only learns
// that by polling, the campaign silently sits still — so the terminal outcome
// is announced on the customer webhook catalog, in the same transaction that
// records the outcome.
//
// The mapping is separated from the database write so the decision is provable
// on its own: which topics fire, for which terminal state and gate decision.

func TestFinalizationTopicsFollowStateAndGateDecision(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		state    string
		decision string
		want     []string
	}{
		{
			name:     "a complete run that may send announces only completion",
			state:    StateComplete,
			decision: GatePass,
			want:     []string{"assurance.run.completed"},
		},
		{
			// Both fire: `completed` is the lifecycle fact every integrator
			// subscribes to, `blocked` is the actionable subset. An integrator
			// watching only one still sees the outcome.
			name:     "a blocked run announces completion and the block",
			state:    StateComplete,
			decision: GateBlock,
			want:     []string{"assurance.run.completed", "assurance.run.blocked"},
		},
		{
			// Incomplete is NOT a pass, and it is not silence either: the run
			// reached a terminal state and the integrator has to know the
			// evidence was unavailable.
			name:     "an incomplete run still announces completion",
			state:    StateIncomplete,
			decision: GatePending,
			want:     []string{"assurance.run.completed"},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := finalizationWebhookTopics(Run{
				State: testCase.state, GateDecision: testCase.decision,
			})
			if len(got) != len(testCase.want) {
				t.Fatalf("topics = %v, want %v", got, testCase.want)
			}
			for i := range got {
				if got[i] != testCase.want[i] {
					t.Fatalf("topics = %v, want %v", got, testCase.want)
				}
			}
		})
	}
}

// The source event id is the integrator's dedup key. A retried finalization
// must reuse it, or the same outcome is delivered twice.
func TestFinalizationSourceEventIDIsStablePerRunAndTopic(t *testing.T) {
	run := Run{ID: "run-1", State: StateComplete, GateDecision: GateBlock}

	first := finalizationSourceEventID(run, "assurance.run.blocked")
	second := finalizationSourceEventID(run, "assurance.run.blocked")
	if first != second {
		t.Errorf("source event id is not stable: %q vs %q", first, second)
	}
	if other := finalizationSourceEventID(run, "assurance.run.completed"); other == first {
		t.Errorf("distinct topics must not share a source event id, both are %q", first)
	}
	if different := finalizationSourceEventID(Run{ID: "run-2"}, "assurance.run.blocked"); different == first {
		t.Errorf("distinct runs must not share a source event id, both are %q", first)
	}
}

// The payload names the decision and the exact frozen revision, and carries no
// campaign content: a webhook body is delivered to a third-party endpoint, and
// the assurance evidence it describes is the tenant's message text.
func TestFinalizationPayloadNamesTheDecisionWithoutContent(t *testing.T) {
	body := finalizationWebhookBody(Run{
		ID: "run-1", CampaignID: "cmp-1", ContentRevisionID: "rev-1",
		Profile: ProfileFull, State: StateComplete, GateDecision: GateBlock,
		BlockingFindingCount: 2,
	})

	for _, key := range []string{
		"run_id", "campaign_id", "content_revision_id",
		"profile", "state", "decision", "blocking_finding_count",
	} {
		if _, ok := body[key]; !ok {
			t.Errorf("payload is missing %q: %v", key, body)
		}
	}
	if body["decision"] != GateBlock {
		t.Errorf("decision = %v, want %q", body["decision"], GateBlock)
	}
	for _, forbidden := range []string{"subject", "html", "text", "semantic_tree", "fact_contract"} {
		if _, present := body[forbidden]; present {
			t.Errorf("payload must not carry campaign content, found %q", forbidden)
		}
	}
}
