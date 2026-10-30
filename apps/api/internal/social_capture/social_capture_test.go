package social_capture

import "testing"

func TestValidateRuleRequiresTrigger(t *testing.T) {
	got := ValidateRule(AutoReplyRule{Name: "IG quiz", Network: "instagram"})
	if got.Valid {
		t.Fatal("expected invalid rule without trigger phrase")
	}
}

func TestValidateRuleNormalizesSupportedRule(t *testing.T) {
	got := ValidateRule(AutoReplyRule{
		Name:           "IG quiz",
		Network:        "Instagram",
		Status:         "Active",
		TriggerPhrases: []string{"Quiz", " quiz "},
		SMSListID:      "00000000-0000-0000-0000-000000000001",
		Questions:      []Question{{Key: "email", Label: "Email"}},
	})
	if !got.Valid {
		t.Fatalf("expected valid rule, got %#v", got)
	}
	if len(got.Warnings) != 0 {
		t.Fatalf("warnings = %#v", got.Warnings)
	}
}

func TestSMSURIEscapesBody(t *testing.T) {
	got := SMSURI(TapToTextLink{
		DestinationPhone: "+14155550100",
		MessageBody:      "JOIN VIP",
	})
	want := "sms:+14155550100?&body=JOIN+VIP"
	if got != want {
		t.Fatalf("SMSURI = %q, want %q", got, want)
	}
}

func TestNormalizeTapLink(t *testing.T) {
	link := TapToTextLink{
		Name:             "Spring Drop",
		SMSListID:        "00000000-0000-0000-0000-000000000001",
		DestinationPhone: "+14155550100",
	}
	if err := normalizeTapLink(&link); err != nil {
		t.Fatal(err)
	}
	if link.Slug != "spring-drop" {
		t.Fatalf("slug = %q", link.Slug)
	}
	if link.MessageBody != "START" {
		t.Fatalf("message body = %q", link.MessageBody)
	}
}
