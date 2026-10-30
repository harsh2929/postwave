// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"strings"

	"github.com/google/uuid"
)

// DeriveDeliveryID allocates the stable ledger primary key before MIME
// composition. The reply-correlation token can therefore authenticate the
// exact delivery row without exposing this UUID on the wire. The derivation is
// an identity function, not an authorization secret; tenant/campaign UUIDs,
// recipient row, and frozen send plan are all length-fixed inputs.
func DeriveDeliveryID(tenantID, campaignID string, campaignRecipientID int64, sendPlanID string) (string, error) {
	tenant, err := canonicalDeliveryUUID(tenantID)
	if err != nil {
		return "", err
	}
	campaign, err := canonicalDeliveryUUID(campaignID)
	if err != nil {
		return "", err
	}
	plan, err := canonicalDeliveryUUID(sendPlanID)
	if err != nil || campaignRecipientID <= 0 {
		return "", errors.New("campaign delivery: invalid deterministic delivery identity")
	}
	hash := sha256.New()
	_, _ = hash.Write([]byte("postwave.campaign-delivery-id.v1\x00"))
	_, _ = hash.Write(tenant[:])
	_, _ = hash.Write(campaign[:])
	var recipient [8]byte
	binary.BigEndian.PutUint64(recipient[:], uint64(campaignRecipientID))
	_, _ = hash.Write(recipient[:])
	_, _ = hash.Write(plan[:])
	sum := hash.Sum(nil)
	var derived uuid.UUID
	copy(derived[:], sum[:16])
	// RFC 9562 version 8 is explicitly application-defined; keep the standard
	// variant bits so generic UUID parsers and PostgreSQL accept the value.
	derived[6] = (derived[6] & 0x0f) | 0x80
	derived[8] = (derived[8] & 0x3f) | 0x80
	return derived.String(), nil
}

func canonicalDeliveryUUID(raw string) (uuid.UUID, error) {
	value := strings.TrimSpace(raw)
	parsed, err := uuid.Parse(value)
	if err != nil || parsed.String() != value {
		return uuid.Nil, errors.New("campaign delivery: canonical UUID required")
	}
	return parsed, nil
}
