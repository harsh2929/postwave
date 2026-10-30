// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"fmt"
	"strings"
)

// MergeTags is the per-subscriber bag a campaign / template editor
// should add to its merge.Context. Refined Referrals PR 2.
//
// Resulting top-level merge tags (all under "referral"):
//
//	{{ referral.share_url }}    /api/public/r/xa9k2m
//	{{ referral.ref_code }}     xa9k2m  (or branded code when set)
//	{{ referral.count }}        7
//	{{ referral.progress }}     "7 of 10 to unlock Hoodie"
//	{{ referral.next_label }}   "Hoodie"   (empty if everything unlocked)
//	{{ referral.next_count }}   10         (0 if everything unlocked)
//
// Pure value object — no HTTP, no mutation. Caller calls
// BuildMergeTags + merges into their merge.Context's Vars["referral"].
type MergeTags struct {
	ShareURL  string `json:"share_url"`
	RefCode   string `json:"ref_code"`
	Count     int    `json:"count"`
	Progress  string `json:"progress"`
	NextLabel string `json:"next_label"`
	NextCount int    `json:"next_count"`
}

// AsMap returns a map[string]any suitable for direct insertion into
// merge.Context — `ctx.Vars["referral"] = tags.AsMap()`.
func (t MergeTags) AsMap() map[string]any {
	return map[string]any{
		"share_url":  t.ShareURL,
		"ref_code":   t.RefCode,
		"count":      t.Count,
		"progress":   t.Progress,
		"next_label": t.NextLabel,
		"next_count": t.NextCount,
	}
}

// BuildMergeTags is the helper a campaign-render path calls just
// before merging. Pulls (or mints) the subscriber's ref code, counts
// their referrals, computes "next milestone" progress, and returns
// the bag.
//
// Returns the zero-value tags when the tenant has no active program
// or is expired — the renderer can still substitute the keys (they
// just render as empty strings).
func (r *Repo) BuildMergeTags(ctx context.Context, tenantID, subscriberID, shareBaseURL string) (MergeTags, error) {
	tags := MergeTags{}
	code, err := r.EnsureCode(ctx, tenantID, subscriberID)
	if err != nil {
		return tags, err
	}
	// Branded code overrides the random one for the public-facing URL.
	branded, _ := r.brandedCode(ctx, tenantID, subscriberID)
	displayCode := code
	if branded != "" {
		displayCode = branded
	}
	base := shareBaseURL
	if base == "" {
		base = "/api/public"
	}
	tags.RefCode = displayCode
	tags.ShareURL = strings.TrimRight(base, "/") + "/r/" + displayCode

	count, _ := r.CountReferrals(ctx, tenantID, subscriberID)
	tags.Count = count

	prog, _ := r.GetActiveProgram(ctx, tenantID)
	if prog == nil {
		tags.Progress = ""
		return tags, nil
	}
	// Find the smallest milestone still ahead of the user.
	var next *Milestone
	for i := range prog.Milestones {
		m := prog.Milestones[i]
		if m.Count > count {
			if next == nil || m.Count < next.Count {
				next = &m
			}
		}
	}
	if next == nil {
		tags.Progress = "All milestones unlocked"
		return tags, nil
	}
	tags.NextLabel = next.RewardLabel
	tags.NextCount = next.Count
	tags.Progress = fmt.Sprintf("%d of %d to unlock %s", count, next.Count, next.RewardLabel)
	return tags, nil
}

// brandedCode returns the desired_code for a subscriber, or "".
func (r *Repo) brandedCode(ctx context.Context, tenantID, subscriberID string) (string, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	var s *string
	err = conn.QueryRow(ctx, `
SELECT desired_code FROM referral_codes
WHERE tenant_id = $1::uuid AND subscriber_id = $2`,
		tenantID, subscriberID).Scan(&s)
	if err != nil || s == nil {
		return "", err
	}
	return *s, nil
}
