// SPDX-License-Identifier: AGPL-3.0-only

package transactional

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/mail"
	"strings"
	"syscall"
	"time"

	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

// Send is the high-level entry: normalize → (schedule | dispatch) → record.
// `source` is api | batch | smtp. It returns an error ONLY for validation
// (ErrValidation → 400) or a hard infra failure; a dispatch failure is
// reflected in SendResult.Status="failed" so a batch can continue.
// ErrIntentConflict is returned when an intent key is reused with different
// content. Answering with the first message's id would silently drop the
// second, which is a worse outcome than refusing.
var ErrIntentConflict = errors.New("transactional: idempotency key reused with different content")

// Send submits a message with a DERIVED intent key. Callers that have an
// Idempotency-Key header should use SendWithIntent so a client retry is
// recognised as the same attempt.
func (d *Deps) Send(ctx context.Context, tenantID, source string, r *SendRequest, now time.Time) (SendResult, error) {
	return d.SendWithIntent(ctx, tenantID, source, r, "", now)
}

// classifyAttempt maps a dispatch outcome onto the two facts the ledger keeps
// separate: what this process attempted, and what we believe reached the
// outside world.
//
// A timeout or cancellation is `unknown`, NOT a failure. The provider may have
// accepted the message and no receipt exists to say — which is precisely the
// case the old ten-minute re-claim treated as "retry me".
func classifyAttempt(status string, derr error) (attemptState, externalEffect string) {
	switch {
	case derr == nil && status == "sent":
		return "submitted", "full"
	case derr == nil:
		// Suppressed or otherwise not dispatched, but decided.
		return "rejected", "none"
	case ambiguousDispatchError(derr):
		return "unknown", "unknown"
	default:
		// A DECIDED refusal: the provider answered and said no. Safe to record
		// as never-happened, and therefore safe to retry.
		return "rejected", "none"
	}
}

// ambiguousDispatchError reports whether an error leaves the provider's state
// genuinely unknown.
//
// The first version only matched context deadline/cancel, which is the easy
// half. An adversarial review showed the case that actually matters is missed:
// a connection reset AFTER the request was written returns
// "exceeded maximum number of attempts, 3, ... read: connection reset by peer",
// matches neither context error, and was recorded as `rejected` — i.e. "it
// definitely did not happen", about a message SES may well have accepted. The
// AWS SDK has also already retried three times underneath us by then.
//
// The rule is about what we can KNOW. A transport failure cannot tell us
// whether the request was processed, so it is `unknown`. Only an answer from
// the provider counts as a refusal.
func ambiguousDispatchError(derr error) bool {
	if derr == nil {
		return false
	}
	if errors.Is(derr, context.DeadlineExceeded) || errors.Is(derr, context.Canceled) {
		return true
	}
	// Connection-level failures. EOF and RST both mean "the conversation ended
	// mid-flight", which is exactly the state we cannot resolve.
	if errors.Is(derr, io.EOF) || errors.Is(derr, io.ErrUnexpectedEOF) ||
		errors.Is(derr, syscall.ECONNRESET) || errors.Is(derr, syscall.EPIPE) ||
		errors.Is(derr, syscall.ECONNABORTED) {
		return true
	}
	var netErr net.Error
	if errors.As(derr, &netErr) {
		return true
	}
	// Provider SDK retry exhaustion. Matched on text because the smithy error
	// types are not imported here and adding that dependency to reach one
	// boolean is a worse trade; a miss degrades to `rejected`, which is the
	// behaviour that existed before this function.
	msg := derr.Error()
	return strings.Contains(msg, "exceeded maximum number of attempts") ||
		strings.Contains(msg, "connection reset by peer") ||
		strings.Contains(msg, "broken pipe")
}

// SendWithIntent is Send with an explicit intent key — normally the caller's
// Idempotency-Key. When empty, the key is derived from the canonical request so
// that every send still has exactly one identity to be deduplicated by.
func (d *Deps) SendWithIntent(ctx context.Context, tenantID, source string, r *SendRequest, intentKey string, now time.Time) (SendResult, error) {
	if err := r.Normalize(d.DefaultFrom, now); err != nil {
		return SendResult{}, err
	}
	// Anti-spoofing: the From domain must belong to this tenant (or be the
	// platform default). Checked at submit time for both immediate + scheduled.
	if err := d.checkFromAllowed(ctx, tenantID, r.From); err != nil {
		return SendResult{}, err
	}

	// Only a CALLER-SUPPLIED key claims an intent.
	//
	// An earlier version derived one from the request body when the header was
	// absent. That was a silent-message-loss regression, not a safety net: only
	// the caller knows that two requests are the same attempt. Deriving it
	// meant two deliberate identical sends — a reminder, a "resend
	// confirmation" button, the same nightly digest — collapsed into ONE
	// delivery forever, with no time window, and the second call returned 202
	// as though it had been sent.
	//
	// Worse, the derived hash covered only from/subject/text/html/to/cc/bcc. Two
	// invoices with the same covering note and different PDFs hashed
	// identically, so the second was dropped AND the conflict check could not
	// fire, because the hashes matched.
	//
	// Without a key there is no claim and the send proceeds as before: the
	// caller has told us nothing about retry semantics, so inventing them is
	// the one thing we must not do.
	intentKey = strings.TrimSpace(intentKey)
	requestHash := hashSendRequest(r)
	if intentKey == "" {
		return d.sendUnclaimed(ctx, tenantID, source, r)
	}

	// Scheduled: persist the full request and let the worker dispatch it.
	if r.ScheduledAt != nil {
		payload, err := json.Marshal(r)
		if err != nil {
			return SendResult{}, err
		}
		id, err := d.Repo.Insert(ctx, tenantID, InsertInput{
			From: r.From, To: r.To, Subject: r.Subject, Status: "scheduled",
			ScheduledAt: r.ScheduledAt, Source: source, Payload: payload,
		})
		if err != nil {
			return SendResult{}, err
		}
		return SendResult{ID: id, Status: "scheduled"}, nil
	}

	// Immediate: CLAIM first, then dispatch, then settle.
	//
	// This used to dispatch first and insert afterwards. That is one write and
	// two failure modes: mail delivered with no ledger row when the insert
	// failed, and a `sending` row the worker re-dispatched ten minutes later.
	// Claiming first costs a second write and removes both.
	id, owned, cerr := d.Repo.ClaimIntent(ctx, tenantID, InsertInput{
		From: r.From, To: r.To, Subject: r.Subject, Status: "sending", Source: source,
	}, intentKey, requestHash)
	if cerr != nil {
		return SendResult{}, cerr
	}
	if !owned {
		// A retry of an intent someone already claimed. Report what the ORIGINAL
		// attempt actually did.
		//
		// Answering a flat "accepted" made a transient provider failure
		// permanent and invisible: the first attempt was throttled and recorded
		// `failed`, the caller retried with the same key, and the API said
		// accepted while nothing was ever sent. For a password reset or an OTP
		// that is the whole product failing silently.
		prior, perr := d.Repo.IntentOutcome(ctx, tenantID, id)
		if perr != nil {
			return SendResult{}, perr
		}
		if prior.Retryable() {
			// The provider was never reached — the prior attempt was rejected
			// before dispatch or the claim was never settled. Re-dispatch is
			// safe precisely because `external_effect` says nothing left.
			return d.dispatchClaimed(ctx, tenantID, id, r)
		}
		return SendResult{ID: id, Status: prior.Status, Error: prior.LastError}, nil
	}
	return d.dispatchClaimed(ctx, tenantID, id, r)
}

// sendUnclaimed is the pre-intent path, used when the caller supplied no
// Idempotency-Key. Dispatch then record, exactly as before — no claim is made
// because the caller has expressed no retry intent for us to honour.
func (d *Deps) sendUnclaimed(ctx context.Context, tenantID, source string, r *SendRequest) (SendResult, error) {
	id, err := d.Repo.Insert(ctx, tenantID, InsertInput{
		From: r.From, To: r.To, Subject: r.Subject, Status: "sending", Source: source,
		AttemptState: "prepared", ExternalEffect: "none",
	})
	if err != nil {
		return SendResult{}, err
	}
	return d.dispatchClaimed(ctx, tenantID, id, r)
}

// dispatchClaimed runs the provider call behind an already-claimed receipt.
func (d *Deps) dispatchClaimed(ctx context.Context, tenantID, id string, r *SendRequest) (SendResult, error) {

	status, suppressed, providerMessageID, derr := d.dispatchWithReceiptForIntent(
		ctx, tenantID, r, "transactional-email:"+id, "transactional_emails:"+id,
	)
	if derr != nil {
		d.log().Warn("transactional: dispatch failed",
			"tenant_id", tenantID, "status", status, "err", derr.Error())
	}
	attemptState, externalEffect := classifyAttempt(status, derr)
	lastError := ""
	if derr != nil {
		lastError = truncate(derr.Error(), 500)
	}
	if err := d.Repo.SettleIntent(ctx, tenantID, id, attemptState, externalEffect,
		status, providerMessageID, lastError, suppressed); err != nil {
		// The claim is already durable, so the row cannot be re-dispatched: it
		// is not `prepared`. Surfacing the dispatch outcome is all that is left.
		d.log().Error("transactional: settle failed",
			"tenant_id", tenantID, "id", id, "err", err.Error())
		res := SendResult{ID: id, Status: status, Suppressed: suppressed}
		if derr != nil {
			res.Error = truncate(derr.Error(), 500)
		}
		if errors.Is(derr, sendallowance.ErrExhausted) || errors.Is(derr, sendallowance.ErrUnavailable) {
			return res, derr
		}
		return res, nil
	}
	// NOTE: a MarkFailed call used to follow here to "stamp the final status
	// precisely". SettleIntent already wrote status, last_error, attempt_state
	// and external_effect in one statement, so it was redundant — and it was
	// invisible because MarkFailed's SQL was broken and its error discarded.
	// Repairing that SQL made this dead line live and actively harmful: it
	// overwrote a correctly-classified `unknown` timeout with `rejected`,
	// turning "the provider may have accepted this" back into "it definitely
	// did not". A test now pins the classification through this path.
	res := SendResult{ID: id, Status: status, Suppressed: suppressed}
	if derr != nil {
		res.Error = truncate(derr.Error(), 500)
	}
	// Provider refusals remain asynchronous result data, but allowance failures
	// happen before any provider call and need an actionable HTTP response. A
	// 402 is safe for idempotency middleware to cache; a 503 remains retryable.
	if errors.Is(derr, sendallowance.ErrExhausted) || errors.Is(derr, sendallowance.ErrUnavailable) {
		return res, derr
	}
	return res, nil
}

// SendStored dispatches a previously-scheduled row (called by the worker). It
// re-runs the full send-core against the persisted payload and marks the row
// sent/failed.
func (d *Deps) SendStored(ctx context.Context, tenantID, id string, payload json.RawMessage) {
	// Every terminal write is CHECKED. These were all `_ =`, which is how
	// MarkSent and MarkFailed could be broken SQL (42P18) in production without
	// anyone noticing — and a row that never leaves `sending`/`prepared` is
	// re-claimed by the worker every ten minutes and delivered again. The
	// duplicate was not a rare crash window; it was a loop.
	mark := func(fn func() error, what string) {
		if err := fn(); err != nil {
			d.log().Error("transactional: could not settle scheduled row",
				"tenant_id", tenantID, "id", id, "transition", what,
				"err", err.Error(),
				"note", "the row stays claimable and WILL be re-dispatched")
		}
	}

	var r SendRequest
	if err := json.Unmarshal(payload, &r); err != nil {
		mark(func() error {
			return d.Repo.MarkFailed(ctx, tenantID, id, "bad stored payload: "+err.Error())
		}, "failed")
		return
	}
	// Clear the schedule so dispatch runs now; re-normalize defensively.
	r.ScheduledAt = nil
	if err := r.Normalize(d.DefaultFrom, time.Now().UTC()); err != nil {
		mark(func() error { return d.Repo.MarkFailed(ctx, tenantID, id, err.Error()) }, "failed")
		return
	}
	if err := d.checkFromAllowed(ctx, tenantID, r.From); err != nil {
		mark(func() error { return d.Repo.MarkFailed(ctx, tenantID, id, err.Error()) }, "failed")
		return
	}
	status, _, providerMessageID, derr := d.dispatchWithReceiptForIntent(
		ctx, tenantID, &r, "transactional-email:"+id, "transactional_emails:"+id,
	)
	attemptState, _ := classifyAttempt(status, derr)
	if attemptState == "unknown" {
		// The provider may have accepted it and no receipt exists to say.
		// Terminal for the worker: re-dispatching is a duplicate to a real
		// person, and dropping it silently is a lost message. Surfaced instead.
		mark(func() error { return d.Repo.MarkUnknown(ctx, tenantID, id, derr.Error()) }, "unknown")
		return
	}
	if derr != nil || status == "failed" {
		msg := "dispatch failed"
		if derr != nil {
			msg = derr.Error()
		}
		mark(func() error { return d.Repo.MarkFailed(ctx, tenantID, id, msg) }, "failed")
		return
	}
	mark(func() error { return d.Repo.MarkSent(ctx, tenantID, id, providerMessageID) }, "sent")
}

// SendRawSMTP dispatches a raw MIME message received over the SMTP relay. The
// envelope `from` + `rcpts` come from MAIL FROM / RCPT TO. Suppressed
// recipients are filtered; if any remain the raw bytes are relayed verbatim
// via SES (Content.Raw). Returns an error only on a genuine send failure (so
// the SMTP server replies 5xx); an all-suppressed message is accepted + dropped.
// SendRawSMTP returns (permanent, err): permanent=true means a non-retryable
// failure (the relay should reply 5xx-permanent, not 4xx-retry) so a bad message
// doesn't loop forever.
func (d *Deps) SendRawSMTP(ctx context.Context, tenantID, from string, rcpts []string, raw []byte) (permanent bool, err error) {
	from = strings.TrimSpace(from)
	if from == "" {
		from = strings.TrimSpace(d.DefaultFrom)
	}
	// Validate envelope syntax up front so a malformed address is a clean
	// permanent reject, not an opaque SES error.
	if _, perr := mail.ParseAddress(from); perr != nil {
		return true, fmt.Errorf("malformed MAIL FROM %q", from)
	}
	rcpts = dedupeLower(rcpts)
	for _, rc := range rcpts {
		if _, perr := mail.ParseAddress(rc); perr != nil {
			return true, fmt.Errorf("malformed RCPT %q", rc)
		}
	}
	// Anti-spoofing: the envelope From domain must belong to this tenant.
	if ferr := d.checkFromAllowed(ctx, tenantID, from); ferr != nil {
		return true, ferr
	}
	subject := parseRawSubject(raw)

	// Message-level dedup: SMTP is at-least-once, so a client that timed out
	// waiting for our 250 will resubmit the identical message. Claim a key
	// (Message-Id, else a hash of the bytes); a duplicate of an
	// already-accepted message is accepted WITHOUT re-sending.
	dedupKey := smtpDedupKey(raw)
	if d.Repo != nil {
		isNew, derr := d.Repo.ClaimSMTPDedup(ctx, tenantID, dedupKey, SMTPDedupWindowSecs)
		if derr != nil {
			d.log().Warn("transactional smtp: dedup claim failed, sending anyway", "tenant_id", tenantID, "err", derr.Error())
		} else if !isNew {
			d.log().Info("transactional smtp: duplicate suppressed", "tenant_id", tenantID, "key", dedupKey)
			d.recordSMTP(ctx, tenantID, from, rcpts, subject, "skipped", 0, "")
			return false, nil // accept the retry, do not re-send
		}
	}

	kept, suppressed := d.filterSuppressed(ctx, tenantID, rcpts)
	if len(kept) == 0 {
		d.recordSMTP(ctx, tenantID, from, rcpts, subject, "skipped", suppressed, "")
		return false, nil // accept + drop — suppression is not a client-facing failure
	}
	var allowanceReservation sendallowance.Reservation
	if d.Allowance == nil {
		if d.RequireAllowance {
			if d.Repo != nil {
				d.Repo.ReleaseSMTPDedup(context.WithoutCancel(ctx), tenantID, dedupKey)
			}
			return false, sendallowance.ErrUnavailable
		}
	} else {
		allowanceReservation, err = d.Allowance.Reserve(ctx, sendallowance.Request{
			TenantID: tenantID, Key: "transactional-smtp:" + dedupKey, Source: "transactional_smtp",
			SourceRef: "transactional_smtp_dedup:" + dedupKey, RecipientIDs: kept,
		})
		if err != nil {
			if d.Repo != nil {
				d.Repo.ReleaseSMTPDedup(context.WithoutCancel(ctx), tenantID, dedupKey)
			}
			return false, err
		}
		if err := d.Allowance.Commit(ctx, allowanceReservation); err != nil {
			_ = d.Allowance.Release(context.WithoutCancel(ctx), allowanceReservation, "commit_failed")
			if d.Repo != nil {
				d.Repo.ReleaseSMTPDedup(context.WithoutCancel(ctx), tenantID, dedupKey)
			}
			return false, err
		}
	}
	providerMessageID, sendErr := sendWithOptionalReceipt(ctx, d.Mailer, mailer.Message{
		TenantID: tenantID,
		From:     from,
		ToList:   kept,
		Raw:      raw,
	})
	status := "sent"
	if sendErr != nil {
		status = "failed"
		d.log().Warn("transactional smtp: relay send failed", "tenant_id", tenantID, "err", sendErr.Error())
	}
	d.recordSMTP(ctx, tenantID, from, kept, subject, status, suppressed, providerMessageID)
	if sendErr != nil {
		var perm *mailer.PermanentError
		isPerm := errors.As(sendErr, &perm)
		ambiguous := ambiguousDispatchError(sendErr)
		if d.Allowance != nil && !ambiguous {
			_ = d.Allowance.Release(context.WithoutCancel(ctx), allowanceReservation, "provider_definitely_rejected")
		}
		// Only a definite transient refusal may be resubmitted. A timeout or
		// transport break can follow provider acceptance; retaining its dedup
		// claim makes the SMTP client's retry resolve to 250 without duplicating
		// the provider submission or escaping the allowance ledger.
		if !isPerm && !ambiguous && d.Repo != nil {
			d.Repo.ReleaseSMTPDedup(context.WithoutCancel(ctx), tenantID, dedupKey)
		}
		return isPerm, sendErr
	}
	return false, nil
}

// SMTPDedupWindowSecs is how long a sent message's dedup key is retained — a
// retry within this window is suppressed. 1 hour comfortably covers MTA retry
// schedules without growing the table.
const SMTPDedupWindowSecs = 3600

// smtpDedupKey derives a per-message dedup key: the MIME Message-Id when the
// client set one (retries reuse it), else a content hash of the raw bytes.
func smtpDedupKey(raw []byte) string {
	if msg, err := mail.ReadMessage(bytes.NewReader(raw)); err == nil {
		if mid := strings.TrimSpace(msg.Header.Get("Message-Id")); mid != "" {
			return "mid:" + truncate(mid, 400)
		}
	}
	sum := sha256.Sum256(raw)
	return "sha:" + hex.EncodeToString(sum[:])
}

func (d *Deps) recordSMTP(
	ctx context.Context,
	tenantID, from string,
	to []string,
	subject, status string,
	suppressed int,
	providerMessageID string,
) {
	if _, err := d.Repo.Insert(ctx, tenantID, InsertInput{
		From: from, To: to, Subject: subject, Status: status, Source: "smtp", SuppressedCount: suppressed,
		ProviderMessageID: providerMessageID,
	}); err != nil {
		d.log().Error("transactional smtp: record insert failed", "tenant_id", tenantID, "err", err.Error())
	}
}

// parseRawSubject pulls the Subject header out of a raw MIME message for the
// activity record. Best-effort; empty on a parse failure.
func parseRawSubject(raw []byte) string {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	return truncate(msg.Header.Get("Subject"), 500)
}

func dedupeLower(in []string) []string {
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
		k := strings.ToLower(a)
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, a)
	}
	return out
}

// hashSendRequest is the content fingerprint an intent key is checked against.
//
// Deliberately over the FIELDS that decide what a recipient receives, not over
// the raw bytes: two byte-different JSON encodings of the same message are the
// same message, and treating them as a conflict would reject legitimate retries
// from a client that re-serialises.
func hashSendRequest(r *SendRequest) string {
	h := sha256.New()
	write := func(parts ...string) {
		for _, p := range parts {
			_, _ = h.Write([]byte(p))
			_, _ = h.Write([]byte{0})
		}
	}
	write(r.From, r.Subject, r.Text, r.HTML)
	for _, to := range append([]string(nil), r.To...) {
		write("to:" + to)
	}
	for _, cc := range append([]string(nil), r.Cc...) {
		write("cc:" + cc)
	}
	for _, bcc := range append([]string(nil), r.Bcc...) {
		write("bcc:" + bcc)
	}
	return hex.EncodeToString(h.Sum(nil))
}
