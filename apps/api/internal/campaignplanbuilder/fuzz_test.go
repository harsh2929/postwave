// SPDX-License-Identifier: AGPL-3.0-only

package campaignplanbuilder

import (
	"encoding/json"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
)

func FuzzAdaptFrozenVariantsNeverAcceptsAmbiguousJSON(f *testing.F) {
	f.Add([]byte(`[]`))
	f.Add([]byte(`null`))
	f.Add([]byte(`[{"id":"legacy","body_html":"<p>x</p>"}]`))
	f.Add([]byte(`[{"adapter_version":"postwave.reviewed-semantic-variant.v1"}]`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 1<<20 {
			t.Skip()
		}
		adapted, err := adaptFrozenVariants(campaignartifact.Revision{Variants: json.RawMessage(raw)})
		if err != nil {
			return
		}
		if adapted.control {
			if len(adapted.coverage) != 0 || len(adapted.byID) != 0 {
				t.Fatal("control adapter result contains explicit variants")
			}
			return
		}
		if len(adapted.coverage) == 0 || len(adapted.coverage) != len(adapted.byID) {
			t.Fatal("reviewed adapter returned an incomplete explicit variant set")
		}
		for _, variant := range adapted.coverage {
			if _, ok := adapted.byID[variant.ID]; !ok {
				t.Fatal("coverage variant is absent from reviewed variant map")
			}
		}
	})
}
