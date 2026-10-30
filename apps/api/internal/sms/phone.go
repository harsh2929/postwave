package sms

import (
	"fmt"
	"strings"
	"unicode/utf16"
)

var optOutKeywords = map[string]bool{
	"STOP":        true,
	"STOPALL":     true,
	"UNSUBSCRIBE": true,
	"END":         true,
	"QUIT":        true,
	"REVOKE":      true,
	"OPTOUT":      true,
	"CANCEL":      true,
}

// NormalizePhoneUSCA converts a US/Canada phone number to E.164. The first
// SMS launch surface is intentionally US/Canada-only because A2P 10DLC,
// toll-free verification, quiet hours, and carrier behavior are country
// specific.
func NormalizePhoneUSCA(raw string) (string, error) {
	// ASCII spaces are a reviewed display separator. Do not use TrimSpace:
	// accepting tabs/newlines/Unicode spacing would reintroduce control and
	// format-character canonicalisation.
	raw = strings.Trim(raw, " ")
	if raw == "" {
		return "", fmt.Errorf("phone is required")
	}
	var digits strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c >= '0' && c <= '9':
			digits.WriteByte(c)
		case c == '+' && i == 0:
			// A single leading plus is the only accepted international marker.
		case c == ' ' || c == '(' || c == ')' || c == '-' || c == '.':
			// Reviewed display separators only. In particular, do not silently
			// discard letters, Unicode digits, bidi marks, controls, or an
			// interior/repeated plus and turn attacker input into a recipient.
		default:
			return "", fmt.Errorf("phone contains an unsupported character")
		}
	}
	s := digits.String()
	if len(s) == 11 && strings.HasPrefix(s, "1") {
		s = s[1:]
	}
	// NANP area codes and central-office codes cannot start with 0 or 1. Keep this identical to the
	// sms_messages write CHECK so malformed recipients fail as typed request
	// validation before any database or provider side effect.
	if len(s) == 10 && ((s[0] < '2' || s[0] > '9') || (s[3] < '2' || s[3] > '9')) {
		return "", fmt.Errorf("phone must use valid US/Canada area and exchange codes")
	}
	switch {
	case len(s) == 10:
		return "+1" + s, nil
	default:
		return "", fmt.Errorf("phone must be a US/Canada number in E.164 or 10-digit format")
	}
}

func ClassifyInbound(body string) string {
	// Carrier fallback classification is deliberately exact and single-word.
	// Provider-authenticated classification (for example Twilio OptOutType)
	// is handled by the webhook adapter and takes precedence over this fallback.
	keyword := strings.ToUpper(strings.TrimSpace(body))
	if keyword == "" || strings.ContainsAny(keyword, " \t\r\n\v\f\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000") {
		return "message"
	}
	if optOutKeywords[keyword] {
		return ConsentRevoked
	}
	switch keyword {
	case "START", "UNSTOP":
		return ConsentGranted
	case "HELP":
		return ConsentHelpRequested
	default:
		return "message"
	}
}

const gsm7BasicCharacters = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"

const gsm7ExtensionCharacters = "^{}\\[~]|€\f"

func gsm7Septets(body string) (int, bool) {
	septets := 0
	for _, r := range body {
		switch {
		case strings.ContainsRune(gsm7BasicCharacters, r):
			septets++
		case strings.ContainsRune(gsm7ExtensionCharacters, r):
			septets += 2
		default:
			return 0, false
		}
	}
	return septets, true
}

func SegmentCount(body string) int {
	if body == "" {
		return 0
	}
	units, gsm7 := gsm7Septets(body)
	single, concat := 160, 153
	if !gsm7 {
		// SMS UCS-2 accounting is by UTF-16 code unit, not Go rune. Astral
		// characters therefore consume two units. Providers may further vary
		// encoding; reservations use this conservative protocol calculation and
		// reconcile against the provider's exact receipt.
		units = 0
		for _, r := range body {
			units += utf16.RuneLen(r)
		}
		single, concat = 70, 67
	}
	if units <= single {
		return 1
	}
	return (units + concat - 1) / concat
}
