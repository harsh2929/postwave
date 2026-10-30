package views

import "testing"

func TestValidSeverity(t *testing.T) {
	for _, s := range []string{"sev1", "sev2", "sev3"} {
		if !ValidSeverity(s) {
			t.Fatalf("ValidSeverity(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "sev0", "SEV1", "critical", "sev4"} {
		if ValidSeverity(s) {
			t.Fatalf("ValidSeverity(%q) = true, want false", s)
		}
	}
}

func TestValidIncidentStatus(t *testing.T) {
	for _, s := range []string{"open", "monitoring", "resolved"} {
		if !ValidIncidentStatus(s) {
			t.Fatalf("ValidIncidentStatus(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "closed", "OPEN", "done"} {
		if ValidIncidentStatus(s) {
			t.Fatalf("ValidIncidentStatus(%q) = true, want false", s)
		}
	}
}
