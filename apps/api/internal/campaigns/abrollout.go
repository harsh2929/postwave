// SPDX-License-Identifier: AGPL-3.0-only
//
// abrollout.go — implements abtests.RolloutCreator. When the
// auto-promotion scheduler decides an A/B test winner AND sample_pct
// was < 100, this creates a "rollout" child campaign whose content
// matches the winning variant and whose audience is the held-back
// remainder. Inserted into the same campaigns table the original
// children went into so the existing sending pipeline picks it up
// automatically.
//
// The held-back audience is computed deterministically using the
// same fnv-1a hash as ApplyABTestSplit, but with a *different*
// bucket convention: instead of N variant-modulo buckets, we use 100
// percent-buckets so we can ask "is this subscriber in the bottom
// sample_pct% or the top (100-sample_pct)%?". The original test
// targeted the bottom; the rollout targets the top. No subscriber
// receives both because the hash split is disjoint by construction.

package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"time"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// ABRolloutDeps wires the dispatcher's collaborators. The dispatcher
// is tiny — it only needs the campaigns Repo + the abtests Repo so it
// can re-read the winning variant's subject/body — but those repos
// already exist in main.go's wiring graph.
type ABRolloutDeps struct {
	Repo           *Repo
	ABRepo         *abtests.Repo
	Pool           *db.Pool
	RuntimeEnabled bool
}

// CreateRollout creates the second-phase campaign for the held-back
// audience and queues it. Returns the new campaign id so the abtests
// scheduler can persist it onto campaign_ab_settings.winner_rollout_campaign_id.
//
// Implementation notes:
//
//   - The new campaign inherits the parent's audience (segment_id) +
//     all metadata, overriding only subject + body from the winning
//     variant.
//   - delivery_settings.ab_test_rollout marks the row so the queue
//     dispatcher knows to apply the held-back filter (the dispatch
//     code reads `ab_test_rollout.parent_id` + `.sample_pct` to
//     compute the excluded buckets).
//   - status starts as `StatusScheduled` with scheduled_at = now() so
//     the existing send-loop picks it up on its next tick. We don't
//     dispatch synchronously — the rollout is best-effort additional
//     send, never block the scheduler.
func (d *ABRolloutDeps) CreateRollout(ctx context.Context, in abtests.RolloutInput) (string, error) {
	// Check policy before touching either repository. Auto-rollout materializes
	// status=scheduled state and therefore shares the scheduler's compile-time
	// recovery qualification plus explicit runtime opt-ins.
	runtimeEnabled := d != nil && d.RuntimeEnabled
	if err := campaigndispatch.CheckScheduledMaterialization(runtimeEnabled); err != nil {
		return "", err
	}
	if d == nil || d.Repo == nil || d.ABRepo == nil {
		return "", errors.New("abrollout: deps not wired")
	}
	parent, err := d.Repo.Get(ctx, in.TenantID, in.ParentCampaignID)
	if err != nil {
		return "", fmt.Errorf("load parent campaign: %w", err)
	}
	variants, err := d.ABRepo.ListVariants(ctx, in.TenantID, in.ParentCampaignID)
	if err != nil {
		return "", fmt.Errorf("load variants: %w", err)
	}
	var winner *abtests.Variant
	for i := range variants {
		if variants[i].ID == in.WinningVariantID {
			winner = &variants[i]
			break
		}
	}
	if winner == nil {
		return "", fmt.Errorf("winning variant %s not found", in.WinningVariantID)
	}

	// Build the new campaign — inherits parent + winning variant.
	now := time.Now().UTC()
	delivery := map[string]any{
		"ab_test_rollout": map[string]any{
			"parent_id":          in.ParentCampaignID,
			"winning_variant_id": in.WinningVariantID,
			"sample_pct":         in.SamplePct,
			"created_at":         now.Format(time.RFC3339),
		},
	}
	// Preserve any unrelated parent delivery settings (e.g. send_window).
	if parent.DeliverySettings != nil {
		for k, v := range parent.DeliverySettings {
			if k == "ab_test" {
				continue // strip the parent's variant-test marker
			}
			if _, exists := delivery[k]; !exists {
				delivery[k] = v
			}
		}
	}
	if winner.FromEmail != "" {
		delivery["from_email"] = winner.FromEmail
	}
	_ = json.Marshal // imported for symmetry with sibling files

	subject := winner.Subject
	if subject == "" {
		subject = parent.Subject
	}
	bodyHTML := winner.BodyHTML
	if bodyHTML == "" {
		bodyHTML = parent.BodyHTML
	}
	bodyMJML := winner.BodyMJML
	if bodyMJML == "" {
		bodyMJML = parent.BodyMJML
	}
	fromName := winner.FromName
	if fromName == "" {
		fromName = parent.FromName
	}

	in2 := CreateInput{
		Name:             fmt.Sprintf("%s · winner rollout", parent.Name),
		Subject:          subject,
		BodyHTML:         bodyHTML,
		BodyMJML:         bodyMJML,
		SegmentID:        parent.SegmentID,
		ScheduledAt:      &now,
		CampaignType:     parent.CampaignType,
		EditorMode:       parent.EditorMode,
		PreviewText:      parent.PreviewText,
		PlainText:        parent.PlainText,
		FromName:         fromName,
		ReplyTo:          parent.ReplyTo,
		ContentBlocks:    parent.ContentBlocks,
		TrackingSettings: parent.TrackingSettings,
		DeliverySettings: delivery,
	}
	child, err := d.Repo.Create(ctx, in.TenantID, in2)
	if err != nil {
		return "", fmt.Errorf("insert child campaign: %w", err)
	}
	return child.ID, nil
}

// ApplyABRolloutHeldBack filters `emails` down to the held-back
// audience — the subscribers whose fnv-1a hash bucket lies in the
// upper [samplePct, 100) range. Deterministic and disjoint from the
// original ApplyABTestSplit output for the same parent: the original
// test put subscribers in buckets [0, samplePct); the rollout
// targets [samplePct, 100). No subscriber receives both phases.
//
// Returns the input unchanged when sample_pct is 100 (no held-back
// audience) or parentID is empty (defensive).
func ApplyABRolloutHeldBack(parentID string, samplePct float64, emails []string) []string {
	if parentID == "" || samplePct >= 100 || samplePct <= 0 {
		return nil
	}
	threshold := int(samplePct) // floor — matches percent-bucket semantics
	out := make([]string, 0, len(emails))
	for _, e := range emails {
		if percentBucket(parentID, e) >= threshold {
			out = append(out, e)
		}
	}
	return out
}

// percentBucket returns 0..99 — a deterministic per-subscriber slot
// derived from the same hash family as abVariantBucket. Splitting on
// 100 buckets (rather than N variant buckets) lets us cleanly carve
// the test/holdback partition by percent.
func percentBucket(parentID, email string) int {
	h := fnv.New64a()
	_, _ = h.Write([]byte(parentID))
	_, _ = h.Write([]byte{':'})
	_, _ = h.Write([]byte(email))
	return int(h.Sum64() % 100)
}

// ParseABRolloutConfig extracts the (parent_id, sample_pct) pair
// from a campaign's delivery_settings.ab_test_rollout block. Returns
// ok=false when the block is missing or malformed — caller treats
// that as "this is not a rollout campaign, send to the full audience".
//
// Wire shape (set by ABRolloutDeps.CreateRollout):
//
//	delivery_settings: {
//	  ab_test_rollout: {
//	    parent_id:          "<uuid>",
//	    winning_variant_id: "<uuid>",
//	    sample_pct:         30,
//	    created_at:         "2026-05-26T..."
//	  }
//	}
func ParseABRolloutConfig(delivery map[string]any) (parentID string, samplePct float64, ok bool) {
	if delivery == nil {
		return "", 0, false
	}
	raw, exists := delivery["ab_test_rollout"]
	if !exists {
		return "", 0, false
	}
	m, isMap := raw.(map[string]any)
	if !isMap {
		return "", 0, false
	}
	pid, _ := m["parent_id"].(string)
	if pid == "" {
		return "", 0, false
	}
	// sample_pct may arrive as float64 (json.Unmarshal default) or
	// int (when the dispatcher serialised from an integer column).
	switch v := m["sample_pct"].(type) {
	case float64:
		samplePct = v
	case int:
		samplePct = float64(v)
	case int64:
		samplePct = float64(v)
	default:
		return "", 0, false
	}
	if samplePct <= 0 || samplePct >= 100 {
		return "", 0, false
	}
	return pid, samplePct, true
}
