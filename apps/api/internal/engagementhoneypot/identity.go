// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// RecipientIdentity derives the pseudonymous recipient identifier a decoy
// carries.
//
// It is computed from the internal campaign-recipient row id, never from the
// address. That is not merely a privacy nicety: the decoy URL crosses every hop
// between us and the mailbox — including the security gateways whose behaviour
// we are trying to measure — so an address in it would be handed to exactly the
// parties we are studying.
//
// Keyed with the honeypot signing secret, so the identifier is not reversible
// or enumerable by anyone who merely knows how many recipients a campaign had.
//
// The value is stable for one recipient of one campaign and unrelated to the
// same person's identifier in any other campaign. That is the right grain:
// the calibration sampling unit is a recipient-campaign, and an identifier that
// followed a person across sends would build a cross-campaign profile the
// evidence does not need.
func (m *Minter) RecipientIdentity(tenantID string, campaignRecipientID int64) string {
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte("postwave.honeypot.recipient.v1"))
	mac.Write([]byte{0x1f})
	mac.Write([]byte(tenantID))
	mac.Write([]byte{0x1f})
	mac.Write([]byte(strconv.FormatInt(campaignRecipientID, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}
