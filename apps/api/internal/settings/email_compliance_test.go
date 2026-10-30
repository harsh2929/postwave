package settings

import "testing"

func TestEmailCompliancePatchValidation(t *testing.T) {
	valid := EmailCompliancePatch{
		LegalSenderName:            "Moosewave Inc.",
		PhysicalAddressLine1:       "123 Main St",
		PhysicalAddressCity:        "Austin",
		PhysicalAddressCountry:     "US",
		ComplianceContactEmail:     "privacy@example.com",
		ListUnsubscribeEnabled:     true,
		OneClickUnsubscribeEnabled: true,
	}
	if err := validateEmailCompliancePatch(valid); err != nil {
		t.Fatalf("valid profile rejected: %v", err)
	}

	invalidEmail := valid
	invalidEmail.ComplianceContactEmail = "nope"
	if err := validateEmailCompliancePatch(invalidEmail); err == nil {
		t.Fatalf("invalid email accepted")
	}

	missingAddress := valid
	missingAddress.PhysicalAddressLine1 = ""
	if err := validateEmailCompliancePatch(missingAddress); err == nil {
		t.Fatalf("missing physical address accepted")
	}

	noOneClick := valid
	noOneClick.OneClickUnsubscribeEnabled = false
	if err := validateEmailCompliancePatch(noOneClick); err == nil {
		t.Fatalf("disabled one-click unsubscribe accepted")
	}
}

func TestEmailComplianceProfileIsReady(t *testing.T) {
	p := EmailComplianceProfile{
		LegalSenderName:            "Moosewave Inc.",
		PhysicalAddressLine1:       "123 Main St",
		PhysicalAddressCity:        "Austin",
		PhysicalAddressCountry:     "US",
		ComplianceContactEmail:     "privacy@example.com",
		ListUnsubscribeEnabled:     true,
		OneClickUnsubscribeEnabled: true,
	}
	if !p.IsReady() {
		t.Fatalf("profile should be ready")
	}
	p.ComplianceContactEmail = ""
	if p.IsReady() {
		t.Fatalf("profile without contact should not be ready")
	}
}
