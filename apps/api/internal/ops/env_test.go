// SPDX-License-Identifier: AGPL-3.0-only

package ops

import "testing"

// clearProductionEnvKeys blanks every key IsProductionEnv consults so each
// case starts from a known-clean slate regardless of the ambient shell
// (NODE_ENV in particular is commonly set on dev machines). t.Setenv also
// restores the originals when the test ends.
func clearProductionEnvKeys(t *testing.T) {
	t.Helper()
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		t.Setenv(key, "")
	}
}

// TestIsProductionEnv pins the shared production detector's full contract:
// three keys, two spellings, case-insensitive, whitespace-tolerant. main.go's
// boot checks and the push canary's zero-channels branch both ride on this —
// the canary once matched only POSTWAVE_ENV=production while the boot check
// accepted all of the below, and that divergence let a mis-spelled production
// deployment hide an unwired alert pipeline in the board's green lane.
func TestIsProductionEnv(t *testing.T) {
	cases := []struct {
		name  string
		key   string
		value string
		want  bool
	}{
		{"POSTWAVE_ENV production", "POSTWAVE_ENV", "production", true},
		{"POSTWAVE_ENV prod", "POSTWAVE_ENV", "prod", true},
		{"POSTWAVE_ENV mixed case", "POSTWAVE_ENV", "Production", true},
		{"POSTWAVE_ENV padded", "POSTWAVE_ENV", "  production  ", true},
		{"ENVIRONMENT production", "ENVIRONMENT", "production", true},
		{"ENVIRONMENT prod", "ENVIRONMENT", "PROD", true},
		{"NODE_ENV production", "NODE_ENV", "production", true},
		{"NODE_ENV prod", "NODE_ENV", "prod", true},
		{"development is not production", "POSTWAVE_ENV", "development", false},
		{"staging is not production", "ENVIRONMENT", "staging", false},
		{"prefix does not match", "NODE_ENV", "production-eu", false},
		{"empty value", "POSTWAVE_ENV", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearProductionEnvKeys(t)
			t.Setenv(tc.key, tc.value)
			if got := IsProductionEnv(); got != tc.want {
				t.Fatalf("IsProductionEnv() with %s=%q = %v, want %v", tc.key, tc.value, got, tc.want)
			}
		})
	}

	t.Run("no keys set", func(t *testing.T) {
		clearProductionEnvKeys(t)
		if IsProductionEnv() {
			t.Fatal("IsProductionEnv() with no env keys set must be false")
		}
	})
}
