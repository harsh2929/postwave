// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

// SignupCapture is one public signup — a hosted or embedded form submission —
// that the subscriber store must reflect.
type SignupCapture struct {
	Email string
	// Name is what the visitor typed. It names a subscriber this capture
	// creates; an existing profile keeps its own names.
	Name string
	// SignupSource is SignupSourceHostedPage or SignupSourceEmbeddedForm;
	// anything else is stored as SignupSourceUnknown.
	SignupSource SignupSource
	// SourceID identifies the capturing form.
	SourceID string
	// SignupIP and UserAgent are the visitor's, recorded on a new subscriber
	// and on the consent evidence.
	SignupIP  string
	UserAgent string
	// Consent is the email consent this capture grants now; nil grants none
	// (a double opt-in that is not confirmed yet, or a visitor who left the
	// consent checkbox unticked).
	Consent *SignupConsent
	// AwaitingConfirmation reports a capture that asked to subscribe and was
	// sent a confirmation link instead of being granted consent: a double
	// opt-in. Email consent is then pending, which is what the profile's
	// Consent tab must say — not "unknown", which reads as nothing having
	// happened at all.
	AwaitingConfirmation bool
}

// SignupConsent is the evidence for the email consent a signup grants.
type SignupConsent struct {
	// Source is ConsentSingleOptIn or ConsentDoubleOptIn.
	Source        string
	OccurredAt    time.Time
	Evidence      string
	Reason        string
	PolicyVersion string
	// MailboxVerified is true when the consent act proved control of the
	// mailbox: a click on a double opt-in confirmation link.
	MailboxVerified bool
}

const (
	// signupSourcePlatform is subscribers.source_platform for a subscriber a
	// form signup created.
	signupSourcePlatform = "form"
	// signupConsentJurisdiction is recorded on form consent evidence. Forms do
	// not ask for a country, and an IP address is not a jurisdiction
	// determination, so the record says so rather than guessing one.
	signupConsentJurisdiction = "UNSPECIFIED"
	// signupAuditActor labels the audit rows a signup writes.
	signupAuditActor = "form-signup"
)

// RecordSignup makes the subscriber store reflect one public signup and
// returns the stored subscriber after the write.
//
// When the address is new it creates the subscriber — unconfirmed, without
// consent, attributed to the capturing form — the way every other capture
// path does: canonical address row, subscriber.created webhook, audit row and
// engine-sync intent in one transaction. It never edits an existing profile.
// A public form is not the workspace's word on anybody's name, tags or fields,
// and Upsert's replace semantics would wipe them.
//
// It then grants email consent when the capture carries it, through the same
// consent path an operator's status=enabled change takes, so the immutable
// consent event, the structured proof, the purpose projection, the webhooks
// and the engine sync move together. Who a capture may enable:
//   - an unconfirmed subscriber, by any capture;
//   - a disabled or blocklisted one (unsubscribed, bounced, complained) only
//     by a MailboxVerified capture, because an unauthenticated form POST
//     naming someone's address must never reverse their opt-out;
//   - an enabled subscriber is left as it is.
//
// ErrErasureBlocked is returned for an address erased under a privacy
// request: a form does not re-create an erased person.
func (r *Repo) RecordSignup(ctx context.Context, tenantID string, in SignupCapture) (*Subscriber, error) {
	email, err := normalizeEmail(in.Email)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidInput, err.Error())
	}
	in.Email = email
	switch in.SignupSource = NormalizeSignupSource(in.SignupSource); in.SignupSource {
	case SignupSourceHostedPage, SignupSourceEmbeddedForm:
	default:
		in.SignupSource = SignupSourceUnknown
	}
	if parsed := net.ParseIP(strings.TrimSpace(in.SignupIP)); parsed != nil {
		in.SignupIP = parsed.String()
	} else {
		in.SignupIP = ""
	}
	sub, err := r.ensureSignupSubscriber(ctx, tenantID, in)
	if err != nil {
		return nil, err
	}
	if in.Consent == nil || !signupMayEnable(sub.Status, in.Consent.MailboxVerified) {
		return sub, nil
	}
	return r.grantSignupConsent(ctx, tenantID, sub, in)
}

// signupMayEnable is the re-enable policy RecordSignup documents.
func signupMayEnable(status string, mailboxVerified bool) bool {
	switch status {
	case StatusUnconfirmed:
		return true
	case StatusEnabled:
		return false
	default:
		return mailboxVerified
	}
}

// ensureSignupSubscriber creates the subscriber for a new address and returns
// the stored row either way.
func (r *Repo) ensureSignupSubscriber(ctx context.Context, tenantID string, in SignupCapture) (*Subscriber, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = rejectErasedAddress(ctx, tx, tenantID, in.Email); err != nil {
		return nil, err
	}
	first, last, full := signupNames(in.Name)
	// INSERT .. DO NOTHING, then read: a concurrent writer that created the
	// address first wins, and its profile is not touched.
	sub, err := scanSubscriber(tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status, consent_source,
    source_id, source_platform, signup_ip, signup_source,
    first_name, last_name, full_name, display_name
)
VALUES (
    $1::uuid, $2, $2, 'unconfirmed', 'non_subscribed', 'unknown',
    NULLIF($3, ''), $4, NULLIF($5, '')::inet, $6,
    $7, $8, $9, $9
)
ON CONFLICT (tenant_id, email) DO NOTHING
RETURNING `+subscriberColumns,
		tenantID, in.Email, in.SourceID, signupSourcePlatform, in.SignupIP, in.SignupSource,
		first, last, full))
	if errors.Is(err, pgx.ErrNoRows) {
		if sub, err = getInTx(ctx, tx, tenantID, in.Email); err != nil {
			return nil, err
		}
		if err = markEmailConsentAwaitingConfirmation(ctx, tx, tenantID, sub, in); err != nil {
			return nil, err
		}
		return sub, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	if _, err = ensureCanonicalSubscriberEmailForEvidenceInTx(ctx, tx, tenantID, sub); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEmailTaken
		}
		return nil, fmt.Errorf("ensure canonical subscriber email row: %w", err)
	}
	jurisdictionDrift, err := r.stampJurisdictionDriftInTx(ctx, tx, tenantID, sub)
	if err != nil {
		return nil, err
	}
	if err = r.fireUpsertWebhooksInTx(ctx, tx, tenantID, sub, true, jurisdictionDrift); err != nil {
		return nil, err
	}
	if err = db.Audit(ctx, tx, db.AuditMeta{
		TenantID:   tenantID,
		IP:         in.SignupIP,
		UserAgent:  in.UserAgent,
		ActorType:  "system",
		ActorLabel: signupAuditActor,
	}, "subscriber.created", "subscriber", sub.ID, map[string]any{
		"operation":     "form_signup",
		"signup_source": in.SignupSource,
		"source_id":     in.SourceID,
		"status":        sub.Status,
	}); err != nil {
		return nil, fmt.Errorf("audit form signup: %w", err)
	}
	if err = r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return nil, err
	}
	if err = markEmailConsentAwaitingConfirmation(ctx, tx, tenantID, sub, in); err != nil {
		return nil, err
	}
	// Re-read: the canonical-address and jurisdiction writes above can
	// advance the row, and the caller pins its consent grant to this version.
	stored, err := getInTx(ctx, tx, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	r.inferDemographicsPostCommit(ctx, tenantID, stored)
	r.scanPII(ctx, tenantID, stored)
	return stored, nil
}

// markEmailConsentAwaitingConfirmation records that a double opt-in signup is
// waiting on its confirmation link, so the profile's Consent tab says email
// consent is pending instead of leaving it at "unknown" — which reads as no
// signup having happened, on a profile that has one on file and an email in
// flight.
//
// It never contradicts a decision already on record: an address that had
// consented or opted out keeps that state, because an unauthenticated form
// POST naming somebody's address is not a reason to reopen or retract it. The
// grant itself still comes from the confirmation click, through the canonical
// evidence path.
func markEmailConsentAwaitingConfirmation(
	ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, in SignupCapture,
) error {
	if sub == nil || in.Consent != nil || !in.AwaitingConfirmation {
		return nil
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_channel_consents
       (tenant_id, subscriber_id, channel, status, consent_source, email)
VALUES ($1::uuid, $2::uuid, 'email', 'pending', $3, $4)
ON CONFLICT (tenant_id, subscriber_id, channel) DO UPDATE
   SET status = 'pending',
       consent_source = $3,
       updated_at = clock_timestamp()
 WHERE subscriber_channel_consents.status = 'unknown'`,
		tenantID, sub.ID, ConsentDoubleOptIn, sub.Email); err != nil {
		return fmt.Errorf("record email consent awaiting confirmation: %w", err)
	}
	return nil
}

// grantSignupConsent enables sub with the capture's consent evidence. The
// write is pinned to the version ensureSignupSubscriber read, so a status
// change that lands in between fails with ErrPreconditionFailed and the
// caller re-decides from the new state instead of overwriting it.
func (r *Repo) grantSignupConsent(ctx context.Context, tenantID string, sub *Subscriber, in SignupCapture) (*Subscriber, error) {
	enabled := StatusEnabled
	mailchimpSubscribed := "subscribed"
	source := in.Consent.Source
	occurredAt := in.Consent.OccurredAt.UTC()
	return r.UpdateWithAudit(ctx, tenantID, sub.ID, UpdateInput{
		IfMatchToken:         httpcache.ConcurrencyToken("subscriber", sub.ID, sub.UpdatedAt),
		Status:               &enabled,
		MailchimpStatus:      &mailchimpSubscribed,
		ConsentSource:        &source,
		ConsentTimestamp:     &occurredAt,
		ConsentChannel:       "web",
		ConsentLegalBasis:    "consent",
		ConsentJurisdiction:  signupConsentJurisdiction,
		ConsentEvidence:      in.Consent.Evidence,
		ConsentReason:        in.Consent.Reason,
		ConsentPolicyVersion: in.Consent.PolicyVersion,
	}, db.AuditMeta{
		IP:         in.SignupIP,
		UserAgent:  in.UserAgent,
		ActorType:  "system",
		ActorLabel: signupAuditActor,
	})
}

// signupNames splits a name typed into a single form field the way such a
// field is usually filled: the first word is the first name and the rest the
// last name. Whitespace runs collapse to one space.
func signupNames(name string) (first, last, full string) {
	full = strings.Join(strings.Fields(name), " ")
	first, last, _ = strings.Cut(full, " ")
	return first, last, full
}

// EmailWasErased reports whether the address was erased in this workspace
// under a privacy request: the email_suppressions tombstone every write that
// answers ErrErasureBlocked checks. A form's confirmation email is never sent
// to such an address.
func (r *Repo) EmailWasErased(ctx context.Context, tenantID, email string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	switch err := rejectErasedAddress(ctx, tx, tenantID, email); {
	case errors.Is(err, ErrErasureBlocked):
		return true, nil
	case err != nil:
		return false, err
	}
	return false, tx.Commit(ctx)
}
