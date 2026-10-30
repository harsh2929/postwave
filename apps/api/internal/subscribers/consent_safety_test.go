package subscribers

import (
	"strings"
	"testing"
	"time"
)

func completeCreateConsentInput() CreateInput {
	when := time.Date(2026, 7, 1, 10, 30, 0, 0, time.UTC)
	return CreateInput{
		Email:                "subscriber@example.test",
		Status:               StatusEnabled,
		ConsentTimestamp:     &when,
		ConsentSource:        ConsentDoubleOptIn,
		ConsentChannel:       "email",
		ConsentLegalBasis:    "consent",
		ConsentEvidence:      "receipt:consent-123",
		ConsentReason:        "Reviewed the double opt-in receipt.",
		ConsentPolicyVersion: "privacy-2026-07",
		Country:              "gb",
	}
}

func TestNormalizeCreate_DefaultsToNonSendableWithoutConsentClaims(t *testing.T) {
	in := CreateInput{Email: "subscriber@example.test"}
	if err := normalizeCreate(&in); err != nil {
		t.Fatalf("normalizeCreate: %v", err)
	}
	if in.Status != StatusUnconfirmed || in.MailchimpStatus != "non_subscribed" || in.ConsentSource != ConsentUnknown {
		t.Fatalf("unsafe create defaults: status=%q mailchimp=%q source=%q", in.Status, in.MailchimpStatus, in.ConsentSource)
	}
}

func TestNormalizeCreate_EnabledRequiresCompleteConsentEvidence(t *testing.T) {
	base := completeCreateConsentInput()
	cases := []struct {
		name string
		edit func(*CreateInput)
	}{
		{"timestamp", func(in *CreateInput) { in.ConsentTimestamp = nil }},
		{"source", func(in *CreateInput) { in.ConsentSource = ConsentUnknown }},
		{"channel", func(in *CreateInput) { in.ConsentChannel = "" }},
		{"legal basis", func(in *CreateInput) { in.ConsentLegalBasis = "" }},
		{"evidence", func(in *CreateInput) { in.ConsentEvidence = "" }},
		{"reason", func(in *CreateInput) { in.ConsentReason = "" }},
		{"policy", func(in *CreateInput) { in.ConsentPolicyVersion = "" }},
		{"jurisdiction", func(in *CreateInput) { in.Country = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			tc.edit(&in)
			if err := normalizeCreate(&in); err == nil {
				t.Fatal("incomplete evidence must not create a sendable subscriber")
			}
		})
	}
	in := base
	if err := normalizeCreate(&in); err != nil {
		t.Fatalf("complete evidence rejected: %v", err)
	}
	if in.Country != "GB" || in.MailchimpStatus != "subscribed" {
		t.Fatalf("complete evidence was not canonicalized: %+v", in)
	}
}

func TestNormalizeCreate_NonSendableStatusRejectsOrphanConsentClaims(t *testing.T) {
	when := time.Date(2026, 7, 1, 10, 30, 0, 0, time.UTC)
	for _, in := range []CreateInput{
		{Email: "source@example.test", Status: StatusUnconfirmed, ConsentSource: ConsentDoubleOptIn},
		{Email: "time@example.test", Status: StatusDisabled, ConsentTimestamp: &when},
		{Email: "proof@example.test", Status: StatusBlocklisted, ConsentEvidence: "orphan proof"},
	} {
		if err := normalizeCreate(&in); err == nil || !strings.Contains(err.Error(), "consent evidence") {
			t.Fatalf("orphan consent claim accepted: %+v (err=%v)", in, err)
		}
	}
}

func completeUpdateConsentInput() UpdateInput {
	status := StatusEnabled
	when := time.Date(2026, 7, 1, 10, 30, 0, 0, time.UTC)
	source := ConsentDoubleOptIn
	return UpdateInput{
		Status:               &status,
		ConsentTimestamp:     &when,
		ConsentSource:        &source,
		ConsentChannel:       " EMAIL ",
		ConsentLegalBasis:    " CONSENT ",
		ConsentJurisdiction:  " gb ",
		ConsentEvidence:      " receipt:update-123 ",
		ConsentReason:        " reviewed the exact-address receipt ",
		ConsentPolicyVersion: " privacy-2026-07 ",
	}
}

func TestNormalizeUpdate_EnabledRequiresCompleteAddressEvidence(t *testing.T) {
	base := completeUpdateConsentInput()
	cases := []struct {
		name string
		edit func(*UpdateInput)
	}{
		{"timestamp", func(in *UpdateInput) { in.ConsentTimestamp = nil }},
		{"source", func(in *UpdateInput) { in.ConsentSource = nil }},
		{"channel", func(in *UpdateInput) { in.ConsentChannel = "" }},
		{"legal basis", func(in *UpdateInput) { in.ConsentLegalBasis = "" }},
		{"jurisdiction", func(in *UpdateInput) { in.ConsentJurisdiction = "" }},
		{"evidence", func(in *UpdateInput) { in.ConsentEvidence = "" }},
		{"reason", func(in *UpdateInput) { in.ConsentReason = "" }},
		{"policy", func(in *UpdateInput) { in.ConsentPolicyVersion = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			tc.edit(&in)
			if err := normalizeUpdate(&in); err == nil {
				t.Fatal("incomplete evidence must not enable a subscriber")
			}
		})
	}
	in := base
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("complete update evidence rejected: %v", err)
	}
	if in.ConsentChannel != "email" || in.ConsentLegalBasis != "consent" || in.ConsentJurisdiction != "GB" {
		t.Fatalf("update evidence was not canonicalized: %+v", in)
	}
}

func TestNormalizeUpdate_RejectsOrphanConsentEvidence(t *testing.T) {
	name := "Ordinary profile edit"
	if err := normalizeUpdate(&UpdateInput{FullName: &name}); err != nil {
		t.Fatalf("unrelated profile edit rejected: %v", err)
	}
	in := completeUpdateConsentInput()
	in.Status = nil
	if err := normalizeUpdate(&in); err == nil || !strings.Contains(err.Error(), "status=enabled") {
		t.Fatalf("orphan update evidence accepted: %v", err)
	}
}
