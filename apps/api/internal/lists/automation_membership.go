package lists

// automation_membership.go — the apps/api half of a flow's "Move to list".
//
// services/automation's move_to_list action used to PUT the contact onto the
// Listmonk list and stop. Campaigns send to Moosewave membership
// (list_subscribers), and nothing carries an engine-side membership back, so
// the contact never received a campaign sent to that list — and a list named
// by its Moosewave uuid failed outright, because the engine Atoi'd the id. The
// engine now enqueues an automation.list_membership outbox row and this
// handler writes the membership through the owned writer every other source
// uses, resolving the list id in either form.
//
// The row carries only the address the run was enrolled with, and it is
// handled later, with retries. The handler therefore acts only on a contact
// that still exists and was not erased: it never creates one
// (AddExistingContactToListOwned), so a flow cannot bring back an address a
// deletion or privacy request removed.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// AutomationListMembershipKind is the outbox kind a services/automation
// move_to_list action enqueues.
//
// MUST stay equal to services/automation/internal/runtime.listMembershipKind.
const AutomationListMembershipKind = "automation.list_membership"

// automationListMembershipPayload mirrors runtime.ListMembershipRequest in
// services/automation. Keep the json tags in sync — this is the wire contract.
type automationListMembershipPayload struct {
	SubscriberEmail string `json:"subscriber_email"`
	ListID          string `json:"list_id"`
	AutomationID    string `json:"automation_id"`
	NodeID          string `json:"node_id"`
	RunID           string `json:"run_id,omitempty"`
}

// AutomationListMembershipHandler writes automation.list_membership outbox
// rows as Moosewave list memberships.
type AutomationListMembershipHandler struct {
	Repo   *Repo
	Logger *slog.Logger
}

func (h *AutomationListMembershipHandler) log() *slog.Logger {
	if h != nil && h.Logger != nil {
		return h.Logger
	}
	return slog.Default()
}

// Handle implements outbox.HandlerFunc for kind=automation.list_membership.
//
// Ack-vs-retry policy (the outbox is at-least-once; nil acks the row, an error
// backs off and retries until MaxAttempts, then dead-letters it):
//   - an unreadable payload, a missing address or list, a list that does not
//     exist in this tenant (deleted since the flow was built), an address the
//     tenant has no contact for (deleted since the run was enrolled), or an
//     erased address → log and ack. Retrying cannot make any of them valid.
//   - a database failure → return the error so the worker retries.
//
// The membership is owned as 'source:api' — an operator-configured action, so
// the Members-tab removal retires it like any other operator add — with the
// automation, node and run recorded in the owner's metadata. The write is an
// upsert, so a redelivered row changes nothing.
func (h *AutomationListMembershipHandler) Handle(ctx context.Context, ev outbox.Event) error {
	if h == nil || h.Repo == nil || h.Repo.Pool == nil {
		return errors.New("automation list membership: handler is not configured")
	}
	var p automationListMembershipPayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		h.log().Warn("automation list membership: unreadable payload, dropping",
			"tenant_id", ev.TenantID, "event_id", ev.ID, "err", err)
		return nil
	}
	email := strings.TrimSpace(p.SubscriberEmail)
	listID := strings.TrimSpace(p.ListID)
	if email == "" || listID == "" {
		h.log().Warn("automation list membership: no address or list, dropping",
			"tenant_id", ev.TenantID, "event_id", ev.ID, "automation_id", p.AutomationID, "node_id", p.NodeID)
		return nil
	}
	_, err := h.Repo.AddExistingContactToListOwned(ctx, ev.TenantID, listID, email, ListMembershipOwner{
		Source:   "api",
		OwnerKey: "source:api",
		Metadata: map[string]any{
			"owner":         "automation",
			"automation_id": p.AutomationID,
			"node_id":       p.NodeID,
			"run_id":        p.RunID,
		},
	})
	switch {
	case errors.Is(err, ErrListIDNotMapped), errors.Is(err, ErrInvalidListID):
		h.log().Warn("automation list membership: the flow names a list this workspace does not have, dropping",
			"tenant_id", ev.TenantID, "event_id", ev.ID, "automation_id", p.AutomationID,
			"node_id", p.NodeID, "list_id", listID)
		return nil
	case errors.Is(err, ErrNoContactForAddress), errors.Is(err, ErrErasureBlocked):
		// The address is deliberately not logged: it may belong to a person
		// whose data was erased.
		h.log().Info("automation list membership: the contact no longer exists or was erased, dropping",
			"tenant_id", ev.TenantID, "event_id", ev.ID, "automation_id", p.AutomationID,
			"node_id", p.NodeID, "list_id", listID, "erased", errors.Is(err, ErrErasureBlocked))
		return nil
	}
	return err
}
