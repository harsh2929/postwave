// SPDX-License-Identifier: AGPL-3.0-only

package track

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// A tenant's own events become reportable metrics.
//
// metric_definitions has existed complete — unique on (tenant_id, key), RLS on
// both directions, grants, four CHECK constraints, and a `source` enum whose
// values include 'track' — and had zero Go references and zero rows. Everything
// about it was built except the one line that writes to it, which is the
// purest form of the failure this ledger catalogues: a table that survives
// every schema review because there is nothing wrong with it.
//
// It is NOT a duplicate of report_metric_registry. That table holds metrics an
// operator CURATED; this one holds metrics the product DISCOVERED, which is why
// it carries event_name, property_path, first_seen_at and last_seen_at and the
// other does not. Discovery feeds curation.
//
// The reason this matters to a person: today a tenant who sends
// `checkout_completed` through the track API can see it counted in the event
// stream but cannot build a report on it, because the reporting metric registry
// only knows metrics somebody hardcoded in Go. Every custom event was a
// second-class citizen of the analytics product.

// discoveredMetricPrefix namespaces discovered metrics away from built-in keys.
//
// Without it a tenant sending an event called `campaign.opened` would collide
// with the built-in metric of that name and silently redefine what an open is
// for their reports. The prefix makes that impossible rather than unlikely.
const discoveredMetricPrefix = "track."

// DiscoveredMetricKey is the registry key for one observed event name.
func DiscoveredMetricKey(eventName string) string {
	return discoveredMetricPrefix + strings.TrimSpace(eventName)
}

// RecordMetricDiscovery notes that an event name exists and is countable.
//
// Runs on the caller's tx, on the ingest path, so it is deliberately ONE upsert
// with no read: the common case is an event name seen ten thousand times a day,
// where the row already exists and this is a single indexed UPDATE of
// last_seen_at.
//
// first_seen_at is preserved on conflict. It is the only column here that
// cannot be recomputed later — "we have been receiving this since March" is not
// derivable from an event stream that has been partially pruned — while
// last_seen_at is refreshed so a metric that stopped arriving is visible as
// stale rather than merely present.
//
// Best-effort by contract: callers must not fail an event ingest because the
// catalogue could not be updated. Losing an event is worse than losing a
// catalogue entry that the next event will recreate.
func RecordMetricDiscovery(ctx context.Context, tx pgx.Tx, tenantID, eventName string) error {
	name := strings.TrimSpace(eventName)
	if name == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `
INSERT INTO metric_definitions
    (tenant_id, key, label, source, event_name, aggregation, value_type, status,
     first_seen_at, last_seen_at)
VALUES ($1::uuid, $2, $3, 'track', $4, 'count', 'number', 'active', now(), now())
ON CONFLICT (tenant_id, key) DO UPDATE SET
    last_seen_at = now(),
    updated_at   = now()`,
		tenantID, DiscoveredMetricKey(name), name, name)
	return err
}
