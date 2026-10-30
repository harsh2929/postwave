package campaigndispatch

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Once a campaign has begun sending, what a recipient receives stops changing.
//
// The send loop re-reads delivered content from the database inside EVERY batch
// transaction rather than snapshotting it at dispatch. So an edit accepted
// mid-send makes batch 1 deliver version A and batches 2..N deliver version B,
// under one campaign id, with nothing recording which recipient got which — and
// the archive then shows only the last version, leaving a complaint about the
// first unanswerable.
//
// The rule lives here, in the workspace package, for the reason stated at the
// top of qualification.go: it is consulted by the canonical campaigns repo, by
// the Mailchimp compatibility surface, and by the A/B variant writer, in three
// different packages. A copy per writer is not one rule — and the two doors
// found after the first implementation were both writers nobody remembered.
//
// KEYED ON started_at, NOT ON STATUS. A campaign paused halfway through a send
// reads 'paused' while some recipients already hold version A; resuming after an
// edit delivers version B to the rest. The status list stays as a second
// disjunct for rows that reached a terminal status before started_at was
// stamped — historical imports and campaigns migrated from Listmonk carry
// status='sent' with no start instant.
const (
	// DispatchedPredicate is the SQL for "this campaign has begun dispatching",
	// written against an aliasable campaigns row. Callers that need it against a
	// specific alias should use DispatchedPredicateFor.
	DispatchedPredicate = `(started_at IS NOT NULL OR status IN ('sending', 'sent'))`

	// EditablePredicate is its negation, for use as an UPDATE guard.
	EditablePredicate = `(started_at IS NULL AND status NOT IN ('sending', 'sent'))`

	// StartedAtStampFor is applied by every writer that moves a campaign into a
	// dispatching status, so "has this campaign begun" is a fact the guard can
	// read. Monotonic: a re-queue must not reset it, or the second pause would
	// unfreeze content the first send already delivered.
	StartedAtStamp = `started_at = COALESCE(started_at, now())`

	FrozenCode    = "campaign_dispatching"
	FrozenMessage = "this campaign has started sending; its content can no longer be changed — duplicate it to send a revised version"
)

// ErrContentFrozen is returned when a write would change what a recipient
// receives on a campaign that has begun dispatching.
//
// Deliberately distinct from a not-found error. "This campaign has started" is a
// state the caller can act on — wait it out, or duplicate past it; "no such
// campaign" means their id is wrong. Collapsing them sends someone hunting for a
// record that is right there.
var ErrContentFrozen = errors.New(FrozenCode)

// Querier is the subset of pgx a caller must supply. Both pgx.Tx and pgxpool
// satisfy it, so a caller can check inside its own transaction — which is the
// only way the answer is meaningful, since the campaign can start dispatching
// between an outside read and the write it guards.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// HasDispatched reports whether the campaign has begun sending.
//
// Returns pgx.ErrNoRows when the campaign does not exist for this tenant, so a
// caller can tell "frozen" from "wrong id" — the distinction ErrContentFrozen
// exists to preserve.
func HasDispatched(ctx context.Context, q Querier, tenantID, campaignID string) (bool, error) {
	var dispatched bool
	err := q.QueryRow(ctx, `
SELECT `+DispatchedPredicate+`
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, campaignID).Scan(&dispatched)
	if err != nil {
		return false, err
	}
	return dispatched, nil
}

// RequireEditable returns ErrContentFrozen when the campaign has begun
// dispatching. It is the form most callers want: a guard clause before writing
// content that lives in a table the UPDATE predicate cannot reach, such as
// campaign_variants.
//
// Must be called INSIDE the transaction that performs the write. Outside it, a
// campaign can enter 'sending' between the check and the write.
func RequireEditable(ctx context.Context, q Querier, tenantID, campaignID string) error {
	dispatched, err := HasDispatched(ctx, q, tenantID, campaignID)
	if err != nil {
		return err
	}
	if dispatched {
		return ErrContentFrozen
	}
	return nil
}
