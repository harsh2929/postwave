// SPDX-License-Identifier: AGPL-3.0-only
package approvals

import (
	"context"
	"testing"
)

// An escalation nobody receives is a database stamp.
//
// The sweeper stamps `escalated_at` and emits `approval.escalated` on the event
// bus. A repo-wide grep for that topic finds the emitter, a doc comment and one
// more comment in main.go — no subscriber. So the escalation policy an operator
// configured ("chase this after 8 hours") fires, updates a column, and reaches
// nobody. The approval sits exactly as unattended as before, and the audit trail
// says it was escalated.
//
// `approval.requested` already has the answer next door: it goes through
// `notifyfanout.Dispatch`, which writes the feed row FIRST as the cross-channel
// identity and then fans to web push, mobile push and SSE under per-user
// preferences. One product, one concept, and the second half was left as an
// event with no listener.

// recordingEscalationNotifier captures what the sweeper asks to be delivered.
type recordingEscalationNotifier struct {
	calls []EscalationNotice
}

func (r *recordingEscalationNotifier) NotifyEscalated(_ context.Context, n EscalationNotice) {
	r.calls = append(r.calls, n)
}

func TestAnEscalationIsDelivered(t *testing.T) {
	rec := &recordingEscalationNotifier{}
	s := &EscalationSweeper{Notifier: rec}

	s.announce(context.Background(), []escalatedApproval{
		{TenantID: "t1", ID: "a1", NotifyOwners: true},
	})

	if len(rec.calls) != 1 {
		t.Fatalf("the sweeper made %d delivery attempt(s). An escalation that "+
			"updates a column and notifies nobody leaves the approval exactly as "+
			"unattended as before, while the record says it was escalated.",
			len(rec.calls))
	}
	got := rec.calls[0]
	if got.TenantID != "t1" || got.ApprovalID != "a1" {
		t.Errorf("notice = %+v, want tenant t1 / approval a1", got)
	}
}

func TestAPolicyThatOptsOutOfOwnerNotificationIsHonoured(t *testing.T) {
	// `notify_owners` is a real column on `approval_escalation_policies`, read
	// by the sweeper and — before this — used for nothing but a log line. A
	// tenant that turned it off must not start receiving pushes.
	rec := &recordingEscalationNotifier{}
	s := &EscalationSweeper{Notifier: rec}

	s.announce(context.Background(), []escalatedApproval{
		{TenantID: "t1", ID: "a1", NotifyOwners: false},
	})

	if len(rec.calls) != 0 {
		t.Fatalf("a policy with notify_owners=false produced %d notification(s). "+
			"The column exists so a tenant can turn this off.", len(rec.calls))
	}
}

func TestNoNotifierIsNotACrash(t *testing.T) {
	// The sweeper runs in composition where the notifier may be absent (tests,
	// a stripped deployment). Escalation must still stamp the column.
	s := &EscalationSweeper{}
	s.announce(context.Background(), []escalatedApproval{{TenantID: "t1", ID: "a1", NotifyOwners: true}})
}
