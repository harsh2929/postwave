// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

var testCursorSigningKey = []byte("route43-test-cursor-signing-key-32-bytes")

func TestCursorRoundTripBindsTenantFiltersSnapshotAndPosition(t *testing.T) {
	snapshot := time.Date(2026, 8, 29, 12, 0, 0, 123456789, time.UTC)
	position := snapshot.Add(-time.Minute)
	filter := ListFilter{
		Platform: "apns", Reason: "manual", HashPrefix: "abcdef01",
		Limit: 17, SnapshotAt: snapshot, SnapshotRevision: 42,
	}
	raw, err := encodeCursor(testCursorSigningKey, testTenantID, filter, Row{ID: testRowID, CreatedAt: position})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "=") {
		t.Fatalf("cursor must use unpadded base64url: %q", raw)
	}
	decoded, err := decodeCursor(testCursorSigningKey, raw, testTenantID, "apns", "manual", "abcdef01")
	if err != nil {
		t.Fatalf("decode minted cursor: %v", err)
	}
	if decoded.Platform != filter.Platform || decoded.Reason != filter.Reason || decoded.HashPrefix != filter.HashPrefix ||
		!decoded.SnapshotAt.Equal(snapshot) || decoded.SnapshotRevision != 42 ||
		!decoded.AfterAt.Equal(position) || decoded.AfterID != testRowID {
		t.Fatalf("cursor binding changed: %+v", decoded)
	}

	for _, mismatch := range []struct {
		tenant, platform, reason, prefix string
	}{
		{tenant: "abcdefab-cdef-1abc-8def-abcdefabcdee", platform: "apns", reason: "manual", prefix: "abcdef01"},
		{tenant: testTenantID, platform: "fcm", reason: "manual", prefix: "abcdef01"},
		{tenant: testTenantID, platform: "apns", reason: "expired", prefix: "abcdef01"},
		{tenant: testTenantID, platform: "apns", reason: "manual", prefix: "12345678"},
	} {
		if _, err := decodeCursor(testCursorSigningKey, raw, mismatch.tenant, mismatch.platform, mismatch.reason, mismatch.prefix); err == nil {
			t.Fatalf("cursor accepted mismatched binding: %+v", mismatch)
		}
	}
}

func TestCursorRoundTripSurvivesWallClockRollback(t *testing.T) {
	// Membership is bound by the monotonic tenant revision, not wall time. A
	// host clock may move backward between an authority insert and the list
	// snapshot; that must not mint a cursor which the next page rejects.
	snapshot := time.Date(2026, 8, 29, 11, 0, 0, 0, time.UTC)
	position := snapshot.Add(time.Hour)
	raw, err := encodeCursor(testCursorSigningKey, testTenantID, ListFilter{
		SnapshotAt: snapshot, SnapshotRevision: 42,
	}, Row{ID: testRowID, CreatedAt: position})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeCursor(testCursorSigningKey, raw, testTenantID, "", "", "")
	if err != nil {
		t.Fatalf("decode cursor across clock rollback: %v", err)
	}
	if decoded.SnapshotRevision != 42 || !decoded.SnapshotAt.Equal(snapshot) || !decoded.AfterAt.Equal(position) {
		t.Fatalf("cursor boundary changed: %+v", decoded)
	}
}

func TestCursorRejectsHostileAndNoncanonicalEncodings(t *testing.T) {
	minted, err := encodeCursor(testCursorSigningKey, testTenantID, ListFilter{
		SnapshotAt: time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC), SnapshotRevision: 42,
	}, Row{ID: testRowID, CreatedAt: time.Date(2026, 8, 29, 11, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	decodedMinted, err := base64.RawURLEncoding.DecodeString(minted)
	if err != nil {
		t.Fatal(err)
	}
	valid := string(decodedMinted)
	encode := func(raw string) string { return base64.RawURLEncoding.EncodeToString([]byte(raw)) }
	tests := map[string]string{
		"empty":                "",
		"not base64url":        "%%%",
		"padded":               minted + "=",
		"unknown field":        encode(strings.TrimSuffix(valid, "}") + `,"extra":true}`),
		"duplicate field":      encode(strings.Replace(valid, `"v":1`, `"v":1,"v":1`, 1)),
		"missing revision":     encode(strings.Replace(valid, `,"snapshot_revision":42`, "", 1)),
		"negative revision":    encode(strings.Replace(valid, `"snapshot_revision":42`, `"snapshot_revision":-1`, 1)),
		"noncanonical spacing": encode(strings.Replace(valid, `"v":1`, `"v": 1`, 1)),
		"trailing value":       encode(valid + `{}`),
		"non-v4 row id":        encode(strings.Replace(valid, testRowID, testTenantID, 1)),
		"noncanonical tenant":  encode(strings.Replace(valid, testTenantID, strings.ToUpper(testTenantID), 1)),
		"non-UTC timestamp":    encode(strings.Replace(valid, "2026-08-29T12:00:00Z", "2026-08-29T17:30:00+05:30", 1)),
		"before time window":   encode(strings.Replace(valid, "2026-08-29T12:00:00Z", "1999-12-31T23:59:59Z", 1)),
		"after time window":    encode(strings.Replace(valid, "2026-08-29T12:00:00Z", "2100-01-01T00:00:00Z", 1)),
		"tampered position":    encode(strings.Replace(valid, "2026-08-29T11:00:00Z", "2026-08-29T13:00:00Z", 1)),
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeCursor(testCursorSigningKey, raw, testTenantID, "", "", ""); err == nil {
				t.Fatalf("hostile cursor accepted: %q", raw)
			}
		})
	}
	if _, err := decodeCursor(testCursorSigningKey, strings.Repeat("a", maxCursorBytes+1), testTenantID, "", "", ""); err == nil {
		t.Fatal("oversized cursor accepted")
	}
}

func TestCursorRejectsWrongOrMissingSigningKey(t *testing.T) {
	raw, err := encodeCursor(testCursorSigningKey, testTenantID, ListFilter{
		SnapshotAt: time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC), SnapshotRevision: 1,
	}, Row{ID: testRowID, CreatedAt: time.Date(2026, 8, 29, 11, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range [][]byte{nil, []byte("too-short"), []byte("different-route43-cursor-key-32-bytes!")} {
		if _, err := decodeCursor(key, raw, testTenantID, "", "", ""); err == nil {
			t.Fatal("cursor accepted an unavailable or incorrect signing key")
		}
	}
}

func TestCanonicalUUIDAllowsTenantVersionsButRequiresV4Rows(t *testing.T) {
	if !canonicalUUID(testTenantID, false) {
		t.Fatal("canonical non-v4 tenant UUID rejected")
	}
	if canonicalUUID(testTenantID, true) {
		t.Fatal("non-v4 row UUID accepted")
	}
	if !canonicalUUID(testRowID, true) {
		t.Fatal("canonical v4 row UUID rejected")
	}
	for _, invalid := range []string{strings.ToUpper(testRowID), " " + testRowID, "not-a-uuid"} {
		if canonicalUUID(invalid, false) {
			t.Fatalf("noncanonical UUID accepted: %q", invalid)
		}
	}
}
