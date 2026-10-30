// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"log/slog"
	"time"
)

// SendMinter adapts the token minter to the campaign send runtime, producing
// the decoy markup embedded in one recipient's HTML.
//
// It exists so the send path holds no opinion about how a decoy is hidden or
// whether that hiding can certify a label. Those decisions live in exactly one
// place — Technique.Certifies and Build — and everything downstream inherits
// them.
type SendMinter struct {
	Minter  *Minter
	BaseURL string
	Logger  *slog.Logger
}

// MintDecoys returns the markup for every certifying technique.
//
// It never returns an error. A decoy is measurement, and a send that fails
// because the instrument failed is strictly worse than a send carrying one
// fewer label — so a misconfiguration degrades to "no decoy this message" and
// is logged rather than surfaced. The signature keeps the error for the
// interface's sake and for a future caller that wants to distinguish the cases.
func (s *SendMinter) MintDecoys(
	tenantID, campaignID string, campaignRecipientID int64, issuedAt time.Time,
) ([]string, error) {
	if s == nil || s.Minter == nil || s.BaseURL == "" {
		return nil, nil
	}
	decoys, err := Build(s.Minter, Claim{
		TenantID:              tenantID,
		CampaignID:            campaignID,
		RecipientIdentityHMAC: s.Minter.RecipientIdentity(tenantID, campaignRecipientID),
		IssuedAt:              issuedAt,
	}, s.BaseURL)
	if err != nil {
		if s.Logger != nil {
			// Campaign id only. The recipient identifier is pseudonymous but
			// still per-person, and a log line is a wider audience than the
			// evidence table.
			s.Logger.Warn("honeypot decoy minting failed; sending without a decoy",
				"campaign_id", campaignID, "err", err)
		}
		return nil, nil
	}
	markup := make([]string, 0, len(decoys))
	for _, decoy := range decoys {
		markup = append(markup, string(decoy.HTMLMarkup))
	}
	return markup, nil
}
