// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

// RegistrySource adapts the secret-backed seed registry without exposing its
// addresses through the API gateway or persistence. ConnectorKind is safe
// operational provenance (for example imap/vendor), never a credential.
type RegistrySource struct {
	Registry      *seedlist.Registry
	Connector     seedlist.Connector
	ConnectorKind string
	Clock         func() time.Time
}

func (s RegistrySource) ActiveSeeds(_ context.Context) ([]Seed, error) {
	if s.Registry == nil {
		return nil, errors.New("seed registry is unavailable")
	}
	out := make([]Seed, 0)
	for _, inbox := range s.Registry.All() {
		if inbox == nil || inbox.Status != seedlist.StatusActive {
			continue
		}
		out = append(out, Seed{
			MailboxID: strings.TrimSpace(inbox.ID), Provider: strings.TrimSpace(string(inbox.Provider)),
			Address: strings.TrimSpace(inbox.Address), RegistryVersionID: strings.TrimSpace(inbox.RegistryVersionID),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MailboxID < out[j].MailboxID })
	return out, nil
}

func (s RegistrySource) CapabilitySnapshot(_ context.Context) (inboxrealitycontract.CapabilitySnapshot, error) {
	capabilities := seedlist.CapabilitiesOf(s.Connector)
	now := time.Now().UTC()
	if s.Clock != nil {
		now = s.Clock().UTC()
	}
	return inboxrealitycontract.CapabilitySnapshot{
		Version: "postwave.seed-capability-snapshot.v1", Connector: strings.TrimSpace(s.ConnectorKind),
		Placement: string(capabilities.Placement), Headers: string(capabilities.Headers),
		RawMIME: string(capabilities.RawMIME), BodyParts: string(capabilities.BodyParts),
		ObservedSurface: string(capabilities.ObservedSurface), CapturedAt: now,
	}, nil
}
