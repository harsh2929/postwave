// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// suppressionLookupTimeout bounds the dependency read for an entire
	// claimed send batch. A timeout is an unknown decision and therefore a
	// denial for this drain attempt; the caller releases the claims to pending.
	suppressionLookupTimeout = 10 * time.Second
	// suppressionLookupChunkSize prevents an accidentally oversized Guard
	// BatchSize from producing an unbounded SQL array / response map. The
	// default send batch is 50, so normal operation remains one round trip.
	suppressionLookupChunkSize = 250
)

var (
	ErrSuppressionGateUnavailable = errors.New("sendloop: suppression gate unavailable")
	ErrSuppressionBatchIncomplete = errors.New("sendloop: suppression batch response incomplete")
)

// SuppressionDecision is a complete, explicit send-time decision for one
// normalized email. A clear decision is represented by Suppressed=false; a
// missing map key is never interpreted as clear.
type SuppressionDecision struct {
	Suppressed bool
	Entry      *SuppressionEntry
}

// SuppressionBatchChecker is the optional bounded batch surface used by the
// send loop. Implementations MUST return one key for every non-empty normalized
// input address. This total-map contract distinguishes a proven clear result
// from an accidentally omitted decision.
type SuppressionBatchChecker interface {
	CheckBatch(ctx context.Context, tenantID string, emails []string) (map[string]SuppressionDecision, error)
}

func normalizeSuppressionEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func normalizeSuppressionEmails(emails []string) []string {
	seen := make(map[string]struct{}, len(emails))
	out := make([]string, 0, len(emails))
	for _, email := range emails {
		key := normalizeSuppressionEmail(email)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

// lookupSuppression centralizes the scalar fail-closed contract. In
// particular, a buggy checker cannot smuggle a clear result alongside an
// error: any error makes the decision unknown and the caller withholds.
func lookupSuppression(
	ctx context.Context,
	checker SuppressionChecker,
	tenantID, email string,
) (bool, *SuppressionEntry, error) {
	if checker == nil {
		return false, nil, ErrSuppressionGateUnavailable
	}
	suppressed, entry, err := checker.Check(ctx, tenantID, email)
	if err != nil {
		return false, nil, err
	}
	return suppressed, entry, nil
}

// prefetchSuppressionDecisions resolves a complete batch when the configured
// checker exposes the optional batch surface. Unsupported batch lookup is not
// an error: RunOnce uses the scalar fail-closed path instead. Batch errors and
// incomplete maps are returned to RunOnce, which releases every claimed row
// immediately and surfaces the outage to the worker loop.
func (g *Guard) prefetchSuppressionDecisions(
	ctx context.Context,
	tenantID string,
	emails []string,
) (map[string]SuppressionDecision, bool, error) {
	if g == nil || g.Suppressions == nil {
		return nil, false, ErrSuppressionGateUnavailable
	}
	normalized := normalizeSuppressionEmails(emails)
	if len(normalized) == 0 {
		return map[string]SuppressionDecision{}, true, nil
	}
	batchChecker, ok := g.Suppressions.(SuppressionBatchChecker)
	if !ok {
		return nil, false, nil
	}

	lookupCtx, cancel := context.WithTimeout(ctx, suppressionLookupTimeout)
	defer cancel()
	out := make(map[string]SuppressionDecision, len(normalized))
	for start := 0; start < len(normalized); start += suppressionLookupChunkSize {
		end := start + suppressionLookupChunkSize
		if end > len(normalized) {
			end = len(normalized)
		}
		chunk := normalized[start:end]
		decisions, err := batchChecker.CheckBatch(lookupCtx, tenantID, chunk)
		if err != nil {
			return nil, true, fmt.Errorf("suppression batch lookup: %w", err)
		}
		for _, email := range chunk {
			decision, present := decisions[email]
			if !present {
				return nil, true, fmt.Errorf("%w: one or more requested addresses were omitted", ErrSuppressionBatchIncomplete)
			}
			out[email] = decision
		}
	}
	return out, true, nil
}
