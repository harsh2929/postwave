// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"errors"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

type recordingBoundDispatcher struct {
	inputs []BoundDispatchInput
	result BoundDispatchResult
	err    error
}

func (d *recordingBoundDispatcher) DispatchBound(_ context.Context, input BoundDispatchInput) (BoundDispatchResult, error) {
	input.Binding = cloneAssuranceBinding(input.Binding)
	input.Headers = cloneDispatchHeaders(input.Headers)
	d.inputs = append(d.inputs, input)
	return d.result, d.err
}

func TestDispatchPreparedBoundUsesOnlyRawRuntime(t *testing.T) {
	legacy := &mockListmonk{}
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := &Guard{Listmonk: legacy, AssuranceBound: raw}
	binding := AssuranceBinding{
		ContentRevisionID: "revision", SendPlanID: "plan", RunID: "run", RunAttempt: 1,
		ArtifactSetHash: "artifact-set", SourceHash: "source", PlanHash: "plan-hash",
		GateDecision: "pass", OverrideIDs: []string{"override-b", "override-a"},
	}
	headers := map[string]string{"List-Unsubscribe": "<https://example.test/unsubscribe>"}
	result := guard.dispatchPrepared(
		context.Background(), "tenant", pendingRow{id: 42, cid: "campaign", email: "person@example.test", vid: "variant", binding: binding},
		campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test", replyTo: "reply@example.test"},
		"legacy HTML must not be sent", headers, "dedicated-messenger", true,
	)

	if result.status != RecipientSent || !result.attempted || !result.externalEffectPossible || result.revert || result.err != nil {
		t.Fatalf("result = %+v", result)
	}
	if legacy.count() != 0 {
		t.Fatalf("bound row crossed Listmonk %d times", legacy.count())
	}
	if len(raw.inputs) != 1 {
		t.Fatalf("raw runtime calls = %d", len(raw.inputs))
	}
	got := raw.inputs[0]
	if got.CampaignRecipientID != 42 || got.Recipient != "person@example.test" || got.Messenger != "dedicated-messenger" ||
		got.Binding.RunID != "run" || len(got.Binding.OverrideIDs) != 2 || got.Headers["List-Unsubscribe"] == "" {
		t.Fatalf("raw input = %+v", got)
	}
	// The dispatcher receives owned collections, not aliases into the send loop.
	binding.OverrideIDs[0] = "mutated"
	headers["List-Unsubscribe"] = "mutated"
	if got.Binding.OverrideIDs[0] != "override-b" || got.Headers["List-Unsubscribe"] == "mutated" {
		t.Fatal("raw dispatch input retained caller-owned collections")
	}
}

func TestDispatchPreparedPartialBindingNeverFallsBack(t *testing.T) {
	legacy := &mockListmonk{}
	guard := &Guard{Listmonk: legacy}
	result := guard.dispatchPrepared(
		context.Background(), "tenant",
		pendingRow{id: 43, cid: "campaign", email: "person@example.test", binding: AssuranceBinding{SourceHash: "partial"}},
		campaignBody{subject: "subject"}, "legacy HTML", nil, "", true,
	)
	if result.status != RecipientFailed || result.errMsg != boundReasonRuntimeUnconfigured || !result.attempted || result.revert {
		t.Fatalf("result = %+v", result)
	}
	if legacy.count() != 0 {
		t.Fatalf("partially bound row crossed Listmonk %d times", legacy.count())
	}
}

func TestDispatchPreparedBoundRequiresOneClickUnsubscribe(t *testing.T) {
	legacy := &mockListmonk{}
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := &Guard{Listmonk: legacy, AssuranceBound: raw}
	result := guard.dispatchPrepared(
		context.Background(), "tenant",
		pendingRow{id: 44, cid: "campaign", email: "person@example.test", binding: AssuranceBinding{RunID: "run"}},
		campaignBody{subject: "subject"}, "legacy HTML", nil, "", false,
	)
	if result.status != RecipientFailed || result.errMsg != boundReasonUnsubscribeUnavailable || !result.attempted {
		t.Fatalf("result = %+v", result)
	}
	if legacy.count() != 0 || len(raw.inputs) != 0 {
		t.Fatalf("unsafe dispatch calls: listmonk=%d raw=%d", legacy.count(), len(raw.inputs))
	}
}

func TestDispatchPreparedBoundOutcomeSemantics(t *testing.T) {
	tests := []struct {
		name      string
		outcome   BoundDispatchResult
		err       error
		status    string
		errMsg    string
		attempted bool
		revert    bool
		external  bool
	}{
		{name: "retryable dependency", outcome: BoundDispatchResult{Status: BoundDispatchRetryable, Reason: "BOUND_DEPENDENCY_UNAVAILABLE"}, err: errors.New("temporary"), errMsg: "BOUND_DEPENDENCY_UNAVAILABLE", revert: true},
		{name: "indeterminate", outcome: BoundDispatchResult{Status: BoundDispatchIndeterminate, Reason: "BOUND_DELIVERY_INDETERMINATE"}, err: errors.New("unknown outcome"), status: RecipientFailed, errMsg: "BOUND_DELIVERY_INDETERMINATE", attempted: true, external: true},
		{name: "rejected", outcome: BoundDispatchResult{Status: BoundDispatchRejected, Reason: "BOUND_DELIVERY_REJECTED"}, err: errors.New("rejected"), status: RecipientFailed, errMsg: "BOUND_DELIVERY_REJECTED", attempted: true},
		{name: "invalid reason", outcome: BoundDispatchResult{Status: BoundDispatchWithheld, Reason: "contains unsafe detail"}, status: RecipientFailed, errMsg: boundReasonInvalidResult, attempted: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			legacy := &mockListmonk{}
			raw := &recordingBoundDispatcher{result: test.outcome, err: test.err}
			guard := &Guard{Listmonk: legacy, AssuranceBound: raw}
			result := guard.dispatchPrepared(
				context.Background(), "tenant",
				pendingRow{id: 45, cid: "campaign", email: "person@example.test", binding: AssuranceBinding{RunID: "run"}},
				campaignBody{subject: "subject"}, "legacy HTML", nil, "", true,
			)
			if result.status != test.status || result.errMsg != test.errMsg || result.attempted != test.attempted || result.revert != test.revert || result.externalEffectPossible != test.external {
				t.Fatalf("result = %+v", result)
			}
			if legacy.count() != 0 || len(raw.inputs) != 1 {
				t.Fatalf("dispatch calls: listmonk=%d raw=%d", legacy.count(), len(raw.inputs))
			}
		})
	}
}

func TestDispatchPreparedLegacyRowRetainsListmonkPath(t *testing.T) {
	legacy := &mockListmonk{}
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := &Guard{Listmonk: legacy, AssuranceBound: raw}
	result := guard.dispatchPrepared(
		context.Background(), "tenant",
		pendingRow{id: 46, cid: "campaign", email: "person@example.test"},
		campaignBody{subject: "subject"}, "legacy HTML", nil, "shared", false,
	)
	if result.status != RecipientSent || !result.attempted || !result.externalEffectPossible || result.err != nil {
		t.Fatalf("result = %+v", result)
	}
	if legacy.count() != 1 || len(raw.inputs) != 0 {
		t.Fatalf("dispatch calls: listmonk=%d raw=%d", legacy.count(), len(raw.inputs))
	}
}

func TestDispatchPreparedLegacyDefiniteRejectionHasNoExternalEffect(t *testing.T) {
	legacy := &mockListmonk{failNext: &listmonk.HTTPError{Method: "POST", Path: "/api/tx", StatusCode: 400}}
	result := (&Guard{Listmonk: legacy}).dispatchPrepared(
		context.Background(), "tenant",
		pendingRow{id: 48, cid: "campaign", email: "person@example.test"},
		campaignBody{subject: "subject"}, "body", nil, "", true,
	)
	if result.status != RecipientFailed || !result.attempted || result.externalEffectPossible {
		t.Fatalf("result = %+v", result)
	}
}

func TestDispatchPreparedBlockRolloutWithholdsEveryUnboundRow(t *testing.T) {
	legacy := &mockListmonk{}
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := &Guard{Listmonk: legacy, AssuranceBound: raw, RequireAssuranceBinding: true}
	metric := assuranceDispatchBlocks.WithLabelValues(boundReasonAssuranceRequired)
	before := testutil.ToFloat64(metric)
	result := guard.dispatchPrepared(
		context.Background(), "tenant",
		pendingRow{id: 47, cid: "campaign", email: "person@example.test"},
		campaignBody{subject: "subject"}, "legacy HTML", nil, "shared", true,
	)
	if result.status != RecipientFailed || result.errMsg != boundReasonAssuranceRequired || !result.attempted || result.revert {
		t.Fatalf("result = %+v", result)
	}
	if legacy.count() != 0 || len(raw.inputs) != 0 {
		t.Fatalf("unbound block-mode row crossed a provider: listmonk=%d raw=%d", legacy.count(), len(raw.inputs))
	}
	if after := testutil.ToFloat64(metric); after != before+1 {
		t.Fatalf("global unbound-row interlock metric=%v, want %v", after, before+1)
	}
}
