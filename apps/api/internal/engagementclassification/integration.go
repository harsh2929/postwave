// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// AggregateBuilder lets a provider adapter add message-level behavior it has
// already resolved (all-links fetch, burst, compatible open/click families).
// Returning a zero aggregate is valid and widens the unknown band.
type AggregateBuilder interface {
	BuildEngagementAggregate(
		ctx context.Context,
		tx pgx.Tx,
		tenantID string,
		observation ObservationInput,
	) (MessageAggregate, error)
}

type AggregateBuilderFunc func(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observation ObservationInput,
) (MessageAggregate, error)

func (fn AggregateBuilderFunc) BuildEngagementAggregate(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observation ObservationInput,
) (MessageAggregate, error) {
	return fn(ctx, tx, tenantID, observation)
}

// IngestHook is the production composition boundary. Provider packages need
// only this narrow method; they do not import classifier rules or registry
// storage. Record must be invoked after INSERT ... RETURNING the canonical
// subscriber event and before committing that same tenant-worker transaction.
type IngestHook struct {
	Repo             *Repo
	Classifier       *Classifier
	AggregateBuilder AggregateBuilder
}

func (hook *IngestHook) Record(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observation ObservationInput,
) (RecordReceipt, error) {
	if hook == nil || hook.Repo == nil || hook.Classifier == nil {
		return RecordReceipt{}, fmt.Errorf("%w: F01 ingest hook is not configured", ErrInvalidInput)
	}
	aggregate := MessageAggregate{}
	if hook.AggregateBuilder != nil {
		var err error
		aggregate, err = hook.AggregateBuilder.BuildEngagementAggregate(
			ctx, tx, tenantID, observation,
		)
		if err != nil {
			return RecordReceipt{}, fmt.Errorf("build engagement aggregate: %w", err)
		}
	}
	return hook.Repo.RecordInTx(
		ctx, tx, tenantID, observation, aggregate, hook.Classifier,
	)
}
