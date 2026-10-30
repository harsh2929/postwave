// SPDX-License-Identifier: AGPL-3.0-only
package audience_destinations

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestManualOperationKeyIsStableBoundedAndOpaque(t *testing.T) {
	const callerKey = "customer-retry-token-that-must-not-be-stored-verbatim"
	first := manualOperationKey(callerKey)
	second := manualOperationKey("  " + callerKey + "  ")
	if first != second {
		t.Fatalf("same normalized caller key produced %q and %q", first, second)
	}
	if !strings.HasPrefix(first, operationTriggerManual+":") || len(first) != len(operationTriggerManual)+1+64 {
		t.Fatalf("operation key shape = %q", first)
	}
	if strings.Contains(first, callerKey) {
		t.Fatal("durable operation key leaked the caller-supplied token")
	}
	if manualOperationKey("different") == first {
		t.Fatal("different caller keys converged unexpectedly")
	}
	// Two separate calls on purpose: an empty caller key must mint a fresh
	// identity each time rather than a stable derivation of "".
	firstAnonymous, secondAnonymous := manualOperationKey(""), manualOperationKey("")
	if firstAnonymous == secondAnonymous {
		t.Fatal("requests without an idempotency key must receive distinct operation identities")
	}
}

func TestRunTerminalStatusPreservesExternalEffectUncertainty(t *testing.T) {
	tests := []struct {
		name   string
		result syncExecutionResult
		err    error
		want   string
	}{
		{name: "success", want: RunStatusSucceeded},
		{name: "cap rejected before delivery", result: syncExecutionResult{CapExceeded: true}, err: ErrAudienceCapExceeded, want: RunStatusRejected},
		{name: "acknowledged partial delivery", result: syncExecutionResult{RowsExported: 10, BatchesSent: 1, ExternalEffectAttempted: true}, err: errors.New("batch two ambiguous"), want: RunStatusPartial},
		{name: "ambiguous first request", result: syncExecutionResult{ExternalEffectAttempted: true}, err: errors.New("connection reset"), want: RunStatusNeedsReconciliation},
		{name: "pre-effect failure", err: errors.New("source missing"), want: RunStatusFailed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := runTerminalStatus(tc.result, tc.err); got != tc.want {
				t.Fatalf("runTerminalStatus() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDestinationTerminalStatusPreservesProviderUncertainty(t *testing.T) {
	if got := destinationTerminalStatus(DestinationSyncOutcome{}, nil, true); got != RunStatusSucceeded {
		t.Fatalf("success = %q", got)
	}
	if got := destinationTerminalStatus(DestinationSyncOutcome{MembersSent: 2}, errors.New("later batch failed"), true); got != RunStatusPartial {
		t.Fatalf("partial = %q", got)
	}
	if got := destinationTerminalStatus(DestinationSyncOutcome{}, errors.New("timeout"), true); got != RunStatusNeedsReconciliation {
		t.Fatalf("ambiguous = %q", got)
	}
	if got := destinationTerminalStatus(DestinationSyncOutcome{}, ErrAdapterNotConfigured, true); got != RunStatusFailed {
		t.Fatalf("pre-effect config failure = %q", got)
	}
}

func TestExecuteRejectsOversizeBeforeWebhookOrProviderEffects(t *testing.T) {
	oversizeResolver := func(context.Context, string, *Sync) ([]MemberRow, bool, error) {
		return []MemberRow{{Email: "first@example.test"}}, true, nil
	}
	verify := func(context.Context, string, *Sync) error { return nil }

	t.Run("webhook", func(t *testing.T) {
		calls := 0
		runner := &SyncRunner{
			verifySourceFn:   verify,
			resolveMembersFn: oversizeResolver,
			HTTPClient:       roundTripFuncClient(func() { calls++ }),
		}
		result, err := runner.execute(context.Background(), "tenant", &Sync{
			ID: "sync", Destination: SyncDestination{Type: DestinationTypeWebhook, URL: "https://receiver.example"}, secret: "secret",
		}, "run")
		if !errors.Is(err, ErrAudienceCapExceeded) {
			t.Fatalf("execute error = %v, want ErrAudienceCapExceeded", err)
		}
		if calls != 0 {
			t.Fatalf("receiver calls = %d, want zero", calls)
		}
		if !result.CapExceeded || result.SourceMembersObserved != SyncMaxRows+1 || result.RowsExported != 0 {
			t.Fatalf("result = %#v", result)
		}
	})

	t.Run("platform", func(t *testing.T) {
		adapter := &recordingAdapter{provider: DestinationTypeMeta}
		runner := &SyncRunner{
			verifySourceFn:   verify,
			resolveMembersFn: oversizeResolver,
			Adapters:         AdapterRegistry{DestinationTypeMeta: adapter},
		}
		result, err := runner.execute(context.Background(), "tenant", &Sync{
			ID: "sync", Destination: SyncDestination{Type: DestinationTypeMeta, Config: map[string]any{"audience_id": "aud"}},
		}, "run")
		if !errors.Is(err, ErrAudienceCapExceeded) {
			t.Fatalf("execute error = %v, want ErrAudienceCapExceeded", err)
		}
		if adapter.callCount != 0 {
			t.Fatalf("adapter calls = %d, want zero", adapter.callCount)
		}
		if !result.CapExceeded || result.SourceMembersObserved != SyncMaxRows+1 || result.RowsExported != 0 {
			t.Fatalf("result = %#v", result)
		}
	})
}

// roundTripFuncClient intentionally panics if a request reaches Transport;
// the counter makes the zero-side-effect assertion easy to diagnose.
func roundTripFuncClient(onCall func()) *http.Client {
	return &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		onCall()
		return nil, errors.New("unexpected request")
	})}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMembersPayloadSHA256IsDeterministicAndOrderSensitive(t *testing.T) {
	a := []MemberRow{{Email: " First@Example.Test ", Status: "enabled", Tags: []string{"vip"}}}
	b := []MemberRow{{Email: "first@example.test", Status: "enabled", Tags: []string{"vip"}}}
	if membersPayloadSHA256(a) != membersPayloadSHA256(b) {
		t.Fatal("normalization-equivalent members produced different manifest hashes")
	}
	c := append([]MemberRow{}, b...)
	c = append(c, MemberRow{Email: "second@example.test"})
	if membersPayloadSHA256(a) == membersPayloadSHA256(c) {
		t.Fatal("different member manifests produced the same hash")
	}
}
