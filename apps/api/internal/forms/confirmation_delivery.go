// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// OutboxKindSendConfirmation is the durable double opt-in email. It is
// appended in the same transaction that makes a submission pending: a double
// opt-in signup (InsertSubmissionWithSignup), or a single opt-in from an
// address that opted out earlier (SignupAudience.RecordSubmitted). Its
// handler, Deps.DeliverConfirmation, sends the email and records the outcome
// on the submission; a failed send is retried by the outbox and dead-lettered
// after its last attempt, so no confirmation is ever discarded.
const OutboxKindSendConfirmation = "forms.confirmation.send"

// ConfirmationEmailState is the last outcome of a submission's confirmation
// email (form_submissions.confirmation_email_state, migration 2050).
type ConfirmationEmailState string

const (
	ConfirmationEmailQueued              ConfirmationEmailState = "queued"
	ConfirmationEmailSent                ConfirmationEmailState = "sent"
	ConfirmationEmailSendFailed          ConfirmationEmailState = "send_failed"
	ConfirmationEmailNoSender            ConfirmationEmailState = "no_sender"
	ConfirmationEmailQuotaExceeded       ConfirmationEmailState = "quota_exceeded"
	ConfirmationEmailRecipientSuppressed ConfirmationEmailState = "recipient_suppressed"
)

// defaultStandardSenderHourlyLimit is how many confirmation emails one
// workspace may send through the standard sender in an hour. A workspace that
// needs more sends from its own verified domain.
const defaultStandardSenderHourlyLimit = 200

var (
	// ErrConfirmationNoSender: the form names no sender on a verified domain
	// and no standard sender is configured.
	ErrConfirmationNoSender = errors.New("forms: no sender may send this workspace's confirmation emails")
	// ErrConfirmationRecipientSuppressed: the address bounced, complained, or
	// was erased, so it is never mailed.
	ErrConfirmationRecipientSuppressed = errors.New("forms: the address may not be sent a confirmation email")
	// ErrConfirmationQuotaExceeded: the workspace reached the standard
	// sender's hourly limit.
	ErrConfirmationQuotaExceeded = errors.New("forms: the workspace reached the standard sender's hourly confirmation limit")
)

// SenderDomainVerifier reports whether a workspace has a verified sending
// identity for a domain. transactional.SendingIdentityVerifier implements it.
type SenderDomainVerifier interface {
	IsFromDomainVerified(ctx context.Context, tenantID, domain string) (bool, error)
}

// ConfirmationRecipientGuard reports whether an address may be sent a
// confirmation email. It refuses an address that hard-bounced, complained,
// or was erased under a privacy request; an earlier unsubscribe does not
// block it, because confirming is how that person re-subscribes.
type ConfirmationRecipientGuard interface {
	MayMailConfirmation(ctx context.Context, tenantID, email string) (bool, error)
}

type confirmationSendPayload struct {
	TenantID     string `json:"tenant_id"`
	FormID       string `json:"form_id"`
	SubmissionID string `json:"submission_id"`
}

// DeliveryAttempt is which outbox attempt a confirmation send is: Number
// counts from 1 and includes this one, Max is the last one the outbox makes
// before dead-lettering the event. Zero values mean unknown.
type DeliveryAttempt struct {
	Number int
	Max    int
}

// last reports that no retry follows a failure of this attempt.
func (a DeliveryAttempt) last() bool {
	return a.Max > 0 && a.Number >= a.Max
}

// DeliverConfirmation handles OutboxKindSendConfirmation. A submission that
// is gone, no longer pending, or already mailed needs nothing. A refusal the
// operator must resolve (no sender, a suppressed address) is recorded and not
// retried; a failed or throttled send is recorded and retried. Every failed
// send is logged at WARN, and the last attempt's at ERROR, because the
// submission then stays pending with no email on its way.
func (d *Deps) DeliverConfirmation(ctx context.Context, tenantID string, rawPayload []byte, attempt DeliveryAttempt) error {
	var p confirmationSendPayload
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return fmt.Errorf("decode confirmation send payload: %w", err)
	}
	target, err := d.Repo.confirmationTarget(ctx, tenantID, p.SubmissionID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !target.awaitsConfirmation(time.Now()) || target.EmailState == ConfirmationEmailSent {
		return nil
	}
	state, sendErr := d.deliverConfirmation(ctx, target)
	if err := d.Repo.recordConfirmationEmail(ctx, tenantID, target.SubmissionID, state); err != nil {
		return err
	}
	switch {
	case sendErr == nil:
		return nil
	case state == ConfirmationEmailNoSender || state == ConfirmationEmailRecipientSuppressed:
		d.log().WarnContext(ctx, "forms: a confirmation email was not sent; the submission stays pending",
			"tenant_id", tenantID, "form_id", target.Form.ID, "submission_id", target.SubmissionID, "state", string(state))
		return nil
	default:
		d.logFailedConfirmationSend(ctx, target, state, attempt, sendErr)
		return sendErr
	}
}

// logFailedConfirmationSend records a send the outbox will retry, or that was
// its last attempt. The outbox's own bookkeeping line is INFO, which hides a
// visitor who never gets their confirmation email.
func (d *Deps) logFailedConfirmationSend(ctx context.Context, target *confirmationTarget, state ConfirmationEmailState, attempt DeliveryAttempt, sendErr error) {
	attrs := []any{
		"tenant_id", target.TenantID, "form_id", target.Form.ID, "submission_id", target.SubmissionID,
		"state", string(state), "attempt", attempt.Number, "max_attempts", attempt.Max, "err", sendErr,
	}
	var refused *mailer.PermanentError
	if errors.As(sendErr, &refused) {
		attrs = append(attrs, "refusal", string(refused.Reason))
	}
	if attempt.last() {
		d.log().ErrorContext(ctx, "forms: a confirmation email could not be sent and will not be retried; the submission stays pending until it is resent", attrs...)
		return
	}
	d.log().WarnContext(ctx, "forms: a confirmation email could not be sent; it will be retried", attrs...)
}

// sendFailureAnswer is the operator-facing answer to a resend the email
// provider did not accept. A refusal that resending cannot change is a 4xx
// naming what must change first; only a failure a later attempt may get past
// is a 5xx that says to try again.
func sendFailureAnswer(err error) (status int, code, message string) {
	var refused *mailer.PermanentError
	if !errors.As(err, &refused) {
		return http.StatusBadGateway, "confirmation_email_failed",
			"The email provider didn't accept the confirmation email just now. Try again in a few minutes."
	}
	switch refused.Reason {
	case mailer.RefusalNotPermitted:
		return http.StatusUnprocessableEntity, "confirmation_recipient_not_allowed",
			"The email provider refused this confirmation email: this environment isn't allowed to send to this address (it may only send to approved addresses). Resending won't help until the address is approved or sending is enabled for this environment."
	case mailer.RefusalSenderUnverified:
		return http.StatusUnprocessableEntity, "confirmation_sender_unverified",
			"The email provider refused this confirmation email because the sender's domain isn't verified with it. Verify the sending domain, then resend."
	case mailer.RefusalSendingPaused:
		return http.StatusUnprocessableEntity, "confirmation_sending_paused",
			"The email provider has paused sending for this environment, so the confirmation email can't be sent. Resending won't help until sending is resumed."
	default:
		return http.StatusUnprocessableEntity, "confirmation_email_rejected",
			"The email provider rejected the request to send this confirmation email, and resending won't change that. Check this environment's email sending setup, then resend."
	}
}

// resendFailureLevel logs a refusal the operator is told how to resolve as a
// warning, and a failure nobody can act on but by retrying as an error.
func resendFailureLevel(status int) slog.Level {
	if status < http.StatusInternalServerError {
		return slog.LevelWarn
	}
	return slog.LevelError
}

// deliverConfirmation sends one confirmation email and reports the state to
// record. It is shared by the outbox handler and the operator's resend.
func (d *Deps) deliverConfirmation(ctx context.Context, target *confirmationTarget) (ConfirmationEmailState, error) {
	if d.ConfirmationMailer == nil {
		return ConfirmationEmailSendFailed, ErrConfirmationMailerUnavailable
	}
	if d.RecipientGuard == nil {
		return ConfirmationEmailSendFailed, errors.New("forms: no recipient guard is configured for confirmation emails")
	}
	allowed, err := d.RecipientGuard.MayMailConfirmation(ctx, target.TenantID, target.Email)
	if err != nil {
		return ConfirmationEmailSendFailed, fmt.Errorf("forms: check the confirmation recipient: %w", err)
	}
	if !allowed {
		return ConfirmationEmailRecipientSuppressed, ErrConfirmationRecipientSuppressed
	}
	confirmURL, err := confirmationURL(d.PublicHostBase, target.Form.Slug, target.Token)
	if err != nil {
		return ConfirmationEmailSendFailed, err
	}
	msg, state, err := d.confirmationEnvelope(ctx, target, confirmURL)
	if err != nil {
		return state, err
	}
	msg.TenantID = target.TenantID
	msg.To = target.Email
	if err := d.ConfirmationMailer.Send(ctx, msg); err != nil {
		return ConfirmationEmailSendFailed, newConfirmationSendError(err, target.Email)
	}
	return ConfirmationEmailSent, nil
}

// confirmationEnvelope picks who the email is from and what it says.
//
// A form whose sender (settings.confirmationFromEmail) is on a domain the
// workspace verified sends the operator's own subject and body from that
// address, as the transactional API allows. Otherwise the email goes from the
// standard sender with a fixed text that names the workspace and the form:
// the operator cannot put their own words, or a link of their choosing, into
// mail sent from an address the workspace does not own, and the standard
// sender is capped per workspace per hour.
func (d *Deps) confirmationEnvelope(ctx context.Context, target *confirmationTarget, confirmURL string) (mailer.Message, ConfirmationEmailState, error) {
	if from, ok, err := d.workspaceConfirmationSender(ctx, target); err != nil {
		return mailer.Message{}, ConfirmationEmailSendFailed, err
	} else if ok {
		msg := confirmationMessage(&target.Form, confirmURL)
		msg.From = from
		msg.Tags = map[string]string{"purpose": confirmationMailPurpose, "sender": "workspace"}
		return msg, "", nil
	}
	if strings.TrimSpace(d.ConfirmationFrom) == "" {
		return mailer.Message{}, ConfirmationEmailNoSender, ErrConfirmationNoSender
	}
	limit := d.StandardSenderHourlyLimit
	if limit <= 0 {
		limit = defaultStandardSenderHourlyLimit
	}
	sent, err := d.Repo.confirmationsSentSince(ctx, target.TenantID, time.Now().Add(-time.Hour))
	if err != nil {
		return mailer.Message{}, ConfirmationEmailSendFailed, err
	}
	if sent >= limit {
		return mailer.Message{}, ConfirmationEmailQuotaExceeded, ErrConfirmationQuotaExceeded
	}
	msg := standardConfirmationMessage(target.WorkspaceName, target.Form.Name, confirmURL)
	msg.From = d.ConfirmationFrom
	msg.Tags = map[string]string{"purpose": confirmationMailPurpose, "sender": "standard"}
	return msg, "", nil
}

// workspaceConfirmationSender returns the form's own sender when its domain
// is one of the workspace's verified sending identities.
func (d *Deps) workspaceConfirmationSender(ctx context.Context, target *confirmationTarget) (string, bool, error) {
	raw := strings.TrimSpace(stringFromSettings(target.Form.Settings, "confirmationFromEmail"))
	if raw == "" || d.SenderVerifier == nil {
		return "", false, nil
	}
	addr, err := mail.ParseAddress(raw)
	if err != nil || addr.Name != "" {
		return "", false, nil
	}
	at := strings.LastIndex(addr.Address, "@")
	if at <= 0 || at == len(addr.Address)-1 {
		return "", false, nil
	}
	verified, err := d.SenderVerifier.IsFromDomainVerified(ctx, target.TenantID, strings.ToLower(addr.Address[at+1:]))
	if err != nil {
		return "", false, fmt.Errorf("forms: check the form's confirmation sender: %w", err)
	}
	if !verified {
		return "", false, nil
	}
	name := strings.Join(strings.Fields(stringFromSettings(target.Form.Settings, "confirmationFromName")), " ")
	if name == "" {
		name = strings.Join(strings.Fields(target.WorkspaceName), " ")
	}
	return (&mail.Address{Name: name, Address: addr.Address}).String(), true, nil
}

// standardConfirmationMessage is the fixed confirmation email the standard
// sender sends. The workspace and form names are the only operator-written
// text in it, collapsed to one line and bounded.
func standardConfirmationMessage(workspaceName, formName, confirmURL string) mailer.Message {
	workspace := boundedName(workspaceName, "this sender")
	body := "You asked to get emails from " + workspace + " by signing up with the form " +
		"“" + boundedName(formName, "signup form") + "”.\n\n" +
		"To confirm, open this link:\n\n" + confirmURLPlaceholder + "\n\n" +
		"If you didn't sign up, ignore this email and you won't get anything else from " + workspace + "."
	return mailer.Message{
		Subject:  "Confirm your subscription to " + workspace,
		Body:     strings.ReplaceAll(body, confirmURLPlaceholder, confirmURL),
		HTMLBody: confirmationHTML(body, confirmURL),
	}
}

func boundedName(value, fallback string) string {
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return fallback
	}
	if runes := []rune(value); len(runes) > 80 {
		value = strings.TrimSpace(string(runes[:80])) + "…"
	}
	return value
}

// confirmationTarget is a submission as its confirmation email needs it.
type confirmationTarget struct {
	TenantID      string
	SubmissionID  string
	Email         string
	Token         string
	Status        SubmissionStatus
	ExpiresAt     *time.Time
	EmailState    ConfirmationEmailState
	WorkspaceName string
	// Form carries the form's id, slug, name and settings.
	Form Form
}

func (t *confirmationTarget) awaitsConfirmation(now time.Time) bool {
	return t.Status == SubmissionPending && t.Token != "" && (t.ExpiresAt == nil || t.ExpiresAt.After(now))
}
