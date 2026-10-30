// SPDX-License-Identifier: AGPL-3.0-only
//
// filter.go — the Consent-Safe Activation Firewall (feature #2).
//
// WHAT: a PURE decision function that, given a set of activation members
// (emails), the per-purpose consent state, the suppression set, and the
// destination → purpose mapping, partitions them into KEPT and EXCLUDED.
// Every excluded member carries the governing rule (rule_class +
// rule_reason) so the downstream receipt is self-explanatory.
//
// WHERE IT RUNS: at every data-activation boundary BEFORE rows leave
// Moosewave — audience_destinations sync_runner (resolveMembers), the
// zerocopy_triggers worker (PollOnce → EnqueueRun), and the warehouse
// export path. It does NOT run on GDPR Article-15 portability exports
// (exports/walkers.go) — that is a data-subject right that cannot be
// conditioned on consent (D4, senior-staff approved 2026-06-15).
//
// FAIL-DENY (D1, approved): like the email-marketing purpose gate, the
// activation firewall never interprets a database hiccup as permission. If
// the consent lookup errors, EVERY
// member is excluded (rule_class='policy',
// rule_reason='consent_lookup_unavailable'). A sync/trigger is not under
// real-time delivery SLA pressure; failing deny means zero profiles leak
// to a Meta audience or a warehouse in a degraded-infra state, and the
// exclusion receipt proves exactly what happened so the run can be
// retried.
//
// PRECEDENCE: suppression is checked FIRST. A member who is both
// suppressed AND non-consented produces exactly ONE exclusion row, with
// rule_class='suppression'.
//
// This file imports nothing heavy: it talks to consent + suppression
// through the SMALL interfaces below, which the production wiring
// (main.go) satisfies with adapters and tests satisfy with fakes — no
// live DB required to unit-test the decision.
package activation_firewall

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// Run-type constants — mirror the activation_exclusion_receipts.run_type
// CHECK (migration 0406).
const (
	RunTypeAudienceSync    = "audience_sync"
	RunTypeZerocopyTrigger = "zerocopy_trigger"
)

// Rule-class constants — mirror the rule_class CHECK (0406).
const (
	RuleClassConsent     = "consent"
	RuleClassSuppression = "suppression"
	RuleClassPolicy      = "policy"
)

// Policy rule-reason constants used when the firewall itself (not a
// specific consent/suppression row) is the cause.
const (
	// ReasonConsentLookupUnavailable is the FAIL-DENY marker: the consent
	// lookup errored, so the member was withheld rather than leaked.
	ReasonConsentLookupUnavailable = "consent_lookup_unavailable"
	// ReasonProfileKeyNotEmail marks a zerocopy fire whose profile_key is
	// not an email and therefore cannot be consent-checked — fail-deny.
	ReasonProfileKeyNotEmail = "profile_key_not_email_cannot_check_consent"
)

// ConsentBatchLookup is the firewall's slim view of the consent store.
// It resolves consent for a batch of emails against a single purpose in
// one round trip and returns a map keyed by lowercase email. A missing
// key means "not consented" for the activation firewall (the
// fail-deny-on-missing-consent posture); the boolean is the grant state.
//
// The production implementation (PurposeBatchAdapter in repo.go) delegates to
// consent.PurposeLookup so activation and campaign delivery cannot drift;
// tests pass a fake.
type ConsentBatchLookup interface {
	AllowedBatch(ctx context.Context, tenantID string, emails []string, purpose string) (map[string]bool, error)
}

// SuppressionLookup is the firewall's slim view of the suppression
// converger. It returns the set of suppressed addresses (keyed
// lowercase) with the suppression Entry so the Reason can be recorded
// verbatim on the receipt. Production wires *suppressions.SuppressionConverger
// directly (it already satisfies this signature); tests pass a fake.
type SuppressionLookup interface {
	LookupBulk(ctx context.Context, tenantID string, emails []string, channel suppressions.Channel, scope suppressions.Scope) (map[string]*suppressions.Entry, error)
}

// ExclusionRecord is one withheld profile + the rule that governed it.
// It is the in-memory shape the firewall returns and the repo persists
// to activation_exclusion_receipts.
type ExclusionRecord struct {
	SubscriberEmail string
	RuleClass       string // consent | suppression | policy
	RuleReason      string
	Purpose         string
	DestinationType string
	// ConsentEventID is a soft link to consent_events.id; nil for
	// suppression/policy exclusions. Reserved for a follow-up that
	// resolves the nearest consent action — the v1 firewall leaves it nil
	// and the receipt CSV renders an empty cell, never a fabricated id.
	ConsentEventID *int64
}

// Filter is the firewall. Both dependencies are interfaces so the
// decision is unit-testable without Postgres; either may be nil
// (degraded mode — see Decide).
type Filter struct {
	Consent     ConsentBatchLookup
	Suppression SuppressionLookup
}

// New constructs a Filter. Passing nil for either dependency is allowed:
// see Decide for the degraded-mode contract.
func New(c ConsentBatchLookup, s SuppressionLookup) *Filter {
	return &Filter{Consent: c, Suppression: s}
}

// Decision is the outcome of one Decide call.
type Decision struct {
	// Kept is the subset of input emails that passed both gates, in input
	// order, de-duplicated and lowercased.
	Kept []string
	// Excluded is one record per withheld profile.
	Excluded []ExclusionRecord
}

// Decide is the PURE core: given a list of emails and the resolved
// purpose + destination type, it returns the kept/excluded partition.
//
// Behaviour:
//   - Empty input → empty Decision, no lookups, no records.
//   - Degraded mode: a nil *Filter, or a nil Consent dependency, returns
//     all members as KEPT with NO exclusions (the firewall is "not
//     configured" — main.go logs a startup warning when it wires nil).
//     This is distinct from a LOOKUP ERROR, which is fail-DENY.
//   - Suppression is evaluated first (precedence). A suppressed member is
//     excluded with rule_class='suppression', rule_reason = the
//     suppression Reason. A nil Suppression dependency means "no
//     suppression gate" (suppression is best-effort defence-in-depth on
//     top of consent); a suppression LOOKUP ERROR is logged-equivalent
//     and treated as "no suppressions found" so the consent gate still
//     runs (consent is the load-bearing gate here).
//   - Consent is evaluated for every non-suppressed member. A consent
//     LOOKUP ERROR is FAIL-DENY: every non-suppressed member is excluded
//     with rule_class='policy', rule_reason='consent_lookup_unavailable'.
//   - A non-consented member is excluded with rule_class='consent',
//     rule_reason='consent_<column> null'.
func (f *Filter) Decide(ctx context.Context, tenantID string, purpose consent.Purpose, destType string, emails []string) Decision {
	dec := Decision{Kept: []string{}, Excluded: []ExclusionRecord{}}
	norm := normalizeEmails(emails)
	if len(norm) == 0 {
		return dec
	}
	// Degraded mode: firewall not configured → pass everything through.
	if f == nil || f.Consent == nil {
		dec.Kept = norm
		return dec
	}

	purposeStr := string(purpose)

	// 1. Suppression first (precedence). Best-effort: an error here does
	//    NOT fail-deny — consent is the load-bearing gate. A nil
	//    dependency means no suppression gate.
	suppressed := map[string]*suppressions.Entry{}
	if f.Suppression != nil {
		if m, err := f.Suppression.LookupBulk(ctx, tenantID, norm, suppressions.ChannelEmail, suppressions.ScopeMarketing); err == nil {
			suppressed = m
		}
	}

	// 2. Consent for the non-suppressed remainder. FAIL-DENY on error.
	remainder := make([]string, 0, len(norm))
	for _, e := range norm {
		if _, hit := suppressed[e]; !hit {
			remainder = append(remainder, e)
		}
	}
	var consentMap map[string]bool
	consentFailed := false
	if len(remainder) > 0 {
		m, err := f.Consent.AllowedBatch(ctx, tenantID, remainder, purposeStr)
		if err != nil {
			consentFailed = true
		} else {
			consentMap = m
		}
	}

	for _, e := range norm {
		if entry, hit := suppressed[e]; hit {
			dec.Excluded = append(dec.Excluded, ExclusionRecord{
				SubscriberEmail: e,
				RuleClass:       RuleClassSuppression,
				RuleReason:      suppressionReason(entry),
				Purpose:         purposeStr,
				DestinationType: destType,
			})
			continue
		}
		if consentFailed {
			// Fail-deny: lookup unavailable → withhold, don't leak.
			dec.Excluded = append(dec.Excluded, ExclusionRecord{
				SubscriberEmail: e,
				RuleClass:       RuleClassPolicy,
				RuleReason:      ReasonConsentLookupUnavailable,
				Purpose:         purposeStr,
				DestinationType: destType,
			})
			continue
		}
		// Absent key in a successful batch map = not consented (the batch
		// lookup only returns rows it found; the firewall treats absence
		// as "no recorded grant" → exclude).
		if allowed := consentMap[e]; !allowed {
			dec.Excluded = append(dec.Excluded, ExclusionRecord{
				SubscriberEmail: e,
				RuleClass:       RuleClassConsent,
				RuleReason:      consentReason(purpose),
				Purpose:         purposeStr,
				DestinationType: destType,
			})
			continue
		}
		dec.Kept = append(dec.Kept, e)
	}
	return dec
}

// suppressionReason returns the verbatim suppression Reason string for a
// receipt, or a safe fallback when the entry is nil/blank.
func suppressionReason(e *suppressions.Entry) string {
	if e == nil || strings.TrimSpace(string(e.Reason)) == "" {
		return "suppressed"
	}
	return string(e.Reason)
}

// consentReason produces the rule_reason for a missing per-purpose
// consent grant, naming the subscribers column the gate read so an
// auditor can trace it: e.g. "consent_targeted_ads_at null".
func consentReason(p consent.Purpose) string {
	col := consentColumnForPurpose(p)
	if col == "" {
		return "consent_" + string(p) + " null"
	}
	return col + " null"
}

// consentColumnForPurpose mirrors consent.columnForPurpose (unexported
// there) so the receipt names the exact column without exporting
// internals from the consent package.
func consentColumnForPurpose(p consent.Purpose) string {
	switch p {
	case consent.PurposeEmailMarketing:
		return "consent_email_marketing_at"
	case consent.PurposeSMSMarketing:
		return "consent_sms_marketing_at"
	case consent.PurposeProfiling:
		return "consent_profiling_at"
	case consent.PurposeTargetedAds:
		return "consent_targeted_ads_at"
	case consent.PurposeAIProcessing:
		return "consent_ai_processing_at"
	}
	return ""
}

// normalizeEmails lowercases, trims, drops blanks, and de-duplicates
// while preserving first-seen order.
func normalizeEmails(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, e := range in {
		k := strings.ToLower(strings.TrimSpace(e))
		if k == "" {
			continue
		}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	return out
}
