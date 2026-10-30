// SPDX-License-Identifier: AGPL-3.0-only

package pushauthoritylock

import (
	"context"
	"errors"
	"testing"
)

func TestEnsureMutationAllowedRejectsSendLeaseCallbackContext(t *testing.T) {
	if err := EnsureMutationAllowed(context.Background()); err != nil {
		t.Fatalf("ordinary context unexpectedly rejected: %v", err)
	}

	leaseCtx := SendLeaseCallbackContext(context.Background())
	if err := EnsureMutationAllowed(leaseCtx); !errors.Is(err, ErrMutationDuringSendLease) {
		t.Fatalf("lease callback mutation error = %v, want %v", err, ErrMutationDuringSendLease)
	}
	if err := EnsureSendLeaseAllowed(leaseCtx); !errors.Is(err, ErrReentrantSendLease) {
		t.Fatalf("re-entrant lease error = %v, want %v", err, ErrReentrantSendLease)
	}
	if err := EnsureSendLeaseAllowed(context.Background()); err != nil {
		t.Fatalf("ordinary lease acquisition unexpectedly rejected: %v", err)
	}
}
