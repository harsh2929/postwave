// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/replies"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// initializeEngagementClassificationRuntime is the sole production startup
// boundary for Track B F01. The off path reads only its feature flag. The on
// path validates the dedicated HMAC identity key and then proves migration
// 1934 plus the exact immutable registry through the restricted app pool.
func initializeEngagementClassificationRuntime(
	ctx context.Context,
	pool *db.Pool,
	getenv func(string) string,
) (*engagementclassification.Runtime, error) {
	configuration, err := engagementclassification.RuntimeConfigurationFromEnvironment(getenv)
	if err != nil {
		return nil, fmt.Errorf("engagement classification configuration: %w", err)
	}
	if !configuration.Enabled {
		return nil, nil
	}
	runtime, err := engagementclassification.BuildRuntime(ctx, configuration, pool)
	if err != nil {
		return nil, fmt.Errorf("engagement classification startup readiness: %w", err)
	}
	return runtime, nil
}

// engagementClassifierForDeps converts the runtime into the interface value the
// Listmonk ingest handler holds, WITHOUT letting a disabled runtime become a
// non-nil interface.
//
// This exists because of a real defect. `initializeEngagementClassificationRuntime`
// returns an untyped nil *Runtime when the feature flag is off — the default —
// and assigning that pointer straight into an interface-typed field produces an
// interface that is NOT nil. The handler's `if d.EngagementClassifier != nil`
// guard therefore passed with the feature disabled, `RecordProviderEvent`
// returned ErrRuntimeDisabled, and the handler wrapped that as a fatal persist
// error: every engagement event on the Listmonk path failed to store, the batch
// was marked failed, and the provider retried it forever.
//
// The composition test only ever set the flag to "true", so the broken path was
// the one nobody exercised. Returning an explicit nil interface here is the fix;
// the accompanying test asserts the nil-ness rather than the behaviour, because
// the behaviour is only observable through a database transaction.
func engagementClassifierForDeps(
	runtime *engagementclassification.Runtime,
) listmonk_events.TransactionalEngagementClassifier {
	if runtime == nil {
		return nil
	}
	return runtime
}

// espEngagementClassifierForDeps is engagementClassifierForDeps for the ESP
// webhook path.
//
// A second function rather than a generic one because the two packages declare
// their own narrow interfaces — the shape is identical and the types are not, and
// a shared type would couple internal/webhooks to internal/listmonk_events for
// no benefit. The typed-nil hazard is the same in both, which is the only reason
// this needs to exist at all.
func espEngagementClassifierForDeps(
	runtime *engagementclassification.Runtime,
) webhooks.TransactionalEngagementClassifier {
	if runtime == nil {
		return nil
	}
	return runtime
}

// subscriberEngagementClassifierForDeps is the third typed-nil converter.
//
// Four near-identical functions exist because four packages declare their own
// narrow interface for the same contract — the shapes match and the Go types do
// not. A shared type would couple internal/subscribers to internal/listmonk_events
// for no benefit, and the alternative (assigning the concrete pointer directly)
// is the exact typed-nil bug that broke every engagement event with the feature
// disabled. Duplicating four tiny converters is the cheaper mistake.
func subscriberEngagementClassifierForDeps(
	runtime *engagementclassification.Runtime,
) subscribers.TransactionalEngagementClassifier {
	if runtime == nil {
		return nil
	}
	return runtime
}

// replyEngagementClassifierForDeps preserves the same typed-nil guarantee for
// the canonical inbound-reply writer. A disabled F01 runtime means replies are
// retained and header-classified, but no canonical human-engagement assertion
// is emitted without its atomic observation/classification.
func replyEngagementClassifierForDeps(
	runtime *engagementclassification.Runtime,
) replies.TransactionalEngagementClassifier {
	if runtime == nil {
		return nil
	}
	return runtime
}
