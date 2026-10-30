// SPDX-License-Identifier: AGPL-3.0-only

package audience_destinations

import (
	"net/http/httptest"
	"testing"
)

func TestOptionalAudienceIfMatchRequiresOneStrongExactValidator(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		value []string
		want  string
		ok    bool
	}{
		{name: "omitted", ok: true},
		{name: "strong", value: []string{`"audience-sync:row:v17"`}, want: `"audience-sync:row:v17"`, ok: true},
		{name: "whitespace", value: []string{`  "audience-destination:row:v22"  `}, want: `"audience-destination:row:v22"`, ok: true},
		{name: "empty", value: []string{""}},
		{name: "wildcard", value: []string{"*"}},
		{name: "weak", value: []string{`W/"audience-sync:row:v17"`}},
		{name: "comma list", value: []string{`"audience-sync:row:v17", "audience-sync:row:v16"`}},
		{name: "unquoted", value: []string{"audience-sync:row:v17"}},
		{name: "multiple header lines", value: []string{`"audience-sync:row:v17"`, `"audience-sync:row:v16"`}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest("PATCH", "/", nil)
			for _, value := range tt.value {
				req.Header.Add("If-Match", value)
			}
			got, ok := optionalAudienceIfMatch(req)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("optionalAudienceIfMatch() = (%q, %v), want (%q, %v)", got, ok, tt.want, tt.ok)
			}
		})
	}
}
