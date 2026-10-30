package views

import "testing"

func TestDeriveTenantHealth(t *testing.T) {
	cases := []struct {
		name          string
		sendingPaused bool
		dunning       bool
		want          TenantHealth
	}{
		{"clean", false, false, HealthOK},
		{"dunning only", false, true, HealthDunning},
		{"paused sending", true, false, HealthSuspended},
		{"paused beats dunning", true, true, HealthSuspended},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DeriveTenantHealth(tc.sendingPaused, tc.dunning); got != tc.want {
				t.Fatalf("DeriveTenantHealth(%v,%v) = %q, want %q", tc.sendingPaused, tc.dunning, got, tc.want)
			}
		})
	}
}
