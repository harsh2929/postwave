// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import "testing"

func FuzzExtractStructuredDataDoesNotPanic(f *testing.F) {
	f.Add([]byte(`<html><head><script type="application/ld+json">{"@type":"Order"}</script></head></html>`))
	f.Add([]byte(`<script type="application/ld+json">`))
	f.Add([]byte{0xff, 0x00, '<', '>'})
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 1<<20 {
			t.Skip()
		}
		payload, count, err := extractStructuredData(raw)
		if err != nil {
			return
		}
		if count < 0 || (count == 0 && len(payload) != 0) {
			t.Fatalf("invalid extraction count=%d bytes=%d", count, len(payload))
		}
	})
}
