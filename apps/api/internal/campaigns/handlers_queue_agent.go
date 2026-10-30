// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Agent-initiated queueing and the persisted campaign sandbox authority it
// and QueueApprovedCampaign read back.

// AgentQueueResult is the model-facing outcome of an agent-initiated queue.
// It is the narrow projection of queueResponse that the MCP / in-app agent
// surfaces return — recipient count, the resulting status, and whether the
// send is now waiting on a human send-approval (so the agent reports
// "queued for approval" rather than implying the email already went out).
type AgentQueueResult struct {
	CampaignID       string `json:"campaign_id"`
	Status           string `json:"status"`
	RecipientsQueued int    `json:"recipients_queued"`
	ApprovalRequired bool   `json:"approval_required"`
	ApprovalID       string `json:"approval_id,omitempty"`
}

// messageFromQueueErrorBody best-effort extracts a human message from a
// queueError.Body (the {error:{code,message}, ...} envelope some outcomes
// carry instead of a flat Message). Returns "" when no message is present.
func messageFromQueueErrorBody(body any) string {
	m, ok := body.(map[string]any)
	if !ok {
		return ""
	}
	switch e := m["error"].(type) {
	case map[string]string:
		return e["message"]
	case map[string]any:
		if s, ok := e["message"].(string); ok {
			return s
		}
	}
	return ""
}

// QueueCampaignForAgent queues a campaign on behalf of an autonomous agent
// (native MCP / in-app AI). It is the "bare handler" delegation entry point:
// it reuses the EXACT same validation / compliance / suppression / holdout /
// frequency-cap / approval pipeline as the HTTP /queue endpoint via
// queueCampaignCore, but is callable without an http.ResponseWriter so the
// agenttools registry can invoke it directly (no second pass through the
// router middleware → no double governance).
//
// Crucially, approval enforcement stays ACTIVE (SkipApproval is left false),
// so an agent can never fire an un-reviewed send when the tenant requires
// send-approval; the result reports ApprovalRequired in that case. Sandbox
// simulation for sandbox-only keys is handled upstream by the agenttools
// Execute chokepoint (a write-tier tool is simulated, not executed, for a
// sandbox caller), and a campaign explicitly marked sandbox on its row is
// still respected here for defense in depth.
func (d *Deps) QueueCampaignForAgent(ctx context.Context, tenantID, campaignID, actorLabel string) (AgentQueueResult, error) {
	if strings.TrimSpace(actorLabel) == "" {
		actorLabel = "agent"
	}
	sandboxFlag, authorityErr := d.loadCampaignSandboxAuthority(ctx, tenantID, campaignID)
	if authorityErr != nil {
		return AgentQueueResult{}, errors.New("campaign sandbox authority is unavailable")
	}
	out, err := d.queueCampaignCore(ctx, tenantID, campaignID, queueCampaignOptions{
		Sandbox: sandboxFlag,
		Actor: ApprovalActor{
			Type:  "agent",
			Label: actorLabel,
			// Attribute the send to the calling API key so the approval row
			// and audit trail are not anonymous (and the two-person rule has
			// the actor it keys off).
			APIKeyID: middleware.APIKeyIDFromContext(ctx),
		},
	})
	if err != nil {
		// Map the internal queueError to a clean, model-safe message: 5xx
		// detail is logged by the caller path and never echoed; the
		// operator-authored Code/Message for validation/conflict/compliance
		// is safe to surface so the agent can correct course.
		var qe *queueError
		if errors.As(err, &qe) {
			if qe.Status >= 500 {
				return AgentQueueResult{}, errors.New("internal error while queueing the campaign")
			}
			if qe.Message != "" {
				return AgentQueueResult{}, errors.New(qe.Message)
			}
			// Some non-5xx outcomes (e.g. the email-compliance block) carry
			// their operator message in Body rather than Message — surface it
			// so the agent gets an actionable reason, not a bare status code.
			if msg := messageFromQueueErrorBody(qe.Body); msg != "" {
				return AgentQueueResult{}, errors.New(msg)
			}
			if qe.Code != "" {
				return AgentQueueResult{}, fmt.Errorf("campaign cannot be queued: %s", qe.Code)
			}
			return AgentQueueResult{}, fmt.Errorf("campaign cannot be queued (status %d)", qe.Status)
		}
		return AgentQueueResult{}, err
	}
	res := AgentQueueResult{
		CampaignID:       campaignID,
		Status:           out.Response.Status,
		RecipientsQueued: out.Response.RecipientsQueued,
	}
	if out.Approval != nil && !out.Approval.Approved {
		res.ApprovalRequired = true
		res.ApprovalID = out.Response.ApprovalID
	}
	return res, nil
}

func (d *Deps) loadCampaignSandboxAuthority(ctx context.Context, tenantID, campaignID string) (bool, error) {
	store := d.campaignSandboxAuthorityStore()
	if store == nil {
		return false, errors.New("campaign repository is not configured")
	}
	sandboxFlag, err := store.GetSandboxFlag(ctx, tenantID, campaignID)
	if err != nil {
		return false, fmt.Errorf("resolve campaign sandbox authority: %w", err)
	}
	return sandboxFlag, nil
}

func (d *Deps) persistCampaignSandboxAuthority(ctx context.Context, tenantID, campaignID string, sandbox bool) error {
	store := d.campaignSandboxAuthorityStore()
	if store == nil {
		return errors.New("campaign sandbox authority store is not configured")
	}
	if err := store.SetSandboxFlag(ctx, tenantID, campaignID, sandbox); err != nil {
		return fmt.Errorf("persist campaign sandbox authority: %w", err)
	}
	return nil
}

func (d *Deps) campaignSandboxAuthorityStore() SandboxAuthorityStore {
	if d == nil {
		return nil
	}
	if d.SandboxAuthority != nil {
		return d.SandboxAuthority
	}
	if d.Repo != nil {
		return d.Repo
	}
	return nil
}
