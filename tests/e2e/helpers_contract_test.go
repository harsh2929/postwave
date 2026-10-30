package e2e

import "testing"

func TestE2EEnabledRequiresExplicitOptIn(t *testing.T) {
	for _, value := range []string{"1", "true", "YES", " on "} {
		t.Run("enabled_"+value, func(t *testing.T) {
			t.Setenv("POSTWAVE_E2E_RUN", value)
			if !E2EEnabled() {
				t.Fatalf("E2EEnabled() = false for explicit opt-in %q", value)
			}
		})
	}
	for _, value := range []string{"", "0", "false", "disabled", "2"} {
		t.Run("disabled_"+value, func(t *testing.T) {
			t.Setenv("POSTWAVE_E2E_RUN", value)
			if E2EEnabled() {
				t.Fatalf("E2EEnabled() = true without explicit opt-in for %q", value)
			}
		})
	}
}
