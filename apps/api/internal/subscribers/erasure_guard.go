// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// rejectErasedAddress refuses a write that would create a subscriber at, or
// move one onto, an address an irreversible erasure tombstone protects.
//
// Every writer in this package asks suppressions.ErasedAddresses, the one
// predicate the CSV import and list membership writers share, rather than
// querying a single store. The stores disagree on shape: a contact delete
// leaves plaintext email_suppressions evidence, while the privacy-request
// worker removes the plaintext and keeps only SHA-256-keyed tombstones in
// subscriber_suppressions and suppressions. A guard that reads one of them
// lets the other kind of erasure be undone by an ordinary add.
//
// Run it inside the tenant-scoped transaction that performs the write so RLS
// confines the evidence to the tenant.
func rejectErasedAddress(ctx context.Context, q suppressions.ErasureQuerier, tenantID, email string) error {
	return rejectErasedAddresses(ctx, q, tenantID, []string{email})
}

// rejectErasedAddresses is rejectErasedAddress for writes that touch several
// addresses at once, such as a merge that links two profiles.
func rejectErasedAddresses(ctx context.Context, q suppressions.ErasureQuerier, tenantID string, emails []string) error {
	erased, err := suppressions.ErasedAddresses(ctx, q, tenantID, emails)
	if err != nil {
		return fmt.Errorf("check erasure tombstones: %w", err)
	}
	if len(erased) > 0 {
		return ErrErasureBlocked
	}
	return nil
}
