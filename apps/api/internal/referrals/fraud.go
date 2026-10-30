// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// freemailDomains is the seed list of throwaway / freemail providers
// that contribute to a higher fraud score. Not exhaustive — meant as
// a cheap first signal. Real abuse needs the full Spamhaus DBL.
var freemailDomains = map[string]struct{}{
	"mailinator.com":    {},
	"guerrillamail.com": {},
	"10minutemail.com":  {},
	"tempmail.com":      {},
	"temp-mail.org":     {},
	"trashmail.com":     {},
	"sharklasers.com":   {},
	"yopmail.com":       {},
	"throwawaymail.com": {},
	"dispostable.com":   {},
}

// computeFraudScore returns a 0..1 score for a candidate conversion.
// Higher = more suspect. Components (each adds a fraction):
//
//   - Same IP referred multiple times by this referrer in last 7 days: +0.5
//   - Throwaway / freemail domain on the referee email: +0.3
//     (we can't see the email here yet — left as a hook for PR 4)
//   - Self-referral (referrer == referee subscriber id): +1.0 (cap at 1.0)
//   - IP missing: +0.0 (don't penalise — many setups can't capture it)
//
// Pure read; never writes. Returns (score, _) for symmetry with
// future heuristics that may want to surface the breakdown.
func (r *Repo) computeFraudScore(ctx context.Context, tenantID, referrerID, refereeID, refereeIP string) (float64, error) {
	score := 0.0
	if strings.TrimSpace(referrerID) != "" && referrerID == strings.TrimSpace(refereeID) {
		score = 1.0
	}

	if score < 1 && refereeIP != "" {
		tx, err := db.WithTenant(ctx, r.Pool, tenantID)
		if err == nil {
			defer func() { _ = tx.Rollback(ctx) }()
			var seen int
			_ = tx.QueryRow(ctx, `
SELECT count(*)::int FROM referral_conversions
WHERE referrer_subscriber_id = $1
  AND referee_ip = $2
  AND created_at >= now() - interval '7 days'`,
				referrerID, refereeIP,
			).Scan(&seen)
			if seen >= 1 {
				score += 0.5
			}
			_ = tx.Commit(ctx)
		}
	}

	return clampUnit(score), nil
}

// IsFreemailDomain returns true when the given email's domain
// appears in the throwaway list. Exposed for callers that have the
// referee email (signup form) and want to add their own +score.
func IsFreemailDomain(email string) bool {
	at := strings.LastIndexByte(email, '@')
	if at < 0 || at == len(email)-1 {
		return false
	}
	domain := strings.ToLower(email[at+1:])
	_, ok := freemailDomains[domain]
	return ok
}

func clampUnit(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
