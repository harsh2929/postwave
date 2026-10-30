// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/pushtoken"
)

type scannerFunc func(...any) error

func (f scannerFunc) Scan(dest ...any) error { return f(dest...) }

func TestScanAuthorityRowMinimizesInternalSource(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	scanner := scannerFunc(func(dest ...any) error {
		if len(dest) != 10 {
			return errors.New("unexpected projection width")
		}
		*dest[0].(*string) = testRowID
		*dest[1].(*string) = testTenantID
		*dest[2].(*string) = "0123456789abcdef"
		*dest[3].(*string) = "apns"
		*dest[4].(*string) = "expired"
		*dest[5].(*string) = "apns.feedback.production.v7"
		*dest[6].(*time.Time) = now
		*dest[7].(*time.Time) = now
		*dest[8].(*int64) = 1
		*dest[9].(*string) = "provider"
		return nil
	})
	row, err := scanAuthorityRow(scanner)
	if err != nil {
		t.Fatal(err)
	}
	if row.Source != "provider" || row.Reversible || row.LockedReason != "provider_authority" {
		t.Fatalf("internal source was exposed or authority misprojected: %+v", row)
	}
}

func TestAuthorityWhereUsesBoundArgumentsForEveryFilter(t *testing.T) {
	filter := ListFilter{
		Platform: "apns' OR true --", Reason: "manual' OR true --",
		HashPrefix: "deadbeef' OR true --", SnapshotAt: time.Now().UTC(), SnapshotRevision: 42,
		AfterAt: time.Now().UTC().Add(-time.Hour), AfterID: testRowID,
	}
	where, args := authorityWhere(testTenantID, filter, true)
	for _, hostile := range []string{filter.Platform, filter.Reason, filter.HashPrefix} {
		if strings.Contains(where, hostile) {
			t.Fatalf("filter was interpolated into SQL: %q", where)
		}
	}
	if len(args) != 7 || args[0] != testTenantID || args[1] != int64(42) || args[2] != filter.Platform || args[3] != filter.Reason || args[4] != filter.HashPrefix || args[6] != testRowID {
		t.Fatalf("unexpected positional binding: where=%q args=%#v", where, args)
	}
}

func TestTokenValidationUsesExactBoundedBytes(t *testing.T) {
	valid := strings.Repeat("é", 10) // 10 runes, exactly 20 UTF-8 bytes.
	if err := validateToken(valid); err != nil {
		t.Fatalf("valid exact-byte token rejected: %v", err)
	}
	for name, token := range map[string]string{
		"nineteen bytes": strings.Repeat("a", 19),
		"too large":      strings.Repeat("a", pushtoken.MaxBytes+1),
		"ascii space":    strings.Repeat("a", 20) + " ",
		"unicode space":  strings.Repeat("a", 20) + "\u00a0",
		"control":        strings.Repeat("a", 20) + "\x00",
		"invalid utf8":   strings.Repeat("a", 20) + string([]byte{0xff}),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateToken(token); err == nil {
				t.Fatalf("hostile token accepted: %q", token)
			}
		})
	}
}

func TestStoreManualAddDefensivelyEnforcesExactTokenDomain(t *testing.T) {
	valid := ManualAdd{Platform: "apns", DeviceToken: strings.Repeat("a", pushtoken.MinBytes)}
	if err := validateManualAddStoreInput(valid); err != nil {
		t.Fatalf("valid store input rejected: %v", err)
	}
	for name, in := range map[string]ManualAdd{
		"unknown platform": {Platform: "ios", DeviceToken: valid.DeviceToken},
		"short token":      {Platform: "apns", DeviceToken: "short"},
		"rewritten token":  {Platform: "apns", DeviceToken: valid.DeviceToken + " "},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateManualAddStoreInput(in); err == nil {
				t.Fatal("invalid direct store input accepted")
			}
		})
	}
}
