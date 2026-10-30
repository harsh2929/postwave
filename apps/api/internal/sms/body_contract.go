// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// One contract governs every canonical sms_messages writer and the private
// inbox projection. Bytes bound storage/provider payload size; runes bound
// operator rendering cost without conflating astral code points with bytes.
const (
	SMSInboxBodyMaxBytes = 16 << 10
	SMSInboxBodyMaxRunes = 4800
)

var ErrSMSBodyOutsideContract = errors.New("SMS body is outside the canonical inbox contract")

func validSMSInboxBody(body string, allowEmpty bool) bool {
	if !utf8.ValidString(body) || len(body) > SMSInboxBodyMaxBytes ||
		utf8.RuneCountInString(body) > SMSInboxBodyMaxRunes ||
		strings.ContainsRune(body, '\x00') {
		return false
	}
	return allowEmpty || strings.TrimSpace(body) != ""
}
