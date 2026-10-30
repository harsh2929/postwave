// SPDX-License-Identifier: AGPL-3.0-only

// Package coderedemption attributes a code redemption to the campaign that
// issued the code (PRD F04).
//
// The acceptance criterion is the whole design: "a redemption with no preceding
// click event still attributes to the campaign." It matters because under AI
// mediation the population that reads a message and then goes to the site
// DIRECTLY grows — they never click, so last-touch attribution never sees them,
// and the campaign that caused the purchase gets no credit at all. The revenue is
// real; only the connection is missing.
//
// A presented code links an outcome to the campaign assignment that issued the
// code. It does not prove who presented it or who read the campaign: codes can
// be forwarded, copied, or intentionally shared. This package therefore keeps
// assignment provenance separate from recipient identity and never promotes a
// redemption into human-readership evidence.
package coderedemption

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// AttributedViaCodeRedemption is a distinct provenance value.
//
// Not `explicit`: that means a caller asserted a campaign id, which is a claim
// about what the caller believes. This value means a code was resolved through
// one allocation receipt to its issuing campaign. It is evidence of outcome
// linkage, not evidence about the identity or readership of the redeemer.
const AttributedViaCodeRedemption = "code_redemption"

var (
	// ErrUnknownCode is returned when no live assignment matches.
	ErrUnknownCode = errors.New("coderedemption: code not recognised")
	// ErrCodeExpired is returned past the assignment's expiry.
	ErrCodeExpired = errors.New("coderedemption: code has expired")
	// ErrAlreadyRedeemed is returned for a second redemption of a single-use code.
	ErrAlreadyRedeemed = errors.New("coderedemption: code has already been redeemed")
	// ErrAmbiguousCode is returned when code alone names more than one assignment.
	// The caller can retry with the opaque assignment reference it received at
	// allocation; silently choosing the newest assignment would misattribute money.
	ErrAmbiguousCode = errors.New("coderedemption: code matches more than one assignment")
	// ErrCodeUnavailable covers non-redeemable lifecycle states such as reserved
	// or released without revealing unrelated assignment details.
	ErrCodeUnavailable = errors.New("coderedemption: code is not redeemable")
	// ErrAttributionUnavailable refuses to consume a code when its assignment
	// does not have one internally consistent campaign and discount linkage.
	ErrAttributionUnavailable = errors.New("coderedemption: attribution linkage is unavailable")
)

// Repo records redemptions.
type Repo struct {
	Pool *db.Pool
	Now  func() time.Time
}

func (r *Repo) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// Redemption is what the customer's commerce system reports.
type Redemption struct {
	Code string
	// AssignmentID is the opaque allocation reference. It is optional when Code
	// is unique inside the tenant and required to disambiguate shared/static
	// codes. It is never inferred from render_key, which is not a redeemable code.
	AssignmentID string
	// AmountCents and Currency are optional: a redemption is attributable even
	// when the caller cannot say what it was worth, and refusing an unpriced
	// redemption would discard the attribution along with the missing number.
	AmountCents *int64
	Currency    string
	OccurredAt  time.Time
	// Source records who reported it, so an internal test redemption is
	// distinguishable from a customer's live commerce system.
	Source string
}

// Result is the attribution that was recorded.
type Result struct {
	AssignmentID string
	CampaignID   string
	// ConversionID is set when a conversion row was written. Zero when the
	// redemption was recorded but carried no monetary value.
	ConversionID int64
	// LinkedWithoutRecordedAssignmentClick says only that the subscriber to whom
	// the assignment was issued had no recorded click for this campaign before
	// the redemption. It does not identify the redeemer or prove readership.
	LinkedWithoutRecordedAssignmentClick bool
	// AttributionScope is campaign_assignment: the evidence links the outcome to
	// one allocation receipt and campaign, not to a reader identity.
	AttributionScope string
}

// Record attributes a redemption to the campaign that issued the code.
//
// Runs in one transaction: the redemption, the assignment state change and the
// conversion must all land or none of them. A redemption recorded without its
// conversion is revenue nobody can find; a conversion without its redemption
// would double-count on retry.
func (r *Repo) Record(ctx context.Context, tenantID string, in Redemption) (*Result, error) {
	code := strings.TrimSpace(in.Code)
	if code == "" {
		return nil, ErrUnknownCode
	}
	occurredAt := in.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = r.now()
	}
	source := strings.TrimSpace(in.Source)
	if source == "" {
		source = "internal"
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The assignment carries the campaign. This is the join the schema could not
	// express before: coupon_assignments had no campaign_id, so there was no path
	// from a redeemed code back to the message that sent it.
	assignmentReference := strings.TrimSpace(in.AssignmentID)
	var assignmentID, assignmentCampaignID, poolCampaignID, subscriberID, discountID string
	var status string
	var expiresAt *time.Time
	rows, err := tx.Query(ctx, `
SELECT a.id::text,
       COALESCE(a.campaign_id::text, ''),
       COALESCE(p.campaign_id::text, ''),
       COALESCE(a.subscriber_id::text, ''),
       COALESCE(p.discount_id::text, ''),
       a.status,
       a.expires_at
  FROM coupon_assignments a
  LEFT JOIN coupon_pools p ON p.id = a.pool_id AND p.tenant_id = a.tenant_id
 WHERE a.tenant_id = $1::uuid
	AND a.static_code = $2
	AND (NULLIF($3, '') IS NULL OR a.id = NULLIF($3, '')::uuid)
 ORDER BY a.id
 LIMIT 2
 FOR UPDATE OF a`, tenantID, code, assignmentReference)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	matched := 0
	for rows.Next() {
		matched++
		if matched > 1 {
			return nil, ErrAmbiguousCode
		}
		if err := rows.Scan(
			&assignmentID, &assignmentCampaignID, &poolCampaignID,
			&subscriberID, &discountID, &status, &expiresAt,
		); err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if matched == 0 {
		return nil, ErrUnknownCode
	}
	campaignID := assignmentCampaignID
	if campaignID == "" {
		campaignID = poolCampaignID
	}
	if campaignID == "" || discountID == "" ||
		(assignmentCampaignID != "" && poolCampaignID != "" && assignmentCampaignID != poolCampaignID) {
		return nil, ErrAttributionUnavailable
	}

	// Expiry is checked before status so an expired-and-unredeemed code reports
	// the more useful of the two facts.
	if expiresAt != nil && occurredAt.After(*expiresAt) {
		return nil, ErrCodeExpired
	}
	if status == "redeemed" {
		return nil, ErrAlreadyRedeemed
	}
	if status != "assigned" {
		return nil, ErrCodeUnavailable
	}

	// Was there a click? Asked BEFORE writing anything, because the answer is the
	// PRD's acceptance criterion and it must describe the state the redemption
	// arrived into, not the state after.
	clicked := false
	if subscriberID != "" && campaignID != "" {
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscriber_events e
      JOIN subscribers s ON s.id = $2::uuid AND s.tenant_id = e.tenant_id
     WHERE e.tenant_id = $1::uuid
       AND e.subscriber_email = s.email
       AND e.campaign_id = $3::uuid
       AND e.event_type = 'clicked'
)`, tenantID, subscriberID, campaignID).Scan(&clicked); err != nil {
			return nil, err
		}
	}

	result := &Result{
		AssignmentID:                         assignmentID,
		CampaignID:                           campaignID,
		LinkedWithoutRecordedAssignmentClick: !clicked,
		AttributionScope:                     AttributionScopeCampaignAssignment,
	}

	if _, err := tx.Exec(ctx, `
UPDATE coupon_assignments
   SET status = 'redeemed', redeemed_at = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, assignmentID, occurredAt); err != nil {
		return nil, err
	}

	// The redemption record, idempotent on the assignment. The customer's
	// commerce system will retry.
	var redemptionID int64
	if err := tx.QueryRow(ctx, `
INSERT INTO discount_redemptions
    (tenant_id, discount_id, subscriber_id, redeemed_at, campaign_id, assignment_id,
     code, source, linked_without_recorded_assignment_click)
VALUES ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9)
ON CONFLICT (tenant_id, assignment_id) WHERE assignment_id IS NOT NULL DO NOTHING
RETURNING id`,
		tenantID, discountID, subscriberID, occurredAt,
		campaignID, assignmentID, code, source, !clicked).Scan(&redemptionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAlreadyRedeemed
		}
		return nil, err
	}

	// The conversion, credited to the campaign with NO click required. This is
	// the line the acceptance criterion is about.
	if in.AmountCents != nil && campaignID != "" {
		if err := tx.QueryRow(ctx, `
INSERT INTO conversions
    (tenant_id, subscriber_email, event_name, amount_cents, currency,
     campaign_id, attributed_via, occurred_at, code_assignment_id,
     properties)
VALUES ($1::uuid, NULL, 'code_redemption', $2, NULLIF($3, ''),
        $4::uuid, $5, $6, $7::uuid,
        jsonb_build_object('redemption_id', $8::bigint,
                           'linkage', 'campaign_assignment'))
RETURNING id`, tenantID, *in.AmountCents, in.Currency,
			campaignID, AttributedViaCodeRedemption, occurredAt, assignmentID,
			redemptionID).Scan(&result.ConversionID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
