// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

var ErrBadReferralCookie = errors.New("referrals: bad referral cookie")

// signReferralCookie binds an attribution to the exact referral-code owner.
// v2 deliberately includes the referrer subscriber id in the authenticated
// payload; resolving the code again during credit is a second, independent
// ownership check rather than the only binding.
func signReferralCookie(code, tenantID, referrerSubscriberID string, expires time.Time, secret string) string {
	if strings.TrimSpace(secret) == "" {
		return code
	}
	exp := strconv.FormatInt(expires.Unix(), 10)
	payload := code + "|" + tenantID + "|" + referrerSubscriberID + "|" + exp
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))
	return "v2." + b64(code) + "." + b64(tenantID) + "." + b64(referrerSubscriberID) + "." + exp + "." + sig
}

func parseReferralCookie(value, secret string, now time.Time) (code, tenantID, referrerSubscriberID string, legacy bool, err error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", "", "", false, ErrBadReferralCookie
	}
	if !strings.HasPrefix(value, "v2.") {
		// Unsigned plain-code cookies are retained only for secret-less local
		// development. Once signing is configured, both raw cookies and the
		// former v1 format are expired rather than silently accepted.
		if strings.TrimSpace(secret) != "" || strings.Contains(value, ".") {
			return "", "", "", false, ErrBadReferralCookie
		}
		return value, "", "", true, nil
	}
	if strings.TrimSpace(secret) == "" {
		return "", "", "", false, ErrBadReferralCookie
	}
	parts := strings.Split(value, ".")
	if len(parts) != 6 {
		return "", "", "", false, ErrBadReferralCookie
	}
	code, err = unb64(parts[1])
	if err != nil {
		return "", "", "", false, ErrBadReferralCookie
	}
	tenantID, err = unb64(parts[2])
	if err != nil {
		return "", "", "", false, ErrBadReferralCookie
	}
	referrerSubscriberID, err = unb64(parts[3])
	if err != nil {
		return "", "", "", false, ErrBadReferralCookie
	}
	if strings.TrimSpace(code) == "" || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(referrerSubscriberID) == "" {
		return "", "", "", false, ErrBadReferralCookie
	}
	exp, err := strconv.ParseInt(parts[4], 10, 64)
	if err != nil {
		return "", "", "", false, ErrBadReferralCookie
	}
	if !now.Before(time.Unix(exp, 0)) {
		return "", "", "", false, ErrBadReferralCookie
	}
	payload := code + "|" + tenantID + "|" + referrerSubscriberID + "|" + parts[4]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	want := mac.Sum(nil)
	got, err := hex.DecodeString(parts[5])
	if err != nil || !hmac.Equal(want, got) {
		return "", "", "", false, ErrBadReferralCookie
	}
	return code, tenantID, referrerSubscriberID, false, nil
}

func b64(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func unb64(s string) (string, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
