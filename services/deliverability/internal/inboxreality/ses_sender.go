// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"github.com/aws/smithy-go"
)

const seedSendTimeout = 15 * time.Second

type sesAPI interface {
	SendEmail(context.Context, *sesv2.SendEmailInput, ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error)
}

// SESRawSeedSender is a concrete raw-MIME transport. The recipient is supplied
// only as the SES envelope destination; the source MIME is changed solely by
// Dispatcher's deterministic correlation-header insertion.
type SESRawSeedSender struct {
	client    sesAPI
	configSet string
}

func NewSESRawSeedSender(config aws.Config, configSet string) *SESRawSeedSender {
	return &SESRawSeedSender{client: sesv2.NewFromConfig(config), configSet: strings.TrimSpace(configSet)}
}

func (s *SESRawSeedSender) SendRaw(ctx context.Context, request SendRequest) (SendReceipt, error) {
	if s == nil || s.client == nil || strings.TrimSpace(request.EnvelopeTo) == "" ||
		len(request.RawMIME) == 0 || len(request.RawMIME) > maxRawMIMEBytes || digest(request.RawMIME) != request.MIMEHash {
		return SendReceipt{}, &SendError{Disposition: FailurePermanentDefinitelyNotSent,
			Code: "INVALID_SEED_MESSAGE", Err: ErrInvalidRequest}
	}
	message, err := mail.ReadMessage(bytes.NewReader(request.RawMIME))
	if err != nil {
		return SendReceipt{}, &SendError{Disposition: FailurePermanentDefinitelyNotSent,
			Code: "INVALID_SEED_MESSAGE", Err: err}
	}
	from, err := mail.ParseAddress(message.Header.Get("From"))
	if err != nil || strings.TrimSpace(from.Address) == "" {
		return SendReceipt{}, &SendError{Disposition: FailurePermanentDefinitelyNotSent,
			Code: "INVALID_SEED_FROM", Err: errors.New("valid From header required")}
	}
	input := &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(from.Address),
		Destination:      &sestypes.Destination{ToAddresses: []string{request.EnvelopeTo}},
		Content:          &sestypes.EmailContent{Raw: &sestypes.RawMessage{Data: request.RawMIME}},
	}
	if s.configSet != "" {
		input.ConfigurationSetName = aws.String(s.configSet)
	}
	callCtx, cancel := context.WithTimeout(ctx, seedSendTimeout)
	defer cancel()
	output, err := s.client.SendEmail(callCtx, input)
	if err != nil {
		disposition, code := classifySESSendError(err)
		return SendReceipt{}, &SendError{Disposition: disposition, Code: code,
			Err: fmt.Errorf("send controlled seed through SES: %w", err)}
	}
	return SendReceipt{ProviderMessageID: strings.TrimSpace(aws.ToString(output.MessageId))}, nil
}

func classifySESSendError(err error) (FailureDisposition, string) {
	if err == nil {
		return FailureIndeterminate, "PROVIDER_RESULT_INDETERMINATE"
	}
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		// A transport timeout/reset can occur after SES accepted the request.
		return FailureIndeterminate, "SES_RESULT_INDETERMINATE"
	}
	switch apiError.ErrorCode() {
	case "TooManyRequestsException", "LimitExceededException":
		return FailureRetryableDefinitelyNotSent, "SES_THROTTLED"
	case "BadRequestException", "MessageRejected", "MailFromDomainNotVerifiedException",
		"NotFoundException", "AccountSuspendedException", "SendingPausedException":
		return FailurePermanentDefinitelyNotSent, "SES_MESSAGE_REJECTED"
	default:
		// Unknown and service-side errors are not safe to replay: the API may
		// have accepted the message before returning or losing its response.
		return FailureIndeterminate, "SES_RESULT_INDETERMINATE"
	}
}
