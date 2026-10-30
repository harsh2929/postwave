// SPDX-License-Identifier: AGPL-3.0-only

// Package emailidentity owns the canonical mailbox identity accepted by
// subscriber write paths. It intentionally accepts a single ASCII dot-atom
// mailbox only: display-name forms, comments, quoted local parts, controls,
// SMTPUTF8 addresses, and domain literals are not stable subscriber keys.
package emailidentity

import (
	"errors"
	"strings"
	"unicode"
)

var errInvalid = errors.New("email must be a valid mailbox address")

// ContainsControl reports every Unicode control rune, including the ASCII
// vertical-tab/form-feed characters covered by PostgreSQL's POSIX `cntrl`
// constraints. Callers must check the raw value before trimming so controls
// cannot be normalized away at an API or import boundary.
func ContainsControl(raw string) bool {
	for _, r := range raw {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// Normalize returns the lower-cased canonical subscriber key. The bounds are
// the SMTP envelope limits (254-byte address, 64-byte local part) with DNS
// label bounds at the domain boundary.
func Normalize(raw string) (string, error) {
	if ContainsControl(raw) {
		return "", errInvalid
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("email is required")
	}
	if len(raw) > 254 || strings.Count(raw, "@") != 1 {
		return "", errInvalid
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < 0x21 || raw[i] > 0x7e {
			return "", errInvalid
		}
	}
	local, domain, _ := strings.Cut(raw, "@")
	if local == "" || domain == "" || len(local) > 64 || len(domain) > 253 {
		return "", errInvalid
	}
	if local[0] == '.' || local[len(local)-1] == '.' || strings.Contains(local, "..") {
		return "", errInvalid
	}
	for i := 0; i < len(local); i++ {
		if !isDotAtom(local[i]) {
			return "", errInvalid
		}
	}
	// Public marketing identities must have a DNS-shaped domain, not an
	// internal single-label host. Punycode is accepted; raw Unicode is not.
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return "", errInvalid
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errInvalid
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
				(c >= '0' && c <= '9') || c == '-') {
				return "", errInvalid
			}
		}
	}
	return strings.ToLower(local + "@" + domain), nil
}

func isDotAtom(c byte) bool {
	if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
		return true
	}
	return strings.ContainsRune("!#$%&'*+-/=?^_`{|}~.", rune(c))
}
