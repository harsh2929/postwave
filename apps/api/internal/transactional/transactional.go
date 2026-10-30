// SPDX-License-Identifier: AGPL-3.0-only
//
// Package transactional implements the public transactional email API — the
// Resend-style "fire one email from your app" surface that Moosewave previously
// lacked (sending was campaign-only). It accepts a normalized SendRequest
// (from/to/cc/bcc/reply_to/subject/html/text/headers/tags/attachments/
// scheduled_at), checks suppression, dispatches through the shared mailer.Mailer
// (SES — which handles open/click/bounce tracking via the configuration set),
// records the send in transactional_emails, and supports immediate + scheduled
// + batch sends. The same send-core backs the SMTP relay.

package transactional

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

// Limits — kept conservative to stay under the SES 40 MB message ceiling and to
// bound abuse. Total recipients counts to+cc+bcc.
const (
	MaxRecipients          = 50
	MaxAttachmentBytes     = 25 << 20 // 25 MiB decoded (~33 MB base64 on the wire)
	MaxBatchSize           = 100
	maxRemoteAttachmentTTL = 15 * time.Second
)

var (
	// ErrValidation is a 400-class input error (message is operator-safe).
	ErrValidation = errors.New("transactional: validation")
	// ErrAllSuppressed means every recipient was on the suppression list.
	ErrAllSuppressed = errors.New("transactional: all recipients suppressed")
)

// validationErr wraps a human message as an ErrValidation.
func validationErr(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrValidation, fmt.Sprintf(format, a...))
}

// stringList unmarshals a JSON string OR an array of strings, so callers can
// send `"to": "a@b.com"` or `"to": ["a@b.com","c@d.com"]` (Resend parity).
type stringList []string

func (s *stringList) UnmarshalJSON(b []byte) error {
	b = []byte(strings.TrimSpace(string(b)))
	if len(b) == 0 || string(b) == "null" {
		*s = nil
		return nil
	}
	if b[0] == '"' {
		var one string
		if err := json.Unmarshal(b, &one); err != nil {
			return err
		}
		*s = stringList{one}
		return nil
	}
	var arr []string
	if err := json.Unmarshal(b, &arr); err != nil {
		return err
	}
	*s = stringList(arr)
	return nil
}

// Tag is a per-message key/value label (forwarded to SES message tags +
// surfaced on webhook events for filtering).
type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Attachment is one file on the message. Exactly one of Content (base64) or
// Path (a remote https URL fetched at send time) must be set.
type Attachment struct {
	Filename    string `json:"filename"`
	Content     string `json:"content,omitempty"` // base64
	Path        string `json:"path,omitempty"`    // remote https URL
	ContentType string `json:"content_type,omitempty"`
	ContentID   string `json:"content_id,omitempty"` // inline (cid:) reference
}

// SendRequest is the normalized JSON body of POST /api/v1/emails (and one
// element of the /emails/batch array).
type SendRequest struct {
	From        string            `json:"from"`
	To          stringList        `json:"to"`
	Cc          stringList        `json:"cc,omitempty"`
	Bcc         stringList        `json:"bcc,omitempty"`
	ReplyTo     stringList        `json:"reply_to,omitempty"`
	Subject     string            `json:"subject"`
	HTML        string            `json:"html,omitempty"`
	Text        string            `json:"text,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Tags        []Tag             `json:"tags,omitempty"`
	Attachments []Attachment      `json:"attachments,omitempty"`
	ScheduledAt *time.Time        `json:"scheduled_at,omitempty"`
}

// SendResult is the API response for one accepted send.
type SendResult struct {
	ID         string `json:"id"`
	Status     string `json:"status"` // sent | scheduled | failed | skipped
	Error      string `json:"error,omitempty"`
	Suppressed int    `json:"suppressed,omitempty"`
}

// SuppressionChecker reports whether an address is suppressed for transactional
// email. Implemented by the suppressions converger (adapted in main.go).
type SuppressionChecker interface {
	IsSuppressed(ctx context.Context, tenantID, email string) (bool, error)
}

// FromVerifier reports whether a tenant may send from a given domain — i.e. the
// domain has a verify_state='verified' sending_identities row for THIS tenant.
// Without it, any domain verified by ANY tenant on the shared SES account could
// be spoofed cross-tenant. nil disables the check (dev only).
type FromVerifier interface {
	IsFromDomainVerified(ctx context.Context, tenantID, domain string) (bool, error)
}

// emailDomain returns the lower-cased domain of an address (after parsing a
// possible "Name <addr>" form). Empty on failure.
func emailDomain(addr string) string {
	parsed, err := mail.ParseAddress(strings.TrimSpace(addr))
	if err != nil {
		return ""
	}
	at := strings.LastIndex(parsed.Address, "@")
	if at < 0 || at == len(parsed.Address)-1 {
		return ""
	}
	return strings.ToLower(parsed.Address[at+1:])
}

// AttachmentFetcher fetches a remote attachment URL (SSRF-guarded). Optional;
// nil disables `path` attachments.
type AttachmentFetcher interface {
	Fetch(ctx context.Context, url string) (body []byte, contentType string, err error)
}

// Deps is the send-core dependency set.
type Deps struct {
	Mailer           mailer.Mailer
	Repo             *Repo
	Suppression      SuppressionChecker // optional; nil = no pre-send suppression filter
	FromVerify       FromVerifier       // optional; nil = no From-ownership check (dev)
	Fetcher          AttachmentFetcher  // optional; nil = `path` attachments rejected
	DefaultFrom      string             // used when a request omits From
	Logger           *slog.Logger
	Allowance        sendallowance.Gate
	RequireAllowance bool
}

// defaultDomain is the domain of DefaultFrom (the platform sender), which is
// always allowed regardless of tenant identities.
func (d *Deps) defaultDomain() string {
	return emailDomain(d.DefaultFrom)
}

// checkFromAllowed rejects a From whose domain is neither the platform default
// nor a verified sending identity of the tenant (anti cross-tenant spoofing).
func (d *Deps) checkFromAllowed(ctx context.Context, tenantID, from string) error {
	if d.FromVerify == nil {
		return nil
	}
	domain := emailDomain(from)
	if domain == "" {
		return validationErr("from address is malformed")
	}
	if dd := d.defaultDomain(); dd != "" && domain == dd {
		return nil // the platform's own sender
	}
	ok, err := d.FromVerify.IsFromDomainVerified(ctx, tenantID, domain)
	if err != nil {
		// Fail closed on a verifier error: a From-ownership check that can't run
		// must not silently allow spoofing.
		return validationErr("could not verify the from domain; try again")
	}
	if !ok {
		return validationErr("from domain %q has no verified sending identity for this tenant", domain)
	}
	return nil
}

func (d *Deps) log() *slog.Logger {
	if d != nil && d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// Normalize trims + defaults the request in place and validates it. Returns an
// ErrValidation-wrapped error on bad input.
func (r *SendRequest) Normalize(defaultFrom string, now time.Time) error {
	r.From = strings.TrimSpace(r.From)
	if r.From == "" {
		r.From = strings.TrimSpace(defaultFrom)
	}
	if r.From == "" {
		return validationErr("from is required")
	}
	if _, err := mail.ParseAddress(r.From); err != nil {
		return validationErr("from is not a valid address: %v", err)
	}
	r.To = cleanAddrs(r.To)
	r.Cc = cleanAddrs(r.Cc)
	r.Bcc = cleanAddrs(r.Bcc)
	r.ReplyTo = cleanAddrs(r.ReplyTo)
	if len(r.To) == 0 {
		return validationErr("at least one `to` recipient is required")
	}
	total := len(r.To) + len(r.Cc) + len(r.Bcc)
	if total > MaxRecipients {
		return validationErr("too many recipients (%d > %d)", total, MaxRecipients)
	}
	for _, list := range [][]string{r.To, r.Cc, r.Bcc, r.ReplyTo} {
		for _, a := range list {
			if _, err := mail.ParseAddress(a); err != nil {
				return validationErr("invalid recipient %q", a)
			}
		}
	}
	r.Subject = strings.TrimSpace(r.Subject)
	if r.Subject == "" {
		return validationErr("subject is required")
	}
	if strings.TrimSpace(r.HTML) == "" && strings.TrimSpace(r.Text) == "" {
		return validationErr("one of `html` or `text` is required")
	}
	if len(r.Attachments) > 0 {
		for i := range r.Attachments {
			r.Attachments[i].Filename = strings.TrimSpace(r.Attachments[i].Filename)
			if r.Attachments[i].Filename == "" {
				return validationErr("attachment %d missing filename", i)
			}
			hasContent := strings.TrimSpace(r.Attachments[i].Content) != ""
			hasPath := strings.TrimSpace(r.Attachments[i].Path) != ""
			if hasContent == hasPath {
				return validationErr("attachment %q needs exactly one of content or path", r.Attachments[i].Filename)
			}
		}
	}
	if r.ScheduledAt != nil {
		// A scheduled_at within the past (or now) is treated as "send now".
		if !r.ScheduledAt.After(now) {
			r.ScheduledAt = nil
		}
	}
	return nil
}

func cleanAddrs(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, a := range in {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		key := strings.ToLower(a)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, a)
	}
	return out
}

// tagsToMap flattens the Resend-style tag list into a map for the mailer.
func tagsToMap(tags []Tag) map[string]string {
	if len(tags) == 0 {
		return nil
	}
	m := make(map[string]string, len(tags))
	for _, t := range tags {
		if n := strings.TrimSpace(t.Name); n != "" {
			m[n] = t.Value
		}
	}
	return m
}

// resolveAttachments decodes base64 content / fetches remote paths into raw
// bytes, enforcing the total-size cap.
func (d *Deps) resolveAttachments(ctx context.Context, in []Attachment) ([]mailer.Attachment, error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make([]mailer.Attachment, 0, len(in))
	var total int
	for _, a := range in {
		var raw []byte
		ct := strings.TrimSpace(a.ContentType)
		if c := strings.TrimSpace(a.Content); c != "" {
			dec, err := base64.StdEncoding.DecodeString(c)
			if err != nil {
				return nil, validationErr("attachment %q content is not valid base64", a.Filename)
			}
			raw = dec
		} else {
			if d.Fetcher == nil {
				return nil, validationErr("remote attachment paths are not enabled")
			}
			fctx, cancel := context.WithTimeout(ctx, maxRemoteAttachmentTTL)
			body, fct, err := d.Fetcher.Fetch(fctx, a.Path)
			cancel()
			if err != nil {
				return nil, validationErr("attachment %q fetch failed: %v", a.Filename, err)
			}
			raw = body
			if ct == "" {
				ct = fct
			}
		}
		total += len(raw)
		if total > MaxAttachmentBytes {
			return nil, validationErr("attachments exceed the %d-byte limit", MaxAttachmentBytes)
		}
		out = append(out, mailer.Attachment{
			Filename:    a.Filename,
			Content:     raw,
			ContentType: ct,
			Inline:      a.ContentID != "",
			ContentID:   a.ContentID,
		})
	}
	return out, nil
}

// dispatch preserves the historical error-only shape for package callers and
// tests that do not need provider attribution.
func (d *Deps) dispatch(ctx context.Context, tenantID string, r *SendRequest) (status string, suppressed int, err error) {
	status, suppressed, _, err = d.dispatchWithReceipt(ctx, tenantID, r)
	return status, suppressed, err
}

// dispatchWithReceipt performs one immediate send and retains the optional
// provider message ID so the transactional ledger can resolve later feedback
// to exactly one tenant.
func (d *Deps) dispatchWithReceipt(
	ctx context.Context,
	tenantID string,
	r *SendRequest,
) (status string, suppressed int, providerMessageID string, err error) {
	return d.dispatchWithReceiptForIntent(ctx, tenantID, r, "", "")
}

func (d *Deps) dispatchWithReceiptForIntent(
	ctx context.Context,
	tenantID string,
	r *SendRequest,
	allowanceKey, sourceRef string,
) (status string, suppressed int, providerMessageID string, err error) {
	to, sTo := d.filterSuppressed(ctx, tenantID, r.To)
	cc, sCc := d.filterSuppressed(ctx, tenantID, r.Cc)
	bcc, sBcc := d.filterSuppressed(ctx, tenantID, r.Bcc)
	suppressed = sTo + sCc + sBcc
	if len(to) == 0 {
		return "skipped", suppressed, "", ErrAllSuppressed
	}
	atts, err := d.resolveAttachments(ctx, r.Attachments)
	if err != nil {
		return "failed", suppressed, "", err
	}
	msg := mailer.Message{
		TenantID:    tenantID,
		From:        r.From,
		ToList:      to,
		Cc:          cc,
		Bcc:         bcc,
		Subject:     r.Subject,
		Body:        r.Text,
		HTMLBody:    r.HTML,
		Headers:     r.Headers,
		Tags:        tagsToMap(r.Tags),
		Attachments: atts,
	}
	if len(r.ReplyTo) > 0 {
		msg.ReplyTo = r.ReplyTo[0]
	}
	var reservation sendallowance.Reservation
	if d.Allowance == nil {
		if d.RequireAllowance {
			return "failed", suppressed, "", sendallowance.ErrUnavailable
		}
	} else {
		if strings.TrimSpace(allowanceKey) == "" {
			return "failed", suppressed, "", fmt.Errorf("%w: transactional send has no durable allowance identity", sendallowance.ErrUnavailable)
		}
		recipients := append(append(append([]string(nil), to...), cc...), bcc...)
		reservation, err = d.Allowance.Reserve(ctx, sendallowance.Request{
			TenantID: tenantID, Key: allowanceKey, Source: "transactional",
			SourceRef: sourceRef, RecipientIDs: recipients,
		})
		if err != nil {
			return "failed", suppressed, "", err
		}
		if err := d.Allowance.Commit(ctx, reservation); err != nil {
			_ = d.Allowance.Release(context.WithoutCancel(ctx), reservation, "commit_failed")
			return "failed", suppressed, "", err
		}
	}
	providerMessageID, err = sendWithOptionalReceipt(ctx, d.Mailer, msg)
	if err != nil {
		if d.Allowance != nil && !ambiguousDispatchError(err) {
			_ = d.Allowance.Release(context.WithoutCancel(ctx), reservation, "provider_definitely_rejected")
		}
		return "failed", suppressed, "", err
	}
	return "sent", suppressed, providerMessageID, nil
}

func sendWithOptionalReceipt(ctx context.Context, sender mailer.Mailer, msg mailer.Message) (string, error) {
	if receiptSender, ok := sender.(mailer.ReceiptMailer); ok {
		receipt, err := receiptSender.SendWithReceipt(ctx, msg)
		return strings.TrimSpace(receipt.ProviderMessageID), err
	}
	return "", sender.Send(ctx, msg)
}

// filterSuppressed removes suppressed addresses; returns (kept, suppressedCount).
func (d *Deps) filterSuppressed(ctx context.Context, tenantID string, in []string) ([]string, int) {
	if d.Suppression == nil || len(in) == 0 {
		return in, 0
	}
	kept := make([]string, 0, len(in))
	dropped := 0
	for _, a := range in {
		ok, err := d.Suppression.IsSuppressed(ctx, tenantID, a)
		if err != nil {
			// Fail-open on a suppression-store error: better to send than to
			// silently drop a password-reset. But LOG it — a persistent store
			// failure means we're bypassing suppression (deliverability risk).
			d.log().Warn("transactional: suppression check failed, sending anyway",
				"tenant_id", tenantID, "err", err.Error())
			kept = append(kept, a)
			continue
		}
		if ok {
			dropped++
			continue
		}
		kept = append(kept, a)
	}
	return kept, dropped
}
