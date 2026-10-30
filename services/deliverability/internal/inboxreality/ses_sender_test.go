// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
)

type sesAPIFake struct {
	input *sesv2.SendEmailInput
}

func (f *sesAPIFake) SendEmail(_ context.Context, input *sesv2.SendEmailInput, _ ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error) {
	f.input = input
	return &sesv2.SendEmailOutput{MessageId: aws.String("ses-receipt-1")}, nil
}

func TestSESRawSeedSenderUsesEnvelopeDestinationAndExactMIME(t *testing.T) {
	api := &sesAPIFake{}
	sender := &SESRawSeedSender{client: api, configSet: "controlled-seeds"}
	raw := []byte("From: Moosewave <sender@example.test>\r\nTo: placeholder@example.test\r\nSubject: Launch\r\n\r\nLaunch\r\n")
	receipt, err := sender.SendRaw(context.Background(), SendRequest{
		EnvelopeTo: "private-seed@example.test", RawMIME: raw, MIMEHash: digest(raw),
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ProviderMessageID != "ses-receipt-1" || api.input == nil ||
		aws.ToString(api.input.FromEmailAddress) != "sender@example.test" ||
		len(api.input.Destination.ToAddresses) != 1 ||
		api.input.Destination.ToAddresses[0] != "private-seed@example.test" ||
		api.input.ConfigurationSetName == nil ||
		!bytes.Equal(api.input.Content.Raw.Data, raw) {
		t.Fatal("SES request did not preserve the exact controlled-seed envelope/MIME contract")
	}
}
