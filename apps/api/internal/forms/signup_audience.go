// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

// AudienceWriter writes a form signup into the workspace's canonical
// audience: the subscriber, its email consent, and its list memberships —
// what Subscribers, a list's Members and every campaign audience read. The
// composition root implements it over the subscribers and lists repositories
// so this package depends on neither.
type AudienceWriter interface {
	RecordSignup(ctx context.Context, signup AudienceSignup) (AudienceResult, error)
}

// ErrAudienceRefused is returned by an AudienceWriter that will not record
// this address at all: it was erased under a privacy request, or it already
// belongs to a different subscriber profile. The submission stays on file,
// retrying cannot change the answer, and nothing may be written to Listmonk.
var ErrAudienceRefused = errors.New("forms: the audience refused this signup")

// AudienceSignup is one step of a form signup.
type AudienceSignup struct {
	TenantID     string
	FormID       string
	SubmissionID string
	Email        string
	Name         string
	// SignupSource is hosted_page, embedded_form, or "" when unknown.
	SignupSource string
	IP           string
	UserAgent    string
	// ListIDs are the Moosewave list UUIDs to join now. A double opt-in joins
	// its lists when it is confirmed, so they are empty until then.
	ListIDs []string
	// Consent is the email consent this step grants; nil grants none.
	Consent *AudienceConsent
	// AwaitingConfirmation reports a visitor who asked to subscribe on a
	// double opt-in form: consent is pending on the emailed link, which the
	// audience must record as such rather than leave the profile looking as
	// though nothing was ever asked.
	AwaitingConfirmation bool
}

// AudienceConsent is the evidence for the email consent a signup step grants.
type AudienceConsent struct {
	Method        string // single_optin | double_optin
	OccurredAt    time.Time
	Evidence      string
	Reason        string
	PolicyVersion string
	// MailboxVerified is true when the consent act proved control of the
	// mailbox — a click on the double opt-in link. Only a verified grant may
	// re-enable an address that unsubscribed, bounced or complained.
	MailboxVerified bool
}

// AudienceResult reports the audience state after a signup step.
type AudienceResult struct {
	// Subscribed reports that the subscriber can receive email marketing:
	// its status is enabled.
	Subscribed bool
	// NeedsMailboxProof reports an unverified grant that did not subscribe an
	// address because it had unsubscribed. Only verified consent (the double
	// opt-in click) may reverse that; a bounce or a complaint is never
	// reported here, because no email may go to that address.
	NeedsMailboxProof bool
}

// SignupAudience writes the audience state a committed public submission
// implies and projects it into Listmonk. It handles two outbox kinds:
// OutboxKindRecordSignup after a submission, and OutboxKindEnableListmonk
// after a double opt-in confirmation. Every step is idempotent, because the
// outbox redelivers on failure and can deliver twice.
//
// Moosewave is written first and decides what Listmonk gets: an address the
// audience refuses (an erased person) never reaches Listmonk, and the form
// writes Listmonk only for a subscriber Moosewave has enabled. A response that
// subscribed nobody (an unticked consent box, a double opt-in not yet
// confirmed, an address that opted out) leaves Listmonk to the canonical
// engine sync. Listmonk therefore never holds an unconfirmed subscription,
// which also keeps it from mailing its own opt-in request for a double
// opt-in list.
type SignupAudience struct {
	Repo     *Repo
	Audience AudienceWriter
	// Engines hands out the Listmonk engine this tenant's writes may use. It
	// is optional; nil skips the projection.
	Engines EngineResolver
	// Outbox queues the confirmation email for a single opt-in from an
	// address that had unsubscribed (see AudienceResult.NeedsMailboxProof).
	Outbox OutboxAppender
	Logger *slog.Logger
}

// ListmonkEngine is the part of the Listmonk client the projection uses.
type ListmonkEngine interface {
	CreateSubscriber(ctx context.Context, req listmonk.CreateSubscriberReq) (*listmonk.Subscriber, error)
	FindSubscriberByEmail(ctx context.Context, email string) (*listmonk.Subscriber, error)
	UpdateSubscriberAttribs(ctx context.Context, id int64, email string, attribs map[string]any) error
	UpdateSubscriberStatus(ctx context.Context, id int64, req listmonk.UpdateSubscriberStatusReq) error
	AddSubscribersToLists(ctx context.Context, subscriberIDs, listIDs []int64, status string) error
}

// EngineResolver acquires the Listmonk engine for one tenant, holding any
// tenancy proof until release is called. It must never hand out an engine
// whose subscribers other workspaces share: a form writes Listmonk by email
// address, so on a shared instance workspace B's form would edit and enable
// the subscriber workspace A synced for the same address. The composition
// root implements it over the subscribers package's resolver, the one every
// other Moosewave-to-Listmonk subscriber writer goes through.
type EngineResolver interface {
	AcquireEngine(ctx context.Context, tenantID string) (engine ListmonkEngine, release func(), err error)
}

// ErrEngineNotTenantScoped is returned by an EngineResolver that cannot prove
// the engine belongs to the tenant alone (a process-global Listmonk on a
// deployment with more than one workspace). The projection is skipped:
// Moosewave already holds the canonical signup.
var ErrEngineNotTenantScoped = errors.New("forms: no Listmonk engine is scoped to this workspace")

// RecordSubmitted handles OutboxKindRecordSignup.
func (h *SignupAudience) RecordSubmitted(ctx context.Context, tenantID string, rawPayload []byte) error {
	if err := h.configured(); err != nil {
		return err
	}
	var p signupRecordPayload
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return fmt.Errorf("decode signup payload: %w", err)
	}
	snap, err := h.Repo.signupSnapshot(ctx, tenantID, p.SubmissionID)
	if errors.Is(err, ErrNotFound) {
		// Deleted (as spam, with its form, or under a privacy request) before
		// this ran: there is nobody left to record.
		h.log().InfoContext(ctx, "forms: signup submission no longer exists; nothing to record",
			"tenant_id", tenantID, "submission_id", p.SubmissionID)
		return nil
	}
	if err != nil {
		return err
	}
	signup := snap.audienceSignup()
	joining := p.Subscribe && p.Consent != nil
	// Asked to subscribe with no consent to grant yet: the confirmation email
	// queued in the same transaction as the submission is what will grant it.
	signup.AwaitingConfirmation = p.Subscribe && p.Consent == nil
	if joining {
		signup.ListIDs = snap.listIDs()
		signup.Consent = &AudienceConsent{
			Method:        p.Consent.Method,
			OccurredAt:    p.Consent.OccurredAt,
			Evidence:      p.Consent.Evidence,
			Reason:        singleOptInReason,
			PolicyVersion: formSignupConsentPolicy,
		}
	}
	result, err := h.record(ctx, signup)
	if err != nil || result == nil {
		return err
	}
	if joining && result.NeedsMailboxProof {
		// The address had unsubscribed, and a form POST that anyone could
		// have sent does not undo that. The owner of the mailbox can: the
		// submission becomes pending and gets the confirmation email a double
		// opt-in sends. The visitor's answer was given at submit time and is
		// the same either way, so it reveals nothing about the address.
		return h.Repo.requireMailboxProof(ctx, tenantID, snap.FormID, snap.SubmissionID, h.Outbox)
	}
	if !result.Subscribed {
		return nil
	}
	var intent engineIntent
	if joining {
		intent.ListIDs = snap.engineListIDs()
	}
	return h.projectToEngine(ctx, snap, intent)
}

// RecordConfirmed handles OutboxKindEnableListmonk: the visitor clicked the
// double opt-in link, which is verified consent to join the lists they
// signed up to.
func (h *SignupAudience) RecordConfirmed(ctx context.Context, tenantID string, rawPayload []byte) error {
	if err := h.configured(); err != nil {
		return err
	}
	var p confirmPayload
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return fmt.Errorf("decode confirmation payload: %w", err)
	}
	submissionID := p.SubmissionID
	if submissionID == "" {
		// Written before migration 2049: the row named the address.
		id, err := h.Repo.latestConfirmedSubmissionID(ctx, tenantID, p.FormID, p.Email)
		if errors.Is(err, ErrNotFound) {
			h.log().InfoContext(ctx, "forms: confirmed submission no longer exists; nothing to record",
				"tenant_id", tenantID, "form_id", p.FormID)
			return nil
		}
		if err != nil {
			return err
		}
		submissionID = id
	}
	snap, err := h.Repo.signupSnapshot(ctx, tenantID, submissionID)
	if errors.Is(err, ErrNotFound) {
		h.log().InfoContext(ctx, "forms: confirmed submission no longer exists; nothing to record",
			"tenant_id", tenantID, "submission_id", submissionID)
		return nil
	}
	if err != nil {
		return err
	}
	if snap.Status != SubmissionConfirmed || snap.ConfirmedAt == nil {
		// Unsubscribed through the submission after confirming: the later
		// decision stands.
		h.log().InfoContext(ctx, "forms: submission is no longer confirmed; not subscribing",
			"tenant_id", tenantID, "submission_id", submissionID, "status", snap.Status)
		return nil
	}
	signup := snap.audienceSignup()
	signup.ListIDs = snap.listIDs()
	signup.Consent = &AudienceConsent{
		Method:          consentMethodDoubleOptIn,
		OccurredAt:      *snap.ConfirmedAt,
		Evidence:        doubleOptInEvidence(snap.FormName, snap.FormID, snap.SubmittedAt),
		Reason:          doubleOptInReason,
		PolicyVersion:   formSignupConsentPolicy,
		MailboxVerified: true,
	}
	result, err := h.record(ctx, signup)
	if err != nil || result == nil || !result.Subscribed {
		return err
	}
	return h.projectToEngine(ctx, snap, engineIntent{ListIDs: snap.engineListIDs(), Verified: true})
}

// record runs the audience write. A refusal is final and logged; it returns a
// nil result so the caller skips the Listmonk projection.
func (h *SignupAudience) record(ctx context.Context, signup AudienceSignup) (*AudienceResult, error) {
	result, err := h.Audience.RecordSignup(ctx, signup)
	if errors.Is(err, ErrAudienceRefused) {
		h.log().WarnContext(ctx, "forms: the audience refused a signup; it stays a submission only",
			"tenant_id", signup.TenantID, "form_id", signup.FormID,
			"submission_id", signup.SubmissionID, "err", err)
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("record form signup in the audience: %w", err)
	}
	return &result, nil
}

// engineIntent is what the Listmonk projection of an enabled subscriber must
// converge to.
type engineIntent struct {
	// ListIDs are the Listmonk lists to hold a confirmed subscription to.
	ListIDs []int64
	// Verified reports a double opt-in click: fresh consent from the owner of
	// the mailbox. Only a verified signup may reverse an earlier unsubscribe
	// or blocklist, or edit a subscriber Listmonk already held.
	Verified bool
}

// projectToEngine creates or updates the Listmonk subscriber of a signup that
// Moosewave enabled, so it matches the audience write.
func (h *SignupAudience) projectToEngine(ctx context.Context, snap *signupSnapshot, intent engineIntent) error {
	if h.Engines == nil {
		return nil
	}
	engine, release, err := h.Engines.AcquireEngine(ctx, snap.TenantID)
	if errors.Is(err, ErrEngineNotTenantScoped) {
		h.log().InfoContext(ctx, "forms: Listmonk is shared with other workspaces; the signup is recorded in the audience only",
			"tenant_id", snap.TenantID, "submission_id", snap.SubmissionID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("acquire the workspace's Listmonk engine: %w", err)
	}
	defer release()
	return projectSignup(ctx, engine, snap, intent, h.log())
}

// projectSignup creates or converges the Listmonk subscriber through an
// engine the caller holds for the snapshot's tenant.
func projectSignup(ctx context.Context, engine ListmonkEngine, snap *signupSnapshot, intent engineIntent, logger *slog.Logger) error {
	attribs := snap.engineAttribs()
	_, err := engine.CreateSubscriber(ctx, listmonk.CreateSubscriberReq{
		Email:                   snap.Email,
		Name:                    snap.Name,
		Status:                  listmonk.SubscriberEnabled,
		Lists:                   intent.ListIDs,
		Attribs:                 attribs,
		PreconfirmSubscriptions: len(intent.ListIDs) > 0,
	})
	var decodeErr *listmonk.DecodeError
	var upstream *listmonk.HTTPError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &decodeErr):
		// Listmonk created the subscriber; only its answer was unreadable.
		logger.WarnContext(ctx, "forms: Listmonk accepted a subscriber but its response could not be decoded",
			"tenant_id", snap.TenantID, "submission_id", snap.SubmissionID, "err", err)
		return nil
	case errors.As(err, &upstream) && upstream.IsConflict():
		return updateEngineSubscriber(ctx, engine, snap, intent, attribs)
	default:
		return fmt.Errorf("create the Listmonk subscriber: %w", err)
	}
}

// updateEngineSubscriber converges a subscriber Listmonk already holds. A
// create never adds lists to an existing address, so this is the path every
// re-submission, retargeted form and second form takes.
//
// What the visitor typed replaces the stored name and attributes only on a
// verified signup. An unverified POST can name anyone's address, and a public
// form never edits an existing profile (subscribers.Repo.RecordSignup), so
// the canonical engine sync stays the only writer of an existing
// subscriber's attributes.
func updateEngineSubscriber(ctx context.Context, engine ListmonkEngine, snap *signupSnapshot, intent engineIntent, attribs map[string]any) error {
	existing, err := engine.FindSubscriberByEmail(ctx, snap.Email)
	if err != nil {
		return fmt.Errorf("find the existing Listmonk subscriber: %w", err)
	}
	if existing == nil || existing.ID <= 0 {
		return errors.New("listmonk reported the address exists but returned no subscriber for it")
	}
	if intent.Verified {
		if err := engine.UpdateSubscriberAttribs(ctx, existing.ID, existing.Email, attribs); err != nil {
			return fmt.Errorf("merge form fields into the Listmonk subscriber: %w", err)
		}
	}
	if existing.Status == listmonk.SubscriberBlocklisted && !intent.Verified {
		// Listmonk blocklisted the address (a bounce, a complaint, an
		// unsubscribe). An unverified form POST does not undo that.
		return nil
	}
	if existing.Status != listmonk.SubscriberEnabled {
		if err := engine.UpdateSubscriberStatus(ctx, existing.ID, listmonk.UpdateSubscriberStatusReq{
			Email:  existing.Email,
			Status: listmonk.SubscriberEnabled,
		}); err != nil {
			return fmt.Errorf("enable the Listmonk subscriber: %w", err)
		}
	}
	add := listsToConfirm(existing, intent.ListIDs, intent.Verified)
	if err := engine.AddSubscribersToLists(ctx, []int64{existing.ID}, add, listmonk.SubscriptionConfirmed); err != nil {
		return fmt.Errorf("subscribe the Listmonk subscriber to the form's lists: %w", err)
	}
	return nil
}

// listsToConfirm picks the lists that need a confirmed subscription written.
// Listmonk's add overwrites an existing subscription's status, so an
// "unsubscribed" one is only included when the signup is verified: a
// double opt-in click is fresh consent, a form POST naming someone's address
// is not.
func listsToConfirm(sub *listmonk.Subscriber, listIDs []int64, verified bool) []int64 {
	var out []int64
	for _, id := range listIDs {
		current, ok := sub.Subscription(id)
		switch {
		case !ok, current.SubscriptionStatus == listmonk.SubscriptionUnconfirmed:
			out = append(out, id)
		case current.SubscriptionStatus == listmonk.SubscriptionUnsubscribed && verified:
			out = append(out, id)
		}
	}
	return out
}

func (h *SignupAudience) configured() error {
	if h == nil || h.Repo == nil || h.Audience == nil {
		return errors.New("forms: signup audience handler is not configured")
	}
	return nil
}

func (h *SignupAudience) log() *slog.Logger {
	if h.Logger != nil {
		return h.Logger
	}
	return slog.Default()
}

// signupSnapshot is a committed submission as the audience write needs it.
type signupSnapshot struct {
	TenantID     string
	FormID       string
	FormName     string
	SubmissionID string
	Email        string
	Name         string
	Status       SubmissionStatus
	IP           string
	UserAgent    string
	SignupSource string
	CustomFields map[string]string
	SubmittedAt  time.Time
	ConfirmedAt  *time.Time
	// Lists are the submission's target lists that are still the workspace's.
	Lists []TargetList
}

func (s *signupSnapshot) audienceSignup() AudienceSignup {
	return AudienceSignup{
		TenantID:     s.TenantID,
		FormID:       s.FormID,
		SubmissionID: s.SubmissionID,
		Email:        s.Email,
		Name:         s.Name,
		SignupSource: s.SignupSource,
		IP:           s.IP,
		UserAgent:    s.UserAgent,
	}
}

func (s *signupSnapshot) listIDs() []string {
	out := make([]string, 0, len(s.Lists))
	for _, list := range s.Lists {
		out = append(out, list.ListID)
	}
	return out
}

func (s *signupSnapshot) engineListIDs() []int64 {
	out := make([]int64, 0, len(s.Lists))
	for _, list := range s.Lists {
		out = append(out, list.EngineID)
	}
	return out
}

// engineAttribs is what Listmonk stores as the subscriber's attributes: the
// form's custom fields and the visitor's name.
func (s *signupSnapshot) engineAttribs() map[string]any {
	out := make(map[string]any, len(s.CustomFields)+1)
	for key, value := range s.CustomFields {
		out[key] = value
	}
	if s.Name != "" {
		out["name"] = s.Name
	}
	return out
}
