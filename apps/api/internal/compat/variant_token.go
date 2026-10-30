// SPDX-License-Identifier: AGPL-3.0-only
//
// LAND-037 attribution token. The public serve picks an A/B variant and returns
// an OPAQUE, HMAC-signed token (not the raw variant UUID) that binds the chosen
// variant to the served page for a short window. The renderer echoes the token
// on conversion; the convert handler verifies it and recovers the variant id.
// This makes conversion attribution both functional (the renderer no longer
// needs to know the raw id) and tamper-resistant: a client cannot harvest arm
// UUIDs from the serve response, nor forge a conversion for an arm it was not
// served, nor decouple the arm from the page.
package compat

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
)

// variantTokenTTL bounds how long after a serve a conversion can attribute.
const variantTokenTTL = 6 * time.Hour

// signVariantToken returns "payload.mac" where payload is
// base64url(pageID|variantID|unixExpiry) and mac is base64url(HMAC-SHA256).
// Returns "" when no key is configured (attribution then degrades to
// unattributed conversions, never to trusting client input).
func signVariantToken(key []byte, pageID, variantID string, now time.Time) string {
	if len(key) == 0 || pageID == "" || variantID == "" {
		return ""
	}
	exp := now.Add(variantTokenTTL).Unix()
	payload := pageID + "|" + variantID + "|" + strconv.FormatInt(exp, 10)
	enc := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return enc + "." + macFor(key, enc)
}

// verifyVariantToken checks the token's signature, expiry, and that it was
// minted for pageID, returning the bound variant id. ok is false for any
// malformed/expired/wrong-page/forged token — the caller then records an
// unattributed conversion rather than erroring.
func verifyVariantToken(key []byte, token, pageID string, now time.Time) (variantID string, ok bool) {
	if len(key) == 0 || token == "" {
		return "", false
	}
	enc, mac, found := strings.Cut(token, ".")
	if !found {
		return "", false
	}
	if !hmac.Equal([]byte(mac), []byte(macFor(key, enc))) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return "", false
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 3 {
		return "", false
	}
	if parts[0] != pageID {
		return "", false // token minted for a different page
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || now.Unix() > exp {
		return "", false
	}
	return parts[1], true
}

func macFor(key []byte, enc string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(enc))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
