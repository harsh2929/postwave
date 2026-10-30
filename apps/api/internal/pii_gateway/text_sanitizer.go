// SPDX-License-Identifier: AGPL-3.0-only

package pii_gateway

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// StrictTextMaxBytes covers the largest combined prompt/context envelope
	// admitted by the production authoring routes. The factory rechecks the
	// bound so a future caller cannot accidentally use the strict wrapper as an
	// unbounded regex/tokenization service.
	StrictTextMaxBytes = 96 << 10
	maxStrictValues    = 256
	maxStrictFields    = 256
	maxConfiguredValue = 16 << 10
)

var (
	ErrStrictTextInvalid       = errors.New("pii_gateway: strict text input is invalid")
	ErrStrictTextTooLarge      = errors.New("pii_gateway: strict text input is too large")
	ErrStrictTextTooManyValues = errors.New("pii_gateway: too many sensitive values in strict text input")
	ErrStrictTextTooManyFields = errors.New("pii_gateway: too many sensitive fields in strict text policy")
)

var (
	strictEmailRE = regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`)
	strictSSNRE   = regexp.MustCompile(`\b\d{3}[- ]\d{2}[- ]\d{4}\b`)
	strictCardRE  = regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`)
	strictIBANRE  = regexp.MustCompile(`\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`)
	strictPhoneRE = regexp.MustCompile(`(?:\+?\d{1,3}[ .\-]?)?(?:\(?\d{2,4}\)?[ .\-]?){2,4}\d{2,4}`)

	// Known credential families have strong enough syntax to tokenize without
	// relying on a nearby label. The generic labelled form below deliberately
	// requires an explicit secret/key/token/password label to avoid masking
	// ordinary prose identifiers.
	strictKnownSecretRE = regexp.MustCompile(`(?i)\b(?:sk_(?:live|test)_|pk_live_|rk_live_|whsec_|sk-|gh[pousr]_|github_pat_|xox[baprs]-|SG\.|pw_)[A-Za-z0-9._~+/=\-]{8,}\b|\bAIza[A-Za-z0-9_-]{20,}\b`)
	strictAWSKeyRE      = regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`)
	strictJWTRE         = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`)
	strictBearerRE      = regexp.MustCompile(`(?i)\bBearer[ \t]+([A-Za-z0-9._~+/=\-]{12,})`)
	strictBasicAuthRE   = regexp.MustCompile(`(?i)\bBasic[ \t]+([A-Za-z0-9+/]{8,}={0,2})`)
	strictSecretLabelRE = regexp.MustCompile(`(?i)\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|secret|authorization)[ \t]*[:=][ \t]*(?:"([^"\r\n]{4,1000})"|'([^'\r\n]{4,1000})'|([^\s,}\r\n]{4,1000}))`)
	strictPrivateKeyRE  = regexp.MustCompile(`(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`)
)

// NewStrictTextSanitizer builds a request-scoped sanitizer from values that
// are actually present in prompt/context text. Unlike SanitizeForTenant, it
// does not require a caller to already know a subscriber's email or phone.
//
// config contributes labelled custom fields (for example a configured
// `loyalty_number` appearing as `loyalty_number: LY-123` in resolved context).
// configuredValues is the safe extension point for concrete values resolved by
// a server-owned resource loader. Production authoring currently passes nil
// rather than bulk-reading subscriber data into the model boundary.
func NewStrictTextSanitizer(
	salt string,
	config []FieldSensitivity,
	configuredValues []KindValue,
	texts ...string,
) (Sanitizer, error) {
	if strings.TrimSpace(salt) == "" {
		return nil, fmt.Errorf("%w: salt is required", ErrStrictTextInvalid)
	}
	totalBytes := 0
	for _, text := range texts {
		if !utf8.ValidString(text) {
			return nil, fmt.Errorf("%w: input is not valid UTF-8", ErrStrictTextInvalid)
		}
		totalBytes += len(text)
		if totalBytes > StrictTextMaxBytes {
			return nil, ErrStrictTextTooLarge
		}
	}

	values := make([]KindValue, 0, 32)
	seen := make(map[string]struct{})
	add := func(kind, value string) error {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil
		}
		if len(value) > maxConfiguredValue {
			return fmt.Errorf("%w: one value exceeds the limit", ErrStrictTextInvalid)
		}
		key := strings.ToUpper(strings.TrimSpace(kind)) + "\x00" + value
		if _, duplicate := seen[key]; duplicate {
			return nil
		}
		if len(values) >= maxStrictValues {
			return ErrStrictTextTooManyValues
		}
		seen[key] = struct{}{}
		values = append(values, KindValue{Kind: strictTokenKind(kind), Value: value})
		return nil
	}

	for _, configured := range configuredValues {
		if err := add(configured.Kind, configured.Value); err != nil {
			return nil, err
		}
	}

	for _, text := range texts {
		if err := detectStrictTextValues(text, add); err != nil {
			return nil, err
		}
	}
	sensitiveFields := 0
	for _, field := range config {
		if !field.Sensitive || field.BuiltIn {
			continue
		}
		sensitiveFields++
		if sensitiveFields > maxStrictFields {
			return nil, ErrStrictTextTooManyFields
		}
		fieldName := strings.TrimSpace(field.FieldName)
		if fieldName == "" || len(fieldName) > 128 || !utf8.ValidString(fieldName) ||
			strings.IndexFunc(fieldName, unicode.IsControl) >= 0 {
			return nil, fmt.Errorf("%w: sensitive field name is invalid", ErrStrictTextInvalid)
		}
		for _, text := range texts {
			for _, value := range configuredLabelValues(text, fieldName) {
				if err := add(fieldName, value); err != nil {
					return nil, err
				}
			}
		}
	}

	return NewSanitizerFromKindValues(salt, values), nil
}

// StrictTextSanitizerForTenant loads the tenant's sensitivity labels and then
// detects concrete values in the bounded text. A configuration read failure is
// fatal on this strict path: callers must not invoke the model with raw text.
func (r *Repo) StrictTextSanitizerForTenant(
	ctx context.Context,
	tenantID, salt, prompt, contextText string,
) (Sanitizer, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("pii_gateway: repository is unavailable")
	}
	config, err := r.LoadConfig(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("pii_gateway: load strict text policy: %w", err)
	}
	return NewStrictTextSanitizer(salt, config, nil, prompt, contextText)
}

func detectStrictTextValues(text string, add func(string, string) error) error {
	patterns := []struct {
		kind string
		re   *regexp.Regexp
	}{
		{kind: "PRIVATE_KEY", re: strictPrivateKeyRE},
		{kind: "SECRET", re: strictKnownSecretRE},
		{kind: "SECRET", re: strictAWSKeyRE},
		{kind: "SECRET", re: strictJWTRE},
		{kind: "EMAIL", re: strictEmailRE},
	}
	for _, pattern := range patterns {
		for _, value := range pattern.re.FindAllString(text, -1) {
			if err := add(pattern.kind, value); err != nil {
				return err
			}
		}
	}
	for _, match := range strictCardRE.FindAllString(text, -1) {
		if luhnValidStrict(match) {
			if err := add("PAYMENT_CARD", match); err != nil {
				return err
			}
		}
	}
	for _, match := range strictSSNRE.FindAllString(text, -1) {
		if validStrictSSN(match) {
			if err := add("SSN", match); err != nil {
				return err
			}
		}
	}
	for _, match := range strictIBANRE.FindAllString(text, -1) {
		if validStrictIBAN(match) {
			if err := add("IBAN", match); err != nil {
				return err
			}
		}
	}
	for _, match := range strictPhoneRE.FindAllString(text, -1) {
		if highConfidencePhone(match) {
			if err := add("PHONE", match); err != nil {
				return err
			}
		}
	}
	for _, pattern := range []*regexp.Regexp{strictBearerRE, strictSecretLabelRE} {
		for _, match := range pattern.FindAllStringSubmatch(text, -1) {
			for index := 1; index < len(match); index++ {
				if strings.TrimSpace(match[index]) == "" {
					continue
				}
				if err := add("SECRET", match[index]); err != nil {
					return err
				}
				break
			}
		}
	}
	for _, match := range strictBasicAuthRE.FindAllStringSubmatch(text, -1) {
		if len(match) > 1 && validStrictBasicCredential(match[1]) {
			if err := add("SECRET", match[1]); err != nil {
				return err
			}
		}
	}
	return nil
}

func configuredLabelValues(text, fieldName string) []string {
	fieldName = strings.TrimSpace(fieldName)
	// Supported bounded forms are line/object assignments:
	//   loyalty_number: LY-123
	//   {"loyalty_number":"LY-123"}
	// Arbitrary prose cannot be reliably associated with a configured field
	// name, so it is intentionally left to an explicit server value resolver.
	pattern := regexp.MustCompile(`(?im)(?:^|[\n,{])[ \t]*["']?` + regexp.QuoteMeta(fieldName) + `["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]{1,1000})"|'([^'\r\n]{1,1000})'|([^,}\r\n]{1,1000}))`)
	out := []string{}
	for _, match := range pattern.FindAllStringSubmatch(text, -1) {
		for i := 1; i < len(match); i++ {
			if value := strings.TrimSpace(match[i]); value != "" {
				out = append(out, value)
				break
			}
		}
	}
	return out
}

func strictTokenKind(value string) string {
	value = strings.TrimSpace(strings.ToUpper(value))
	var out strings.Builder
	lastUnderscore := false
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			out.WriteRune(r)
			lastUnderscore = r == '_'
		} else if out.Len() == 0 || !lastUnderscore {
			out.WriteByte('_')
			lastUnderscore = true
		}
		if out.Len() >= 48 {
			break
		}
	}
	if out.Len() == 0 {
		return "SENSITIVE"
	}
	return out.String()
}

func validStrictSSN(value string) bool {
	digits := strings.NewReplacer("-", "", " ", "").Replace(value)
	if len(digits) != 9 {
		return false
	}
	area := int(digits[0]-'0')*100 + int(digits[1]-'0')*10 + int(digits[2]-'0')
	return area != 0 && area != 666 && area < 900 &&
		digits[3:5] != "00" && digits[5:] != "0000"
}

func validStrictIBAN(value string) bool {
	if len(value) < 15 || len(value) > 34 {
		return false
	}
	rearranged := value[4:] + value[:4]
	remainder := 0
	for _, r := range rearranged {
		switch {
		case r >= '0' && r <= '9':
			remainder = (remainder*10 + int(r-'0')) % 97
		case r >= 'A' && r <= 'Z':
			number := int(r-'A') + 10
			remainder = (remainder*100 + number) % 97
		default:
			return false
		}
	}
	return remainder == 1
}

func validStrictBasicCredential(value string) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil || len(decoded) < 3 {
		return false
	}
	separator := strings.IndexByte(string(decoded), ':')
	return separator > 0 && separator < len(decoded)-1
}

func highConfidencePhone(value string) bool {
	digits := 0
	separators := 0
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case r == ' ' || r == '.' || r == '-':
			separators++
		}
	}
	return digits >= 10 && digits <= 15 &&
		(strings.ContainsAny(value, "+()") || separators >= 2)
}

func luhnValidStrict(value string) bool {
	digits := make([]int, 0, 19)
	for _, r := range value {
		if r >= '0' && r <= '9' {
			digits = append(digits, int(r-'0'))
		}
	}
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum := 0
	parity := len(digits) % 2
	for i, digit := range digits {
		if i%2 == parity {
			digit *= 2
			if digit > 9 {
				digit -= 9
			}
		}
		sum += digit
	}
	return sum%10 == 0
}
