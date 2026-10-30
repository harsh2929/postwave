// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"fmt"
	"time"
)

// FetchLister is the read side the exporter needs. Repo satisfies it.
type FetchLister interface {
	ListFetches(ctx context.Context, tenantID string, from, until time.Time, limit int) ([]Fetch, error)
}

// ExportSummary reports what the export actually covered.
//
// Dropped is stated rather than swallowed. A run that silently discards rows
// reads afterwards as "we exported everything", and a corpus that quietly lost
// evidence is indistinguishable from one whose evidence never arrived.
type ExportSummary struct {
	FetchesRead          int
	Examples             int
	DroppedNonCertifying int
	Truncated            bool
}

// ExportTenantCorpus reads one tenant's honeypot evidence for a window and
// writes a controlled-machine calibration corpus.
//
// Rows whose technique cannot certify are dropped and counted rather than
// failing the run. The stricter behaviour belongs at the write boundary, where
// Repo.RecordFetch and a CHECK constraint already refuse them; failing a whole
// quarter's export because one legacy row exists would throw away good evidence
// to punish a bad one.
func ExportTenantCorpus(
	ctx context.Context,
	lister FetchLister,
	directory, tenantID string,
	from, until time.Time,
	limit int,
	options CorpusOptions,
) (ExportSummary, error) {
	var summary ExportSummary
	if lister == nil {
		return summary, fmt.Errorf("%w: honeypot fetch lister is required", ErrInvalidInput)
	}
	if !until.After(from) {
		return summary, fmt.Errorf("%w: honeypot export window must be non-empty", ErrInvalidInput)
	}
	fetches, err := lister.ListFetches(ctx, tenantID, from, until, limit)
	if err != nil {
		return summary, err
	}
	summary.FetchesRead = len(fetches)
	// A full page means there may be more evidence than this corpus contains.
	// Saying so keeps a partial quarter from being read as a complete one.
	summary.Truncated = limit > 0 && len(fetches) >= limit

	certifying := make([]Fetch, 0, len(fetches))
	for _, fetch := range fetches {
		if !fetch.Claim.Technique.Certifies() {
			summary.DroppedNonCertifying++
			continue
		}
		certifying = append(certifying, fetch)
	}
	if len(certifying) == 0 {
		return summary, fmt.Errorf("%w: no certifying honeypot evidence in the window", ErrInvalidInput)
	}
	if err := ExportCorpus(directory, options, certifying); err != nil {
		return summary, err
	}
	// Recomputed from the collapse rather than assumed equal to the input:
	// repeat fetches of one recipient are one observation.
	examples, err := collapseToObservations(certifying, options.Provider)
	if err != nil {
		return summary, err
	}
	summary.Examples = len(examples)
	return summary, nil
}
