// SPDX-License-Identifier: AGPL-3.0-only

package pii_gateway

import (
	"errors"
	"strings"
	"testing"
)

func TestStrictTextSanitizerDetectsAndRestoresActualValues(t *testing.T) {
	const (
		email  = "alice@example.com"
		phone  = "+1 415-555-0199"
		secret = "sk_live_51VerySensitiveToken"
		custom = "LOYAL-998877"
	)
	prompt := "Email " + email + " and use api_key=" + secret
	contextText := "Backup phone: " + phone + "\nloyalty_number: " + custom

	sanitizer, err := NewStrictTextSanitizer(
		"request-salt",
		[]FieldSensitivity{{FieldName: "loyalty_number", Sensitive: true}},
		nil,
		prompt,
		contextText,
	)
	if err != nil {
		t.Fatalf("NewStrictTextSanitizer: %v", err)
	}

	sanitizedPrompt := sanitizer.Sanitize(prompt)
	sanitizedContext := sanitizer.Sanitize(contextText)
	for _, raw := range []string{email, phone, secret, custom} {
		if strings.Contains(sanitizedPrompt, raw) || strings.Contains(sanitizedContext, raw) {
			t.Errorf("sensitive value reached sanitized text: %q", raw)
		}
	}
	if !strings.Contains(sanitizedPrompt, "[[PII:EMAIL:") {
		t.Fatalf("prompt did not contain an email token: %q", sanitizedPrompt)
	}
	if !strings.Contains(sanitizedContext, "[[PII:PHONE:") {
		t.Fatalf("context did not contain a phone token: %q", sanitizedContext)
	}
	if got := sanitizer.Restore(sanitizedPrompt + "\n" + sanitizedContext); !strings.Contains(got, email) ||
		!strings.Contains(got, phone) || !strings.Contains(got, secret) || !strings.Contains(got, custom) {
		t.Fatalf("Restore did not recover every protected value: %q", got)
	}
}

func TestStrictTextSanitizerProtectsExplicitConfiguredValues(t *testing.T) {
	const customerSecret = "tenant-specific-secret-value"
	sanitizer, err := NewStrictTextSanitizer(
		"request-salt",
		nil,
		[]KindValue{{Kind: "CUSTOM_SECRET", Value: customerSecret}},
		"Write about "+customerSecret,
	)
	if err != nil {
		t.Fatalf("NewStrictTextSanitizer: %v", err)
	}
	sanitized := sanitizer.Sanitize("Write about " + customerSecret)
	if strings.Contains(sanitized, customerSecret) {
		t.Fatalf("configured value was not protected: %q", sanitized)
	}
	if restored := sanitizer.Restore(sanitized); !strings.Contains(restored, customerSecret) {
		t.Fatalf("configured value was not restored: %q", restored)
	}
}

func TestStrictTextSanitizerLeavesNonPIITextUsable(t *testing.T) {
	const input = "Draft a concise product update for annual subscribers."
	sanitizer, err := NewStrictTextSanitizer("request-salt", nil, nil, input)
	if err != nil {
		t.Fatalf("NewStrictTextSanitizer: %v", err)
	}
	if got := sanitizer.Sanitize(input); got != input {
		t.Fatalf("non-PII text changed: got %q want %q", got, input)
	}
}

func TestStrictTextSanitizerFailsClosedOnInvalidOrUnboundedInput(t *testing.T) {
	tests := []struct {
		name string
		salt string
		text string
		want error
	}{
		{name: "missing salt", text: "hello", want: ErrStrictTextInvalid},
		{name: "invalid UTF-8", salt: "salt", text: string([]byte{0xff}), want: ErrStrictTextInvalid},
		{name: "too large", salt: "salt", text: strings.Repeat("x", StrictTextMaxBytes+1), want: ErrStrictTextTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NewStrictTextSanitizer(test.salt, nil, nil, test.text)
			if got != nil || !errors.Is(err, test.want) {
				t.Fatalf("sanitizer=%T err=%v, want nil and %v", got, err, test.want)
			}
		})
	}
}

func TestStrictTextSanitizerFailsClosedWhenDetectionSetOverflows(t *testing.T) {
	values := make([]KindValue, 0, maxStrictValues+1)
	for index := 0; index <= maxStrictValues; index++ {
		values = append(values, KindValue{
			Kind:  "SECRET",
			Value: "secret-value-" + strings.Repeat("x", index+1),
		})
	}
	sanitizer, err := NewStrictTextSanitizer("salt", nil, values, "plain text")
	if sanitizer != nil || !errors.Is(err, ErrStrictTextTooManyValues) {
		t.Fatalf("sanitizer=%T err=%v", sanitizer, err)
	}
}

func TestConfiguredLabelValuesRequireSensitiveConfigAndBoundedAssignment(t *testing.T) {
	const value = "VIP-44001"
	text := "{\"member_code\":\"" + value + "\",\"public_note\":\"hello\"}"
	sanitizer, err := NewStrictTextSanitizer(
		"salt",
		[]FieldSensitivity{
			{FieldName: "member_code", Sensitive: true},
			{FieldName: "public_note", Sensitive: false},
		},
		nil,
		text,
	)
	if err != nil {
		t.Fatalf("NewStrictTextSanitizer: %v", err)
	}
	sanitized := sanitizer.Sanitize(text)
	if strings.Contains(sanitized, value) {
		t.Fatalf("configured field value leaked: %q", sanitized)
	}
	if !strings.Contains(sanitized, "hello") {
		t.Fatalf("non-sensitive configured field was changed: %q", sanitized)
	}
}

func TestStrictTextSanitizerProtectsValidatedIdentifiersAndQuotedSecrets(t *testing.T) {
	const (
		ssn      = "123-45-6789"
		iban     = "GB82WEST12345698765432"
		password = "correct horse!battery staple"
		basic    = "dXNlcjpwYXNz"
	)
	input := "ssn=" + ssn + " iban=" + iban + ` password="` + password + `" Authorization: Basic ` + basic
	sanitizer, err := NewStrictTextSanitizer("salt", nil, nil, input)
	if err != nil {
		t.Fatalf("NewStrictTextSanitizer: %v", err)
	}
	sanitized := sanitizer.Sanitize(input)
	for _, raw := range []string{ssn, iban, password, basic} {
		if strings.Contains(sanitized, raw) {
			t.Errorf("validated sensitive value remained in model text: %q", raw)
		}
	}
	if restored := sanitizer.Restore(sanitized); restored != input {
		t.Fatalf("restored=%q want=%q", restored, input)
	}
}

func TestStrictTextSanitizerDoesNotTreatInvalidSSNOrIBANAsHighConfidence(t *testing.T) {
	const input = "references: 000-00-0000, GB00WEST12345698765432, and Basic authentication"
	sanitizer, err := NewStrictTextSanitizer("salt", nil, nil, input)
	if err != nil {
		t.Fatalf("NewStrictTextSanitizer: %v", err)
	}
	if sanitized := sanitizer.Sanitize(input); sanitized != input {
		t.Fatalf("invalid identifiers should remain usable: %q", sanitized)
	}
}

func TestStrictTextSanitizerFailsClosedOnInvalidOrUnboundedPolicy(t *testing.T) {
	tooMany := make([]FieldSensitivity, maxStrictFields+1)
	for index := range tooMany {
		tooMany[index] = FieldSensitivity{
			FieldName: "sensitive_field",
			Sensitive: true,
		}
	}
	tests := []struct {
		name   string
		config []FieldSensitivity
		want   error
	}{
		{
			name: "invalid sensitive field name",
			config: []FieldSensitivity{{
				FieldName: "secret\nfield",
				Sensitive: true,
			}},
			want: ErrStrictTextInvalid,
		},
		{
			name:   "too many sensitive fields",
			config: tooMany,
			want:   ErrStrictTextTooManyFields,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sanitizer, err := NewStrictTextSanitizer("salt", test.config, nil, "plain text")
			if sanitizer != nil || !errors.Is(err, test.want) {
				t.Fatalf("sanitizer=%T err=%v want=%v", sanitizer, err, test.want)
			}
		})
	}
}
