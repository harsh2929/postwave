// SPDX-License-Identifier: AGPL-3.0-only
//
// reputation.go — the reputation sub-score. Thresholds are the ones the
// mailbox providers actually enforce, and they are the same two constants
// the pre-send gate blocks on (campaigns.complaintBlockNum /
// complaintWarnNum). Score and gate must agree: it is worse than useless to
// show a passing score for a send the gate will refuse.
//
// NOTE: these thresholds previously claimed to "mirror the free-pool
// guardrails service". No such service exists — it was referenced by comment
// only, and nothing was ever auto-suspended. The 1.0% fail line inherited
// from that fiction was 3.3x above the ceiling Gmail enforces.

package eqscore

import "fmt"

const (
	// minimumReputationSends is the smallest denominator that can carry a
	// weighted reputation pillar. Smaller samples are explicitly skipped.
	minimumReputationSends int64 = 100
	// complaintRateWarn is where measurable inbox-placement harm begins.
	// Google: "user-reported spam rates greater than 0.1% have a negative
	// impact on email inbox delivery."
	complaintRateWarn = 0.0010 // 0.10%
	// complaintRateFail is the hard ceiling Gmail, Yahoo and Outlook
	// enforce. Past it, Outlook rejects at the SMTP level (550 5.7.515)
	// and the sender is ineligible for mitigation until the rate stays
	// below it for 7 consecutive days. By 1% — the old value here — the
	// sending domain is already burnt.
	complaintRateFail = 0.0030 // 0.30%
	// bounceRateWarn / bounceRateFail follow the same shape; 2% is the
	// industry "clean your list" line, 5% is where blocks start.
	bounceRateWarn = 0.020 // 2%
	bounceRateFail = 0.050 // 5%
)

func scoreReputation(s Last7dStats) SubScore {
	score := 100
	reasons := []Reason{}

	br := s.BounceRate()
	cr := s.ComplaintRate()

	switch {
	case cr >= complaintRateFail:
		score -= 50
		reasons = append(reasons, Reason{
			Code: "complaint_rate_critical", Severity: "fail", Bucket: "reputation",
			Message: fmt.Sprintf("Complaint rate is %.2f%% over the last 7 days (%d of %d sent). At or above 0.30%% Gmail, Yahoo and Outlook reject mail outright, and sending is blocked until the rate stays below 0.30%% for 7 consecutive days — stop the campaign and audit the list.", cr*100, s.Complained, s.Sent),
		})
	case cr >= complaintRateWarn:
		score -= 18
		reasons = append(reasons, Reason{
			Code: "complaint_rate_high", Severity: "warning", Bucket: "reputation",
			Message: fmt.Sprintf("Complaint rate is %.2f%% over the last 7 days. Inbox providers throttle senders above 0.10%%; review opt-in source and re-engagement frequency.", cr*100),
		})
	}

	switch {
	case br >= bounceRateFail:
		score -= 40
		reasons = append(reasons, Reason{
			Code: "bounce_rate_critical", Severity: "fail", Bucket: "reputation",
			Message: fmt.Sprintf("Bounce rate is %.1f%% over the last 7 days. At or above 5%% triggers automatic suspension — clean the list or import via verified-only flow.", br*100),
		})
	case br >= bounceRateWarn:
		score -= 12
		reasons = append(reasons, Reason{
			Code: "bounce_rate_elevated", Severity: "warning", Bucket: "reputation",
			Message: fmt.Sprintf("Bounce rate is %.1f%% over the last 7 days. Industry benchmarks expect under 2%%; consider running an address-validation pass before the next broadcast.", br*100),
		})
	}

	// Insufficient volume to score reliably. Don't surface this as a
	// reason — the dashboard handles the "needs more sends" UI from
	// the SkippedSubScores field on the parent result.
	if s.Sent < minimumReputationSends {
		score = 100 // reset; the small sample tells us nothing
		reasons = []Reason{}
	}

	return SubScore{Score: clamp(score), Reasons: reasons}
}
