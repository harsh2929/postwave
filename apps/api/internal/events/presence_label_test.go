// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestPresenceDisplayLabel locks in the A27 contract: presence labels
// are human-readable but never expose the full email address.
func TestPresenceDisplayLabel(t *testing.T) {
	cases := []struct {
		name string
		user *middleware.User
		want string
	}{
		{"nil user", nil, ""},
		{"plain email", &middleware.User{Email: "alice@example.com"}, "alice"},
		{"trims whitespace", &middleware.User{Email: "  bob@x.dev "}, "bob"},
		{"no at-sign passes through", &middleware.User{Email: "operator"}, "operator"},
		{"leading at-sign keeps raw", &middleware.User{Email: "@weird"}, "@weird"},
		{"empty email", &middleware.User{Email: ""}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := presenceDisplayLabel(tc.user); got != tc.want {
				t.Errorf("presenceDisplayLabel(%+v) = %q, want %q", tc.user, got, tc.want)
			}
		})
	}
	for _, tc := range cases {
		if tc.user == nil {
			continue
		}
		got := presenceDisplayLabel(tc.user)
		if i := indexByteSafe(got, '@'); i > 0 {
			t.Errorf("label %q still contains a full-email shape", got)
		}
	}
}

func indexByteSafe(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
