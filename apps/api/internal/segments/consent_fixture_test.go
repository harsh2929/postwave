// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/consent"
)

// seedCanonicalEmailFixture creates the exact address projection used by the
// activation evaluator. A positive fixture is granted through the same paired
// event/proof shape as the production consent writer; direct positive column
// writes are deliberately rejected by migration 1766.
func seedCanonicalEmailFixture(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, email string,
	granted bool,
) string {
	t.Helper()

	var addressID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3::citext, true, 'never_subscribed', false)
RETURNING id::text`, tenantID, subscriberID, email).Scan(&addressID); err != nil {
		t.Fatalf("seed subscriber email %s: %v", email, err)
	}
	if !granted {
		return addressID
	}

	occurredAt := time.Now().UTC().Truncate(time.Microsecond)
	const (
		jurisdiction = "US"
		reason       = "Canonical segment population database fixture"
		operation    = "segment_population_fixture"
		policy       = "segment-population-test-v1"
		proof        = "Reviewed exact-address grant for segment population testing."
	)
	eventID, err := consent.RecordEventInTx(ctx, tx, consent.EventInput{
		TenantID:      tenantID,
		SubjectType:   "subscriber",
		SubjectID:     addressID,
		SubjectEmail:  email,
		Channel:       "email",
		Category:      "email_marketing",
		Action:        "granted",
		Source:        "double_optin",
		PolicyVersion: policy,
		ProofText:     proof,
		Preferences: map[string]any{
			"legal_basis":    "consent",
			"jurisdiction":   jurisdiction,
			"reason":         reason,
			"operation":      operation,
			"subscriber_id":  subscriberID,
			"address_id":     addressID,
			"consent_status": "subscribed",
		},
		OccurredAt: &occurredAt,
	})
	if err != nil {
		t.Fatalf("seed consent event %s: %v", email, err)
	}
	evidence, err := json.Marshal(map[string]any{
		"event_id":       eventID,
		"address_id":     addressID,
		"operation":      operation,
		"legal_basis":    "consent",
		"jurisdiction":   jurisdiction,
		"reason":         reason,
		"policy_version": policy,
		"evidence":       proof,
	})
	if err != nil {
		t.Fatalf("encode consent proof %s: %v", email, err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records
       (tenant_id, subscriber_id, email, channel, consent_status, source,
        captured_at, evidence)
VALUES ($1::uuid, $2::uuid, $3::citext, 'email', 'granted', 'double_optin',
        $4::timestamptz, $5::jsonb)`,
		tenantID, subscriberID, email, occurredAt, string(evidence)); err != nil {
		t.Fatalf("seed consent record %s: %v", email, err)
	}
	return addressID
}
