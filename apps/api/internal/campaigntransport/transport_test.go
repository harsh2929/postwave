// SPDX-License-Identifier: AGPL-3.0-only

package campaigntransport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

const (
	transportTenantID   = "00000000-0000-4000-8000-000000000001"
	transportCampaignID = "00000000-0000-4000-8000-000000000002"
	transportArtifactID = "00000000-0000-4000-8000-000000000003"
)

type receiptMailer struct {
	message           mailer.Message
	err               error
	providerMessageID string
}

func (m *receiptMailer) Send(_ context.Context, message mailer.Message) error {
	m.message = message
	return m.err
}

func (m *receiptMailer) SendWithReceipt(_ context.Context, message mailer.Message) (mailer.DeliveryReceipt, error) {
	m.message = message
	providerID := m.providerMessageID
	if providerID == "" && m.err == nil {
		providerID = "provider-message-1"
	}
	return mailer.DeliveryReceipt{ProviderMessageID: providerID}, m.err
}

func TestRawMailerTransportTreatsMissingProviderReceiptAsIndeterminate(t *testing.T) {
	t.Parallel()
	compiled := transportFixture(t)
	provider := &receiptMailer{providerMessageID: " "}
	_, err := (RawMailerTransport{Mailer: provider}).Send(context.Background(), validRequest(compiled))
	if !errors.Is(err, ErrProviderReceiptMissing) || FailureDispositionOf(err) != FailureIndeterminate {
		t.Fatalf("error/disposition = %v/%q", err, FailureDispositionOf(err))
	}
}

type basicMailer struct{ message mailer.Message }

func (m *basicMailer) Send(_ context.Context, message mailer.Message) error {
	m.message = message
	return nil
}

func TestRawMailerTransportPreservesExactCompiledMIMEAndReceipt(t *testing.T) {
	t.Parallel()
	compiled := transportFixture(t)
	provider := &receiptMailer{}
	transport := RawMailerTransport{Mailer: provider}

	receipt, err := transport.Send(context.Background(), validRequest(compiled))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(provider.message.Raw, compiled.RFC822) {
		t.Fatal("transport modified compiled RFC822 bytes")
	}
	if provider.message.TenantID != transportTenantID ||
		len(provider.message.ToList) != 1 || provider.message.ToList[0] != "fixture@example.test" {
		t.Fatalf("provider envelope = %+v", provider.message)
	}
	if receipt.ProviderMessageID != "provider-message-1" ||
		receipt.OutboundMIMEHash != compiled.Artifact.OutboundMIMEHash ||
		receipt.IdempotencyMode != LedgerIdempotencyMode {
		t.Fatalf("receipt = %+v", receipt)
	}
	capabilities := transport.Capabilities()
	if !capabilities.RawMIME || !capabilities.ProviderReceipt || capabilities.ProviderIdempotency || capabilities.DedicatedMessenger {
		t.Fatalf("capabilities = %+v", capabilities)
	}
}

func TestRawMailerTransportExplicitlyRefusesUnsupportedParityRequirements(t *testing.T) {
	t.Parallel()
	compiled := transportFixture(t)
	provider := &receiptMailer{}
	transport := RawMailerTransport{Mailer: provider}

	request := validRequest(compiled)
	request.Messenger = "dedicated-ip-1"
	if _, err := transport.Send(context.Background(), request); !errors.Is(err, ErrDedicatedRoutingUnsupported) || FailureDispositionOf(err) != FailureDefinitelyNotSent {
		t.Fatalf("dedicated routing error = %v", err)
	}
	request = validRequest(compiled)
	request.RequireProviderIdempotency = true
	if _, err := transport.Send(context.Background(), request); !errors.Is(err, ErrProviderIdempotencyUnsupported) || FailureDispositionOf(err) != FailureDefinitelyNotSent {
		t.Fatalf("provider idempotency error = %v", err)
	}
	if len(provider.message.Raw) != 0 {
		t.Fatal("unsupported request reached the provider")
	}
}

func TestRawMailerTransportRejectsMIMEOrEnvelopeMismatchBeforeSend(t *testing.T) {
	t.Parallel()
	compiled := transportFixture(t)
	tests := []struct {
		name   string
		mutate func(*SendRequest)
		want   error
	}{
		{name: "tampered MIME", mutate: func(request *SendRequest) { request.Message.RFC822 = append(request.Message.RFC822, 'x') }, want: ErrMIMEIntegrity},
		{name: "wrong envelope sender", mutate: func(request *SendRequest) { request.Message.EnvelopeFrom = "other@example.test" }, want: ErrInvalidMessage},
		{name: "wrong ledger Message-ID", mutate: func(request *SendRequest) { request.Message.MessageID = "<other@example.test>" }, want: ErrInvalidMessage},
		{name: "wrong ledger Reply-To", mutate: func(request *SendRequest) { request.Message.ReplyTo = "reply+other@reply.example.test" }, want: ErrInvalidMessage},
		{name: "wrong recipient", mutate: func(request *SendRequest) { request.Recipient = "other@example.test" }, want: ErrInvalidMessage},
		{name: "recipient absent from envelope", mutate: func(request *SendRequest) { request.Message.To = []string{"other@example.test"} }, want: ErrInvalidMessage},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			provider := &receiptMailer{}
			request := validRequest(compiled)
			test.mutate(&request)
			if _, err := (RawMailerTransport{Mailer: provider}).Send(context.Background(), request); !errors.Is(err, test.want) || FailureDispositionOf(err) != FailureDefinitelyNotSent {
				t.Fatalf("Send() error = %v, want %v", err, test.want)
			}
			if len(provider.message.Raw) != 0 {
				t.Fatal("invalid message reached the provider")
			}
		})
	}
}

func TestRawMailerTransportClassifiesProviderFailuresForSafeRetry(t *testing.T) {
	t.Parallel()
	compiled := transportFixture(t)
	tests := []struct {
		name string
		err  error
		want FailureDisposition
	}{
		{name: "provider rejection", err: &mailer.PermanentError{Err: errors.New("rejected")}, want: FailureDefinitelyNotSent},
		{name: "timeout may have accepted", err: context.DeadlineExceeded, want: FailureIndeterminate},
		{name: "unknown provider failure", err: errors.New("connection reset"), want: FailureIndeterminate},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			provider := &receiptMailer{err: test.err}
			_, err := (RawMailerTransport{Mailer: provider}).Send(context.Background(), validRequest(compiled))
			if !errors.Is(err, test.err) || FailureDispositionOf(err) != test.want {
				t.Fatalf("error/disposition = %v/%q, want wrapped/%q", err, FailureDispositionOf(err), test.want)
			}
		})
	}
}

func TestFailureDispositionOfUntypedErrorFailsClosed(t *testing.T) {
	t.Parallel()
	if got := FailureDispositionOf(errors.New("untyped")); got != FailureIndeterminate {
		t.Fatalf("disposition = %q, want %q", got, FailureIndeterminate)
	}
	if got := FailureDispositionOf(nil); got != "" {
		t.Fatalf("nil disposition = %q", got)
	}
}

func TestRawMailerTransportWorksWithoutProviderReceiptCapability(t *testing.T) {
	t.Parallel()
	compiled := transportFixture(t)
	provider := &basicMailer{}
	transport := RawMailerTransport{Mailer: provider}
	receipt, err := transport.Send(context.Background(), validRequest(compiled))
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ProviderMessageID != "" || transport.Capabilities().ProviderReceipt {
		t.Fatalf("receipt/capabilities falsely claim provider evidence: %+v %+v", receipt, transport.Capabilities())
	}
}

func transportFixture(t *testing.T) campaigncompiler.Result {
	t.Helper()
	html := `<html><body><h1>Fixture</h1></body></html>`
	plain := "Fixture\n"
	compiled, err := campaigncompiler.Compile(campaigncompiler.Input{
		Revision: campaignartifact.Revision{
			ID: "00000000-0000-4000-8000-000000000010", CampaignID: transportCampaignID,
			SourceMode: campaignartifact.SourceModeLegacyHTML, ContentSchemaVersion: 1,
			Subject: "Fixture", LegacyHTML: &html, ReviewedPlainText: &plain,
			SemanticTree: json.RawMessage(`[]`), FactContract: json.RawMessage(`{}`),
			SourceHash: strings.Repeat("a", 64),
		},
		Scenario: campaigncompiler.Scenario{ID: "scenario-a", Locale: "en-US", FixtureID: "synthetic-a"},
		Envelope: campaigncompiler.Envelope{
			From:      mail.Address{Name: "Moosewave", Address: "news@example.test"},
			To:        []mail.Address{{Name: "Synthetic Fixture", Address: "fixture@example.test"}},
			ReplyTo:   []mail.Address{{Address: "reply+opaque@reply.example.test"}},
			Date:      time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
			MessageID: "<fixture@example.test>", Boundary: "postwave-transport-fixture",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return compiled
}

func validRequest(compiled campaigncompiler.Result) SendRequest {
	return SendRequest{
		TenantID: transportTenantID, Recipient: "fixture@example.test", IdempotencyKey: "campaign-recipient-1",
		Message: CompiledMessage{
			ArtifactID: transportArtifactID, ScenarioID: compiled.Artifact.ScenarioID,
			CampaignID: transportCampaignID, MessageID: "<fixture@example.test>",
			ReplyTo: "reply+opaque@reply.example.test", EnvelopeFrom: "Moosewave <news@example.test>",
			To: []string{"fixture@example.test"}, RFC822: compiled.RFC822,
			MIMEHash: compiled.Artifact.OutboundMIMEHash,
		},
	}
}
