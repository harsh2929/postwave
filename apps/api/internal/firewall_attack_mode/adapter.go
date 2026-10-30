// SPDX-License-Identifier: AGPL-3.0-only

package firewall_attack_mode

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Adapter wraps a *db.Pool to satisfy the forms.FirewallScorer
// interface. We keep this in a separate file from
// firewall_attack_mode.go so the adapter doesn't bloat the file the
// scorer + HTTP surface live in.
//
// Wiring (main.go):
//
//	formsDeps.Firewall = &firewall_attack_mode.Adapter{Pool: pool}
type Adapter struct {
	Pool *db.Pool
}

// ScoreAndMaybeReject runs the four-signal scorer, records an audit
// row, and (when attack mode is on AND the score crosses the
// tenant's threshold) returns reject=true. Best-effort throughout:
// any DB hiccup falls open (accept) so a misconfigured firewall row
// never blocks legitimate signups.
func (a *Adapter) ScoreAndMaybeReject(ctx context.Context, tenantID, formID, ip, userAgent, referer string, browserFPPresent bool) (bool, int) {
	if a == nil || a.Pool == nil || tenantID == "" {
		return false, 0
	}
	// Load settings; lazy-create on first call so a tenant who has
	// never visited the admin page still gets observation-mode
	// auditing.
	s, err := GetOrCreateSettings(ctx, a.Pool, tenantID)
	if err != nil {
		return false, 0
	}
	// Pull the per-IP rate (best effort — 0 on error).
	rate, _ := RateForIP(ctx, a.Pool, tenantID, ip)
	res := Score(SignupInput{
		BrowserFPPresent:    browserFPPresent,
		UserAgent:           userAgent,
		Referer:             referer,
		IP:                  ip,
		Rate5m:              rate,
		FingerprintRequired: s.FingerprintRequired,
	})
	action := "observed"
	reject := false
	if s.AttackModeEnabled && res.RiskScore >= s.AttackModeThreshold {
		action = "rejected"
		reject = true
	} else if s.AttackModeEnabled {
		action = "accepted"
	}
	_ = RecordEvent(ctx, a.Pool, tenantID, formID, SignupInput{
		BrowserFPPresent: browserFPPresent,
		UserAgent:        userAgent,
		Referer:          referer,
		IP:               ip,
		Rate5m:           rate,
	}, res, action)
	return reject, res.RiskScore
}
