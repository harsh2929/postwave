// SPDX-License-Identifier: AGPL-3.0-only

// Package campaigntransport defines the no-re-render raw-MIME boundary used by
// certified campaign delivery. Legacy Listmonk HTML dispatch intentionally does
// not implement this interface.
package campaigntransport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net/mail"
	"strings"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

const ContractVersion = "postwave.campaign-transport.v2"

// LedgerIdempotencyMode is intentionally explicit about the safety boundary:
// the Moosewave ledger collapses duplicate calls before dispatch, but SES does
// not accept an idempotency token. A transport error after the provider call
// can therefore be indeterminate and must not be retried automatically.
const LedgerIdempotencyMode = "postwave_ledger_no_ambiguous_retry"

var (
	ErrInvalidMessage                 = errors.New("campaign transport: invalid compiled message")
	ErrMIMEIntegrity                  = errors.New("campaign transport: outbound MIME integrity mismatch")
	ErrDedicatedRoutingUnsupported    = errors.New("campaign transport: dedicated routing is unsupported")
	ErrProviderIdempotencyUnsupported = errors.New("campaign transport: provider idempotency is unsupported")
	ErrProviderReceiptMissing         = errors.New("campaign transport: provider accepted without a correlation receipt")
)

// FailureDisposition tells the delivery coordinator whether an error is
// known to have happened before provider acceptance or whether acceptance is
// unknowable. Only definitely_not_sent failures are eligible for a new
// attempt; indeterminate failures require provider-event reconciliation or a
// governed operator decision.
type FailureDisposition string

const (
	FailureDefinitelyNotSent FailureDisposition = "definitely_not_sent"
	FailureIndeterminate     FailureDisposition = "indeterminate"
)

// SendError preserves errors.Is/errors.As through Unwrap while carrying the
// retry-safety fact that a plain error string cannot express.
type SendError struct {
	Disposition FailureDisposition
	Err         error
}

func (e *SendError) Error() string {
	if e == nil || e.Err == nil {
		return "campaign transport: delivery error"
	}
	return e.Err.Error()
}

func (e *SendError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// FailureDispositionOf fails closed: an untyped error may have crossed the
// provider boundary, so it is considered indeterminate.
func FailureDispositionOf(err error) FailureDisposition {
	if err == nil {
		return ""
	}
	var deliveryError *SendError
	if errors.As(err, &deliveryError) && deliveryError.Disposition != "" {
		return deliveryError.Disposition
	}
	return FailureIndeterminate
}

func definitelyNotSent(err error) error {
	if err == nil {
		return nil
	}
	return &SendError{Disposition: FailureDefinitelyNotSent, Err: err}
}

func providerFailure(err error) error {
	if err == nil {
		return nil
	}
	var permanent *mailer.PermanentError
	if errors.As(err, &permanent) {
		return definitelyNotSent(err)
	}
	return &SendError{Disposition: FailureIndeterminate, Err: err}
}

type Capabilities struct {
	ContractVersion       string `json:"contract_version"`
	RawMIME               bool   `json:"raw_mime"`
	ProviderReceipt       bool   `json:"provider_receipt"`
	ProviderIdempotency   bool   `json:"provider_idempotency"`
	DedicatedMessenger    bool   `json:"dedicated_messenger"`
	TransportHeadersAdded bool   `json:"transport_headers_added"`
}

// CompiledMessage is already fully rendered. A Transport must not rewrite its
// body, headers, links, or MIME structure. Envelope fields are separate because
// Bcc and SMTP routing are not necessarily represented in RFC822 headers.
type CompiledMessage struct {
	ArtifactID   string
	ScenarioID   string
	CampaignID   string
	MessageID    string
	ReplyTo      string
	EnvelopeFrom string
	To           []string
	Cc           []string
	Bcc          []string
	RFC822       []byte
	MIMEHash     string
}

type SendRequest struct {
	TenantID                   string
	Recipient                  string
	IdempotencyKey             string
	Messenger                  string
	RequireProviderIdempotency bool
	Message                    CompiledMessage
}

type Receipt struct {
	ContractVersion   string `json:"contract_version"`
	ArtifactID        string `json:"artifact_id"`
	ScenarioID        string `json:"scenario_id"`
	CampaignID        string `json:"campaign_id"`
	OutboundMIMEHash  string `json:"outbound_mime_hash"`
	ProviderMessageID string `json:"provider_message_id,omitempty"`
	IdempotencyKey    string `json:"idempotency_key"`
	IdempotencyMode   string `json:"idempotency_mode"`
}

type Transport interface {
	Capabilities() Capabilities
	Send(ctx context.Context, request SendRequest) (Receipt, error)
}

// RawMailerTransport adapts a mailer.Mailer whose raw path preserves RFC822
// bytes (currently SES v2). SES does not expose a request idempotency token or
// Listmonk messenger routing, and the capability receipt says so explicitly.
type RawMailerTransport struct {
	Mailer mailer.Mailer
	// BounceReturnPathDomain permits the SMTP envelope sender to differ from the
	// RFC822 From, but ONLY within this one domain (PRD F05).
	//
	// Empty — the default — keeps the strict equality this transport has always
	// enforced. That default is the safe one: an unconstrained envelope sender is
	// how a message ends up with a MAIL FROM nobody authorised.
	//
	// WHY THE RELAXATION IS WANTED. A VERP return path is what makes a BOUNCE and
	// an RFC 3834 auto-reply attributable to the recipient they concern. Those
	// arrive at the envelope sender, not at Reply-To, so a Reply-To-only VERP
	// leaves exactly the machine-generated traffic unattributed — and under AI
	// mediation that is a growing share of what comes back.
	//
	// WHY IT IS BOUNDED TO ONE DOMAIN. SPF authenticates the MAIL FROM domain, so
	// moving the envelope sender moves which record must authorise the send. DMARC
	// then aligns via DKIM, which signs the From domain and is unaffected. That is
	// standard bounce-domain practice, but it only holds when the envelope domain
	// is one the operator has actually published SPF for — hence a named domain
	// rather than a boolean.
	BounceReturnPathDomain string
}

func (t RawMailerTransport) Capabilities() Capabilities {
	_, receipts := t.Mailer.(mailer.ReceiptMailer)
	return Capabilities{
		ContractVersion:       ContractVersion,
		RawMIME:               true,
		ProviderReceipt:       receipts,
		ProviderIdempotency:   false,
		DedicatedMessenger:    false,
		TransportHeadersAdded: true,
	}
}

func (t RawMailerTransport) Send(ctx context.Context, request SendRequest) (Receipt, error) {
	if t.Mailer == nil {
		return Receipt{}, definitelyNotSent(fmt.Errorf("%w: mailer is required", ErrInvalidMessage))
	}
	if strings.TrimSpace(request.Messenger) != "" {
		return Receipt{}, definitelyNotSent(ErrDedicatedRoutingUnsupported)
	}
	if request.RequireProviderIdempotency {
		return Receipt{}, definitelyNotSent(ErrProviderIdempotencyUnsupported)
	}
	if _, err := uuid.Parse(strings.TrimSpace(request.TenantID)); err != nil {
		return Receipt{}, definitelyNotSent(fmt.Errorf("%w: invalid tenant_id", ErrInvalidMessage))
	}
	request.Recipient = strings.TrimSpace(request.Recipient)
	request.IdempotencyKey = strings.TrimSpace(request.IdempotencyKey)
	if request.Recipient == "" || request.IdempotencyKey == "" {
		return Receipt{}, definitelyNotSent(fmt.Errorf("%w: recipient and idempotency key are required", ErrInvalidMessage))
	}
	if err := validateCompiled(request.Message, request.Recipient, t.BounceReturnPathDomain); err != nil {
		return Receipt{}, definitelyNotSent(err)
	}

	message := mailer.Message{
		TenantID: request.TenantID,
		From:     request.Message.EnvelopeFrom,
		ToList:   append([]string(nil), request.Message.To...),
		Cc:       append([]string(nil), request.Message.Cc...),
		Bcc:      append([]string(nil), request.Message.Bcc...),
		Raw:      append([]byte(nil), request.Message.RFC822...),
		Tags: map[string]string{
			"postwave_campaign_id": request.Message.CampaignID,
			"postwave_artifact_id": request.Message.ArtifactID,
		},
	}
	receipt := Receipt{
		ContractVersion: ContractVersion, ArtifactID: request.Message.ArtifactID,
		ScenarioID: request.Message.ScenarioID, CampaignID: request.Message.CampaignID,
		OutboundMIMEHash: request.Message.MIMEHash, IdempotencyKey: request.IdempotencyKey,
		IdempotencyMode: LedgerIdempotencyMode,
	}
	if sender, ok := t.Mailer.(mailer.ReceiptMailer); ok {
		provider, err := sender.SendWithReceipt(ctx, message)
		if err != nil {
			return Receipt{}, providerFailure(err)
		}
		receipt.ProviderMessageID = strings.TrimSpace(provider.ProviderMessageID)
		if receipt.ProviderMessageID == "" {
			// The provider call succeeded, so acceptance is possible. Do not
			// downgrade this to a definitely-not-sent validation error.
			return Receipt{}, &SendError{Disposition: FailureIndeterminate, Err: ErrProviderReceiptMissing}
		}
		return receipt, nil
	}
	if err := t.Mailer.Send(ctx, message); err != nil {
		return Receipt{}, providerFailure(err)
	}
	return receipt, nil
}

func validateCompiled(message CompiledMessage, recipient, bounceReturnPathDomain string) error {
	for _, field := range []struct{ name, value string }{
		{name: "artifact_id", value: message.ArtifactID},
		{name: "scenario_id", value: message.ScenarioID},
		{name: "campaign_id", value: message.CampaignID},
		{name: "message_id", value: message.MessageID},
		{name: "reply_to", value: message.ReplyTo},
		{name: "envelope_from", value: message.EnvelopeFrom},
	} {
		if strings.TrimSpace(field.value) == "" {
			return fmt.Errorf("%w: %s is required", ErrInvalidMessage, field.name)
		}
	}
	if _, err := uuid.Parse(strings.TrimSpace(message.ArtifactID)); err != nil {
		return fmt.Errorf("%w: invalid artifact_id", ErrInvalidMessage)
	}
	if _, err := uuid.Parse(strings.TrimSpace(message.CampaignID)); err != nil {
		return fmt.Errorf("%w: invalid campaign_id", ErrInvalidMessage)
	}
	if len(message.RFC822) == 0 || digest(message.RFC822) != message.MIMEHash {
		return ErrMIMEIntegrity
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(message.RFC822))
	if err != nil {
		return fmt.Errorf("%w: parse RFC822: %v", ErrInvalidMessage, err)
	}
	from, err := mail.ParseAddress(parsed.Header.Get("From"))
	if err != nil {
		return fmt.Errorf("%w: RFC822 From: %v", ErrInvalidMessage, err)
	}
	envelopeFrom, err := mail.ParseAddress(message.EnvelopeFrom)
	if err != nil {
		return fmt.Errorf("%w: envelope and RFC822 From do not match", ErrInvalidMessage)
	}
	if !strings.EqualFold(from.Address, envelopeFrom.Address) &&
		!envelopeInBounceDomain(envelopeFrom.Address, bounceReturnPathDomain) {
		// Still a single parseable mailbox, still refused unless it is inside the
		// one domain the operator named. The check is on the DOMAIN rather than on
		// the full address because the local part is the VERP token and is
		// different for every recipient — that is the entire point of it.
		return fmt.Errorf("%w: envelope and RFC822 From do not match", ErrInvalidMessage)
	}
	messageIDs := exactHeaderValues(parsed.Header, "Message-ID")
	if len(messageIDs) != 1 || strings.TrimSpace(messageIDs[0]) != strings.TrimSpace(message.MessageID) {
		return fmt.Errorf("%w: RFC822 Message-ID differs from immutable ledger identity", ErrInvalidMessage)
	}
	replyHeaders := exactHeaderValues(parsed.Header, "Reply-To")
	if len(replyHeaders) != 1 {
		return fmt.Errorf("%w: RFC822 must contain one Reply-To", ErrInvalidMessage)
	}
	replyAddresses, err := mail.ParseAddressList(replyHeaders[0])
	if err != nil || len(replyAddresses) != 1 ||
		!strings.EqualFold(strings.TrimSpace(replyAddresses[0].Address), strings.TrimSpace(message.ReplyTo)) {
		return fmt.Errorf("%w: RFC822 Reply-To differs from immutable ledger identity", ErrInvalidMessage)
	}
	mediaType, _, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "multipart/alternative") {
		return fmt.Errorf("%w: RFC822 must be multipart/alternative", ErrInvalidMessage)
	}
	addresses, err := mail.ParseAddressList(parsed.Header.Get("To"))
	if err != nil || !containsAddress(addresses, recipient) {
		return fmt.Errorf("%w: recipient is absent from RFC822 To", ErrInvalidMessage)
	}
	if !containsStringAddress(message.To, recipient) {
		return fmt.Errorf("%w: recipient is absent from transport envelope To", ErrInvalidMessage)
	}
	return nil
}

func exactHeaderValues(header mail.Header, wanted string) []string {
	values := make([]string, 0, 1)
	for name, candidates := range header {
		if strings.EqualFold(strings.TrimSpace(name), wanted) {
			values = append(values, candidates...)
		}
	}
	return values
}

func containsAddress(addresses []*mail.Address, target string) bool {
	for _, address := range addresses {
		if address != nil && strings.EqualFold(strings.TrimSpace(address.Address), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}

func containsStringAddress(addresses []string, target string) bool {
	for _, raw := range addresses {
		address, err := mail.ParseAddress(raw)
		if err == nil && strings.EqualFold(strings.TrimSpace(address.Address), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// envelopeInBounceDomain reports whether an envelope sender is inside the one
// domain configured to carry a VERP return path.
//
// Returns false for an empty configured domain, which is what keeps the default
// strict: an operator who has not named a bounce domain gets the equality rule
// this transport has always had.
func envelopeInBounceDomain(envelopeAddress, bounceDomain string) bool {
	bounceDomain = strings.ToLower(strings.TrimSpace(bounceDomain))
	if bounceDomain == "" {
		return false
	}
	at := strings.LastIndex(envelopeAddress, "@")
	if at < 0 || at == len(envelopeAddress)-1 {
		return false
	}
	// Exact domain match, never a suffix test. A suffix would accept
	// "evil-moosewave.com" for a configured "moosewave.com".
	return strings.EqualFold(envelopeAddress[at+1:], bounceDomain)
}
