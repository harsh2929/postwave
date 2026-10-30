// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Assignment v2 makes the immutable recipient ledger the cohort authority.
// Membership is proved directly: every treatment assignment has one send row
// and every control assignment has none. No report-time re-hash is permitted
// to invent a second population after the queue transaction has committed.
func TestFrozenAssignmentLedgerMatchesSuppressedSendMembership_DB(t *testing.T) {
	pool := holdoutDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	fixture := seedFrozenLiftFixture(t, pool, ctx, 7, 3,
		time.Now().UTC().Add(-8*24*time.Hour), 7, "purchase", 0.10)

	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT assignment.recipient_id::text, assignment.arm,
       count(recipient.id) AS send_rows
  FROM campaign_holdout_assignments AS assignment
  JOIN subscribers AS subscriber
    ON subscriber.tenant_id = assignment.tenant_id
   AND subscriber.id = assignment.recipient_id
  LEFT JOIN campaign_recipients AS recipient
    ON recipient.tenant_id = assignment.tenant_id
   AND recipient.campaign_id = assignment.campaign_id
   AND recipient.subscriber_email = subscriber.email
 WHERE assignment.tenant_id = $1::uuid
   AND assignment.campaign_id = $2::uuid
 GROUP BY assignment.recipient_id, assignment.arm
 ORDER BY assignment.recipient_id`, fixture.TenantID, fixture.CampaignID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var treatment, control int
	for rows.Next() {
		var recipientID, arm string
		var sendRows int
		if err := rows.Scan(&recipientID, &arm, &sendRows); err != nil {
			t.Fatal(err)
		}
		switch arm {
		case "treatment":
			treatment++
			if sendRows != 1 {
				t.Errorf("treatment assignment %s has %d send rows, want 1", recipientID, sendRows)
			}
		case "control":
			control++
			if sendRows != 0 {
				t.Errorf("suppressed control assignment %s has %d send rows, want 0", recipientID, sendRows)
			}
		default:
			t.Fatalf("unknown assignment arm %q", arm)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if treatment != len(fixture.Treatment) || control != len(fixture.Control) {
		t.Fatalf("ledger membership treatment=%d control=%d, want %d/%d",
			treatment, control, len(fixture.Treatment), len(fixture.Control))
	}
}
