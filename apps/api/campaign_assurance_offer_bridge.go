// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceofferbridge"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/offers"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// canonicalOfferBridge adapts the offers repository to the assurance worker's
// resolver seam (PRD F15).
//
// The adapter lives in the composition root because it is the only place both
// packages are already known. internal/campaignassuranceworker must not depend
// on offer storage, and internal/offers must not know that assurance exists;
// the seam between them is one interface and this ten-line translation.
//
// It maps offers.CanonicalBinding into the neutral campaignchecks type rather
// than passing the richer one through. That is deliberate: the richer binding
// carries the whole *Offer, and handing that to the check engine would let a
// future rule read a field the sender never rendered and report on it as though
// the message had said it.
type canonicalOfferBridge struct {
	repo *offers.Repo
}

func (b canonicalOfferBridge) ResolveCanonicalOffers(
	ctx context.Context, tenantID string, document semanticemail.DocumentV2,
) ([]campaignchecks.CanonicalOfferBinding, error) {
	return (campaignassuranceofferbridge.Bridge{Repo: b.repo}).ResolveCanonicalOffers(
		ctx, tenantID, document,
	)
}
