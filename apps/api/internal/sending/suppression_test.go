package sending

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

type stubChecker struct {
	mu         sync.Mutex
	suppressed bool
	reason     string
	err        error
	calls      int
	lastEmail  string
}

func (s *stubChecker) Check(_ context.Context, _, email string) (bool, *SuppressionEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.lastEmail = email
	if s.err != nil {
		return false, nil, s.err
	}
	if !s.suppressed {
		return false, nil, nil
	}
	return true, &SuppressionEntry{Reason: s.reason}, nil
}

type stubBatchChecker struct {
	mu        sync.Mutex
	decisions map[string]SuppressionDecision
	err       error
	autoClear bool
	calls     [][]string
}

func (s *stubBatchChecker) Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error) {
	if err := ctx.Err(); err != nil {
		return false, nil, err
	}
	decisions, err := s.CheckBatch(ctx, tenantID, []string{email})
	if err != nil {
		return false, nil, err
	}
	decision, ok := decisions[normalizeSuppressionEmail(email)]
	if !ok {
		return false, nil, ErrSuppressionBatchIncomplete
	}
	return decision.Suppressed, decision.Entry, nil
}

func (s *stubBatchChecker) CheckBatch(_ context.Context, _ string, emails []string) (map[string]SuppressionDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	call := append([]string(nil), emails...)
	s.calls = append(s.calls, call)
	if s.err != nil {
		return nil, s.err
	}
	out := make(map[string]SuppressionDecision, len(emails))
	if s.autoClear {
		for _, email := range emails {
			out[normalizeSuppressionEmail(email)] = SuppressionDecision{}
		}
	}
	for email, decision := range s.decisions {
		out[normalizeSuppressionEmail(email)] = decision
	}
	return out, nil
}

func (s *stubBatchChecker) callSizes() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int, len(s.calls))
	for i, call := range s.calls {
		out[i] = len(call)
	}
	return out
}

func TestSuppressionAdaptersRejectNilDependency(t *testing.T) {
	var storeAdapter *SuppressionStoreAdapter
	if _, _, err := storeAdapter.Check(t.Context(), "tid", "x@y.co"); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil store adapter error = %v, want ErrSuppressionGateUnavailable", err)
	}
	if _, err := storeAdapter.CheckBatch(t.Context(), "tid", []string{"x@y.co"}); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil store batch adapter error = %v, want ErrSuppressionGateUnavailable", err)
	}

	var convergerAdapter *SuppressionConvergerAdapter
	if _, _, err := convergerAdapter.Check(t.Context(), "tid", "x@y.co"); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil converger adapter error = %v, want ErrSuppressionGateUnavailable", err)
	}
	if _, err := convergerAdapter.CheckBatch(t.Context(), "tid", []string{"x@y.co"}); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil converger batch adapter error = %v, want ErrSuppressionGateUnavailable", err)
	}
}

func TestLookupSuppressionPreservesClearAndSuppressedDecisions(t *testing.T) {
	clear := &stubChecker{}
	suppressed, hit, err := lookupSuppression(t.Context(), clear, "t", "clear@example.com")
	if err != nil || suppressed || hit != nil {
		t.Fatalf("clear decision: suppressed=%v hit=%+v err=%v", suppressed, hit, err)
	}

	blocked := &stubChecker{suppressed: true, reason: "hard_bounce"}
	suppressed, hit, err = lookupSuppression(t.Context(), blocked, "t", "blocked@example.com")
	if err != nil || !suppressed || hit == nil || hit.Reason != "hard_bounce" {
		t.Fatalf("suppressed decision: suppressed=%v hit=%+v err=%v", suppressed, hit, err)
	}
}

func TestLookupSuppressionFailsClosedOnErrorOrMissingGate(t *testing.T) {
	wantErr := errors.New("suppression store unavailable")
	broken := &stubChecker{suppressed: false, err: wantErr}
	if suppressed, hit, err := lookupSuppression(t.Context(), broken, "t", "x@example.com"); !errors.Is(err, wantErr) || suppressed || hit != nil {
		t.Fatalf("lookup error must be unknown/denied: suppressed=%v hit=%+v err=%v", suppressed, hit, err)
	}
	if suppressed, hit, err := lookupSuppression(t.Context(), nil, "t", "x@example.com"); !errors.Is(err, ErrSuppressionGateUnavailable) || suppressed || hit != nil {
		t.Fatalf("missing gate must be unknown/denied: suppressed=%v hit=%+v err=%v", suppressed, hit, err)
	}
}

func TestPrefetchSuppressionDecisionsReturnsExplicitClearAndHit(t *testing.T) {
	checker := &stubBatchChecker{
		autoClear: true,
		decisions: map[string]SuppressionDecision{
			"BLOCKED@EXAMPLE.COM": {Suppressed: true, Entry: &SuppressionEntry{Reason: "spam_complaint"}},
		},
	}
	guard := &Guard{Suppressions: checker}
	decisions, batched, err := guard.prefetchSuppressionDecisions(
		t.Context(), "tenant", []string{" Clear@Example.com ", "BLOCKED@example.com"},
	)
	if err != nil || !batched {
		t.Fatalf("prefetch: batched=%v err=%v", batched, err)
	}
	if decisions["clear@example.com"].Suppressed {
		t.Fatal("clear address was suppressed")
	}
	blocked := decisions["blocked@example.com"]
	if !blocked.Suppressed || blocked.Entry == nil || blocked.Entry.Reason != "spam_complaint" {
		t.Fatalf("blocked decision = %+v", blocked)
	}
}

func TestPrefetchSuppressionDecisionsRejectsBatchErrorAndIncompleteMap(t *testing.T) {
	wantErr := errors.New("database unavailable")
	guard := &Guard{Suppressions: &stubBatchChecker{err: wantErr}}
	if _, batched, err := guard.prefetchSuppressionDecisions(t.Context(), "tenant", []string{"a@example.com"}); !batched || !errors.Is(err, wantErr) {
		t.Fatalf("batch error: batched=%v err=%v", batched, err)
	}

	guard.Suppressions = &stubBatchChecker{decisions: map[string]SuppressionDecision{
		"a@example.com": {},
	}}
	if _, batched, err := guard.prefetchSuppressionDecisions(
		t.Context(), "tenant", []string{"a@example.com", "missing@example.com"},
	); !batched || !errors.Is(err, ErrSuppressionBatchIncomplete) {
		t.Fatalf("incomplete map: batched=%v err=%v", batched, err)
	}
}

func TestPrefetchSuppressionDecisionsBoundsAndDeduplicatesBatchCalls(t *testing.T) {
	checker := &stubBatchChecker{autoClear: true}
	emails := make([]string, 0, suppressionLookupChunkSize*2+2)
	for i := 0; i < suppressionLookupChunkSize*2+1; i++ {
		emails = append(emails, fmt.Sprintf("person-%03d@example.com", i))
	}
	// Duplicate one address with different case/space; it must not consume a
	// fourth query slot or create an extra decision.
	emails = append(emails, " PERSON-000@EXAMPLE.COM ")
	guard := &Guard{Suppressions: checker}
	decisions, batched, err := guard.prefetchSuppressionDecisions(t.Context(), "tenant", emails)
	if err != nil || !batched {
		t.Fatalf("prefetch: batched=%v err=%v", batched, err)
	}
	if got, want := len(decisions), suppressionLookupChunkSize*2+1; got != want {
		t.Fatalf("decision count = %d, want %d", got, want)
	}
	if got, want := checker.callSizes(), []int{250, 250, 1}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("batch call sizes = %v, want %v", got, want)
	}
}

func TestObserveSuppressionMetricsNoPanic(t *testing.T) {
	observeRecipientSuppressed("")
	observeRecipientSuppressed("hard_bounce")
	observeSuppressionDecisionUnavailable("unconfigured", 1)
	observeSuppressionDecisionUnavailable("batch_error", 2)
	observeSuppressionDecisionUnavailable("batch_incomplete", 3)
	observeSuppressionDecisionUnavailable("recipient_error", 4)
}
