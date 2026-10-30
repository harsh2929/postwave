// Package reputation aggregates external reputation signals (Google
// Postmaster, Microsoft SNDS, SenderScore, DNSBLs) into a single Reputation
// snapshot. The Source interface lets us swap individual providers — e.g.
// drop Validity if pricing changes — without touching the aggregator.
package reputation

import (
	"context"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Source is one external reputation provider.
type Source interface {
	// Name is a short stable id used for logs and metrics.
	Name() string
	// Fetch returns whatever subset of Reputation this source can populate.
	// The aggregator will merge non-zero fields.
	Fetch(ctx context.Context, domainName, ip string) (domain.Reputation, error)
}
