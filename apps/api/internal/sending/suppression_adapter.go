// SuppressionStoreAdapter bridges a *suppressions.Store into the
// SuppressionChecker interface the send loop depends on. Defined in
// the sending package (not suppressions) so the dependency direction
// stays one-way: suppressions imports nothing from sending; sending
// imports suppressions only here, where the wire-in is explicit.
//
// main.go wraps the real three-store converger with
// NewSuppressionConvergerAdapter and hands it to Guard.Suppressions. The raw
// store adapter remains for narrower deployments/tests.

package sending

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// SuppressionStoreAdapter implements SuppressionChecker by delegating
// to a *suppressions.Store. A nil adapter/store is an unavailable safety
// dependency, never proof that an address is clear.
type SuppressionStoreAdapter struct {
	Store *suppressions.Store
}

// Check satisfies the SuppressionChecker interface.
func (a *SuppressionStoreAdapter) Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error) {
	if a == nil || a.Store == nil {
		return false, nil, ErrSuppressionGateUnavailable
	}
	suppressed, hit, err := a.Store.Check(ctx, tenantID, email)
	if err != nil {
		return false, nil, err
	}
	if !suppressed || hit == nil {
		return suppressed, nil, nil
	}
	return true, &SuppressionEntry{Reason: string(hit.Reason)}, nil
}

// CheckBatch satisfies SuppressionBatchChecker. Store.LookupBulk is a hit-set
// API, so the adapter expands it into the send loop's total-map contract: every
// requested address receives an explicit clear or suppressed decision.
func (a *SuppressionStoreAdapter) CheckBatch(ctx context.Context, tenantID string, emails []string) (map[string]SuppressionDecision, error) {
	if a == nil || a.Store == nil {
		return nil, ErrSuppressionGateUnavailable
	}
	normalized := normalizeSuppressionEmails(emails)
	hits, err := a.Store.LookupBulk(ctx, tenantID, normalized)
	if err != nil {
		return nil, err
	}
	out := make(map[string]SuppressionDecision, len(normalized))
	for _, email := range normalized {
		out[email] = SuppressionDecision{Suppressed: hits[email]}
	}
	return out, nil
}

// NewSuppressionAdapter is the wire-in helper main.go calls.
func NewSuppressionAdapter(store *suppressions.Store) *SuppressionStoreAdapter {
	return &SuppressionStoreAdapter{Store: store}
}

// SuppressionConvergerAdapter implements SuppressionChecker via the
// converger, so the campaign send guard sees rows from ALL THREE
// suppression tables (legacy `suppressions`, `email_suppressions`,
// `subscriber_suppressions`) through v_suppressions_unified. The raw
// *Store adapter above only reads subscriber_suppressions, which let
// CSV/paste-list imports slip past the send loop (P0 D05#1/#2).
type SuppressionConvergerAdapter struct {
	Conv *suppressions.SuppressionConverger
}

// Check satisfies the SuppressionChecker interface. It intentionally uses the
// converger's one-address unified batch query rather than Conv.Check: the send
// loop already performs a total-map batch preflight, and this last-moment clear
// revalidation must stay one bounded query instead of the scalar miss path's
// view + three direct-fallback probes. The unified-view migration is therefore
// a production release prerequisite; any query error propagates fail-closed.
func (a *SuppressionConvergerAdapter) Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error) {
	if a == nil || a.Conv == nil {
		return false, nil, ErrSuppressionGateUnavailable
	}
	key := normalizeSuppressionEmail(email)
	if key == "" {
		return false, nil, nil
	}
	hits, err := a.Conv.LookupBulk(ctx, tenantID, []string{key}, suppressions.ChannelEmail, suppressions.ScopeMarketing)
	if err != nil {
		return false, nil, err
	}
	hit := hits[key]
	if hit == nil {
		return false, nil, nil
	}
	return true, &SuppressionEntry{Reason: string(hit.Reason)}, nil
}

// CheckBatch satisfies SuppressionBatchChecker using the converger's unified
// three-store read. The hit-set response is expanded into a complete decision
// map so omission can never be confused with a proven-clear address.
func (a *SuppressionConvergerAdapter) CheckBatch(ctx context.Context, tenantID string, emails []string) (map[string]SuppressionDecision, error) {
	if a == nil || a.Conv == nil {
		return nil, ErrSuppressionGateUnavailable
	}
	normalized := normalizeSuppressionEmails(emails)
	hits, err := a.Conv.LookupBulk(ctx, tenantID, normalized, suppressions.ChannelEmail, suppressions.ScopeMarketing)
	if err != nil {
		return nil, err
	}
	out := make(map[string]SuppressionDecision, len(normalized))
	for _, email := range normalized {
		decision := SuppressionDecision{}
		if hit := hits[email]; hit != nil {
			decision.Suppressed = true
			decision.Entry = &SuppressionEntry{Reason: string(hit.Reason)}
		}
		out[email] = decision
	}
	return out, nil
}

// NewSuppressionConvergerAdapter wires the converger into the send guard.
func NewSuppressionConvergerAdapter(conv *suppressions.SuppressionConverger) *SuppressionConvergerAdapter {
	return &SuppressionConvergerAdapter{Conv: conv}
}

var (
	_ SuppressionChecker      = (*SuppressionStoreAdapter)(nil)
	_ SuppressionBatchChecker = (*SuppressionStoreAdapter)(nil)
	_ SuppressionChecker      = (*SuppressionConvergerAdapter)(nil)
	_ SuppressionBatchChecker = (*SuppressionConvergerAdapter)(nil)
)
