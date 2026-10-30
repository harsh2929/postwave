// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// The four non-campaign paths a person can take to a purchase.
//
// `campaign_id` has answered "where did this money come from" alone since the
// column was added, and it answers it for one path out of five. A flow that
// nudged someone, a form they filled, a discount they redeemed, a referral that
// sent them and an experiment arm they sat in were each recorded faithfully in
// their own table and connected to revenue nowhere — so "revenue by flow" was
// not a slow query, it was an unanswerable one.
//
// These are resolved INDEPENDENTLY and stored in separate columns. There is
// deliberately no precedence rule: a conversion can honestly have come through
// a form AND used a discount AND been in an experiment arm, and picking one
// winner would be this code inventing a claim about how revenue is credited —
// which is the operator's decision, made per report, not a schema default.
//
// Every edge uses the SAME window and the SAME anchor as campaign last-touch
// (lastTouchAttributionWindow before occurredAt, strictly before it). Sharing
// the window is not laziness: five edges with five different look-backs would
// mean two reports over the same conversion disagreeing about which touches
// counted, and nothing in the row's ask justifies that.

const structuralEdgeLookupSavepoint = "conversion_structural_edges"

// structuralEdges is what one conversion could be joined to. Empty string means
// "no edge found in window" — never "this edge cannot exist".
type structuralEdges struct {
	FlowID               string
	FormID               string
	DiscountID           string
	ReferrerSubscriberID string
	ExperimentVariantID  string
}

// lookupStructuralEdges resolves all five edges for one conversion.
//
// It runs INSIDE the caller's tenant-scoped tx (RLS on every source table keys
// on app.tenant_id, which the caller has bound) and additionally filters
// tenant_id = $1 explicitly, so the probes stay tenant-correct even under the
// public-ingest GUC path — the same belt-and-braces lookupLastTouchCampaign
// uses, and for the same reason.
//
// Three of the five source tables key on subscriber_id and two on the email
// directly, so the subscriber is resolved ONCE up front rather than joined five
// times. An email with no subscriber row still gets the two email-keyed edges:
// a form submission from someone who never became a subscriber is exactly the
// case a form edge exists to capture, and dropping it would make the edge
// systematically miss first-time buyers.
func lookupStructuralEdges(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	occurredAt time.Time,
) (structuralEdges, error) {
	var out structuralEdges
	if email == "" {
		// An anonymous conversion has nothing to join on. Every edge here is
		// reached through the person.
		return out, nil
	}
	windowStart := occurredAt.Add(-lastTouchAttributionWindow)

	var subscriberID string
	err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2
 LIMIT 1`, tenantID, email).Scan(&subscriberID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}

	// Form: keyed on email, so it resolves for non-subscribers too.
	//
	// status is not filtered. A submission that is still unconfirmed did happen,
	// and the edge records the path taken, not the outcome of a double opt-in.
	if err := scanEdge(ctx, tx, &out.FormID, `
SELECT form_id::text
  FROM form_submissions
 WHERE tenant_id = $1::uuid
   AND email = $2
   AND submitted_at < $3
   AND submitted_at >= $4
 ORDER BY submitted_at DESC
 LIMIT 1`, tenantID, email, occurredAt, windowStart); err != nil {
		return out, err
	}

	// Experiment arm: flow_ab_test_assignments keys on subscriber_email.
	if err := scanEdge(ctx, tx, &out.ExperimentVariantID, `
SELECT variant_id
  FROM flow_ab_test_assignments
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND assigned_at < $3
   AND assigned_at >= $4
 ORDER BY assigned_at DESC
 LIMIT 1`, tenantID, email, occurredAt, windowStart); err != nil {
		return out, err
	}

	if subscriberID == "" {
		return out, nil
	}

	// Flow: the journey the run belonged to, not the run.
	//
	// created_at (enrolment), not finished_at: a flow that enrolled someone and
	// is still running is exactly as much a cause of the purchase as one that
	// completed, and anchoring on completion would silently exclude every
	// long-running nurture — the flows most likely to be doing the work.
	if err := scanEdge(ctx, tx, &out.FlowID, `
SELECT flow_id::text
  FROM flow_runs
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND created_at < $3
   AND created_at >= $4
 ORDER BY created_at DESC
 LIMIT 1`, tenantID, subscriberID, occurredAt, windowStart); err != nil {
		return out, err
	}

	// Discount: the redemption, which is the act that touched the money.
	if err := scanEdge(ctx, tx, &out.DiscountID, `
SELECT discount_id::text
  FROM discount_redemptions
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND redeemed_at < $3
   AND redeemed_at >= $4
 ORDER BY redeemed_at DESC
 LIMIT 1`, tenantID, subscriberID, occurredAt, windowStart); err != nil {
		return out, err
	}

	// Referral: this subscriber is the REFEREE, and the edge names the referrer
	// — the person the money is owed to. referral_codes carries no program_id,
	// so a conversion-to-program edge would have to be invented; the referrer is
	// the fact that exists.
	if err := scanEdge(ctx, tx, &out.ReferrerSubscriberID, `
SELECT referrer_subscriber_id
  FROM referral_conversions
 WHERE tenant_id = $1::uuid
   AND referee_subscriber_id = $2
   AND created_at < $3
   AND created_at >= $4
 ORDER BY created_at DESC
 LIMIT 1`, tenantID, subscriberID, occurredAt, windowStart); err != nil {
		return out, err
	}

	return out, nil
}

// scanEdge runs one probe, leaving dst untouched when there is no match.
//
// A miss is not an error: most conversions have no flow, no form and no
// discount behind them, and treating "nothing in window" as a failure would
// turn the ordinary case into a logged incident.
func scanEdge(ctx context.Context, tx pgx.Tx, dst *string, sql string, args ...any) error {
	var v *string
	if err := tx.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if v != nil {
		*dst = *v
	}
	return nil
}
