// SPDX-License-Identifier: AGPL-3.0-only
//
// filter_test.go — table-driven unit tests for the firewall decision.
// No live DB: ConsentBatchLookup + SuppressionLookup are satisfied by
// in-memory fakes. The critical behaviour pinned here is FAIL-DENY on a
// consent-lookup error and suppression-takes-precedence.
package activation_firewall

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// fakeConsent returns a fixed grant map; err forces the fail-deny path.
type fakeConsent struct {
	granted map[string]bool
	err     error
	calls   int
}

func (f *fakeConsent) AllowedBatch(_ context.Context, _ string, emails []string, _ string) (map[string]bool, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	out := map[string]bool{}
	for _, e := range emails {
		if v, ok := f.granted[e]; ok {
			out[e] = v
		}
	}
	return out, nil
}

// fakeSuppression returns a fixed suppressed set; err is swallowed by the
// firewall (suppression is best-effort) so we also assert that.
type fakeSuppression struct {
	suppressed map[string]*suppressions.Entry
	err        error
}

func (f *fakeSuppression) LookupBulk(_ context.Context, _ string, _ []string, _ suppressions.Channel, _ suppressions.Scope) (map[string]*suppressions.Entry, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.suppressed, nil
}

func entry(reason suppressions.Reason) *suppressions.Entry {
	return &suppressions.Entry{Reason: reason}
}

const tid = "11111111-1111-1111-1111-111111111111"

func TestDecide_AllConsentedNoSuppression(t *testing.T) {
	f := New(&fakeConsent{granted: map[string]bool{"a@x.com": true, "b@x.com": true}}, &fakeSuppression{})
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com", "b@x.com"})
	if len(dec.Excluded) != 0 {
		t.Fatalf("want 0 excluded, got %d: %+v", len(dec.Excluded), dec.Excluded)
	}
	if len(dec.Kept) != 2 {
		t.Fatalf("want 2 kept, got %d", len(dec.Kept))
	}
}

func TestDecide_NonConsentedTargetedAds(t *testing.T) {
	f := New(&fakeConsent{granted: map[string]bool{"a@x.com": true}}, &fakeSuppression{})
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com", "b@x.com"})
	if len(dec.Kept) != 1 || dec.Kept[0] != "a@x.com" {
		t.Fatalf("want only a@x.com kept, got %+v", dec.Kept)
	}
	if len(dec.Excluded) != 1 {
		t.Fatalf("want 1 excluded, got %d", len(dec.Excluded))
	}
	ex := dec.Excluded[0]
	if ex.SubscriberEmail != "b@x.com" || ex.RuleClass != RuleClassConsent {
		t.Fatalf("unexpected exclusion: %+v", ex)
	}
	if ex.RuleReason != "consent_targeted_ads_at null" {
		t.Fatalf("rule_reason = %q, want consent_targeted_ads_at null", ex.RuleReason)
	}
	if ex.Purpose != string(consent.PurposeTargetedAds) || ex.DestinationType != "meta" {
		t.Fatalf("purpose/dest not stamped: %+v", ex)
	}
}

func TestDecide_SuppressedRegardlessOfConsent(t *testing.T) {
	// b@x.com is consented AND suppressed → excluded by suppression.
	f := New(
		&fakeConsent{granted: map[string]bool{"a@x.com": true, "b@x.com": true}},
		&fakeSuppression{suppressed: map[string]*suppressions.Entry{"b@x.com": entry(suppressions.ReasonHardBounce)}},
	)
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com", "b@x.com"})
	if len(dec.Excluded) != 1 {
		t.Fatalf("want exactly 1 exclusion row, got %d: %+v", len(dec.Excluded), dec.Excluded)
	}
	ex := dec.Excluded[0]
	if ex.SubscriberEmail != "b@x.com" || ex.RuleClass != RuleClassSuppression {
		t.Fatalf("expected suppression exclusion for b@x.com, got %+v", ex)
	}
	if ex.RuleReason != string(suppressions.ReasonHardBounce) {
		t.Fatalf("rule_reason = %q, want hard_bounce", ex.RuleReason)
	}
}

func TestDecide_BothConsentAndSuppression_OneRow_SuppressionWins(t *testing.T) {
	// b@x.com is NOT consented AND suppressed → still exactly one row,
	// and it must be the suppression row (first-check wins).
	f := New(
		&fakeConsent{granted: map[string]bool{}}, // nobody consented
		&fakeSuppression{suppressed: map[string]*suppressions.Entry{"b@x.com": entry(suppressions.ReasonGlobalUnsubscribe)}},
	)
	dec := f.Decide(context.Background(), tid, consent.PurposeProfiling, "warehouse", []string{"b@x.com"})
	if len(dec.Excluded) != 1 {
		t.Fatalf("want exactly 1 exclusion row, got %d", len(dec.Excluded))
	}
	if dec.Excluded[0].RuleClass != RuleClassSuppression {
		t.Fatalf("suppression must win precedence, got rule_class %q", dec.Excluded[0].RuleClass)
	}
}

func TestDecide_FailDenyOnConsentError(t *testing.T) {
	// Consent lookup errors → EVERY non-suppressed member excluded with
	// rule_class=policy. This is the deliberate contrast with the send
	// loop's fail-open.
	fc := &fakeConsent{err: errors.New("db down")}
	f := New(fc, &fakeSuppression{})
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com", "b@x.com"})
	if len(dec.Kept) != 0 {
		t.Fatalf("fail-deny must keep nobody, got %+v", dec.Kept)
	}
	if len(dec.Excluded) != 2 {
		t.Fatalf("want 2 policy exclusions, got %d", len(dec.Excluded))
	}
	for _, ex := range dec.Excluded {
		if ex.RuleClass != RuleClassPolicy || ex.RuleReason != ReasonConsentLookupUnavailable {
			t.Fatalf("fail-deny row wrong: %+v", ex)
		}
	}
}

func TestDecide_FailDeny_SuppressedStillSuppressionRow(t *testing.T) {
	// Even when consent fails-deny, an already-suppressed member keeps its
	// suppression rule_class (suppression is resolved before consent).
	f := New(
		&fakeConsent{err: errors.New("db down")},
		&fakeSuppression{suppressed: map[string]*suppressions.Entry{"s@x.com": entry(suppressions.ReasonHardBounce)}},
	)
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"s@x.com", "p@x.com"})
	byEmail := map[string]ExclusionRecord{}
	for _, ex := range dec.Excluded {
		byEmail[ex.SubscriberEmail] = ex
	}
	if byEmail["s@x.com"].RuleClass != RuleClassSuppression {
		t.Fatalf("s@x.com should be suppression, got %+v", byEmail["s@x.com"])
	}
	if byEmail["p@x.com"].RuleClass != RuleClassPolicy {
		t.Fatalf("p@x.com should be fail-deny policy, got %+v", byEmail["p@x.com"])
	}
}

func TestDecide_SuppressionLookupError_DoesNotFailDeny(t *testing.T) {
	// A suppression lookup error is swallowed (consent is the load-bearing
	// gate); consent still decides.
	f := New(
		&fakeConsent{granted: map[string]bool{"a@x.com": true}},
		&fakeSuppression{err: errors.New("view missing")},
	)
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com", "b@x.com"})
	if len(dec.Kept) != 1 || dec.Kept[0] != "a@x.com" {
		t.Fatalf("consent gate should still keep a@x.com, got %+v", dec.Kept)
	}
	if len(dec.Excluded) != 1 || dec.Excluded[0].RuleClass != RuleClassConsent {
		t.Fatalf("b@x.com should be excluded by consent, got %+v", dec.Excluded)
	}
}

func TestDecide_EmptyInput(t *testing.T) {
	fc := &fakeConsent{}
	f := New(fc, &fakeSuppression{})
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", nil)
	if len(dec.Kept) != 0 || len(dec.Excluded) != 0 {
		t.Fatalf("empty input must yield empty decision")
	}
	if fc.calls != 0 {
		t.Fatalf("empty input must not call the consent lookup")
	}
}

func TestDecide_DegradedModeNilConsent_PassesThrough(t *testing.T) {
	// Nil consent dependency = firewall not configured → pass everything,
	// no exclusions. Distinct from a lookup error (fail-deny).
	f := New(nil, &fakeSuppression{})
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com", "b@x.com"})
	if len(dec.Kept) != 2 || len(dec.Excluded) != 0 {
		t.Fatalf("degraded mode must pass all through, got kept=%v excluded=%v", dec.Kept, dec.Excluded)
	}
}

func TestDecide_NilFilterReceiver(t *testing.T) {
	var f *Filter
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta", []string{"a@x.com"})
	if len(dec.Kept) != 1 || len(dec.Excluded) != 0 {
		t.Fatalf("nil filter must pass through, got %+v", dec)
	}
}

func TestDecide_NormalizesAndDedupes(t *testing.T) {
	f := New(&fakeConsent{granted: map[string]bool{"a@x.com": true}}, &fakeSuppression{})
	dec := f.Decide(context.Background(), tid, consent.PurposeTargetedAds, "meta",
		[]string{" A@X.com ", "a@x.com", "", "  "})
	if len(dec.Kept) != 1 || dec.Kept[0] != "a@x.com" {
		t.Fatalf("want single normalized kept a@x.com, got %+v", dec.Kept)
	}
}
