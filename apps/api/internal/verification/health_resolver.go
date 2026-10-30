// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"sort"
	"strings"
	"time"
)

const (
	HealthModelVersion          = "postwave-email-health-v1"
	HealthVerificationFreshness = 30 * 24 * time.Hour
	HealthPositiveFreshness     = 90 * 24 * time.Hour
	// HealthSoftNegativeFreshness is the recovery window for historical
	// mailbox-negative evidence. It applies to both hard and soft bounces;
	// active suppressions remain authoritative through HealthInput.HardStop.
	HealthSoftNegativeFreshness = 30 * 24 * time.Hour
	healthFutureClockTolerance  = 5 * time.Minute
)

type HealthGrade string

const (
	HealthGradeA HealthGrade = "A"
	HealthGradeB HealthGrade = "B"
	HealthGradeC HealthGrade = "C"
	HealthGradeD HealthGrade = "D"
	HealthGradeF HealthGrade = "F"
	HealthGradeU HealthGrade = "U"
)

func (g HealthGrade) Valid() bool {
	switch g {
	case HealthGradeA, HealthGradeB, HealthGradeC, HealthGradeD, HealthGradeF, HealthGradeU:
		return true
	default:
		return false
	}
}

type HealthRecommendation string

const (
	HealthRecommendationSend      HealthRecommendation = "send"
	HealthRecommendationCaution   HealthRecommendation = "caution"
	HealthRecommendationDoNotSend HealthRecommendation = "do_not_send"
	HealthRecommendationBlocked   HealthRecommendation = "blocked"
)

type HealthEvidenceKind string

const (
	HealthEvidenceHardBounce        HealthEvidenceKind = "hard_bounce"
	HealthEvidenceComplaint         HealthEvidenceKind = "complaint"
	HealthEvidenceSoftBounce        HealthEvidenceKind = "soft_bounce"
	HealthEvidenceAmbiguousNegative HealthEvidenceKind = "ambiguous_negative"
	HealthEvidenceVendorActivity    HealthEvidenceKind = "vendor_activity"
	HealthEvidenceReply             HealthEvidenceKind = "reply"
	HealthEvidenceClick             HealthEvidenceKind = "click"
	HealthEvidenceDelivered         HealthEvidenceKind = "delivered"
	HealthEvidenceOpen              HealthEvidenceKind = "open"
	// HealthEvidenceHardStop carries consent/suppression chronology without
	// pretending that an unsubscribe is a bounce. HardStop remains the
	// authoritative boolean used by the resolver.
	HealthEvidenceHardStop HealthEvidenceKind = "hard_stop"
)

type HealthEvidence struct {
	Kind       HealthEvidenceKind `json:"kind"`
	At         time.Time          `json:"at"`
	Source     string             `json:"source"`
	ReasonCode string             `json:"reason_code"`
}

// HealthInput is intentionally source-neutral. Persistence code translates
// tenant ledgers into these normalized, public-safe facts; this resolver owns
// only deterministic policy.
type HealthInput struct {
	Email               string
	AsOf                time.Time
	Verification        *Result
	Evidence            []HealthEvidence
	HardStop            bool
	HardStopReasonCodes []string
}

type EmailHealth struct {
	Email          string               `json:"email"`
	Grade          HealthGrade          `json:"grade"`
	Recommendation HealthRecommendation `json:"recommendation"`
	HardStop       bool                 `json:"hard_stop"`
	SendEligible   bool                 `json:"send_eligible"`
	ReasonCodes    []string             `json:"reason_codes"`
	Evidence       []HealthEvidence     `json:"evidence"`
	EvidenceAt     *time.Time           `json:"evidence_at,omitempty"`
	Status         Status               `json:"status,omitempty"`
	Score          *int                 `json:"score,omitempty"`
	Provider       string               `json:"provider,omitempty"`
	CheckedAt      *time.Time           `json:"checked_at,omitempty"`
	ModelVersion   string               `json:"model_version"`
	ComputedAt     time.Time            `json:"computed_at"`
	// EvidenceComplete is false only on the verification response fallback
	// used when the tenant evidence read is unavailable. In that state
	// SendEligible is always false; callers must not mistake missing evidence
	// for a clear recipient.
	EvidenceComplete bool `json:"evidence_complete"`
}

// AttachHealth annotates verification results by normalized address while
// preserving their original order. Results without a matching derived grade
// remain valid backwards-compatible verification payloads.
func AttachHealth(results []Result, health []EmailHealth) []Result {
	byEmail := make(map[string]EmailHealth, len(health))
	for _, item := range health {
		byEmail[NormalizeEmail(item.Email)] = item
	}
	for i := range results {
		if item, ok := byEmail[NormalizeEmail(results[i].Email)]; ok {
			value := item
			results[i].Health = &value
		}
	}
	return results
}

// ResolveEmailHealth applies postwave-email-health-v1.
//
// Provider hard-invalid verdicts and complaints are terminal. Historical hard
// and soft bounces are recoverable negatives: they remain D for 30 days unless
// genuinely later high-confidence positive activity retires them. Consent and
// active suppressions are different: HardStop always forces a blocked
// recommendation, regardless of any grade-like evidence.
func ResolveEmailHealth(input HealthInput) EmailHealth {
	asOf := input.AsOf.UTC()
	if asOf.IsZero() {
		asOf = time.Now().UTC()
	}

	result := EmailHealth{
		Email: NormalizeEmail(input.Email), HardStop: input.HardStop,
		ModelVersion: HealthModelVersion, ComputedAt: asOf,
		Evidence:         normalizedHealthEvidence(input.Evidence, asOf),
		ReasonCodes:      make([]string, 0, len(input.HardStopReasonCodes)+2),
		EvidenceComplete: true,
	}
	result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, input.HardStopReasonCodes...)
	if input.Verification != nil {
		result.Status = input.Verification.Status
		result.Score = input.Verification.Score
		result.Provider = input.Verification.Provider
		if !input.Verification.CheckedAt.IsZero() {
			checkedAt := input.Verification.CheckedAt.UTC()
			result.CheckedAt = &checkedAt
			result.EvidenceAt = &checkedAt
		}
	}

	summary := summarizeHealthEvidence(&result, asOf)
	latestComplaint, latestNegative, latestPositive := summary.latestComplaint, summary.latestNegative, summary.latestPositive
	complaintCode, negativeCode, positiveCode := summary.complaintCode, summary.negativeCode, summary.positiveCode
	hasOpen, hasVendorActivity := summary.hasOpen, summary.hasVendorActivity

	verificationHard := false
	var freshValidAt time.Time
	if input.Verification != nil {
		switch input.Verification.Status {
		case StatusInvalid, StatusSpamtrap, StatusAbuse, StatusDoNotMail:
			verificationHard = true
		case StatusValid:
			if trustedMailboxVerificationProvider(input.Verification.Provider) &&
				healthWithin(input.Verification.CheckedAt, asOf, HealthVerificationFreshness) {
				freshValidAt = input.Verification.CheckedAt.UTC()
			}
		}
	}
	latestTrustedPositive := latestPositive
	if freshValidAt.After(latestTrustedPositive) {
		latestTrustedPositive = freshValidAt
	}

	switch {
	case input.HardStop && recoverableNegativeHardStopOnly(input.HardStopReasonCodes) &&
		!latestNegative.IsZero() && latestComplaint.IsZero() && !verificationHard:
		// An active temporary soft-bounce suppression keeps its D semantics,
		// but the independent hard-stop override changes the recommendation
		// from do_not_send to blocked below.
		result.Grade = HealthGradeD
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, negativeCode)
	case input.HardStop:
		result.Grade = HealthGradeF
		if len(result.ReasonCodes) == 0 {
			result.ReasonCodes = append(result.ReasonCodes, "active_send_hard_stop")
		}
	case verificationHard:
		result.Grade = HealthGradeF
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes,
			"verification_"+string(input.Verification.Status))
	case !latestComplaint.IsZero():
		result.Grade = HealthGradeF
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, complaintCode)
	case !latestNegative.IsZero() && (latestTrustedPositive.IsZero() || !latestNegative.Before(latestTrustedPositive)):
		result.Grade = HealthGradeD
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, negativeCode)
	case !freshValidAt.IsZero() && (latestNegative.IsZero() || freshValidAt.After(latestNegative)):
		result.Grade = HealthGradeA
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "verification_valid_30d")
	case !latestPositive.IsZero() && (latestNegative.IsZero() || latestPositive.After(latestNegative)):
		result.Grade = HealthGradeB
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, positiveCode)
	case input.Verification != nil && input.Verification.Status == StatusCatchAll &&
		trustedMailboxVerificationProvider(input.Verification.Provider):
		result.Grade = HealthGradeC
		result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "verification_catch_all")
	default:
		result.Grade = HealthGradeU
		switch {
		case input.Verification != nil && input.Verification.Status == StatusValid:
			if trustedMailboxVerificationProvider(input.Verification.Provider) {
				result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "verification_stale")
			} else {
				result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "verification_untrusted_provider")
			}
		case input.Verification != nil && input.Verification.Status == StatusCatchAll:
			result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "verification_untrusted_provider")
		case hasVendorActivity:
			result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "vendor_activity_not_trusted")
		case hasOpen:
			result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "open_not_high_confidence")
		default:
			result.ReasonCodes = appendUniqueHealthCodes(result.ReasonCodes, "no_decisive_evidence")
		}
	}

	result.Recommendation = healthRecommendation(result.Grade)
	if result.HardStop {
		result.Recommendation = HealthRecommendationBlocked
	}
	result.SendEligible = !result.HardStop &&
		result.Grade != HealthGradeD && result.Grade != HealthGradeF
	return result
}

// healthEvidenceSummary is the per-class rollup ResolveEmailHealth grades
// from: the freshest complaint, recoverable negative, and high-confidence
// positive (with the reason code of each), plus the advisory-only signals.
type healthEvidenceSummary struct {
	latestComplaint, latestNegative, latestPositive time.Time
	complaintCode, negativeCode, positiveCode       string
	hasOpen, hasVendorActivity                      bool
}

// summarizeHealthEvidence walks the normalized evidence once, advancing the
// result's EvidenceAt high-water mark and keeping the freshest in-window item
// per evidence class. Open and vendor-activity evidence is noted but never
// graded (see the case comments).
func summarizeHealthEvidence(result *EmailHealth, asOf time.Time) healthEvidenceSummary {
	var latestComplaint, latestNegative, latestPositive time.Time
	var complaintCode, negativeCode, positiveCode string
	hasOpen, hasVendorActivity := false, false
	for _, evidence := range result.Evidence {
		if result.EvidenceAt == nil || evidence.At.After(*result.EvidenceAt) {
			evidenceAt := evidence.At
			result.EvidenceAt = &evidenceAt
		}
		code := evidence.ReasonCode
		if code == "" {
			code = "evidence_" + string(evidence.Kind)
		}
		switch evidence.Kind {
		case HealthEvidenceComplaint:
			if evidence.At.After(latestComplaint) {
				latestComplaint, complaintCode = evidence.At, code
			}
		case HealthEvidenceHardBounce, HealthEvidenceSoftBounce, HealthEvidenceAmbiguousNegative:
			if healthWithin(evidence.At, asOf, HealthSoftNegativeFreshness) && evidence.At.After(latestNegative) {
				latestNegative, negativeCode = evidence.At, code
			}
		case HealthEvidenceReply, HealthEvidenceClick, HealthEvidenceDelivered:
			if healthWithin(evidence.At, asOf, HealthPositiveFreshness) && evidence.At.After(latestPositive) {
				latestPositive, positiveCode = evidence.At, code
			}
		case HealthEvidenceVendorActivity:
			// The wire vocabulary reserves this evidence kind, but no reviewed
			// vendor activity feed is trusted to prove human/mailbox activity yet.
			// Keep it visible and advisory without allowing it to manufacture B or
			// retire a known negative.
			hasVendorActivity = true
		case HealthEvidenceOpen:
			hasOpen = true
		}
	}
	return healthEvidenceSummary{
		latestComplaint: latestComplaint, latestNegative: latestNegative, latestPositive: latestPositive,
		complaintCode: complaintCode, negativeCode: negativeCode, positiveCode: positiveCode,
		hasOpen: hasOpen, hasVendorActivity: hasVendorActivity,
	}
}

// trustedMailboxVerificationProvider is deliberately exact. Provider names
// are persisted contract identifiers; trimming or case-folding malformed
// legacy values would turn them into affirmative mailbox evidence.
func trustedMailboxVerificationProvider(provider string) bool {
	return provider == ProviderZeroBounce || provider == ProviderKickbox
}

// recoverableNegativeHardStopOnly distinguishes an active temporary bounce
// suppression from consent, complaint, manual, and permanent suppression
// authority. Only the former keeps the D letter while its recommendation is
// upgraded to blocked; every other active hard stop is F.
func recoverableNegativeHardStopOnly(codes []string) bool {
	if len(codes) == 0 {
		return false
	}
	for _, code := range codes {
		switch safeHealthCode(code) {
		case "suppression_soft_bounce", "suppression_soft_bounce_threshold":
		default:
			return false
		}
	}
	return true
}

// UnavailableEmailHealth is a fail-closed annotation for a verification that
// succeeded while the tenant evidence read failed. It deliberately does not
// infer A/F from the provider result because consent and suppressions remain
// authoritative and were not proven clear.
func UnavailableEmailHealth(email string, result Result, asOf time.Time) EmailHealth {
	if asOf.IsZero() {
		asOf = time.Now().UTC()
	}
	fallback := EmailHealth{
		Email: NormalizeEmail(email), Grade: HealthGradeU,
		Recommendation: HealthRecommendationCaution,
		SendEligible:   false, ReasonCodes: []string{"health_evidence_unavailable"},
		Evidence: []HealthEvidence{}, Status: result.Status, Score: result.Score,
		Provider:     result.Provider,
		ModelVersion: HealthModelVersion, ComputedAt: asOf.UTC(),
		EvidenceComplete: false,
	}
	if !result.CheckedAt.IsZero() {
		checkedAt := result.CheckedAt.UTC()
		fallback.CheckedAt = &checkedAt
	}
	return fallback
}

func healthRecommendation(grade HealthGrade) HealthRecommendation {
	switch grade {
	case HealthGradeA, HealthGradeB:
		return HealthRecommendationSend
	case HealthGradeD:
		return HealthRecommendationDoNotSend
	case HealthGradeF:
		return HealthRecommendationBlocked
	default:
		return HealthRecommendationCaution
	}
}

func healthWithin(at, asOf time.Time, window time.Duration) bool {
	if at.IsZero() || at.After(asOf.Add(healthFutureClockTolerance)) {
		return false
	}
	return !at.Before(asOf.Add(-window))
}

func normalizedHealthEvidence(in []HealthEvidence, asOf time.Time) []HealthEvidence {
	out := make([]HealthEvidence, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, evidence := range in {
		evidence.At = evidence.At.UTC()
		evidence.Source = strings.TrimSpace(evidence.Source)
		evidence.ReasonCode = safeHealthCode(evidence.ReasonCode)
		if evidence.Kind == "" || evidence.At.IsZero() || evidence.At.After(asOf.Add(healthFutureClockTolerance)) {
			continue
		}
		key := string(evidence.Kind) + "\x00" + evidence.At.Format(time.RFC3339Nano) + "\x00" +
			evidence.Source + "\x00" + evidence.ReasonCode
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, evidence)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.After(out[j].At)
		}
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return out[i].ReasonCode < out[j].ReasonCode
	})
	return out
}

func appendUniqueHealthCodes(dst []string, codes ...string) []string {
	seen := make(map[string]struct{}, len(dst)+len(codes))
	for _, code := range dst {
		if normalized := safeHealthCode(code); normalized != "" {
			seen[normalized] = struct{}{}
		}
	}
	for _, code := range codes {
		code = safeHealthCode(code)
		if code == "" {
			continue
		}
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}
		dst = append(dst, code)
	}
	return dst
}

func safeHealthCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return strings.Trim(b.String(), "_-")
}
