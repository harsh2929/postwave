// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"errors"
	"fmt"
	stdhtml "html"
	"net/url"
	"regexp"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// ErrConfirmationMailerUnavailable is returned when no outbound mailer is
// configured, so a double opt-in confirmation cannot be sent.
var ErrConfirmationMailerUnavailable = errors.New("forms: no outbound mailer is configured for confirmation emails")

const (
	confirmURLPlaceholder      = "{{confirm_url}}"
	defaultConfirmationSubject = "Confirm your subscription"
	// defaultConfirmationBody is used when the form has no body of its own. It
	// is written for the person who typed their address, not for the operator.
	defaultConfirmationBody = "Please confirm that you want to receive our emails by opening this link:\n\n" +
		confirmURLPlaceholder +
		"\n\nIf you didn't ask to subscribe, ignore this email and you won't be added."
	confirmationMailPurpose = "form_double_optin"
)

// The confirmation email used to go through Listmonk's /api/tx with no
// template id, which Listmonk v6.1.0 rejects ("template 0 not found"), and
// even with one Listmonk renders the template instead of the body the link
// was in. The error was discarded, so no confirmation email was ever
// delivered while resend reported success. It is now sent through the
// product's outbound mailer by DeliverConfirmation.

// confirmationSendError is a failed send whose message leaves out the
// visitor's address. Callers log it, and providers echo the recipient in
// their errors (SES: "Email address is not verified. The following
// identities failed the check: …").
type confirmationSendError struct {
	cause   error
	message string
}

func newConfirmationSendError(cause error, recipient string) *confirmationSendError {
	message := cause.Error()
	if recipient != "" {
		message = regexp.MustCompile(`(?i)`+regexp.QuoteMeta(recipient)).ReplaceAllString(message, "[recipient]")
	}
	return &confirmationSendError{cause: cause, message: "forms: send confirmation email: " + message}
}

func (e *confirmationSendError) Error() string { return e.message }

func (e *confirmationSendError) Unwrap() error { return e.cause }

// confirmationURL is the absolute link the hosted confirm page serves. A
// relative or host-less base would put a link nobody can open in the email,
// so it is refused instead.
func confirmationURL(publicHostBase, slug, token string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(publicHostBase))
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" {
		return "", fmt.Errorf("forms: FORMS_PUBLIC_HOST %q is not an absolute http(s) URL, so no confirmation link can be built", publicHostBase)
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/forms/" + url.PathEscape(slug) + "/confirm/" + url.PathEscape(token)
	base.RawQuery, base.Fragment = "", ""
	return base.String(), nil
}

// confirmationMessage renders the form's confirmation subject and body. The
// body is the plain text the operator wrote in the form editor: it goes out
// as the text part, and as an HTML part with the text escaped, its line
// breaks kept, and every {{confirm_url}} turned into a link. A body without
// the placeholder gets the link appended, so no confirmation email is ever
// sent without a way to confirm.
func confirmationMessage(form *Form, confirmURL string) mailer.Message {
	subject := strings.Join(strings.Fields(stringFromSettings(form.Settings, "confirmationSubject")), " ")
	if subject == "" {
		subject = defaultConfirmationSubject
	}
	body := strings.TrimSpace(strings.ReplaceAll(stringFromSettings(form.Settings, "confirmationBody"), "\r\n", "\n"))
	if body == "" {
		body = defaultConfirmationBody
	}
	if !strings.Contains(body, confirmURLPlaceholder) {
		body += "\n\n" + confirmURLPlaceholder
	}
	return mailer.Message{
		Subject:  subject,
		Body:     strings.ReplaceAll(body, confirmURLPlaceholder, confirmURL),
		HTMLBody: confirmationHTML(body, confirmURL),
	}
}

func confirmationHTML(body, confirmURL string) string {
	link := `<a href="` + stdhtml.EscapeString(confirmURL) + `" style="color:#1d4ed8;word-break:break-all">` +
		stdhtml.EscapeString(confirmURL) + `</a>`
	segments := strings.Split(body, confirmURLPlaceholder)
	for i, segment := range segments {
		segments[i] = stdhtml.EscapeString(segment)
	}
	text := strings.Join(segments, link)
	paragraphs := make([]string, 0, 4)
	for _, paragraph := range strings.Split(text, "\n\n") {
		if paragraph = strings.TrimSpace(paragraph); paragraph != "" {
			paragraphs = append(paragraphs, "<p style=\"margin:0 0 16px\">"+strings.ReplaceAll(paragraph, "\n", "<br>")+"</p>")
		}
	}
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
		`<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#111827">` +
		strings.Join(paragraphs, "") + `</body></html>`
}
