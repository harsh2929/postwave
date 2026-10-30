// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"strings"
	"testing"
	"time"
)

const detectorTestTenant = "00000000-0000-4000-8000-000000000101"

func newTestDetector(t *testing.T) *Detector {
	t.Helper()
	detector, err := NewDetector([]byte("pii-scanner-test-fingerprint-pepper-32-bytes-minimum"), "test-v1")
	if err != nil {
		t.Fatalf("NewDetector: %v", err)
	}
	detector.now = func() time.Time {
		return time.Date(2026, time.July, 18, 12, 0, 0, 0, time.UTC)
	}
	return detector
}

func TestDetectField_SSN(t *testing.T) {
	d := newTestDetector(t)
	for _, v := range []string{"123-45-6789", "SSN: 078 05 1120", "ssn 123-45-6789 on file"} {
		det := d.DetectField(detectorTestTenant, "notes", v)
		if det == nil || det.DetectedType != TypeSSN {
			t.Errorf("DetectField(%q) = %+v, want ssn", v, det)
		}
	}
	// A bare 9-digit number is intentionally not flagged as SSN.
	if det := d.DetectField(detectorTestTenant, "order_id", "123456789"); det != nil && det.DetectedType == TypeSSN {
		t.Errorf("bare 9-digit %q should not be ssn", "123456789")
	}
}

func TestDetectField_CreditCard(t *testing.T) {
	d := newTestDetector(t)
	// Valid Luhn test numbers.
	for _, v := range []string{"4111111111111111", "4111 1111 1111 1111", "5500 0000 0000 0004"} {
		det := d.DetectField(detectorTestTenant, "comment", v)
		if det == nil || det.DetectedType != TypeCreditCard {
			t.Errorf("DetectField(%q) = %+v, want credit_card", v, det)
		}
	}
	// A 16-digit run that fails Luhn is not flagged as a card.
	if det := d.DetectField(detectorTestTenant, "comment", "1234567812345678"); det != nil && det.DetectedType == TypeCreditCard {
		t.Errorf("non-Luhn %q flagged as card", "1234567812345678")
	}
}

func TestDetectField_DateOfBirth(t *testing.T) {
	d := newTestDetector(t)
	for _, v := range []string{"1990-05-12", "05/12/1990", "DOB 12/31/1985"} {
		det := d.DetectField(detectorTestTenant, "notes", v)
		if det == nil || det.DetectedType != TypeDateOfBirth {
			t.Errorf("DetectField(%q) = %+v, want date_of_birth", v, det)
		}
	}
}

func TestDetectField_PassportAndDL(t *testing.T) {
	d := newTestDetector(t)
	if det := d.DetectField(detectorTestTenant, "notes", "Passport: A12345678"); det == nil || det.DetectedType != TypePassport {
		t.Errorf("passport not detected: %+v", det)
	}
	if det := d.DetectField(detectorTestTenant, "notes", "Driver's license D1234567"); det == nil || det.DetectedType != TypeDriversLicense {
		t.Errorf("dl not detected: %+v", det)
	}
}

func TestDetectField_EmailPhoneIPIBAN(t *testing.T) {
	d := newTestDetector(t)
	if det := d.DetectField(detectorTestTenant, "notes", "reach me at a.b@example.com"); det == nil || det.DetectedType != TypeEmail {
		t.Errorf("email not detected: %+v", det)
	}
	if det := d.DetectField(detectorTestTenant, "notes", "call +1 (415) 555-1234"); det == nil || det.DetectedType != TypePhone {
		t.Errorf("phone not detected: %+v", det)
	}
	if det := d.DetectField(detectorTestTenant, "notes", "from 192.168.1.100"); det == nil || det.DetectedType != TypeIPAddress {
		t.Errorf("ip not detected: %+v", det)
	}
	if det := d.DetectField(detectorTestTenant, "notes", "IBAN GB82WEST12345698765432"); det == nil || det.DetectedType != TypeIBAN {
		t.Errorf("iban not detected: %+v", det)
	}
}

func TestDetectField_Clean(t *testing.T) {
	d := newTestDetector(t)
	for _, v := range []string{"", "   ", "Gold tier", "favorite_color: blue", "VIP customer"} {
		if det := d.DetectField(detectorTestTenant, "notes", v); det != nil {
			t.Errorf("DetectField(%q) = %+v, want nil (clean)", v, det)
		}
	}
}

func TestDetectField_StrongestWins(t *testing.T) {
	// A value carrying both an SSN and a phone-like run should report the
	// higher-confidence SSN, not the phone.
	d := newTestDetector(t)
	det := d.DetectField(detectorTestTenant, "notes", "ssn 123-45-6789")
	if det == nil || det.DetectedType != TypeSSN {
		t.Fatalf("expected ssn (strongest), got %+v", det)
	}
}

func TestScanFields_SkipsDeclaredAndReserved(t *testing.T) {
	d := newTestDetector(t)
	fields := map[string]any{
		"notes":                       "ssn 123-45-6789",
		"declared_pii":                "456-78-9012",
		"_listmonk_id":                "999-99-9999",
		"_private_note":               "321-65-4321",
		"custom_fields._listmonk_id":  "987-65-4321",
		"custom_fields._private_note": "219-09-9999",
		"loyalty_tier":                "gold",
		"contact_email":               "x@y.co",
	}
	declared := map[string]bool{"declared_pii": true}
	result := d.ScanFields(detectorTestTenant, fields, declared)
	dets := result.Detections

	byField := map[string]Detection{}
	for _, det := range dets {
		byField[det.FieldName] = det
	}
	if _, ok := byField["declared_pii"]; ok {
		t.Error("already-declared PII field should be skipped")
	}
	if _, ok := byField["_listmonk_id"]; ok {
		t.Error("exact platform-owned non-PII key should be skipped")
	}
	if _, ok := byField["custom_fields._listmonk_id"]; ok {
		t.Error("namespaced exact platform-owned non-PII key should be skipped")
	}
	if d := byField["_private_note"]; d.DetectedType != TypeSSN {
		t.Errorf("arbitrary underscore-prefixed field must be scanned, got %+v", d)
	}
	if d := byField["custom_fields._private_note"]; d.DetectedType != TypeSSN {
		t.Errorf("namespaced arbitrary underscore-prefixed field must be scanned, got %+v", d)
	}
	if d := byField["notes"]; d.DetectedType != TypeSSN {
		t.Errorf("notes should flag ssn, got %+v", d)
	}
	if d := byField["contact_email"]; d.DetectedType != TypeEmail {
		t.Errorf("contact_email should flag email, got %+v", d)
	}
}

func TestFingerprint_TenantDomainAndKeySeparation(t *testing.T) {
	d := newTestDetector(t)
	ssnA := d.fingerprintValue(detectorTestTenant, TypeSSN, "123-45-6789")
	ssnAEquivalent := d.fingerprintValue(detectorTestTenant, TypeSSN, "123 45 6789")
	ssnOtherTenant := d.fingerprintValue("00000000-0000-4000-8000-000000000102", TypeSSN, "123-45-6789")
	phoneSameDigits := d.fingerprintValue(detectorTestTenant, TypePhone, "123-45-6789")
	if ssnA == "" || len(ssnA) != 64 || ssnA != ssnAEquivalent {
		t.Fatalf("canonical fingerprint mismatch: %q vs %q", ssnA, ssnAEquivalent)
	}
	if ssnA == ssnOtherTenant {
		t.Fatal("equal low-entropy PII correlated across tenants")
	}
	if ssnA == phoneSameDigits {
		t.Fatal("equal bytes correlated across detector domains")
	}
	rotated, err := NewDetector([]byte("a-different-pii-fingerprint-pepper-at-least-32-bytes"), "test-v2")
	if err != nil {
		t.Fatal(err)
	}
	if got := rotated.fingerprintValue(detectorTestTenant, TypeSSN, "123-45-6789"); got == ssnA {
		t.Fatal("key rotation did not create new evidence")
	}
}

func TestNewDetector_FailsClosedWithoutDedicatedKey(t *testing.T) {
	if detector, err := NewDetector([]byte("too-short"), "v1"); err == nil || detector != nil {
		t.Fatalf("short key accepted: detector=%v err=%v", detector, err)
	}
	if detector, err := NewDetector([]byte(strings.Repeat("x", 32)), "legacy"); err == nil || detector != nil {
		t.Fatalf("reserved key version accepted: detector=%v err=%v", detector, err)
	}
}

func TestScanFields_CollectsMultipleUniquePII(t *testing.T) {
	d := newTestDetector(t)
	result := d.ScanFields(detectorTestTenant, map[string]any{
		"notes": "first 123-45-6789 second 321-65-4321 email one@example.test and two@example.test",
	}, nil)
	counts := map[DetectionType]int{}
	for _, detection := range result.Detections {
		counts[detection.DetectedType]++
	}
	if result.Truncated || counts[TypeSSN] != 2 || counts[TypeEmail] != 2 {
		t.Fatalf("multi-PII result=%+v counts=%v", result, counts)
	}
}

func TestDetectorValidationAndTruncationAccounting(t *testing.T) {
	d := newTestDetector(t)
	for _, invalid := range []string{"000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000"} {
		if detection := d.DetectField(detectorTestTenant, "notes", invalid); detection != nil && detection.DetectedType == TypeSSN {
			t.Fatalf("invalid SSN accepted: %q", invalid)
		}
	}
	if detection := d.DetectField(detectorTestTenant, "notes", "DOB 2025-02-31"); detection != nil && detection.DetectedType == TypeDateOfBirth {
		t.Fatal("impossible DOB accepted")
	}
	for _, implausible := range []string{"DOB 2026-07-19", "DOB 1906-07-17"} {
		if detection := d.DetectField(detectorTestTenant, "notes", implausible); detection != nil && detection.DetectedType == TypeDateOfBirth {
			t.Fatalf("future/over-%d-year DOB accepted: %q", MaxPlausibleDOBYears, implausible)
		}
	}
	if detection := d.DetectField(detectorTestTenant, "notes", "DOB 1906-07-18"); detection == nil || detection.DetectedType != TypeDateOfBirth {
		t.Fatalf("inclusive %d-year DOB boundary rejected: %+v", MaxPlausibleDOBYears, detection)
	}
	if detection := d.DetectField(detectorTestTenant, "notes", "IBAN GB00WEST12345698765432"); detection != nil && detection.DetectedType == TypeIBAN {
		t.Fatal("invalid IBAN checksum accepted")
	}
	oversized := strings.Repeat("x", MaxScanFieldBytes) + " 123-45-6789"
	result := d.ScanFields(detectorTestTenant, map[string]any{"notes": oversized}, nil)
	if !result.Truncated || result.FieldsScanned != 1 {
		t.Fatalf("bounded scan did not report truncation: %+v", result)
	}
}

func TestLuhnValid(t *testing.T) {
	if !luhnValid("4111111111111111") {
		t.Error("known-good Luhn rejected")
	}
	if luhnValid("4111111111111112") {
		t.Error("bad Luhn accepted")
	}
}
