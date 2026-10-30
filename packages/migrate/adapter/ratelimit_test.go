// SPDX-License-Identifier: MIT

package adapter

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTokenBucketDebitRecordsAlreadyIssuedRequestAsDebt(t *testing.T) {
	bucket := NewTokenBucket(1, time.Hour, 1)
	bucket.Debit()
	bucket.Debit()

	bucket.mu.Lock()
	tokens := bucket.tokens
	bucket.mu.Unlock()
	require.Less(t, tokens, 0.0)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	require.ErrorIs(t, bucket.Wait(ctx), context.DeadlineExceeded)
}
