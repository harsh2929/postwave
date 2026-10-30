// SPDX-License-Identifier: AGPL-3.0-only
package mailer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
)

func TestSanitizeTagKey(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"alnum_passthrough", "verify_email", "verify_email"},
		{"hyphen_ok", "reset-password", "reset-password"},
		{"strips_spaces", "verify email", "verifyemail"},
		{"strips_dots_in_key", "v.email", "vemail"}, // '.' allowed in values, not keys
		{"strips_unicode", "vérify", "vrify"},
		{"strips_punctuation", "tag!@#$", "tag"},
		{"all_invalid_yields_empty", "!!!", ""},
		{"truncates_over_256", strings.Repeat("a", 300), strings.Repeat("a", 256)},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := sanitizeTagKey(tc.in)
			if got != tc.want {
				t.Fatalf("sanitizeTagKey(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSanitizeTagValue(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"alnum_passthrough", "abc123", "abc123"},
		{"dot_allowed_in_value", "v1.2.3", "v1.2.3"},
		{"hyphen_underscore_ok", "v_1-2", "v_1-2"},
		{"strips_slash", "a/b", "ab"},
		{"strips_unicode", "café", "caf"},
		{"all_invalid_yields_empty", "@@@", ""},
		{"truncates_over_256", strings.Repeat("x", 500), strings.Repeat("x", 256)},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := sanitizeTagValue(tc.in)
			if got != tc.want {
				t.Fatalf("sanitizeTagValue(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestBuildSESTags_DropsUnsanitizable(t *testing.T) {
	t.Parallel()
	in := map[string]string{
		"good-key":  "good.value",
		"!!!":       "value", // unsanitizable key
		"key":       "!!!",   // unsanitizable value
		"another_k": "v1.0",
	}
	out := buildSESTags(in)
	if len(out) != 2 {
		t.Fatalf("buildSESTags: got %d tags, want 2 (in=%v out=%+v)", len(out), in, out)
	}
	for _, tag := range out {
		if tag.Name == nil || *tag.Name == "" {
			t.Errorf("tag with empty name in output: %+v", tag)
		}
		if tag.Value == nil || *tag.Value == "" {
			t.Errorf("tag with empty value in output: %+v", tag)
		}
	}
}

func TestBuildSESTags_NilOnEmptyInput(t *testing.T) {
	t.Parallel()
	if got := buildSESTags(nil); got != nil {
		t.Fatalf("buildSESTags(nil) = %+v, want nil", got)
	}
	if got := buildSESTags(map[string]string{}); got != nil {
		t.Fatalf("buildSESTags(empty) = %+v, want nil", got)
	}
}

func TestSESTagsForMessageReservesTenantBinding(t *testing.T) {
	const tenantID = "11111111-1111-4111-8111-111111111111"
	tags := sesTagsForMessage(Message{
		TenantID: tenantID,
		Tags: map[string]string{
			"purpose":             "receipt",
			sesTenantTagName:      "spoofed",
			"POSTWAVE_TENANT_ID":  "also-spoofed",
			"postwave_tenant_id!": "sanitized-spoof",
		},
	})
	if got := tags[sesTenantTagName]; got != tenantID {
		t.Fatalf("reserved tenant tag = %q, want %q", got, tenantID)
	}
	if len(tags) != 2 {
		t.Fatalf("tags = %#v; want purpose plus one server-owned tenant binding", tags)
	}

	withoutServerBinding := sesTagsForMessage(Message{
		Tags: map[string]string{sesTenantTagName: "forged"},
	})
	if withoutServerBinding != nil {
		t.Fatalf("caller-owned reserved tag was retained: %#v", withoutServerBinding)
	}
}

// stubSES implements sesAPI with a recorded last-input + canned error.
type stubSES struct {
	lastInput *sesv2.SendEmailInput
	err       error
	calls     int
	messageID string
}

func (s *stubSES) SendEmail(_ context.Context, in *sesv2.SendEmailInput, _ ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error) {
	s.calls++
	s.lastInput = in
	if s.err != nil {
		return nil, s.err
	}
	return &sesv2.SendEmailOutput{MessageId: &s.messageID}, nil
}

func TestSESMailer_Send_ValidatesBeforeCallingSES(t *testing.T) {
	t.Parallel()
	stub := &stubSES{}
	m := &SESMailer{client: stub}

	// Missing From — Validate() should reject before any SES call.
	err := m.Send(context.Background(), Message{
		To:      "user@example.com",
		Subject: "hi",
		Body:    "hi",
	})
	if err == nil {
		t.Fatal("expected validation error for missing From")
	}
	if stub.calls != 0 {
		t.Fatalf("SES SendEmail called %d times despite validation failure", stub.calls)
	}
}

func TestMessageValidateRejectsInvalidInternalTenantBinding(t *testing.T) {
	t.Parallel()
	err := (Message{
		TenantID: "not-a-tenant-uuid",
		From:     "from@example.com",
		To:       "to@example.com",
		Subject:  "subject",
		Body:     "body",
	}).Validate()
	if err == nil || !strings.Contains(err.Error(), "TenantID must be a UUID") {
		t.Fatalf("Validate error = %v", err)
	}
}

func TestSESMailer_Send_PassesThroughValidationError(t *testing.T) {
	t.Parallel()
	stub := &stubSES{}
	m := &SESMailer{client: stub}

	err := m.Send(context.Background(), Message{}) // empty
	if err == nil {
		t.Fatal("expected validation error")
	}
	// Validation errors are NOT wrapped as PermanentError — they're caller bugs,
	// not SES rejections.
	var perm *PermanentError
	if errors.As(err, &perm) {
		t.Fatalf("validation error wrapped as PermanentError: %v", err)
	}
}

func TestSESMailer_Send_BuildsExpectedInput(t *testing.T) {
	t.Parallel()
	stub := &stubSES{}
	m := &SESMailer{client: stub, configSet: "postwave-prod"}

	msg := Message{
		TenantID: "11111111-1111-4111-8111-111111111111",
		From:     "Moosewave <noreply@moosewave.com>",
		To:       "user@example.com",
		Subject:  "verify your email",
		Body:     "click the link",
		HTMLBody: "<a>click</a>",
		ReplyTo:  "support@moosewave.com",
		Tags:     map[string]string{"purpose": "verify_email"},
	}
	if err := m.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send returned err: %v", err)
	}
	in := stub.lastInput
	if in == nil {
		t.Fatal("stub did not record input")
	}
	if in.FromEmailAddress == nil || *in.FromEmailAddress != msg.From {
		t.Errorf("FromEmailAddress = %v, want %q", in.FromEmailAddress, msg.From)
	}
	if in.ConfigurationSetName == nil || *in.ConfigurationSetName != "postwave-prod" {
		t.Errorf("ConfigurationSetName = %v, want postwave-prod", in.ConfigurationSetName)
	}
	if len(in.ReplyToAddresses) != 1 || in.ReplyToAddresses[0] != msg.ReplyTo {
		t.Errorf("ReplyToAddresses = %v, want [%q]", in.ReplyToAddresses, msg.ReplyTo)
	}
	if len(in.Destination.ToAddresses) != 1 || in.Destination.ToAddresses[0] != msg.To {
		t.Errorf("Destination.ToAddresses = %v, want [%q]", in.Destination.ToAddresses, msg.To)
	}
	if in.Content == nil || in.Content.Simple == nil {
		t.Fatal("Content.Simple not set")
	}
	if in.Content.Simple.Body.Text == nil || in.Content.Simple.Body.Html == nil {
		t.Error("expected both Text and HTML body parts")
	}
	if len(in.EmailTags) != 2 {
		t.Errorf("EmailTags len = %d, want purpose + tenant binding", len(in.EmailTags))
	}
}

func TestSESMailerSendWithReceiptReturnsProviderMessageID(t *testing.T) {
	t.Parallel()
	stub := &stubSES{messageID: "ses-provider-message-1"}
	m := &SESMailer{client: stub}
	receipt, err := m.SendWithReceipt(context.Background(), Message{
		From:    "from@example.com",
		To:      "to@example.com",
		Subject: "subject",
		Body:    "body",
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ProviderMessageID != stub.messageID {
		t.Fatalf("provider message id = %q, want %q", receipt.ProviderMessageID, stub.messageID)
	}
}

func TestSESMailerRawPathPreservesCompiledMIMEAndEnvelopeEvidence(t *testing.T) {
	t.Parallel()
	const tenantID = "11111111-1111-4111-8111-111111111111"
	raw := []byte("From: Sender <sender@example.com>\r\n" +
		"To: visible@example.net\r\n" +
		"Subject: frozen\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n\r\nbody\r\n")
	stub := &stubSES{messageID: "ses-raw-42"}
	mailer := &SESMailer{client: stub, configSet: "campaign-raw-certified"}
	receipt, err := mailer.SendWithReceipt(context.Background(), Message{
		TenantID: tenantID,
		From:     "sender@example.com",
		ToList:   []string{"visible@example.net"},
		Cc:       []string{"copy@example.net"},
		Bcc:      []string{"blind@example.net"},
		Raw:      append([]byte(nil), raw...),
		// These simple-message fields must never cause SES to re-render Raw.
		Subject:  "ignored subject",
		Body:     "ignored plain",
		HTMLBody: "<p>ignored HTML</p>",
		Headers:  map[string]string{"X-Ignored": "yes"},
		Tags:     map[string]string{"purpose": "campaign"},
	})
	if err != nil {
		t.Fatalf("SendWithReceipt(raw): %v", err)
	}
	if receipt.ProviderMessageID != "ses-raw-42" {
		t.Fatalf("provider message id = %q", receipt.ProviderMessageID)
	}
	input := stub.lastInput
	if input == nil || input.Content == nil || input.Content.Raw == nil {
		t.Fatalf("SES raw content missing: %+v", input)
	}
	if input.Content.Simple != nil {
		t.Fatal("raw path also populated Content.Simple; provider could re-render the artifact")
	}
	if !bytes.Equal(input.Content.Raw.Data, raw) {
		t.Fatalf("raw MIME changed\ngot:  %q\nwant: %q", input.Content.Raw.Data, raw)
	}
	if got := input.Destination.ToAddresses; len(got) != 1 || got[0] != "visible@example.net" {
		t.Fatalf("To envelope = %#v", got)
	}
	if got := input.Destination.CcAddresses; len(got) != 1 || got[0] != "copy@example.net" {
		t.Fatalf("Cc envelope = %#v", got)
	}
	if got := input.Destination.BccAddresses; len(got) != 1 || got[0] != "blind@example.net" {
		t.Fatalf("Bcc envelope = %#v", got)
	}
	if input.ConfigurationSetName == nil || *input.ConfigurationSetName != "campaign-raw-certified" {
		t.Fatalf("configuration set = %v", input.ConfigurationSetName)
	}
	if len(input.EmailTags) != 2 {
		t.Fatalf("EmailTags = %#v, want purpose plus tenant binding", input.EmailTags)
	}
}

// A refusal SES gives for good is a PermanentError that says why; throttling
// and server errors stay retryable. The errors come from the real SESv2
// client decoding the responses SES sends, including the 403 an IAM policy
// that only allows approved recipients produces (it is not a modeled SESv2
// error type, so it arrives as a generic API error).
func TestSESMailerClassifiesProviderRefusalsFromRealResponses(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		status     int
		errorType  string
		message    string
		wantReason RefusalReason // "" = transient
	}{
		{"iam denial", http.StatusForbidden, "AccessDeniedException",
			"User 'arn:aws:sts::123456789012:assumed-role/api/task' is not authorized to perform 'ses:SendEmail' on resource 'arn:aws:ses:eu-west-1:123456789012:identity/example.test'",
			RefusalNotPermitted},
		{"sandbox recipient", http.StatusBadRequest, "MessageRejected",
			"Email address is not verified. The following identities failed the check in region EU-WEST-1: visitor@example.net",
			RefusalNotPermitted},
		{"unverified mail-from", http.StatusBadRequest, "MailFromDomainNotVerifiedException", "MAIL FROM domain not verified", RefusalSenderUnverified},
		{"sending paused", http.StatusBadRequest, "SendingPausedException", "Sending is paused for this account", RefusalSendingPaused},
		{"unknown configuration set", http.StatusNotFound, "NotFoundException", "Configuration set does not exist", RefusalInvalidRequest},
		{"throttled", http.StatusTooManyRequests, "TooManyRequestsException", "Too many requests", ""},
		{"server error", http.StatusInternalServerError, "InternalServiceErrorException", "Internal error", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Amzn-Errortype", tc.errorType)
				w.Header().Set("X-Amzn-Requestid", "4ca9fa56-2260-4a14-a7b4-a79e27b0a793")
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": tc.message})
			}))
			defer srv.Close()
			client := sesv2.New(sesv2.Options{
				Region:       "eu-west-1",
				BaseEndpoint: aws.String(srv.URL),
				Credentials:  aws.AnonymousCredentials{},
				HTTPClient:   srv.Client(),
				Retryer:      aws.NopRetryer{},
			})
			err := (&SESMailer{client: client}).Send(context.Background(), Message{
				From: "signups@example.test", To: "visitor@example.net", Subject: "Confirm", Body: "Confirm",
			})
			if err == nil {
				t.Fatal("Send succeeded against a refusing provider")
			}
			var permanent *PermanentError
			isPermanent := errors.As(err, &permanent)
			switch {
			case tc.wantReason == "" && isPermanent:
				t.Fatalf("a retryable %s was reported as a permanent refusal (%s): %v", tc.errorType, permanent.Reason, err)
			case tc.wantReason != "" && !isPermanent:
				t.Fatalf("%s was reported as retryable: %v", tc.errorType, err)
			case tc.wantReason != "" && permanent.Reason != tc.wantReason:
				t.Fatalf("%s refusal reason = %q, want %q", tc.errorType, permanent.Reason, tc.wantReason)
			}
		})
	}
}

func TestMessageValidateAllowsCompleteRawMIMEWithoutSimpleBodyFields(t *testing.T) {
	t.Parallel()
	err := (Message{
		From: "sender@example.com",
		To:   "recipient@example.net",
		Raw:  []byte("From: sender@example.com\r\n\r\nbody"),
	}).Validate()
	if err != nil {
		t.Fatalf("Validate(raw): %v", err)
	}
}
