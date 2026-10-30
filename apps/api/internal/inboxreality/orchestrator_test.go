// SPDX-License-Identifier: AGPL-3.0-only
package inboxreality

import (
	"context"
	"errors"
	"testing"
	"time"
)

type testSeedRegistry struct{}

func (testSeedRegistry) Seeds(context.Context) ([]SeedAddress, error) {
	return []SeedAddress{{
		MailboxID: "gmail-controlled-01", Address: "seed@example.test",
		Provider: ProviderGmail, ProviderLabel: ProviderGmail.DisplayName(),
	}}, nil
}

func (testSeedRegistry) ProviderInfo(context.Context) ([]ProviderInfo, error) {
	return StaticSeedRegistry{}.ProviderInfo(context.Background())
}

// fixedClock returns a stable time for deterministic comparisons.
func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

// countingMinter returns a sequence of tokens; lets us deterministically
// reproduce the "first token collides, second succeeds" path.
type countingMinter struct {
	tokens []string
	i      int
	err    error
}

func (c *countingMinter) next() (string, error) {
	if c.err != nil {
		return "", c.err
	}
	if c.i >= len(c.tokens) {
		return "", errors.New("countingMinter: out of tokens")
	}
	t := c.tokens[c.i]
	c.i++
	return t, nil
}

func newOrchForTests(t *testing.T) (*Orchestrator, *MemoryStore) {
	t.Helper()
	store := NewMemoryStore(nil)
	o := NewOrchestrator(store, testSeedRegistry{})
	o.Clock = fixedClock(time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC))
	return o, store
}

func TestCreateTest_HappyPath(t *testing.T) {
	o, _ := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}).next

	out, err := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{
		Subject:     "Hello",
		FromAddress: "team@acme.example",
	})
	if err != nil {
		t.Fatalf("CreateTest: %v", err)
	}
	if out.Test.Kind != KindManual {
		t.Errorf("default kind should be manual, got %q", out.Test.Kind)
	}
	if out.Test.Status != StatusAwaitingDelivery {
		t.Errorf("initial status = %q, want awaiting_delivery", out.Test.Status)
	}
	if out.HeaderName != "X-Postwave-Test-ID" {
		t.Errorf("header name = %q", out.HeaderName)
	}
	if out.HeaderValue != "irt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("header value = %q, want prefixed token", out.HeaderValue)
	}
}

func TestCreateTest_RejectsUnknownKind(t *testing.T) {
	o, _ := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"aa"}}).next

	_, err := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{Kind: Kind("evil")})
	if err == nil {
		t.Fatalf("expected error for unknown kind")
	}
}

func TestCreateTest_RetriesOnTokenCollision(t *testing.T) {
	o, store := newOrchForTests(t)
	// Pre-populate the store with the first token so the orchestrator
	// MUST retry to the second.
	taken := "collision-token-aaaaaaaaaaaaaaaaa"
	_, err := store.CreateTest(context.Background(), CreateTestParams{
		TenantID:    "other-tenant",
		HeaderToken: taken,
		Kind:        KindManual,
		ExpiresAt:   time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("seed pre-existing test: %v", err)
	}
	o.TokenMinter = (&countingMinter{tokens: []string{taken, "fresh-token-bbbbbbbbbbbbbbbbbbbbb"}}).next

	out, err := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{Subject: "Retry"})
	if err != nil {
		t.Fatalf("CreateTest after collision: %v", err)
	}
	if out.Test.HeaderToken != "fresh-token-bbbbbbbbbbbbbbbbbbbbb" {
		t.Errorf("expected retry to land on the second token, got %q", out.Test.HeaderToken)
	}
}

func TestCreateTest_ExhaustsRetries(t *testing.T) {
	o, store := newOrchForTests(t)
	// Three tokens, all pre-seeded — every attempt collides.
	collisions := []string{"a", "b", "c"}
	for _, c := range collisions {
		_, _ = store.CreateTest(context.Background(), CreateTestParams{
			TenantID:    "pre-existing",
			HeaderToken: c,
			Kind:        KindManual,
			ExpiresAt:   time.Now().Add(time.Hour),
		})
	}
	o.TokenMinter = (&countingMinter{tokens: collisions}).next
	o.MaxCreateRetries = 3
	_, err := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{})
	if err == nil {
		t.Fatalf("expected error after exhausting retries")
	}
}

func TestCreateTest_TTLClampedAtOneHour(t *testing.T) {
	o, _ := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"tok"}}).next
	out, err := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{
		TTL: 24 * time.Hour, // way over the cap
	})
	if err != nil {
		t.Fatalf("CreateTest: %v", err)
	}
	// CreateTest falls back to DefaultTTL when caller exceeds 1h.
	// We can verify by checking expires_at is exactly DefaultTTL from clock.
	gotDelta := out.Test.ExpiresAt.Sub(o.Clock())
	if gotDelta != o.DefaultTTL {
		t.Errorf("TTL=24h should clamp to DefaultTTL (%s), got %s", o.DefaultTTL, gotDelta)
	}
}

func TestFinalizeIfReady_TransitionsOnFirstResult(t *testing.T) {
	o, store := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"tok-finalise-1"}}).next
	created, err := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Record one result.
	_, err = store.RecordResult(context.Background(), RecordResultParams{
		TestID: created.Test.ID, MailboxID: "gmail-01", Provider: ProviderGmail, Placement: PlacementPrimary, FolderName: "INBOX",
	})
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	// Active seeds=3 → not yet complete, but should advance to classifying.
	updated, err := o.FinalizeIfReady(context.Background(), "tenant-A", created.Test.ID, 3)
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if updated.Status != StatusClassifying {
		t.Errorf("status after first-of-three = %q, want classifying", updated.Status)
	}
}

func TestFinalizeIfReady_CompletesOnAllSeedsReported(t *testing.T) {
	o, store := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"tok-complete"}}).next
	created, _ := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{})
	for i, mb := range []string{"gmail-01", "outlook-01", "yahoo-01"} {
		_, err := store.RecordResult(context.Background(), RecordResultParams{
			TestID: created.Test.ID, MailboxID: mb, Provider: ProviderGmail, Placement: PlacementPrimary,
		})
		if err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	updated, err := o.FinalizeIfReady(context.Background(), "tenant-A", created.Test.ID, 3)
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if updated.Status != StatusComplete {
		t.Errorf("status with 3/3 reported = %q, want complete", updated.Status)
	}
	if updated.CompletedAt == nil {
		t.Errorf("CompletedAt should be set on Complete")
	}
}

func TestFinalizeIfReady_ExpiresAfterDeadlineNoResults(t *testing.T) {
	o, _ := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"tok-expire"}}).next
	created, _ := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{TTL: 1 * time.Second})
	// Advance the orchestrator's clock past expires_at.
	o.Clock = fixedClock(created.Test.ExpiresAt.Add(2 * time.Second))
	updated, err := o.FinalizeIfReady(context.Background(), "tenant-A", created.Test.ID, 5)
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if updated.Status != StatusExpired {
		t.Errorf("status after expiry with no results = %q, want expired", updated.Status)
	}
}

func TestFinalizeIfReady_PartialResultsExpireAsComplete(t *testing.T) {
	o, store := newOrchForTests(t)
	o.TokenMinter = (&countingMinter{tokens: []string{"tok-partial"}}).next
	created, _ := o.CreateTest(context.Background(), "tenant-A", CreateTestInput{TTL: 1 * time.Second})
	_, _ = store.RecordResult(context.Background(), RecordResultParams{
		TestID: created.Test.ID, MailboxID: "gmail-01", Provider: ProviderGmail, Placement: PlacementPrimary,
	})
	o.Clock = fixedClock(created.Test.ExpiresAt.Add(2 * time.Second))
	updated, err := o.FinalizeIfReady(context.Background(), "tenant-A", created.Test.ID, 5)
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	// Partial results past the deadline land at Complete, not Expired,
	// so the dashboard renders what we got.
	if updated.Status != StatusComplete {
		t.Errorf("status with 1 of 5 + expired = %q, want complete", updated.Status)
	}
}

func TestSummariseResults_BreakdownAndPercentages(t *testing.T) {
	results := []Result{
		{Provider: ProviderGmail, Placement: PlacementPrimary},
		{Provider: ProviderGmail, Placement: PlacementSpam},
		{Provider: ProviderOutlookCom, Placement: PlacementPrimary},
		{Provider: ProviderOutlookCom, Placement: PlacementPrimary},
	}
	s := SummariseResults(results)
	if s.Total != 4 {
		t.Errorf("total = %d, want 4", s.Total)
	}
	if s.Placements[PlacementPrimary] != 3 {
		t.Errorf("primary count = %d, want 3", s.Placements[PlacementPrimary])
	}
	if s.PrimaryPct != 0.75 {
		t.Errorf("primary pct = %f, want 0.75", s.PrimaryPct)
	}
	if s.SpamPct != 0.25 {
		t.Errorf("spam pct = %f, want 0.25", s.SpamPct)
	}
	// Providers list should always include ALL provider slots (even 0-result).
	if len(s.Providers) != len(AllProviders) {
		t.Errorf("len(providers) = %d, want %d (every slot, even zero)", len(s.Providers), len(AllProviders))
	}
	for _, pb := range s.Providers {
		switch pb.Provider {
		case ProviderGmail:
			if pb.Total != 2 || pb.PrimaryPct != 0.5 || pb.SpamPct != 0.5 {
				t.Errorf("gmail breakdown = %+v", pb)
			}
		case ProviderOutlookCom:
			if pb.Total != 2 || pb.PrimaryPct != 1.0 || pb.SpamPct != 0 {
				t.Errorf("outlook_com breakdown = %+v", pb)
			}
		}
	}
}

func TestSummariseResults_EmptyIsStable(t *testing.T) {
	s := SummariseResults(nil)
	if s.Total != 0 || s.PrimaryPct != 0 || s.SpamPct != 0 {
		t.Errorf("empty summary should be zero-valued, got %+v", s)
	}
	if len(s.Providers) != len(AllProviders) {
		t.Errorf("empty summary still lists every provider slot")
	}
}
