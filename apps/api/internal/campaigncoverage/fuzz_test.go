// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"encoding/json"
	"testing"
)

func FuzzDecodeManifestNeverPanics(f *testing.F) {
	f.Add([]byte(`{}`))
	f.Add([]byte(`null`))
	f.Add([]byte(`{"schema_version":1,"unknown":true}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		_, _ = DecodeManifest(json.RawMessage(raw))
	})
}

func FuzzSafeFixtureValueNeverAcceptsControls(f *testing.F) {
	f.Add("Synthetic Recipient")
	f.Add("real.person@company.com")
	f.Add("hello\x00world")
	f.Fuzz(func(t *testing.T, value string) {
		if safeFixtureValue(value) {
			for _, current := range value {
				if current < 0x20 || current == 0x7f {
					t.Fatalf("accepted control-bearing value %q", value)
				}
			}
		}
	})
}
