// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrActionBindingStale = errors.New("offers: action resource is stale or unavailable")
	ErrDeclineConflict    = errors.New("offers: decline receipt conflicts with an earlier decision")
)

// BindActionResource freezes the complete canonical offer row into the ticket.
// A later title, price, terms, inventory, validity, URL, or metadata change
// therefore invalidates the bearer instead of applying an old decision to a
// newly-defined offer. The ticket expiry is shortened to the offer deadline.
func (r *Repo) BindActionResource(
	ctx context.Context,
	tenantID, action, resourceKind, resourceID string,
) (actionticket.ResourceBinding, error) {
	if r == nil || r.Pool == nil || action != "offer.decline" || resourceKind != "offer" {
		return actionticket.ResourceBinding{}, ErrActionBindingStale
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return actionticket.ResourceBinding{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	binding, err := readActionBinding(ctx, tx, tenantID, resourceID, r.now())
	if err != nil {
		return actionticket.ResourceBinding{}, err
	}
	return binding, tx.Commit(ctx)
}

// RecordTicketDecline persists the sole side effect authorised by
// offer.decline. It is crash-idempotent: replaying the same ticket after the
// domain commit, or declining the same exact offer version from a second
// notification, observes the existing receipt as success. A different offer
// version never gets folded into the earlier decision.
func (r *Repo) RecordTicketDecline(
	ctx context.Context,
	tenantID, offerID, userID, ticketID, resourceVersion string,
) error {
	if r == nil || r.Pool == nil || !canonicalUUID(tenantID) || !canonicalUUID(offerID) ||
		!canonicalUUID(userID) || !canonicalUUID(ticketID) || !lowerSHA256(resourceVersion) {
		return ErrActionBindingStale
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	binding, err := readActionBinding(ctx, tx, tenantID, offerID, r.now())
	if err != nil {
		return err
	}
	if binding.Version != resourceVersion {
		return ErrActionBindingStale
	}
	decidedAt := r.now()
	tag, err := tx.Exec(ctx, `
INSERT INTO offer_decline_decisions (
    tenant_id, offer_id, user_id, action_ticket_id, offer_version_hash,
    decided_at
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)
ON CONFLICT (tenant_id, offer_id, user_id) DO NOTHING`,
		tenantID, offerID, userID, ticketID, resourceVersion, decidedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var storedVersion string
		if err := tx.QueryRow(ctx, `
SELECT offer_version_hash
  FROM offer_decline_decisions
 WHERE tenant_id = $1::uuid AND offer_id = $2::uuid AND user_id = $3::uuid`,
			tenantID, offerID, userID).Scan(&storedVersion); err != nil {
			return ErrDeclineConflict
		}
		if storedVersion != resourceVersion {
			return ErrDeclineConflict
		}
	}
	return tx.Commit(ctx)
}

type actionBindingQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readActionBinding(
	ctx context.Context,
	query actionBindingQuerier,
	tenantID, offerID string,
	now time.Time,
) (actionticket.ResourceBinding, error) {
	var canonicalRow string
	var validFrom, validUntil *time.Time
	var inventoryState, actionURL string
	err := query.QueryRow(ctx, `
SELECT to_jsonb(offer)::text, offer.valid_from, offer.valid_until,
       offer.inventory_state, offer.action_url
  FROM offers AS offer
 WHERE offer.tenant_id = $1::uuid AND offer.id = $2::uuid
 FOR SHARE OF offer`, tenantID, offerID).
		Scan(&canonicalRow, &validFrom, &validUntil, &inventoryState, &actionURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return actionticket.ResourceBinding{}, ErrActionBindingStale
	}
	if err != nil {
		return actionticket.ResourceBinding{}, err
	}
	now = now.UTC()
	if validFrom != nil && now.Before(validFrom.UTC()) ||
		validUntil != nil && !now.Before(validUntil.UTC()) ||
		inventoryState != "in_stock" && inventoryState != "limited" ||
		!validOfferHTTPSURL(actionURL) {
		return actionticket.ResourceBinding{}, ErrActionBindingStale
	}
	digest := sha256.Sum256([]byte(canonicalRow))
	version := hex.EncodeToString(digest[:])
	return actionticket.ResourceBinding{Version: version, ValidUntil: validUntil}, nil
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func lowerSHA256(value string) bool {
	return len(value) == 64 && strings.Trim(value, "0123456789abcdef") == ""
}

var _ actionticket.ResourceBinder = (*Repo)(nil)
