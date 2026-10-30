// SPDX-License-Identifier: AGPL-3.0-only
//
// consent_revoke_source_test.go — regression guard for the
// p0-sms-consent-revoke-keyword bug.
//
// When a subscriber replies STOP / UNSUBSCRIBE / CANCEL, the SMS
// consent pipeline writes a row into sms_suppressions. The
// `reason` column has a CHECK constraint defined in migration
// 0253_sms_push_suppressions.sql:
//
//     CHECK (reason IN ('manual','stop_keyword','help_keyword',
//                       'carrier_block','complaint','quiet_hours',
//                       'expired'))
//
// Before the fix, the Go store wrote the legacy literal 'opt_out'
// — which is NOT in that set and would fail the CHECK. The
// canonical value for STOP-keyword revocations is 'stop_keyword'.
//
// We don't have a sql-mock / pgxmock dependency in this package
// (and the existing unit tests don't stand up Postgres), so this
// test inspects the source of store.go to assert the regression
// can't silently regress. If you change the literal again, the
// test fails loudly with a clear pointer back to migration 0253.

package sms

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestSMSConsentRevokeWritesStopKeywordSource(t *testing.T) {
	source := readStoreSource(t)

	// The CHECK enum lives in migration 0253; only these values
	// are legal in sms_suppressions.reason. Crucially, 'opt_out'
	// is NOT in this set.
	allowed := map[string]bool{
		"'manual'":        true,
		"'stop_keyword'":  true,
		"'help_keyword'":  true,
		"'carrier_block'": true,
		"'complaint'":     true,
		"'quiet_hours'":   true,
		"'expired'":       true,
	}

	// The two write sites both insert into sms_suppressions with
	// a literal reason. Find them by their identifying SQL and
	// then scan within a ~400-char window for the VALUES clause
	// so we don't pick up unrelated INSERTs that share the leading
	// `VALUES ($1::uuid, $2, ...)` shape.
	insertNeedle := "INSERT INTO sms_suppressions ("
	count := strings.Count(source, insertNeedle)
	if count < 2 {
		t.Fatalf("expected at least 2 sms_suppressions INSERTs in store.go, found %d (did the file move?)", count)
	}
	idx := 0
	found := 0
	for {
		hit := strings.Index(source[idx:], insertNeedle)
		if hit < 0 {
			break
		}
		blockStart := idx + hit
		blockEnd := blockStart + 900
		if blockEnd > len(source) {
			blockEnd = len(source)
		}
		block := source[blockStart:blockEnd]
		// Within this block, find the VALUES clause and extract
		// the reason literal (the third value).
		const prefix = "VALUES ($1::uuid, $2, "
		vIdx := strings.Index(block, prefix)
		if vIdx < 0 {
			t.Fatalf("sms_suppressions INSERT at offset %d missing VALUES clause", blockStart)
		}
		litStart := vIdx + len(prefix)
		litEnd := strings.Index(block[litStart:], ",")
		if litEnd < 0 {
			t.Fatalf("malformed VALUES clause at offset %d", blockStart+litStart)
		}
		literal := strings.TrimSpace(block[litStart : litStart+litEnd])
		if !allowed[literal] {
			t.Fatalf(
				"sms_suppressions INSERT uses disallowed reason %s — "+
					"only %v are valid per migration 0253_sms_push_suppressions.sql. "+
					"Use 'stop_keyword' for STOP-keyword revocations.",
				literal, sortedKeys(allowed),
			)
		}
		if literal != "'stop_keyword'" {
			t.Fatalf(
				"sms_suppressions INSERT writes reason %s; the SMS "+
					"consent-revoke path must record 'stop_keyword' so it "+
					"matches the smsSuppressions tab enum.",
				literal,
			)
		}
		found++
		idx = blockStart + len(insertNeedle)
	}
	if found < 2 {
		t.Fatalf("expected to inspect at least 2 sms_suppressions INSERT literals, inspected %d", found)
	}

	// Only the verified inbound-carrier transaction may clear STOP on START or
	// UNSTOP. The general RecordConsent product/admin path deliberately has no
	// DELETE-on-grant because it does not possess carrier-event authority.
	deleteNeedle := "DELETE FROM sms_suppressions"
	if !strings.Contains(source, deleteNeedle) {
		t.Fatalf("missing DELETE FROM sms_suppressions in store.go")
	}
	// The verified START path first locks exactly a stop_keyword row in the
	// matching provider evidence domain, then deletes only a provenance-known
	// `none` overlay. Preserved manual and legacy-ambiguous rows take their own
	// fail-closed branches and never reach this DELETE.
	delIdx := 0
	delChecked := 0
	for {
		hit := strings.Index(source[delIdx:], deleteNeedle)
		if hit < 0 {
			break
		}
		// Look back to include the authority SELECT and ahead through the DELETE.
		blockStart := delIdx + hit
		lookback := blockStart - 1400
		if lookback < 0 {
			lookback = 0
		}
		blockEnd := blockStart + 500
		if blockEnd > len(source) {
			blockEnd = len(source)
		}
		block := source[lookback:blockEnd]
		for _, required := range []string{
			"reason = 'stop_keyword'",
			"source = $3",
			`case "legacy_unknown":`,
			`case "preserved":`,
			`case "none":`,
			"manual_overlay_state = 'none'",
		} {
			if !strings.Contains(block, required) {
				t.Fatalf("carrier START block around DELETE is missing %q", required)
			}
		}
		delChecked++
		delIdx = blockStart + len(deleteNeedle)
	}
	if delChecked != 1 {
		t.Fatalf("expected exactly one carrier-authoritative DELETE FROM sms_suppressions block, inspected %d", delChecked)
	}
}

// readStoreSource loads internal/sms/store.go from disk. Using
// runtime.Caller keeps the test resilient to where `go test` is
// invoked from (the cwd is the package dir, but be explicit).
func readStoreSource(t *testing.T) string {
	t.Helper()
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := here[:strings.LastIndex(here, "/")]
	b, err := os.ReadFile(dir + "/store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	return string(b)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	// Tiny insertion sort — avoids pulling in sort just for an
	// error message and is plenty fast for ~7 entries.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}
