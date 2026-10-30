// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — the registered op handlers. Each handler is small and
// idempotent. Keep them dependency-free so they stay testable.

package cdp_transforms

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

func init() {
	Register("lowercase", lowercaseHandler)
	Register("uppercase", uppercaseHandler)
	Register("trim", trimHandler)
	Register("title_case", titleCaseHandler)
	Register("strip_html", stripHTMLHandler)
	Register("default_value", defaultValueHandler)
	Register("coerce_number", coerceNumberHandler)
	Register("coerce_bool", coerceBoolHandler)
	Register("truncate", truncateHandler)
	Register("email_normalize", emailNormalizeHandler)
	Register("phone_e164", phoneE164Handler)
	Register("country_iso2", countryISO2Handler)
	Register("delete", deleteHandler)
	Register("regex_replace", regexReplaceHandler)
}

// --- string ops ---

func lowercaseHandler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	low := strings.ToLower(s)
	return low, low != s, nil
}

func uppercaseHandler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	up := strings.ToUpper(s)
	return up, up != s, nil
}

func trimHandler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	t := strings.TrimSpace(s)
	return t, t != s, nil
}

func titleCaseHandler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	out := titleCase(s)
	return out, out != s, nil
}

// titleCase implements first-letter-of-word capitalization without
// relying on x/text. Handles spaces and hyphens as word boundaries.
func titleCase(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	atBoundary := true
	for _, r := range s {
		if unicode.IsSpace(r) || r == '-' {
			b.WriteRune(r)
			atBoundary = true
			continue
		}
		if atBoundary {
			b.WriteRune(unicode.ToUpper(r))
			atBoundary = false
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

var htmlTag = regexp.MustCompile(`<[^>]*>`)

func stripHTMLHandler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	out := htmlTag.ReplaceAllString(s, "")
	return out, out != s, nil
}

func truncateHandler(cur any, op Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	max, ok := argInt(op.Args, "max")
	if !ok || max < 0 {
		return cur, false, fmt.Errorf("truncate: %w: max required", ErrInvalidArgs)
	}
	if len(s) <= max {
		return s, false, nil
	}
	return s[:max], true, nil
}

func defaultValueHandler(cur any, op Op) (any, bool, error) {
	value, ok := op.Args["value"]
	if !ok {
		return cur, false, fmt.Errorf("default_value: %w: value required", ErrInvalidArgs)
	}
	if isEmpty(cur) {
		return value, true, nil
	}
	return cur, false, nil
}

// --- coercion ---

func coerceNumberHandler(cur any, _ Op) (any, bool, error) {
	switch v := cur.(type) {
	case int:
		return float64(v), true, nil
	case int64:
		return float64(v), true, nil
	case float64:
		return v, false, nil
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return cur, false, fmt.Errorf("coerce_number: %q is not numeric", v)
		}
		return n, true, nil
	case bool:
		if v {
			return float64(1), true, nil
		}
		return float64(0), true, nil
	case nil:
		return cur, false, nil
	}
	return cur, false, nil
}

func coerceBoolHandler(cur any, _ Op) (any, bool, error) {
	switch v := cur.(type) {
	case bool:
		return v, false, nil
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "true", "yes", "y", "1", "on":
			return true, true, nil
		case "false", "no", "n", "0", "off", "":
			return false, true, nil
		}
		return cur, false, fmt.Errorf("coerce_bool: %q is not boolean", v)
	case float64:
		return v != 0, true, nil
	case int:
		return v != 0, true, nil
	case nil:
		return cur, false, nil
	}
	return cur, false, nil
}

// --- normalisers ---

func emailNormalizeHandler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	low := strings.ToLower(strings.TrimSpace(s))
	at := strings.IndexByte(low, '@')
	if at < 0 {
		return low, low != s, nil
	}
	// Gmail-style normalisation: strip "+tag" and "."s from the local
	// part for canonical equality. Conservative — only applied to
	// gmail.com / googlemail.com to avoid breaking valid Yahoo
	// "first.last" addresses.
	local, domain := low[:at], low[at+1:]
	if domain == "gmail.com" || domain == "googlemail.com" {
		if plus := strings.IndexByte(local, '+'); plus >= 0 {
			local = local[:plus]
		}
		local = strings.ReplaceAll(local, ".", "")
		low = local + "@" + domain
	}
	return low, low != s, nil
}

var nonDigit = regexp.MustCompile(`\D`)

func phoneE164Handler(cur any, op Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	// E.164: + then country-code then digits, max 15 digits total.
	defaultCC, _ := argString(op.Args, "default_country_code")
	digits := nonDigit.ReplaceAllString(s, "")
	if digits == "" {
		return cur, false, nil
	}
	if !strings.HasPrefix(s, "+") && defaultCC != "" {
		digits = defaultCC + digits
	}
	if len(digits) > 15 {
		digits = digits[:15]
	}
	out := "+" + digits
	return out, out != s, nil
}

// countryISO2Handler accepts a country name OR a 3-letter code and
// returns its ISO-3166 alpha-2 form. The lookup table is small on
// purpose — extending it costs nothing and is mechanical.
func countryISO2Handler(cur any, _ Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	key := strings.ToLower(strings.TrimSpace(s))
	if iso2, found := countryToISO2[key]; found {
		return iso2, iso2 != s, nil
	}
	if len(key) == 2 {
		up := strings.ToUpper(key)
		return up, up != s, nil
	}
	return cur, false, nil
}

// --- structural ---

func deleteHandler(cur any, op Op) (any, bool, error) {
	if cur == nil {
		return nil, false, nil
	}
	// Use deleteField at the engine level — return a sentinel here.
	// Engine's setField path would otherwise re-write the value;
	// the engine checks `changed` and calls delete instead. We
	// encode that by returning the special tombstone struct.
	return tombstone{}, true, nil
}

type tombstone struct{}

func regexReplaceHandler(cur any, op Op) (any, bool, error) {
	s, ok := stringOf(cur)
	if !ok {
		return cur, false, nil
	}
	pattern, has := argString(op.Args, "pattern")
	if !has {
		return cur, false, fmt.Errorf("regex_replace: %w: pattern required", ErrInvalidArgs)
	}
	repl, _ := argString(op.Args, "replacement")
	rx, err := regexp.Compile(pattern)
	if err != nil {
		return cur, false, fmt.Errorf("regex_replace: bad pattern: %w", err)
	}
	out := rx.ReplaceAllString(s, repl)
	return out, out != s, nil
}

// --- helpers ---

func stringOf(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

func isEmpty(v any) bool {
	if v == nil {
		return true
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s) == ""
	}
	if m, ok := v.(map[string]any); ok {
		return len(m) == 0
	}
	if a, ok := v.([]any); ok {
		return len(a) == 0
	}
	return false
}

var countryToISO2 = map[string]string{
	"united states":  "US",
	"usa":            "US",
	"us":             "US",
	"u.s.":           "US",
	"u.s.a.":         "US",
	"united kingdom": "GB",
	"uk":             "GB",
	"great britain":  "GB",
	"england":        "GB",
	"canada":         "CA",
	"germany":        "DE",
	"deutschland":    "DE",
	"france":         "FR",
	"spain":          "ES",
	"italy":          "IT",
	"netherlands":    "NL",
	"belgium":        "BE",
	"sweden":         "SE",
	"norway":         "NO",
	"denmark":        "DK",
	"finland":        "FI",
	"ireland":        "IE",
	"australia":      "AU",
	"new zealand":    "NZ",
	"japan":          "JP",
	"china":          "CN",
	"india":          "IN",
	"brazil":         "BR",
	"mexico":         "MX",
	"poland":         "PL",
	"portugal":       "PT",
	"austria":        "AT",
	"switzerland":    "CH",
	"czechia":        "CZ",
	"czech republic": "CZ",
	"singapore":      "SG",
	"south korea":    "KR",
	"korea":          "KR",
	"argentina":      "AR",
	"chile":          "CL",
	"colombia":       "CO",
	"south africa":   "ZA",
	"israel":         "IL",
	"turkey":         "TR",
	"uae":            "AE",
}
