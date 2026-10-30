// SPDX-License-Identifier: AGPL-3.0-only

package auditsink

import (
	"testing"
)

// TestValidOutputFormat — the allow-list must match migration 0275's
// CHECK constraint exactly. Drift here = constraint violation at write.
func TestValidOutputFormat(t *testing.T) {
	cases := map[string]bool{
		FormatNative: true,
		FormatOCSF18: true,
		"":           false, // empty must be rejected at handler boundary
		"ocsf":       false,
		"ocsf_1.8":   false, // dot vs underscore
		"json":       false,
	}
	for in, want := range cases {
		if got := validOutputFormat(in); got != want {
			t.Errorf("validOutputFormat(%q) = %v, want %v", in, got, want)
		}
	}
}

// TestFormatConstantsMatchMigration — the Go constants must match the
// strings written into the audit_sinks.output_format CHECK constraint
// (see infra/migrations/0275_audit_sink_output_format.sql).
func TestFormatConstantsMatchMigration(t *testing.T) {
	if FormatNative != "postwave_native" {
		t.Errorf("FormatNative = %q, want postwave_native", FormatNative)
	}
	if FormatOCSF18 != "ocsf_1_8" {
		t.Errorf("FormatOCSF18 = %q, want ocsf_1_8", FormatOCSF18)
	}
}
