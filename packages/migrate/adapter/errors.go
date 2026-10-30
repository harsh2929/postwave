// SPDX-License-Identifier: MIT

package adapter

import (
	"errors"
	"time"
)

// Sentinel errors. Adapters wrap these with fmt.Errorf("...: %w", err) so
// callers can use errors.Is / errors.As to switch on category.
var (
	// ErrAuth means the credentials were rejected or have expired and could
	// not be refreshed. UI should re-trigger the OAuth flow.
	ErrAuth = errors.New("auth failed")

	// ErrUnsupported means the adapter (or feature) is not registered or the
	// source platform doesn't expose the requested capability.
	ErrUnsupported = errors.New("unsupported")

	// ErrSourceUnavailable means the upstream API returned 5xx or timed out.
	// Callers should retry with backoff.
	ErrSourceUnavailable = errors.New("source unavailable")
)

// ErrRateLimited carries the server-suggested wait time. errors.As lets the
// scheduler park the job for RetryAfter before resuming.
type ErrRateLimited struct {
	RetryAfter time.Duration
}

func (e *ErrRateLimited) Error() string {
	return "rate limited; retry after " + e.RetryAfter.String()
}
