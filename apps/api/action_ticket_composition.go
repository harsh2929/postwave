// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/offers"
)

// productionActionTicketExecutor is the sole dispatch table for bindings that
// actionticket.KnownActionForResource admits. Keeping registration and domain
// execution adjacent makes a newly catalogued action fail closed until its
// idempotent implementation is explicitly wired here.
type productionActionTicketExecutor struct {
	Approvals *approvals.Service
	Offers    *offers.Repo
}

func (executor productionActionTicketExecutor) Perform(
	req *http.Request,
	redeemed actionticket.Redeemed,
) error {
	if !actionticket.KnownActionForResource(redeemed.Action, redeemed.ResourceKind) {
		return fmt.Errorf("no executor for action %q on %q", redeemed.Action, redeemed.ResourceKind)
	}
	switch redeemed.Action {
	case "approval.approve", "approval.reject":
		return approvalTicketExecutor{Service: executor.Approvals}.Perform(req, redeemed)
	case "offer.decline":
		if executor.Offers == nil {
			return errors.New("offer action-ticket executor is unavailable")
		}
		return executor.Offers.RecordTicketDecline(
			req.Context(), redeemed.TenantID, redeemed.ResourceID,
			redeemed.UserID, redeemed.ID, redeemed.ResourceVersion,
		)
	default:
		return fmt.Errorf("no executor for action %q on %q", redeemed.Action, redeemed.ResourceKind)
	}
}

// approvalTicketExecutor is the production executor for the only action-ticket
// approval bindings registered by actionticket.KnownActionForResource.
//
// Perform is idempotent for crash recovery. If the domain mutation committed
// but the API died before the ticket receipt completed, the next lease observes
// the exact same final approval status and decider and treats that as success.
// A different decision or actor remains a conflict, never a convenient success.
type approvalTicketExecutor struct {
	Service *approvals.Service
}

func (executor approvalTicketExecutor) Perform(
	req *http.Request,
	redeemed actionticket.Redeemed,
) error {
	if executor.Service == nil || executor.Service.Repo == nil {
		return errors.New("approval action-ticket executor is unavailable")
	}
	if !actionticket.KnownActionForResource(redeemed.Action, redeemed.ResourceKind) {
		return fmt.Errorf("no executor for action %q on %q", redeemed.Action, redeemed.ResourceKind)
	}
	decision, wantStatus, err := approvalTicketDecision(redeemed.Action)
	if err != nil {
		return err
	}
	err = executor.Service.Decide(req.Context(), redeemed.TenantID,
		redeemed.ResourceID, decision, redeemed.UserID, "")
	if err == nil {
		return nil
	}
	if !errors.Is(err, approvals.ErrNotPending) && !errors.Is(err, approvals.ErrNotFound) {
		return err
	}

	current, readErr := executor.Service.Repo.Get(req.Context(), redeemed.TenantID, redeemed.ResourceID)
	if readErr != nil {
		return err
	}
	if approvalTicketDecisionMatches(current, wantStatus, redeemed.UserID) {
		return nil
	}
	return err
}

func approvalTicketDecision(action string) (approvals.Decision, approvals.Status, error) {
	switch action {
	case "approval.approve":
		return approvals.DecisionApprove, approvals.StatusApproved, nil
	case "approval.reject":
		return approvals.DecisionReject, approvals.StatusRejected, nil
	default:
		return "", "", fmt.Errorf("no approval executor for action %q", action)
	}
}

func approvalTicketDecisionMatches(
	current *approvals.Approval,
	want approvals.Status,
	userID string,
) bool {
	return current != nil && current.Status == want &&
		current.DecidedByUserID != nil && *current.DecidedByUserID == userID
}
