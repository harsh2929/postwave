// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Send-approval gate for guarded campaign dispatch: the approval fingerprint,
// the one-shot consumption, the post-approval drift check, and the actor
// resolution the approval hook records.

// enforceSendApproval runs the approval gate for one campaign.
//
// Returns (nil, nil) when the send may proceed, (outcome, nil) when it must
// wait for a human, and (nil, err) when it must stop.
//
// Extracted whole rather than left inline: `queueCampaignCore` sits against a
// legacy complexity budget the source-quality gate enforces, and the audience
// digest pushed it over. Moving the entire gate out is also the better shape —
// the fingerprint, the approval check and the one-shot consumption are one
// decision, and they were previously interleaved with queue mechanics.
func (d *Deps) enforceSendApproval(
	ctx context.Context, tenantID, id string, c *Campaign, actor ApprovalActor,
) (*queueCampaignOutcome, *queueError) {
	// Fingerprint the current campaign content so the gate can detect
	// post-approval edits. See D7 in PRODUCTION_READINESS.md.
	//
	// The digest binds WHO the campaign goes to, not just which segment id:
	// without it an editor could rewrite the segment's `query_ast` between
	// approval and send — "customers who bought last month" becomes "everyone" —
	// and this gate would compare two identical fingerprints and let it through.
	//
	// FAIL CLOSED. If the definition cannot be read, the send stops. The
	// tempting fallback is the old audience-blind fingerprint, and that is
	// exactly wrong: it would restore the gap at the moment something is already
	// off, and a send is not reversible.
	fp, fpErr := d.approvalFingerprint(ctx, tenantID, id, c)
	if fpErr != nil {
		return nil, fpErr
	}
	state, err := d.Approvals.EnsureCampaignSendApproved(ctx, tenantID, id, fp, actor)
	if err != nil {
		return nil, &queueError{Status: http.StatusInternalServerError, Err: err}
	}
	if state != nil && !state.Approved {
		return &queueCampaignOutcome{
			Approval: state,
			Response: queueResponse{
				CampaignID:       id,
				RecipientsQueued: 0,
				Status:           "approval_required",
				ApprovalID:       state.ID,
				ApprovalStatus:   state.Status,
				Message:          "campaign send is waiting for approval",
			},
		}, nil
	}
	// One-shot consumption: a second /queue against this campaign must
	// re-request approval rather than silently reuse the prior grant.
	// Best-effort — the content-hash check above is the stronger guard.
	if state != nil && state.ID != "" {
		_ = d.Approvals.MarkApprovalConsumed(ctx, tenantID, state.ID)
	}
	return nil, nil
}

// approvalFingerprint builds the hash the approval gate compares.
//
// Extracted rather than inlined because `queueCampaignCore` sits against a
// legacy complexity budget the source-quality gate enforces, and adding one
// more branch there pushed it from 58 to 59 — a hard CI failure. The logic is
// unchanged; only its address is.
func (d *Deps) approvalFingerprint(
	ctx context.Context, tenantID, campaignID string, c *Campaign,
) (string, *queueError) {
	audienceDigest, err := d.Repo.AudienceFingerprint(ctx, tenantID, c)
	if err != nil {
		return "", &queueError{
			Status: http.StatusConflict,
			Code:   "audience_unverifiable",
			Body: map[string]any{
				"error": map[string]any{
					"code": "audience_unverifiable",
					"message": "This campaign's approved audience can no longer be " +
						"verified, so it was not sent. Re-check the segment and " +
						"request approval again.",
				},
			},
			Err: fmt.Errorf(
				"cannot verify the approved audience for campaign %s: %w", campaignID, err),
		}
	}
	// The variants a recipient ACTUALLY receives, from `campaign_variants`.
	// `c.Variants` is create/update passthrough that the send path never reads,
	// so hashing it protected nothing while reading as protection.
	deliveredVariants, err := d.Repo.DeliveredVariantsDigest(ctx, tenantID, campaignID)
	if err != nil {
		return "", &queueError{
			Status: http.StatusConflict,
			Code:   "audience_unverifiable",
			Err: fmt.Errorf(
				"cannot verify the approved variants for campaign %s: %w", campaignID, err),
		}
	}
	schedule := ""
	if c.ScheduledAt != nil {
		schedule = c.ScheduledAt.UTC().Format(time.RFC3339)
	}
	return approvals.FingerprintReviewBundle(approvals.ReviewBundle{
		Subject:        c.Subject,
		BodyHTML:       c.BodyHTML,
		SegmentID:      c.SegmentID,
		AudienceDigest: audienceDigest,
		FromName:       c.FromName,
		ReplyTo:        c.ReplyTo,
		ScheduledAt:    schedule,
		VariantsDigest: deliveredVariants,
	}), nil
}

// verifyStillApproved refuses a post-approval send whose content or audience
// has moved since the approver saw it.
//
// Returns nil when there is nothing to check against — no approvals service, or
// a legacy approval with no stored hash — because the alternative is bricking
// in-flight approvals on deploy, and the gate makes the same allowance.
func (d *Deps) verifyStillApproved(ctx context.Context, tenantID, campaignID string) error {
	if d.Approvals == nil || d.Repo == nil {
		return nil
	}
	c, err := d.Repo.Get(ctx, tenantID, campaignID)
	if err != nil || c == nil {
		// Cannot read the campaign: fail closed. A send is not reversible.
		if err == nil {
			err = fmt.Errorf("campaign %s not found", campaignID)
		}
		return fmt.Errorf("cannot verify the approved content for campaign %s: %w", campaignID, err)
	}
	fp, fpErr := d.approvalFingerprint(ctx, tenantID, campaignID, c)
	if fpErr != nil {
		return fpErr.Err
	}
	ok, err := d.Approvals.VerifyApprovedFingerprint(ctx, tenantID, campaignID, fp)
	if err != nil {
		return fmt.Errorf("cannot verify the approved content for campaign %s: %w", campaignID, err)
	}
	if !ok {
		return fmt.Errorf(
			"campaign %s changed after it was approved and was not sent; "+
				"request approval again", campaignID)
	}
	return nil
}

// QueueApprovedCampaign is called by the approval hook after a campaign-send
// approval is decided. It deliberately bypasses the approval gate and reuses
// the same validation/suppression/queue code as the HTTP endpoint.
//
// Sandbox-ness is read back from the campaigns row (persisted at
// original /queue time by QueueCampaign — see D6 in
// PRODUCTION_READINESS.md). Without this, a sandbox API key that
// queued a campaign requiring approval would have had its sandbox
// flag silently dropped on the approval hook → REAL sends.
func (d *Deps) QueueApprovedCampaign(ctx context.Context, tenantID, campaignID string) (int, error) {
	// A missing/failed sandbox read is fatal. Defaulting an unknown flag to
	// false would turn an approved sandbox campaign into a real send.
	sandboxFlag, err := d.loadCampaignSandboxAuthority(ctx, tenantID, campaignID)
	if err != nil {
		return 0, err
	}
	// Confirm the campaign still IS what was approved.
	//
	// This path deliberately skips the approval gate — it runs BECAUSE an
	// approval was granted. But skipping the gate also skipped the gate's
	// content check, and in the default wiring the approval decision is what
	// triggers the send, so the second `/queue` that would have compared the
	// fingerprint never happens. The approve→edit→send sequence the fingerprint
	// exists to stop travelled the one path that never looked at it.
	//
	// Checked HERE rather than by un-skipping the gate: re-running the gate
	// would request a NEW approval on mismatch, and an approval hook that
	// silently opens a second approval instead of sending is a worse surprise
	// than a refusal that says what happened.
	if err := d.verifyStillApproved(ctx, tenantID, campaignID); err != nil {
		return 0, err
	}
	out, err := d.queueCampaignCore(ctx, tenantID, campaignID, queueCampaignOptions{
		SkipApproval: true,
		Sandbox:      sandboxFlag,
		Actor: ApprovalActor{
			Type:  "system",
			Label: "approval-hook",
		},
	})
	if err != nil {
		return 0, err
	}
	return out.Response.RecipientsQueued, nil
}

func approvalActorFromContext(ctx context.Context) ApprovalActor {
	actorType, actorLabel := middleware.ActorFromContext(ctx)
	a := ApprovalActor{
		Type:     actorType,
		Label:    actorLabel,
		APIKeyID: middleware.APIKeyIDFromContext(ctx),
	}
	// Capture the requesting user's id so the approval row's
	// requested_by_user_id gets populated (audit HIGH F5: lets
	// Service.Decide refuse self-approval).
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		a.UserID = u.ID
	}
	return a
}
