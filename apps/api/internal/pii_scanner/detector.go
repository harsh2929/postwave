// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Detector finds undeclared PII in free-text values. The regex pass is the
// deterministic baseline; the LLM seam (a future enhancement) would augment
// confidence but never replace the regex floor a DPO can audit.
//
// A Detector is deliberately not zero-value usable. Persisted fingerprints are
// HMACs of low-entropy identifiers (SSNs, phone numbers, cards), so accepting a
// missing/short key would turn the finding table into an offline enumeration
// oracle after a database leak.
type Detector struct {
	fingerprintKey        []byte
	fingerprintKeyVersion string
	now                   func() time.Time
}

const (
	// MinFingerprintPepperBytes is the minimum dedicated HMAC key length.
	MinFingerprintPepperBytes = 32
	// FingerprintSchemeHMACSHA256V1 identifies the domain-separated keyed
	// fingerprint emitted by this detector.
	FingerprintSchemeHMACSHA256V1 = "hmac-sha256-v1"
	// FingerprintSchemeLegacyRedactedV1 identifies random migration tokens that
	// replaced historical bare SHA-256 values. They prove receipt equality only;
	// they cannot be recomputed or used by the prefix-search surface.
	FingerprintSchemeLegacyRedactedV1 = "legacy-redacted-v1"
	LegacyFingerprintKeyVersion       = "legacy"
	fingerprintTenantKeyDomainV1      = "postwave/subscriber-shadow-pii/tenant-key/v1"
	fingerprintValueDomainV1          = "postwave/subscriber-shadow-pii/value/v1"
	fingerprintKeyCommitmentDomainV1  = "postwave/subscriber-shadow-pii/key-commitment/v1"
	MaxScanFields                     = 500
	MaxScanFieldBytes                 = 64 << 10
	MaxDetectionsPerField             = 50
	MaxDetectionsPerSubscriber        = 200
	MaxPlausibleDOBYears              = 120
)

var fingerprintKeyVersionRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// internalNonPIIFieldKeys is an exact allowlist of platform-owned subscriber
// metadata whose value cannot be user free text. Do not broaden this to an
// underscore-prefix rule: imported/custom field keys can legitimately begin
// with an underscore and still contain PII.
var internalNonPIIFieldKeys = map[string]struct{}{
	"_listmonk_id":               {}, // compatibility projection
	"custom_fields._listmonk_id": {},
	"merge_fields._listmonk_id":  {},
}

// NewDetector returns a detector backed by a dedicated HMAC-SHA256 pepper.
// keyVersion is persisted beside every finding and must change whenever the
// key changes. Callers must never pass an authentication/API-key pepper here.
func NewDetector(pepper []byte, keyVersion string) (*Detector, error) {
	keyVersion = strings.TrimSpace(keyVersion)
	if len(pepper) < MinFingerprintPepperBytes {
		return nil, fmt.Errorf("pii_scanner: fingerprint pepper must contain at least %d bytes", MinFingerprintPepperBytes)
	}
	if !fingerprintKeyVersionRE.MatchString(keyVersion) || keyVersion == LegacyFingerprintKeyVersion {
		return nil, errors.New("pii_scanner: fingerprint key version must be a safe non-legacy identifier")
	}
	keyCopy := append([]byte(nil), pepper...)
	return &Detector{fingerprintKey: keyCopy, fingerprintKeyVersion: keyVersion, now: time.Now}, nil
}

// FingerprintKeyVersion returns the non-secret key identifier attached to new
// findings. It is safe to expose in scanner capability metadata.
func (d *Detector) FingerprintKeyVersion() string {
	if d == nil {
		return ""
	}
	return d.fingerprintKeyVersion
}

// FingerprintKeyCommitment is a non-secret HMAC attestation used only to fence
// replicas that accidentally reuse a key version with different key material.
// It is never returned by the public API. The dedicated key must be generated
// with at least 256 bits of entropy; changing it requires a new key version.
func (d *Detector) FingerprintKeyCommitment() string {
	if d == nil || len(d.fingerprintKey) < MinFingerprintPepperBytes {
		return ""
	}
	mac := hmac.New(sha256.New, d.fingerprintKey)
	_, _ = mac.Write([]byte(fingerprintKeyCommitmentDomainV1))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(d.fingerprintKeyVersion))
	return hex.EncodeToString(mac.Sum(nil))
}

var (
	// SSN: 9 digits as NNN-NN-NNNN or NNN NN NNNN. The bare-9-digit form is
	// intentionally NOT matched here to avoid flagging order numbers / zips —
	// a separated SSN is a far stronger signal.
	ssnRE = regexp.MustCompile(`\b\d{3}[- ]\d{2}[- ]\d{4}\b`)

	// Credit card: 13–16 digit runs, optionally separated by spaces/dashes in
	// 4-digit groups. Confirmed by a Luhn check before it is reported.
	cardRE = regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`)

	// Date of birth: ISO (YYYY-MM-DD) or US/EU slashed (MM/DD/YYYY) shapes.
	dobRE = regexp.MustCompile(`\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})\b`)

	// US passport: one letter (optional) followed by 8-9 digits, OR 9 digits
	// preceded by a passport-ish hint. We keep this conservative — a bare
	// 9-digit number alone is ambiguous, so we require a context word.
	passportRE = regexp.MustCompile(`(?i)\bpassport\b[^0-9A-Za-z]{0,12}([A-Z]?\d{8,9})\b`)

	// Drivers license: requires a context hint ("dl"/"driver"/"licen[cs]e")
	// near an alphanumeric 6-12 run, since DL formats vary wildly by state.
	dlRE = regexp.MustCompile(`(?i)\b(?:dl|driver'?s?|licen[cs]e)\b[^0-9A-Za-z]{0,12}([A-Z0-9]{6,12})\b`)

	// Email.
	emailRE = regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`)

	// Phone: international/US shapes with separators. Confirmed by a digit-count
	// check (7-15 digits) so short numerics don't trip it.
	phoneRE = regexp.MustCompile(`(?:\+?\d{1,3}[ .\-]?)?(?:\(?\d{2,4}\)?[ .\-]?){2,4}\d{2,4}`)

	// IBAN: 2 letters + 2 check digits + 11-30 alnum.
	ibanRE = regexp.MustCompile(`\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`)
)

// fingerprintValue derives a tenant-specific HMAC key and then binds the
// detector category plus a canonical match. Equal identifiers therefore do
// not correlate across tenants in a database snapshot, and changing the key
// version creates honest new evidence rather than relabelling an old token.
func (d *Detector) fingerprintValue(tenantID string, detectionType DetectionType, v string) string {
	if d == nil || len(d.fingerprintKey) < MinFingerprintPepperBytes {
		return ""
	}
	tenantID = strings.ToLower(strings.TrimSpace(tenantID))
	v = canonicalMatchedValue(detectionType, v)
	if tenantID == "" || !IsValidDetectionType(string(detectionType)) || v == "" {
		return ""
	}
	derive := hmac.New(sha256.New, d.fingerprintKey)
	_, _ = derive.Write([]byte(fingerprintTenantKeyDomainV1))
	_, _ = derive.Write([]byte{0})
	_, _ = derive.Write([]byte(d.fingerprintKeyVersion))
	_, _ = derive.Write([]byte{0})
	_, _ = derive.Write([]byte(tenantID))
	tenantKey := derive.Sum(nil)

	mac := hmac.New(sha256.New, tenantKey)
	_, _ = mac.Write([]byte(fingerprintValueDomainV1))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(DetectorName))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(DetectorVersion))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(detectionType))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(v))
	return hex.EncodeToString(mac.Sum(nil))
}

// DetectField is a convenience classifier that returns the strongest match.
// The production ScanFields path does not use this lossy projection: it records
// every unique bounded match/type and reports truncation explicitly.
func (d *Detector) DetectField(tenantID, fieldName, value string) *Detection {
	value, _ = boundedUTF8(strings.TrimSpace(value), MaxScanFieldBytes)
	if value == "" {
		return nil
	}
	dets, _ := d.detectAll(tenantID, fieldName, value)
	if len(dets) == 0 {
		return nil
	}
	best := dets[0]
	for _, det := range dets[1:] {
		if det.Confidence > best.Confidence {
			best = det
		}
	}
	return &best
}

// detectAll returns every unique validated token/type up to the per-field cap.
func (d *Detector) detectAll(tenantID, fieldName, value string) ([]Detection, bool) {
	var out []Detection
	seen := map[string]struct{}{}
	truncated := false
	strongDigitRuns := []string{}
	add := func(t DetectionType, conf float64, matched string) {
		fingerprint := d.fingerprintValue(tenantID, t, matched)
		if fingerprint == "" {
			return
		}
		key := string(t) + "\x00" + fingerprint
		if _, duplicate := seen[key]; duplicate {
			return
		}
		if len(out) >= MaxDetectionsPerField {
			truncated = true
			return
		}
		seen[key] = struct{}{}
		out = append(out, Detection{
			FieldName:             fieldName,
			DetectedType:          t,
			Confidence:            conf,
			Fingerprint:           fingerprint,
			FingerprintScheme:     FingerprintSchemeHMACSHA256V1,
			FingerprintKeyVersion: d.fingerprintKeyVersion,
			ScannerName:           ScannerName,
			ScannerVersion:        ScannerVersion,
			DetectorName:          DetectorName,
			DetectorVersion:       DetectorVersion,
			PolicyName:            PolicyName,
			PolicyVersion:         PolicyVersion,
		})
		switch t {
		case TypeSSN, TypeCreditCard, TypePassport, TypeDriversLicense, TypeIBAN, TypeDateOfBirth:
			if digits := digitsOnly(matched); digits != "" {
				strongDigitRuns = append(strongDigitRuns, digits)
			}
		}
	}

	for _, m := range ssnRE.FindAllString(value, -1) {
		if validSSN(m) {
			add(TypeSSN, 0.9, m)
		}
	}
	for _, m := range cardRE.FindAllString(value, -1) {
		if luhnValid(m) {
			add(TypeCreditCard, 0.95, m)
		}
	}
	for _, m := range passportRE.FindAllStringSubmatch(value, -1) {
		if len(m) > 1 {
			add(TypePassport, 0.8, m[1])
		}
	}
	for _, m := range dlRE.FindAllStringSubmatch(value, -1) {
		if len(m) > 1 {
			add(TypeDriversLicense, 0.7, m[1])
		}
	}
	for _, m := range ibanRE.FindAllString(strings.ToUpper(value), -1) {
		if ibanValid(m) {
			add(TypeIBAN, 0.85, m)
		}
	}
	for _, m := range emailRE.FindAllString(value, -1) {
		add(TypeEmail, 0.6, m)
	}
	for _, m := range dobRE.FindAllString(value, -1) {
		if _, ok := d.plausibleDOB(m); ok {
			// A valid date alone is a weaker signal than a structured identifier.
			add(TypeDateOfBirth, 0.55, m)
		}
	}
	for _, m := range validIPs(value) {
		add(TypeIPAddress, 0.6, m)
	}
	for _, m := range phoneRE.FindAllString(value, -1) {
		digits := digitsOnly(m)
		if len(digits) >= 7 && len(digits) <= 15 && !overlapsStrongDigits(digits, strongDigitRuns) {
			add(TypePhone, 0.5, m)
		}
	}
	return out, truncated
}

func overlapsStrongDigits(phone string, strong []string) bool {
	for _, candidate := range strong {
		if strings.Contains(candidate, phone) || strings.Contains(phone, candidate) {
			return true
		}
	}
	return false
}

// luhnValid runs the Luhn checksum over the digits of s, confirming a
// credit-card candidate. Non-digits are stripped first.
func luhnValid(s string) bool {
	var digits []int
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits = append(digits, int(r-'0'))
		}
	}
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		dd := digits[i]
		if double {
			dd *= 2
			if dd > 9 {
				dd -= 9
			}
		}
		sum += dd
		double = !double
	}
	return sum%10 == 0
}

var ipCandidateRE = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b`)

func validIPs(s string) []string {
	out := []string{}
	for _, candidate := range ipCandidateRE.FindAllString(s, -1) {
		if parsed := net.ParseIP(candidate); parsed != nil {
			out = append(out, parsed.String())
		}
	}
	return out
}

func digitsOnly(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	for _, r := range s {
		if r >= '0' && r <= '9' {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func validSSN(s string) bool {
	digits := digitsOnly(s)
	if len(digits) != 9 {
		return false
	}
	area := digits[:3]
	return area != "000" && area != "666" && area[0] != '9' && digits[3:5] != "00" && digits[5:] != "0000"
}

func canonicalDOB(value string) (string, bool) {
	for _, layout := range []string{"2006-01-02", "01/02/2006", "02/01/2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.Format("2006-01-02"), true
		}
	}
	return "", false
}

// plausibleDOB rejects dates that are syntactically valid but cannot
// plausibly be a living subscriber's birth date. The inclusive 120-year bound
// and no-future-date rule are part of DetectorVersion and therefore require a
// version bump if changed.
func (d *Detector) plausibleDOB(value string) (string, bool) {
	canonical, ok := canonicalDOB(value)
	if !ok {
		return "", false
	}
	parsed, err := time.Parse("2006-01-02", canonical)
	if err != nil {
		return "", false
	}
	now := time.Now().UTC()
	if d != nil && d.now != nil {
		now = d.now().UTC()
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	earliest := today.AddDate(-MaxPlausibleDOBYears, 0, 0)
	if parsed.After(today) || parsed.Before(earliest) {
		return "", false
	}
	return canonical, true
}

func ibanValid(value string) bool {
	value = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	if len(value) < 15 || len(value) > 34 {
		return false
	}
	rearranged := value[4:] + value[:4]
	mod := 0
	for _, r := range rearranged {
		switch {
		case r >= '0' && r <= '9':
			mod = (mod*10 + int(r-'0')) % 97
		case r >= 'A' && r <= 'Z':
			n := int(r-'A') + 10
			mod = (mod*100 + n) % 97
		default:
			return false
		}
	}
	return mod == 1
}

func canonicalMatchedValue(detectionType DetectionType, value string) string {
	value = strings.TrimSpace(value)
	switch detectionType {
	case TypeSSN, TypeCreditCard, TypePhone:
		return digitsOnly(value)
	case TypeDateOfBirth:
		if canonical, ok := canonicalDOB(value); ok {
			return canonical
		}
	case TypeEmail:
		return strings.ToLower(value)
	case TypeIPAddress:
		if parsed := net.ParseIP(value); parsed != nil {
			return parsed.String()
		}
	case TypeIBAN:
		return strings.ToUpper(strings.ReplaceAll(value, " ", ""))
	case TypePassport, TypeDriversLicense:
		return strings.ToUpper(value)
	}
	return value
}

func boundedUTF8(value string, maxBytes int) (string, bool) {
	if len(value) <= maxBytes {
		return value, false
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value, true
}

// ScanFields runs DetectField over every string-shaped value in a fields map
// (subscribers.custom_fields / merge_fields). declared is the set of field
// keys already flagged as PII at the schema level (FieldConfig.pii_flag /
// data_classification) — those are skipped so the queue only surfaces
// *undeclared* PII. Nested values are stringified via fmt for a best-effort
// scan of object/array fields.
func (d *Detector) ScanFields(tenantID string, fields map[string]any, declared map[string]bool) ScanResult {
	result := ScanResult{Detections: []Detection{}}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for index, k := range keys {
		if index >= MaxScanFields {
			result.Truncated = true
			result.FieldsOverLimit += len(keys) - index
			break
		}
		if _, internalNonPII := internalNonPIIFieldKeys[k]; internalNonPII {
			result.FieldsReserved++
			continue
		}
		if declared[k] {
			result.FieldsDeclared++
			continue
		}
		str := stringify(fields[k])
		if str == "" {
			continue
		}
		result.FieldsScanned++
		var fieldTruncated bool
		str, fieldTruncated = boundedUTF8(str, MaxScanFieldBytes)
		detections, detectionTruncated := d.detectAll(tenantID, k, str)
		if fieldTruncated || detectionTruncated {
			result.Truncated = true
		}
		remaining := MaxDetectionsPerSubscriber - len(result.Detections)
		if remaining <= 0 {
			if len(detections) > 0 {
				result.Truncated = true
			}
			continue
		}
		if len(detections) > remaining {
			result.Detections = append(result.Detections, detections[:remaining]...)
			result.Truncated = true
		} else {
			result.Detections = append(result.Detections, detections...)
		}
	}
	return result
}

func stringify(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return fmt.Sprint(t)
	}
}
