// SPDX-License-Identifier: AGPL-3.0-only
//
// erasure_guard.go — an erased address is never re-imported.
//
// Deleting a contact, or fulfilling a privacy (DSAR) erasure, leaves a
// tombstone for the address. Every single-row writer refuses such an address
// with erasure_blocked; the batch import must too, in the preflight (so Review
// shows the rows that will fail) and again at execution, inside the chunk's
// serializable transaction (so a tombstone written after the preflight still
// wins). suppressions.ErasedAddresses is the one erasure predicate both use.

package subscriber_import

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// rowCodeErasureBlocked matches the code the single-row subscriber writers
// return for the same condition, so every surface explains it the same way.
const rowCodeErasureBlocked = "erasure_blocked"

// rowMessageErasureBlocked is fixed text: the error log is privacy-safe and
// never repeats the address it refers to.
const rowMessageErasureBlocked = "This address was permanently erased by a contact deletion or privacy request and can't be re-imported."

// erasedImportAddresses reports which of the file's unique identities carry an
// erasure tombstone, read in its own tenant-scoped transaction.
func (d *Deps) erasedImportAddresses(ctx context.Context, tenantID string, emails []string) (map[string]struct{}, error) {
	if len(emails) == 0 {
		return map[string]struct{}{}, nil
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	erased, err := suppressions.ErasedAddresses(ctx, tx, tenantID, emails)
	if err != nil {
		return nil, fmt.Errorf("check erased import addresses: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return erased, nil
}

// withoutErasedCandidates splits a chunk's accepted rows into the ones that may
// be written and a privacy-safe row failure for each erased one. It never
// mutates accepted, so a retried serializable attempt starts from the same
// candidates.
func withoutErasedCandidates(accepted []preparedRow, erased map[string]struct{}) ([]preparedRow, []rowError) {
	if len(erased) == 0 {
		return accepted, nil
	}
	writable := make([]preparedRow, 0, len(accepted))
	var blocked []rowError
	for _, candidate := range accepted {
		if _, isErased := erased[candidate.Email]; isErased {
			blocked = append(blocked, rowError{
				RowNumber: candidate.RowNumber,
				Code:      rowCodeErasureBlocked,
				Message:   rowMessageErasureBlocked,
			})
			continue
		}
		writable = append(writable, candidate)
	}
	return writable, blocked
}
