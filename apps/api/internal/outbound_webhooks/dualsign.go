// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"time"
)

// signWithKeys produces the X-Postwave-Signature value for body using
// the SigningKeys bundle. When Secondary is set (during the rotation
// grace window), both signatures are merged into one header so
// subscribers can verify against either key.
//
// When both keys use the same algorithm, the header deliberately has
// duplicate v* tags (for example two v1 values during HMAC rotation).
// Verifiers must try every value matching their algorithm and accept
// any valid one. VerifySignatureAlgo implements that rule for HMAC,
// ECDSA, and Ed25519.
type signedEnvelope struct {
	Signature string
	KeyIDs    string
}

func signWithKeys(k *SigningKeys, t time.Time, body []byte) (signedEnvelope, error) {
	primary, err := SignBodyWithAlgorithm(k.Algorithm, k.Primary, t, body)
	if err != nil {
		return signedEnvelope{}, err
	}
	out := signedEnvelope{
		Signature: primary,
		KeyIDs:    "primary=" + signingKeyFingerprint(k.Algorithm, k.Primary),
	}
	if len(k.Secondary) == 0 {
		return out, nil
	}
	secondary, err := SignBodyWithAlgorithm(k.Algorithm, k.Secondary, t, body)
	if err != nil {
		// Secondary failed (corrupt key?) — sign with primary only so
		// the delivery still goes through. Rotation will be cleaned up
		// by the janitor sweep at expiry.
		return out, nil
	}
	merged, err := MergeSignatures(primary, secondary)
	if err != nil {
		return out, nil
	}
	out.Signature = merged
	out.KeyIDs += ",secondary=" + signingKeyFingerprint(k.Algorithm, k.Secondary)
	return out, nil
}
