// SPDX-License-Identifier: AGPL-3.0-only
package lists

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// SubscriberAddedMembership is the persisted projection required to create a
// canonical list.subscriber.added event. AddedAt is a membership revision,
// never a caller-generated timestamp.
type SubscriberAddedMembership struct {
	SubscriberID string
	Email        string
	ListID       string
	Source       string
	AddedAt      time.Time
}

// MembershipWebhookFanout persists canonical customer-delivery intent inside
// the membership producer's transaction. Implementations must be set based:
// list duplication and merge can create large audiences in one operation.
type MembershipWebhookFanout interface {
	FireListSubscriberAddedBatch(
		ctx context.Context,
		tx pgx.Tx,
		tenantID string,
		events []SubscriberAddedMembership,
	) (int, error)
}

func (r *Repo) fireListSubscriberAddedBatch(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	events []SubscriberAddedMembership,
) error {
	if len(events) == 0 || r == nil || r.MembershipWebhooks == nil {
		return nil
	}
	if _, err := r.MembershipWebhooks.FireListSubscriberAddedBatch(
		ctx, tx, tenantID, events,
	); err != nil {
		return fmt.Errorf("lists: persist list.subscriber.added intents: %w", err)
	}
	return nil
}

func scanSubscriberAddedMemberships(
	rows pgx.Rows,
) ([]SubscriberAddedMembership, error) {
	defer rows.Close()
	events := make([]SubscriberAddedMembership, 0)
	for rows.Next() {
		var event SubscriberAddedMembership
		if err := rows.Scan(
			&event.SubscriberID,
			&event.Email,
			&event.ListID,
			&event.Source,
			&event.AddedAt,
		); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return events, nil
}
