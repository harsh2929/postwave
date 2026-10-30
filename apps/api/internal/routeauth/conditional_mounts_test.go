package routeauth

import (
	"testing"
)

// The exemption these tests police is the difference between "this deployment
// did not enable the feature" and "this feature is broken". Before it existed,
// both looked identical: the API refused to boot, and the only way past was
// POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1, which disables the ENTIRE guard --
// forward direction included -- and has already hidden a real defect
// (activitycursor, unreachable on main for 17 days).

func TestConditionalMountsAreWellFormed(t *testing.T) {
	got, err := loadConditionalMounts()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(got) == 0 {
		t.Fatal("no conditional mounts loaded; the reverse-check exemption would be dead code")
	}
}

// A conditional entry for a route the manifest does not contain is either a
// typo or a leftover, and both silently widen what the reverse check forgives.
func TestEveryConditionalRouteExistsInTheManifest(t *testing.T) {
	conditional, err := loadConditionalMounts()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	manifestKeys := make(map[string]struct{}, len(defaultManifest.routes))
	for _, p := range defaultManifest.routes {
		manifestKeys[policyKey(p.Method, normalizeTemplate(p.Path))] = struct{}{}
	}
	for key := range conditional {
		if _, ok := manifestKeys[key]; !ok {
			t.Errorf("conditional mount %q is not in the routeauth manifest; "+
				"delete the entry or fix its method/path", key)
		}
	}
}

// The whole point: OFF is excused, ON is not.
func TestGateEnabledSemantics(t *testing.T) {
	const key = "POSTWAVE_TEST_GATE_PROBE"
	for _, off := range []string{"", "0", "false", "no", "off", "  "} {
		t.Setenv(key, off)
		if gateEnabled(key) {
			t.Errorf("%q must read as an OFF gate, so the route stays excused", off)
		}
	}
	for _, on := range []string{"1", "true", "yes", "on", "some-client-id", "hex:abc"} {
		t.Setenv(key, on)
		if !gateEnabled(key) {
			t.Errorf("%q must read as an ON gate, so the route MUST mount", on)
		}
	}
}

// An unset gate is off — the password-only deployment case. This is separate
// from the table above because t.Setenv cannot express "never set".
func TestUnsetGateIsOff(t *testing.T) {
	if gateEnabled("POSTWAVE_DEFINITELY_NOT_SET_ANYWHERE_12345") {
		t.Fatal("an unset gate must be off; otherwise a password-only deployment cannot boot")
	}
}
