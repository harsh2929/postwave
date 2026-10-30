// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import "testing"

func TestDecodeStoredTabletopParticipantsFailsClosed(t *testing.T) {
	t.Parallel()

	valid, err := decodeStoredTabletopParticipants([]byte(`["Ada\u200dLovelace","Grace"]`))
	if err != nil {
		t.Fatalf("valid participants: %v", err)
	}
	if len(valid) != 2 || valid[0] != "Ada\u200dLovelace" || valid[1] != "Grace" {
		t.Fatalf("valid participants=%v", valid)
	}

	for name, raw := range map[string]string{
		"empty bytes":       "",
		"malformed json":    `["Ada"`,
		"wrong shape":       `{"name":"Ada"}`,
		"json null":         `null`,
		"empty array":       `[]`,
		"empty value":       `[""]`,
		"duplicate":         `["Ada","Ada"]`,
		"noncanonical trim": `[" Ada "]`,
		"control":           `["Ada\u0000"]`,
		"bidi formatting":   `["Ada\u202eecarG"]`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got, err := decodeStoredTabletopParticipants([]byte(raw)); err == nil {
				t.Fatalf("participants=%v, want a contract error", got)
			}
		})
	}
}
