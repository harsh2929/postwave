// SPDX-License-Identifier: AGPL-3.0-only
package eqscore

import (
	"context"
	"net/mail"
	"sort"
	"strings"
)

// Input is the message being scored. All fields are advisory — only
// From is strictly required (auth-alignment is meaningless without a
// sending identity); everything else degrades to "skip that
// sub-score" or "treat as zero-length."
type Input struct {
	Subject string
	HTML    string
	Text    string
	From    string
	// VerifiedDomains is the list of domains the tenant has verified
	// for sending. Auth sub-score checks that From@domain is in this
	// set. Empty list means "no verified domain" and the auth score
	// will deduct accordingly.
	VerifiedDomains []string
	// DKIMVerified / SPFVerified / DMARCAligned are pre-computed by
	// the dispatcher when it looks up the sending-domain record.
	// EQ-score does NOT do DNS resolution here.
	DKIMVerified bool
	SPFVerified  bool
	DMARCAligned bool
}

// Reputation is the seam to the per-tenant sending history. Production
// wires this to a small repo over campaign_recipients + email_events;
// tests pass a fixture.
//
// Returning (false, nil) means "no history yet" — the score should drop
// the reputation sub-score entirely.
type Reputation interface {
	Last7d(ctx context.Context, tenantID string) (stats Last7dStats, has bool, err error)
}

// Last7dStats is the rolled-up reputation slice we use.
type Last7dStats struct {
	Sent       int64
	Delivered  int64
	Bounced    int64
	Complained int64
}

// BounceRate returns Bounced/Sent or 0 when Sent is 0.
func (s Last7dStats) BounceRate() float64 {
	if s.Sent == 0 {
		return 0
	}
	return float64(s.Bounced) / float64(s.Sent)
}

// ComplaintRate returns Complained/Sent or 0 when Sent is 0.
func (s Last7dStats) ComplaintRate() float64 {
	if s.Sent == 0 {
		return 0
	}
	return float64(s.Complained) / float64(s.Sent)
}

// Reason is one specific deduction. The Code is a stable string the
// dashboard can match against to localise / link to a help page; the
// Message is the human-readable explanation.
type Reason struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Severity string `json:"severity"` // info / warning / fail
	Bucket   string `json:"bucket"`   // content / auth / reputation
}

// SubScore is one of the three pillars.
type SubScore struct {
	Score   int      `json:"score"` // 0-100
	Weight  float64  `json:"weight"`
	Reasons []Reason `json:"reasons"`
}

// Result is the full grade.
type Result struct {
	Score      int      `json:"score"` // 0-100, weighted aggregate
	Grade      string   `json:"grade"` // A+/A/B/C/D/F
	Content    SubScore `json:"content"`
	Auth       SubScore `json:"auth"`
	Reputation SubScore `json:"reputation"`
	Reasons    []Reason `json:"reasons"`          // sorted high-severity first
	Skipped    []string `json:"skippedSubScores"` // e.g. ["reputation"] when no history yet
}

// Score grades the input. tenantID may be empty when the caller
// doesn't want a reputation lookup (e.g. the editor preview). Pass
// rep=nil for the same effect.
func Score(ctx context.Context, in Input, tenantID string, rep Reputation) (Result, error) {
	content := scoreContent(in)
	auth := scoreAuth(in)

	var (
		reputation     SubScore
		repSkipped     bool
		reputationData Last7dStats
	)
	if rep != nil && tenantID != "" {
		stats, has, err := rep.Last7d(ctx, tenantID)
		if err != nil {
			// A reputation lookup error is non-fatal, but unavailable data
			// must not become a fabricated perfect pillar. Drop its weight,
			// score the two known pillars, and disclose the omission.
			repSkipped = true
			reputation = SubScore{
				Reasons: []Reason{{
					Code:     "reputation_lookup_failed",
					Severity: "info",
					Bucket:   "reputation",
					Message:  "Could not read reputation history; reputation was not included in this score.",
				}},
			}
		} else if has {
			reputation = scoreReputation(stats)
			reputationData = stats
		} else {
			repSkipped = true
		}
	} else {
		repSkipped = true
	}

	// Weights: content 40%, auth 35%, reputation 25%. When reputation
	// is dropped, content + auth absorb its weight proportionally
	// (content 53%, auth 47%) so a brand-new tenant isn't punished by
	// the absence of history.
	weights := struct{ Content, Auth, Reputation float64 }{0.40, 0.35, 0.25}
	if repSkipped {
		weights.Content = 0.40 / 0.75
		weights.Auth = 0.35 / 0.75
		weights.Reputation = 0
	}
	content.Weight = weights.Content
	auth.Weight = weights.Auth
	reputation.Weight = weights.Reputation
	if content.Reasons == nil {
		content.Reasons = []Reason{}
	}
	if auth.Reasons == nil {
		auth.Reasons = []Reason{}
	}
	if reputation.Reasons == nil {
		reputation.Reasons = []Reason{}
	}

	overall := int(float64(content.Score)*weights.Content +
		float64(auth.Score)*weights.Auth +
		float64(reputation.Score)*weights.Reputation)
	if overall > 100 {
		overall = 100
	}
	if overall < 0 {
		overall = 0
	}
	reasons := collectReasons(content, auth, reputation)
	// A weighted average must never compensate away a blocking failure. An
	// unverified sender or provider-ceiling complaint rate is still a failed
	// preflight even when the other two pillars are perfect, and persisted
	// history must not turn that condition into an A/B/C trend signal.
	if reasonsHaveSeverity(reasons, "fail") && overall >= 60 {
		overall = 59
	}

	skipped := []string{}
	if repSkipped {
		skipped = append(skipped, "reputation")
	}
	result := Result{
		Score:      overall,
		Grade:      grade(overall),
		Content:    content,
		Auth:       auth,
		Reputation: reputation,
		Reasons:    reasons,
		Skipped:    skipped,
	}
	_ = reputationData // currently unused outside scoreReputation; kept for future extension
	return result, nil
}

func reasonsHaveSeverity(reasons []Reason, severity string) bool {
	for _, reason := range reasons {
		if reason.Severity == severity {
			return true
		}
	}
	return false
}

// grade maps a numeric score to a one-letter grade. The breakpoints
// are calibrated so a "passes everything" grade rounds to A+, and a
// "missing both SPF and DKIM" grade lands in the C range — well below
// the typical block-on-send threshold (70).
func grade(score int) string {
	switch {
	case score >= 97:
		return "A+"
	case score >= 90:
		return "A"
	case score >= 80:
		return "B"
	case score >= 70:
		return "C"
	case score >= 60:
		return "D"
	default:
		return "F"
	}
}

// collectReasons rolls each sub-score's reasons into one slice, sorted
// fail-first → warning → info so the dashboard can render top-N.
func collectReasons(subs ...SubScore) []Reason {
	all := []Reason{}
	for _, s := range subs {
		all = append(all, s.Reasons...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		return sevRank(all[i].Severity) > sevRank(all[j].Severity)
	})
	return all
}

func sevRank(s string) int {
	switch s {
	case "fail":
		return 3
	case "warning":
		return 2
	case "info":
		return 1
	default:
		return 0
	}
}

// stableDomain extracts the domain part of an email address. Returns
// the input unchanged when no '@' is present so the caller can decide
// what to do.
func stableDomain(addr string) string {
	raw := strings.TrimSpace(addr)
	if parsed, err := mail.ParseAddress(raw); err == nil {
		raw = parsed.Address
	}
	at := strings.LastIndex(raw, "@")
	if at < 0 {
		return strings.ToLower(raw)
	}
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw[at+1:]), "."))
}
