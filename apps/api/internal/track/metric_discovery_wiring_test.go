// SPDX-License-Identifier: AGPL-3.0-only
//
// Both collectors must CALL metric discovery.
//
// metric_definitions spent its whole existence as a complete table with no
// writer — RLS, grants, a unique key, four CHECK constraints, and not one line
// of Go. A test that only checked the function worked would have passed
// throughout that period. This checks the call sites, which is the thing that
// was actually missing.

package track

import (
	"os"
	"strings"
	"testing"
)

func TestBothCollectorsRecordMetricDiscovery(t *testing.T) {
	for _, tc := range []struct{ path, why string }{
		{"repo.go", "the live track ingest path"},
		{"../warehouse/imports.go", "the importer — the likeliest source of an " +
			"event name the product has never otherwise seen"},
	} {
		source, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatalf("read %s: %v", tc.path, err)
		}
		// Guard the guard: an empty or truncated read would pass the check below.
		if len(source) < 1000 {
			t.Fatalf("%s is %d bytes; the assertion below would be vacuous",
				tc.path, len(source))
		}
		if !strings.Contains(string(source), "RecordMetricDiscovery(") {
			t.Errorf("%s (%s) does not call RecordMetricDiscovery — events arriving "+
				"through it are unreportable, and nothing else would say so",
				tc.path, tc.why)
		}
	}
}
