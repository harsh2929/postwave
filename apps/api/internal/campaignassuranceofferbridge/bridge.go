// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassuranceofferbridge adapts canonical offer storage to the
// storage-neutral Campaign Assurance check boundary.
package campaignassuranceofferbridge

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/offers"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// Bridge deliberately exposes only the narrow canonical binding projection.
// The check engine must not receive the full offer row and accidentally report
// a field the message never rendered as if it appeared in the message.
type Bridge struct {
	Repo *offers.Repo
}

func (b Bridge) ResolveCanonicalOffers(
	ctx context.Context,
	tenantID string,
	document semanticemail.DocumentV2,
) ([]campaignchecks.CanonicalOfferBinding, error) {
	if b.Repo == nil {
		return nil, nil
	}
	references := semanticemail.CanonicalOfferReferences(document)
	if len(references) == 0 {
		// Nil means no bridge was declared. An empty non-nil result would imply
		// that canonical offer resolution ran and every rendered offer agreed.
		return nil, nil
	}
	bindings, err := b.Repo.ResolveSemanticOffers(ctx, tenantID, references)
	if err != nil {
		return nil, err
	}
	out := make([]campaignchecks.CanonicalOfferBinding, 0, len(bindings))
	for _, binding := range bindings {
		mapped := campaignchecks.CanonicalOfferBinding{
			NodeID:           binding.NodeID,
			CanonicalOfferID: binding.CanonicalOfferID,
			Missing:          binding.Missing,
		}
		for _, disagreement := range binding.Disagreements {
			mapped.Disagreements = append(
				mapped.Disagreements,
				campaignchecks.CanonicalOfferDisagreement{
					Field:     disagreement.Field,
					InMessage: disagreement.InMessage,
					Canonical: disagreement.Canonical,
					Detail:    disagreement.Detail,
				},
			)
		}
		out = append(out, mapped)
	}
	return out, nil
}
