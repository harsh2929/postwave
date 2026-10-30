// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

type stubRecipientHealthLookup struct {
	mu        sync.Mutex
	decisions map[string]recipientHealthDecision
	err       error
	autoClear bool
	calls     [][]string
}

func (s *stubRecipientHealthLookup) Lookup(ctx context.Context, _ string, emails []string) (map[string]recipientHealthDecision, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, append([]string(nil), emails...))
	if s.err != nil {
		return nil, s.err
	}
	out := make(map[string]recipientHealthDecision, len(emails))
	if s.autoClear {
		for _, email := range emails {
			out[normalizeSuppressionEmail(email)] = recipientHealthDecision{}
		}
	}
	for email, decision := range s.decisions {
		out[normalizeSuppressionEmail(email)] = decision
	}
	return out, nil
}

func (s *stubRecipientHealthLookup) set(decisions map[string]recipientHealthDecision) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.decisions = decisions
}

func (s *stubRecipientHealthLookup) calledWith() [][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([][]string, len(s.calls))
	for i := range s.calls {
		out[i] = append([]string(nil), s.calls[i]...)
	}
	return out
}

func TestRecipientSafetyGateBatchCanOnlyAddBlocks(t *testing.T) {
	base := &stubBatchChecker{
		autoClear: true,
		decisions: map[string]SuppressionDecision{
			"suppressed@example.com": {
				Suppressed: true,
				Entry:      &SuppressionEntry{Reason: "manual_unsubscribe"},
			},
		},
	}
	health := &stubRecipientHealthLookup{
		autoClear: true,
		decisions: map[string]recipientHealthDecision{
			"unsafe@example.com": {
				Blocked: true, Reason: "verification_invalid", SuppressionReason: "invalid_email",
			},
		},
	}
	gate := &RecipientSafetyGate{Suppressions: base, health: health}

	got, err := gate.CheckBatch(t.Context(), "tenant", []string{
		" Suppressed@Example.com ", "SAFE@example.com", "unsafe@example.com",
	})
	if err != nil {
		t.Fatalf("CheckBatch: %v", err)
	}
	if decision := got["suppressed@example.com"]; !decision.Suppressed || decision.Entry == nil || decision.Entry.Reason != "manual_unsubscribe" {
		t.Fatalf("canonical suppression was weakened: %+v", decision)
	}
	if decision := got["safe@example.com"]; decision.Suppressed || decision.Entry != nil {
		t.Fatalf("safe decision = %+v", decision)
	}
	if decision := got["unsafe@example.com"]; !decision.Suppressed || decision.Entry == nil || decision.Entry.Reason != "invalid_email" {
		t.Fatalf("verification-health decision = %+v", decision)
	}
	calls := health.calledWith()
	if got, want := fmt.Sprint(calls), "[[safe@example.com unsafe@example.com]]"; got != want {
		t.Fatalf("health lookups = %s, want %s; canonical hits must not be override candidates", got, want)
	}
}

func TestRecipientSafetyGatePreservesBaseFailuresAndTotalMapContract(t *testing.T) {
	wantErr := errors.New("canonical suppression unavailable")
	health := &stubRecipientHealthLookup{autoClear: true}
	gate := &RecipientSafetyGate{
		Suppressions: &stubBatchChecker{err: wantErr},
		health:       health,
	}
	if _, err := gate.CheckBatch(t.Context(), "tenant", []string{"a@example.com"}); !errors.Is(err, wantErr) {
		t.Fatalf("base error = %v, want %v", err, wantErr)
	}
	if got := len(health.calledWith()); got != 0 {
		t.Fatalf("health called %d times after canonical error", got)
	}

	gate.Suppressions = &stubBatchChecker{decisions: map[string]SuppressionDecision{}}
	if _, err := gate.CheckBatch(t.Context(), "tenant", []string{"a@example.com"}); !errors.Is(err, ErrSuppressionBatchIncomplete) {
		t.Fatalf("canonical incomplete error = %v", err)
	}

	gate.Suppressions = &stubBatchChecker{autoClear: true}
	gate.health = &stubRecipientHealthLookup{decisions: map[string]recipientHealthDecision{}}
	if _, err := gate.CheckBatch(t.Context(), "tenant", []string{"a@example.com"}); !errors.Is(err, ErrSuppressionBatchIncomplete) {
		t.Fatalf("health incomplete error = %v", err)
	}

	gate.health = &stubRecipientHealthLookup{err: wantErr}
	if decisions, err := gate.CheckBatch(t.Context(), "tenant", []string{"a@example.com"}); !errors.Is(err, wantErr) || decisions != nil {
		t.Fatalf("health outage decisions=%v err=%v", decisions, err)
	}
}

func TestRecipientSafetyGateScalarRechecksHealthAtLastMoment(t *testing.T) {
	health := &stubRecipientHealthLookup{autoClear: true}
	gate := &RecipientSafetyGate{Suppressions: &stubChecker{}, health: health}

	suppressed, entry, err := gate.Check(t.Context(), "tenant", "person@example.com")
	if err != nil || suppressed || entry != nil {
		t.Fatalf("initial clear: suppressed=%v entry=%+v err=%v", suppressed, entry, err)
	}
	health.set(map[string]recipientHealthDecision{
		"person@example.com": {
			Blocked: true, Reason: "recent_negative", SuppressionReason: "soft_bounce",
		},
	})
	suppressed, entry, err = gate.Check(t.Context(), "tenant", "person@example.com")
	if err != nil || !suppressed || entry == nil || entry.Reason != "soft_bounce" {
		t.Fatalf("fresh negative: suppressed=%v entry=%+v err=%v", suppressed, entry, err)
	}
	if got := len(health.calledWith()); got != 2 {
		t.Fatalf("scalar health lookup count = %d, want 2", got)
	}
}

func TestRecipientSafetyGateScalarCanonicalHitShortCircuitsHealth(t *testing.T) {
	health := &stubRecipientHealthLookup{autoClear: true}
	gate := &RecipientSafetyGate{
		Suppressions: &stubChecker{suppressed: true, reason: "manual_unsubscribe"},
		health:       health,
	}
	suppressed, entry, err := gate.Check(t.Context(), "tenant", "person@example.com")
	if err != nil || !suppressed || entry == nil || entry.Reason != "manual_unsubscribe" {
		t.Fatalf("canonical hit: suppressed=%v entry=%+v err=%v", suppressed, entry, err)
	}
	if got := len(health.calledWith()); got != 0 {
		t.Fatalf("health called %d times after canonical hit", got)
	}
}

func TestRecipientSafetyGateRejectsMissingDependencies(t *testing.T) {
	var gate *RecipientSafetyGate
	if _, _, err := gate.Check(t.Context(), "tenant", "a@example.com"); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil scalar error = %v", err)
	}
	if _, err := gate.CheckBatch(t.Context(), "tenant", []string{"a@example.com"}); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil batch error = %v", err)
	}
	lookup := &postgresRecipientHealthLookup{}
	if _, err := lookup.Lookup(t.Context(), "tenant", []string{"a@example.com"}); !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("nil postgres lookup error = %v", err)
	}
}

func TestRecipientSafetyGateRolloutSwitchPreservesCanonicalBoundary(t *testing.T) {
	base := &stubChecker{suppressed: true, reason: "manual_unsubscribe"}
	if got := RecipientSafetyGateForRollout(nil, base, false); got != base {
		t.Fatalf("disabled rollout returned %T, want exact canonical checker", got)
	}
	if got := RecipientSafetyGateForRollout(nil, base, true); got == base {
		t.Fatal("enabled rollout did not install recipient health wrapper")
	} else if _, ok := got.(*RecipientSafetyGate); !ok {
		t.Fatalf("enabled rollout returned %T, want *RecipientSafetyGate", got)
	}
}

func TestRecipientHealthEvidencePolicy(t *testing.T) {
	for _, status := range []string{"invalid", "spamtrap", "abuse", "do_not_mail"} {
		decision, blocked := terminalVerificationDecision(status)
		if !blocked || !decision.Blocked || decision.Reason == "" || decision.SuppressionReason == "" {
			t.Fatalf("terminal status %q decision = %+v blocked=%v", status, decision, blocked)
		}
	}
	for _, status := range []string{"valid", "catch_all", "unknown", ""} {
		if decision, blocked := terminalVerificationDecision(status); blocked || decision.Blocked {
			t.Fatalf("caution/eligible status %q blocked: %+v", status, decision)
		}
	}
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	if decision, blocked := hardEvidenceDecision(
		[]healthSnapshotEvidence{{Kind: "complaint", At: now}}, now.Add(recipientHealthFutureTolerance),
	); !blocked || !decision.Blocked {
		t.Fatalf("complaint was not terminal: %+v", decision)
	}
	if decision, blocked := hardEvidenceDecision(
		[]healthSnapshotEvidence{{Kind: "complaint", At: now.Add(recipientHealthFutureTolerance + time.Nanosecond)}},
		now.Add(recipientHealthFutureTolerance),
	); blocked || decision.Blocked {
		t.Fatalf("implausible future complaint blocked: %+v", decision)
	}
	for _, kind := range []string{"hard_bounce", "hard_stop"} {
		if decision, blocked := hardEvidenceDecision(
			[]healthSnapshotEvidence{{Kind: kind, At: now}}, now.Add(recipientHealthFutureTolerance),
		); blocked || decision.Blocked {
			t.Fatalf("recoverable/canonical evidence %q was treated as terminal: %+v", kind, decision)
		}
	}

	cutoff := now.Add(-recipientHealthNegativeWindow)
	positiveCutoff := now.Add(-recipientHealthPositiveWindow)
	for _, kind := range []string{"hard_bounce", "soft_bounce", "ambiguous_negative"} {
		reason, blocked := recentRecoverableNegative(
			[]healthSnapshotEvidence{{Kind: kind, At: cutoff}},
			cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance),
		)
		if !blocked || reason == "" {
			t.Fatalf("%s exactly at freshness boundary decision=%q/%v, want block", kind, reason, blocked)
		}
	}
	if _, blocked := recentRecoverableNegative(
		[]healthSnapshotEvidence{{Kind: "hard_bounce", At: cutoff.Add(-time.Nanosecond)}},
		cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance),
	); blocked {
		t.Fatal("stale historical negative should not block")
	}
	if _, blocked := recentRecoverableNegative(
		[]healthSnapshotEvidence{{Kind: "soft_bounce", At: now.Add(6 * time.Minute)}},
		cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance),
	); blocked {
		t.Fatal("implausible future soft negative should not block")
	}
	if _, blocked := recentRecoverableNegative(
		[]healthSnapshotEvidence{{Kind: "open", At: now}},
		cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance),
	); blocked {
		t.Fatal("positive/caution evidence should not block")
	}
	if reason, blocked := recentRecoverableNegative([]healthSnapshotEvidence{
		{Kind: "hard_bounce", At: now.Add(-2 * time.Hour)},
		{Kind: "vendor_activity", At: now.Add(-time.Hour)},
	}, cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance)); !blocked || reason != "hard_bounce" {
		t.Fatalf("reserved vendor activity decision=%q/%v, want hard_bounce block", reason, blocked)
	}
	if _, blocked := recentRecoverableNegative([]healthSnapshotEvidence{
		{Kind: "hard_bounce", At: now.Add(-2 * time.Hour)},
		{Kind: "delivered", At: now.Add(-time.Hour)},
	}, cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance)); blocked {
		t.Fatal("newer trusted positive did not retire historical hard bounce")
	}
	if reason, blocked := recentRecoverableNegative([]healthSnapshotEvidence{
		{Kind: "delivered", At: now.Add(-2 * time.Hour)},
		{Kind: "hard_bounce", At: now.Add(-time.Hour)},
	}, cutoff, positiveCutoff, now.Add(recipientHealthFutureTolerance)); !blocked || reason != "hard_bounce" {
		t.Fatalf("newer hard bounce decision=%q/%v, want hard_bounce block", reason, blocked)
	}
}

func TestObserveRecipientHealthGateNoPanic(t *testing.T) {
	for _, reason := range []string{
		"verification_invalid", "verification_spamtrap", "verification_abuse",
		"verification_do_not_mail", "hard_bounce", "hard_complaint",
		"recent_negative", "error", "incomplete", "not-a-valid-label",
	} {
		observeRecipientHealthGate(reason)
	}
}

func TestTrustedCacheRetiresTerminalSnapshotOnlyForNewerValid(t *testing.T) {
	snapshotAt := time.Now().UTC().Add(-time.Hour)
	newer := snapshotAt.Add(time.Minute)
	older := snapshotAt.Add(-time.Minute)
	for _, tt := range []struct {
		name     string
		status   string
		provider string
		at       *time.Time
		want     bool
	}{
		{name: "newer trusted valid", status: "valid", provider: recipientHealthProviderKickbox, at: &newer, want: true},
		{name: "equal trusted valid", status: "valid", provider: recipientHealthProviderKickbox, at: &snapshotAt},
		{name: "older trusted valid", status: "valid", provider: recipientHealthProviderZeroBounce, at: &older},
		{name: "newer local valid", status: "valid", provider: "local", at: &newer},
		{name: "newer blank-provider valid", status: "valid", at: &newer},
		{name: "newer forged-provider valid", status: "valid", provider: "KICKBOX", at: &newer},
		{name: "newer unknown", status: "unknown", provider: recipientHealthProviderKickbox, at: &newer},
		{name: "newer catch all", status: "catch_all", provider: recipientHealthProviderKickbox, at: &newer},
		{name: "missing timestamp", status: "valid", provider: recipientHealthProviderKickbox},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := trustedCacheRetiresTerminalSnapshot(
				tt.status, tt.provider, tt.at, &snapshotAt,
			); got != tt.want {
				t.Fatalf("retirement = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSafeSendLoopErrorClassDoesNotExposeRecipientDetail(t *testing.T) {
	const canary = "constraint row contains private.recipient@example.invalid"
	got := safeSendLoopErrorClass(errors.New(canary))
	if got != "persistence_or_internal" || strings.Contains(got, canary) {
		t.Fatalf("safe send-loop error class = %q", got)
	}
	if got := safeSendLoopErrorClass(ErrSuppressionBatchIncomplete); got != "suppression_result_incomplete" {
		t.Fatalf("incomplete error class = %q", got)
	}
	if got := safeSendLoopErrorClass(&sendallowance.ExhaustedError{Limit: 1, Current: 1, Requested: 1}); got != "managed_send_allowance_exhausted" {
		t.Fatalf("allowance error class = %q", got)
	}
}
