// SPDX-License-Identifier: AGPL-3.0-only
package mailer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"github.com/aws/smithy-go"
)

// sesSendTimeout caps a single SendEmail round-trip. SES is regional;
// calls that take longer than this are almost certainly misrouted.
const sesSendTimeout = 10 * time.Second

// sesTenantTagName is reserved for server-owned tenant attribution. Public
// transactional API callers may supply arbitrary tags, but this key is always
// stripped and then populated exclusively from Message.TenantID.
const sesTenantTagName = "postwave_tenant_id"

// sesAPI is the slice of the SES v2 client surface we depend on.
// Defined as an interface for testability — production code wires the
// concrete *sesv2.Client.
type sesAPI interface {
	SendEmail(ctx context.Context, params *sesv2.SendEmailInput, optFns ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error)
}

// SESMailer sends transactional email via Amazon SES v2. The SDK picks
// up credentials via the standard chain (env, IAM role, EC2/ECS
// metadata) — never pass keys inline.
type SESMailer struct {
	client    sesAPI
	configSet string // optional SES configuration set name; "" disables
}

// NewSESMailer constructs an SES-backed Mailer. region is the AWS
// region the SES endpoint should target; configSet is the SES
// Configuration Set name (used to wire bounce/complaint events into
// our SNS topic). configSet may be empty to disable.
func NewSESMailer(ctx context.Context, region, configSet string) (*SESMailer, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{}
	if region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(region))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("ses mailer: load aws config: %w", err)
	}
	return &SESMailer{
		client:    sesv2.NewFromConfig(cfg),
		configSet: configSet,
	}, nil
}

// PermanentError wraps SES errors that the caller should NOT retry —
// invalid recipient, malformed message, account suspended, etc. The
// caller (auth flow) should drop the message and surface to the user.
type PermanentError struct {
	Err error
	// Reason says why the provider refused the message, so a caller can tell
	// the person what would have to change. Empty when unknown.
	Reason RefusalReason
}

// RefusalReason classifies a permanent refusal by what would have to change
// before the same message could be sent.
type RefusalReason string

const (
	// RefusalNotPermitted: this deployment may not send this message to this
	// recipient. The provider's permissions deny it (an IAM policy that only
	// allows approved recipients, an account still in the sandbox that only
	// delivers to verified addresses) or it rejected the message outright.
	RefusalNotPermitted RefusalReason = "not_permitted"
	// RefusalSenderUnverified: the sender's domain is not verified with the
	// provider.
	RefusalSenderUnverified RefusalReason = "sender_unverified"
	// RefusalSendingPaused: sending is paused or suspended for the provider
	// account.
	RefusalSendingPaused RefusalReason = "sending_paused"
	// RefusalInvalidRequest: the provider rejected the request itself (a
	// setting it names does not exist, or a field is invalid).
	RefusalInvalidRequest RefusalReason = "invalid_request"
)

// sesAccessDeniedCode is the error code SES returns when IAM denies the
// send. It is not a modeled sesv2 error type, so it arrives as a generic
// smithy API error.
const sesAccessDeniedCode = "AccessDeniedException"

func (e *PermanentError) Error() string { return "ses permanent: " + e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

// Send implements Mailer while preserving the historical error-only contract.
func (m *SESMailer) Send(ctx context.Context, msg Message) error {
	_, err := m.SendWithReceipt(ctx, msg)
	return err
}

// SendWithReceipt validates the message, sends it, and returns the SES
// MessageId needed for exact feedback attribution. Errors are classified into
// transient (returned as-is, retryable) vs permanent (PermanentError).
func (m *SESMailer) SendWithReceipt(ctx context.Context, msg Message) (DeliveryReceipt, error) {
	if err := msg.Validate(); err != nil {
		return DeliveryReceipt{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, sesSendTimeout)
	defer cancel()

	to := msg.ToList
	if len(to) == 0 {
		to = []string{msg.To}
	}

	// Raw MIME path (SMTP relay): send the bytes verbatim via Content.Raw.
	if len(msg.Raw) > 0 {
		rawInput := &sesv2.SendEmailInput{
			FromEmailAddress: aws.String(msg.From),
			Destination: &sestypes.Destination{
				ToAddresses:  to,
				CcAddresses:  msg.Cc,
				BccAddresses: msg.Bcc,
			},
			Content: &sestypes.EmailContent{
				Raw: &sestypes.RawMessage{Data: msg.Raw},
			},
		}
		if m.configSet != "" {
			rawInput.ConfigurationSetName = aws.String(m.configSet)
		}
		if tags := buildSESTags(sesTagsForMessage(msg)); len(tags) > 0 {
			rawInput.EmailTags = tags
		}
		output, err := m.client.SendEmail(ctx, rawInput)
		if err != nil {
			if class, reason := classifySESError(err); class == sesErrPermanent {
				return DeliveryReceipt{}, &PermanentError{Err: err, Reason: reason}
			}
			return DeliveryReceipt{}, fmt.Errorf("ses send raw: %w", err)
		}
		return DeliveryReceipt{ProviderMessageID: aws.ToString(output.MessageId)}, nil
	}

	body := &sestypes.Body{}
	if msg.Body != "" {
		body.Text = &sestypes.Content{
			Data:    aws.String(msg.Body),
			Charset: aws.String("UTF-8"),
		}
	}
	if msg.HTMLBody != "" {
		body.Html = &sestypes.Content{
			Data:    aws.String(msg.HTMLBody),
			Charset: aws.String("UTF-8"),
		}
	}

	input := &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(msg.From),
		Destination: &sestypes.Destination{
			ToAddresses:  to,
			CcAddresses:  msg.Cc,
			BccAddresses: msg.Bcc,
		},
		Content: &sestypes.EmailContent{
			Simple: &sestypes.Message{
				Subject: &sestypes.Content{
					Data:    aws.String(msg.Subject),
					Charset: aws.String("UTF-8"),
				},
				Body:        body,
				Attachments: buildSESAttachments(msg.Attachments),
				Headers:     buildSESHeaders(msg.Headers),
			},
		},
	}

	if msg.ReplyTo != "" {
		input.ReplyToAddresses = []string{msg.ReplyTo}
	}
	if m.configSet != "" {
		input.ConfigurationSetName = aws.String(m.configSet)
	}
	if tags := buildSESTags(sesTagsForMessage(msg)); len(tags) > 0 {
		input.EmailTags = tags
	}

	output, err := m.client.SendEmail(ctx, input)
	if err != nil {
		if class, reason := classifySESError(err); class == sesErrPermanent {
			return DeliveryReceipt{}, &PermanentError{Err: err, Reason: reason}
		}
		return DeliveryReceipt{}, fmt.Errorf("ses send: %w", err)
	}
	return DeliveryReceipt{ProviderMessageID: aws.ToString(output.MessageId)}, nil
}

func sesTagsForMessage(msg Message) map[string]string {
	tags := make(map[string]string, len(msg.Tags)+1)
	for key, value := range msg.Tags {
		// Compare the eventual wire key, not only the raw caller key: a value
		// such as "postwave_tenant_id!" sanitizes to the reserved name.
		if strings.EqualFold(sanitizeTagKey(strings.TrimSpace(key)), sesTenantTagName) {
			continue
		}
		tags[key] = value
	}
	if tenantID := strings.TrimSpace(msg.TenantID); tenantID != "" {
		tags[sesTenantTagName] = tenantID
	}
	if len(tags) == 0 {
		return nil
	}
	return tags
}

// buildSESTags converts the caller's tag map into the SES wire form,
// dropping any entry whose key/value can't be sanitized to fit the SES
// regex. Per AWS docs:
//
//   - keys:   [A-Za-z0-9_-]{1,256}
//   - values: [A-Za-z0-9_.-]{1,256}
//
// We sanitize by stripping disallowed runes; if the result is empty
// we drop the tag rather than failing the send.
func buildSESTags(tags map[string]string) []sestypes.MessageTag {
	if len(tags) == 0 {
		return nil
	}
	out := make([]sestypes.MessageTag, 0, len(tags))
	for k, v := range tags {
		sk := sanitizeTagKey(k)
		sv := sanitizeTagValue(v)
		if sk == "" || sv == "" {
			continue
		}
		out = append(out, sestypes.MessageTag{
			Name:  aws.String(sk),
			Value: aws.String(sv),
		})
	}
	return out
}

// sanitizeTagKey filters runes to [A-Za-z0-9_-] and truncates to 256.
func sanitizeTagKey(s string) string {
	var b strings.Builder
	for _, r := range s {
		if isTagKeyRune(r) {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > 256 {
		out = out[:256]
	}
	return out
}

// sanitizeTagValue filters runes to [A-Za-z0-9_.-] and truncates to 256.
func sanitizeTagValue(s string) string {
	var b strings.Builder
	for _, r := range s {
		if isTagValueRune(r) {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > 256 {
		out = out[:256]
	}
	return out
}

func isTagKeyRune(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z':
		return true
	case r >= 'a' && r <= 'z':
		return true
	case r >= '0' && r <= '9':
		return true
	case r == '_' || r == '-':
		return true
	}
	return false
}

func isTagValueRune(r rune) bool {
	if isTagKeyRune(r) {
		return true
	}
	return r == '.'
}

type sesErrClass int

const (
	sesErrTransient sesErrClass = iota
	sesErrPermanent
)

// classifySESError sorts SES errors into retryable vs drop-the-message and,
// for a permanent one, says why. Throttling, internal SES errors, and network
// failures are transient. Validation errors (bad recipient, malformed
// content, suppressed destination) and an IAM denial are permanent: the same
// request fails the same way until someone changes the setup.
func classifySESError(err error) (sesErrClass, RefusalReason) {
	if err == nil {
		return sesErrTransient, ""
	}
	// Permanent: typed SES API errors that mean the message will never succeed.
	var notFound *sestypes.NotFoundException
	if errors.As(err, &notFound) {
		return sesErrPermanent, RefusalInvalidRequest
	}
	var badReq *sestypes.BadRequestException
	if errors.As(err, &badReq) {
		return sesErrPermanent, RefusalInvalidRequest
	}
	var msgRejected *sestypes.MessageRejected
	if errors.As(err, &msgRejected) {
		// Among others, what an account still in the SES sandbox answers for
		// a recipient that is not a verified identity.
		return sesErrPermanent, RefusalNotPermitted
	}
	var mailFromDomNotVerified *sestypes.MailFromDomainNotVerifiedException
	if errors.As(err, &mailFromDomNotVerified) {
		return sesErrPermanent, RefusalSenderUnverified
	}
	var accountSuspended *sestypes.AccountSuspendedException
	if errors.As(err, &accountSuspended) {
		return sesErrPermanent, RefusalSendingPaused
	}
	var sendingPaused *sestypes.SendingPausedException
	if errors.As(err, &sendingPaused) {
		return sesErrPermanent, RefusalSendingPaused
	}
	// An IAM policy denied ses:SendEmail — for example one that only allows
	// approved recipients or identities. Retrying cannot change the answer;
	// changing the policy can.
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) && apiErr.ErrorCode() == sesAccessDeniedCode {
		return sesErrPermanent, RefusalNotPermitted
	}
	// Transient: throttling, internal errors, anything we don't recognize.
	// Caller can retry with backoff.
	var tooMany *sestypes.TooManyRequestsException
	if errors.As(err, &tooMany) {
		return sesErrTransient, ""
	}
	// Default to transient — better to retry a recoverable error than drop
	// a real user's verify-email.
	return sesErrTransient, ""
}

// reservedHeaderNames are headers SES sets itself; supplying them via the
// custom Headers map makes SES reject the whole send, so we drop them.
var reservedHeaderNames = map[string]struct{}{
	"from": {}, "to": {}, "cc": {}, "bcc": {}, "subject": {}, "reply-to": {},
	"date": {}, "message-id": {}, "content-type": {}, "content-transfer-encoding": {},
	"mime-version": {}, "return-path": {}, "sender": {},
}

// buildSESAttachments converts the mailer attachments into the SES wire form.
// RawContent is the decoded bytes; the SDK base64-encodes on the wire.
func buildSESAttachments(in []Attachment) []sestypes.Attachment {
	if len(in) == 0 {
		return nil
	}
	out := make([]sestypes.Attachment, 0, len(in))
	for _, a := range in {
		if len(a.Content) == 0 || strings.TrimSpace(a.Filename) == "" {
			continue
		}
		att := sestypes.Attachment{
			FileName:           aws.String(a.Filename),
			RawContent:         a.Content,
			ContentDisposition: sestypes.AttachmentContentDispositionAttachment,
		}
		if ct := strings.TrimSpace(a.ContentType); ct != "" {
			att.ContentType = aws.String(ct)
		}
		if a.Inline {
			att.ContentDisposition = sestypes.AttachmentContentDispositionInline
			if a.ContentID != "" {
				att.ContentId = aws.String(a.ContentID)
			}
		}
		out = append(out, att)
	}
	return out
}

// buildSESHeaders converts the custom-header map into SES MessageHeaders,
// dropping reserved headers SES manages itself.
func buildSESHeaders(in map[string]string) []sestypes.MessageHeader {
	if len(in) == 0 {
		return nil
	}
	out := make([]sestypes.MessageHeader, 0, len(in))
	for k, v := range in {
		name := strings.TrimSpace(k)
		if name == "" {
			continue
		}
		if _, reserved := reservedHeaderNames[strings.ToLower(name)]; reserved {
			continue
		}
		out = append(out, sestypes.MessageHeader{Name: aws.String(name), Value: aws.String(v)})
	}
	return out
}
