// SPDX-License-Identifier: AGPL-3.0-only
//
// firewall_source.go — adapter that lets the Consent-Safe Activation
// Firewall (feature #2) compute a pre-flight exclusion preview for a sync
// without importing audience_destinations into activation_firewall.
//
// The dependency flows ONE way: audience_destinations imports
// activation_firewall (this file), never the reverse — that keeps the
// firewall a leaf package and avoids an import cycle. This adapter lives
// here because it needs the unexported resolveMembers / verifySourceExists.
package audience_destinations

import (
	"context"
	"errors"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
)

// FirewallMemberSource adapts SyncRunner's member resolution to the
// firewall's MemberSource interface (preview path).
type FirewallMemberSource struct{ runner *SyncRunner }

// NewFirewallMemberSource wraps a SyncRunner as an activation_firewall
// MemberSource.
func NewFirewallMemberSource(r *SyncRunner) *FirewallMemberSource {
	return &FirewallMemberSource{runner: r}
}

// SyncActivationContext returns (emails, destinationType, purposeOverride,
// ok, err) for a sync. ok=false (with nil err) means the source is
// unresolvable (deleted list/segment) — the firewall renders the
// -1 sentinel preview rather than a fabricated zero.
func (s *FirewallMemberSource) SyncActivationContext(ctx context.Context, tenantID, syncID string) ([]string, string, string, bool, error) {
	sync, err := s.runner.Repo.GetSync(ctx, tenantID, syncID)
	if err != nil {
		// Translate the not-found sentinel across the boundary. The consumer
		// cannot import this package -- the dependency runs one way, and the
		// reverse edge is a compile-time cycle -- so it can only recognise
		// activation_firewall.ErrNotFound. Without this the caller saw an
		// opaque error and had to report an absent sync as a 500.
		if errors.Is(err, ErrNotFound) {
			return nil, "", "", false, fmt.Errorf("%w: audience sync %s", activation_firewall.ErrNotFound, syncID)
		}
		return nil, "", "", false, err
	}
	if verr := s.runner.verifySourceExists(ctx, tenantID, sync); verr != nil {
		// Ghost source → unresolvable (-1 sentinel upstream), not an error.
		return nil, sync.Destination.Type, sync.RequiredConsentPurpose, false, nil
	}
	members, _, merr := s.runner.resolveMembers(ctx, tenantID, sync)
	if merr != nil {
		return nil, sync.Destination.Type, sync.RequiredConsentPurpose, false, nil
	}
	emails := make([]string, 0, len(members))
	for _, m := range members {
		emails = append(emails, m.Email)
	}
	return emails, sync.Destination.Type, sync.RequiredConsentPurpose, true, nil
}

var _ activation_firewall.MemberSource = (*FirewallMemberSource)(nil)
