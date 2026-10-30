// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/transactional"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// formSignupListSource is the list-membership source a form signup writes.
// Its owner key ("form:<id>") names the form, so a membership the form added
// is told apart from — and never removes — one an operator, an import or an
// integration added for the same address.
const formSignupListSource = "form"

// newFormsSignupAudience builds the handler for both form audience kinds. The
// lists repository carries the canonical membership webhook fanout, so a form
// signup fires list.subscriber_added like every other membership writer.
// engines is the resolver the canonical subscriber sync uses: a form signup
// reaches Listmonk only under the same tenancy proof.
func newFormsSignupAudience(pool *db.Pool, subscriberRepo *subscribers.Repo, webhooksDispatcher *webhooks.Dispatcher, engines subscribers.EngineResolver, outboxRepo *outbox.Repo, logger *slog.Logger) *forms.SignupAudience {
	listsRepo := &lists.Repo{Pool: pool}
	if webhooksDispatcher != nil {
		listsRepo.MembershipWebhooks = newListMembershipWebhookAdapter(webhooksDispatcher.Canonical)
	}
	audience := &forms.SignupAudience{
		Repo:     &forms.Repo{Pool: pool},
		Audience: formsAudienceWriter{subscribers: subscriberRepo, lists: listsRepo},
		Logger:   logger,
	}
	if outboxRepo != nil {
		audience.Outbox = newFormsOutboxAdapter(outboxRepo)
	}
	if engines != nil {
		audience.Engines = formsEngineResolver{resolver: engines}
	}
	return audience
}

// formsEngineResolver lends the form signup projection the Listmonk engine of
// a subscribers.EngineResolver lease, so it passes the same tenancy proof as
// every other subscriber writer: the process-global client is refused unless
// the deployment holds exactly this one tenant.
type formsEngineResolver struct {
	resolver subscribers.EngineResolver
}

func (r formsEngineResolver) AcquireEngine(ctx context.Context, tenantID string) (forms.ListmonkEngine, func(), error) {
	lease, err := r.resolver.Acquire(ctx, tenantID)
	if errors.Is(err, subscribers.ErrGlobalEngineRequiresSingleTenant) {
		return nil, nil, forms.ErrEngineNotTenantScoped
	}
	if err != nil {
		return nil, nil, err
	}
	if lease == nil {
		return nil, nil, errors.New("the subscriber engine resolver returned no lease")
	}
	engine, ok := lease.Engine().(forms.ListmonkEngine)
	if !ok {
		_ = lease.Close()
		return nil, nil, errors.New("the workspace's Listmonk engine cannot manage list subscriptions")
	}
	return engine, func() { _ = lease.Close() }, nil
}

// registerFormsSignupHandlers registers the three outbox kinds a public form
// produces: the signup recorded with every submission, the confirmation
// email, and the double opt-in confirmation. The confirmation email is sent
// by the form handlers' dependencies, which main builds after the outbox
// worker starts; bind them to the returned delivery once they are complete.
func registerFormsSignupHandlers(registry *outbox.Registry, audience *forms.SignupAudience) *formsConfirmationDelivery {
	registry.Register(forms.OutboxKindRecordSignup, func(ctx context.Context, ev outbox.Event) error {
		return audience.RecordSubmitted(ctx, ev.TenantID, ev.Payload)
	})
	registry.Register(forms.OutboxKindEnableListmonk, func(ctx context.Context, ev outbox.Event) error {
		return audience.RecordConfirmed(ctx, ev.TenantID, ev.Payload)
	})
	delivery := &formsConfirmationDelivery{}
	registry.Register(forms.OutboxKindSendConfirmation, delivery.handle)
	return delivery
}

// validateProductionFormsPublicHost refuses to start a production API whose
// FORMS_PUBLIC_HOST no visitor can open. Every double opt-in email links to
// it, and when the variable is unset it defaults to http://localhost:3000, a
// link that works on the developer's machine and nowhere else.
func validateProductionFormsPublicHost(raw string) error {
	if !isProductionEnv() {
		return nil
	}
	refuse := fmt.Errorf("FORMS_PUBLIC_HOST must be the public https origin of the hosted forms in production (for example https://forms.example.com); %q is not, so every double opt-in link would be unusable", raw)
	base, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || base.Scheme != "https" || base.Hostname() == "" || base.User != nil ||
		(base.Path != "" && base.Path != "/") || base.RawQuery != "" || base.Fragment != "" {
		return refuse
	}
	host := strings.ToLower(strings.TrimSuffix(base.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return refuse
	}
	if ip := net.ParseIP(host); ip != nil &&
		(ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		return refuse
	}
	return nil
}

// wireFormsConfirmations gives the form handlers what the double opt-in email
// needs and then publishes them to the outbox worker. Confirmations ride the
// outbound mailer but never the account-mail sender: a form's own sender must
// be on a domain its workspace verified (the transactional API's check), and
// the standard one is the dedicated FORMS_CONFIRMATION_FROM address.
func wireFormsConfirmations(deps *forms.Deps, delivery *formsConfirmationDelivery, outbound mailer.Mailer, cfg config.Config, pool *db.Pool, subscriberRepo *subscribers.Repo, logger *slog.Logger) {
	deps.ConfirmationMailer, deps.ConfirmationFrom = outbound, cfg.FormsConfirmationFrom
	deps.SenderVerifier = &transactional.SendingIdentityVerifier{Pool: pool}
	deps.RecipientGuard = formsConfirmationRecipientGuard{
		subscribers:  subscriberRepo,
		suppressions: suppressions.NewConverger(&suppressions.Store{Pool: pool}, logger),
	}
	delivery.bind(deps)
}

// formsConfirmationDelivery hands OutboxKindSendConfirmation to the form
// handlers' dependencies once they are bound. Until then the event fails and
// the outbox retries it: a confirmation email is never dropped because the
// worker started first.
type formsConfirmationDelivery struct {
	deps atomic.Pointer[forms.Deps]
}

// bind publishes deps to the outbox worker. Call it after every field the
// delivery reads (mailer, senders, recipient guard) is set.
func (b *formsConfirmationDelivery) bind(deps *forms.Deps) {
	b.deps.Store(deps)
}

func (b *formsConfirmationDelivery) handle(ctx context.Context, ev outbox.Event) error {
	deps := b.deps.Load()
	if deps == nil {
		return errors.New("forms: confirmation email delivery is not wired yet")
	}
	return deps.DeliverConfirmation(ctx, ev.TenantID, ev.Payload, forms.DeliveryAttempt{Number: ev.Attempts, Max: ev.MaxAttempts})
}

// formsConfirmationRecipientGuard decides who may be sent a form's
// confirmation email. An erased address never is. Neither is one the
// workspace suppressed for a hard bounce, a complaint, a spam trap or an
// invalid mailbox. An opt-out (an unsubscribe of any kind) does not block it:
// the confirmation is how that person asks to come back, and the address is
// mailed only because someone just submitted it to the form.
type formsConfirmationRecipientGuard struct {
	subscribers  *subscribers.Repo
	suppressions *suppressions.SuppressionConverger
}

func (g formsConfirmationRecipientGuard) MayMailConfirmation(ctx context.Context, tenantID, email string) (bool, error) {
	if g.subscribers == nil || g.suppressions == nil {
		return false, errors.New("the confirmation recipient guard is not configured")
	}
	erased, err := g.subscribers.EmailWasErased(ctx, tenantID, email)
	if err != nil || erased {
		return false, err
	}
	suppressed, entry, err := g.suppressions.Check(ctx, tenantID, email, suppressions.ChannelEmail, suppressions.ScopeMarketing)
	if err != nil {
		return false, err
	}
	return !suppressed || (entry != nil && optOutReopenedByConfirmation(entry.Reason)), nil
}

// legacyUnsubscribeReason is the reason email_suppressions rows written before
// the suppressions vocabulary carry for an unsubscribe.
const legacyUnsubscribeReason suppressions.Reason = "unsubscribe"

// optOutReopenedByConfirmation reports a suppression that records the
// person's own choice to stop receiving mail, which their confirmation click
// may reverse.
func optOutReopenedByConfirmation(reason suppressions.Reason) bool {
	switch reason {
	case suppressions.ReasonManualUnsubscribe, suppressions.ReasonListManual,
		suppressions.ReasonGlobalUnsubscribe, suppressions.ReasonListUnsubHeader,
		legacyUnsubscribeReason:
		return true
	}
	return false
}

// formsAudienceWriter writes a form signup into the canonical audience: the
// subscriber and its consent through subscribers.Repo.RecordSignup, then each
// list membership through the owned list writer.
type formsAudienceWriter struct {
	subscribers *subscribers.Repo
	lists       *lists.Repo
}

func (w formsAudienceWriter) RecordSignup(ctx context.Context, signup forms.AudienceSignup) (forms.AudienceResult, error) {
	if w.subscribers == nil || w.lists == nil {
		return forms.AudienceResult{}, errors.New("form signup audience writer is not configured")
	}
	capture := subscribers.SignupCapture{
		Email:                signup.Email,
		Name:                 signup.Name,
		SignupSource:         signup.SignupSource,
		SourceID:             signup.FormID,
		SignupIP:             signup.IP,
		UserAgent:            signup.UserAgent,
		AwaitingConfirmation: signup.AwaitingConfirmation,
	}
	if consent := signup.Consent; consent != nil {
		capture.Consent = &subscribers.SignupConsent{
			Source:          consent.Method,
			OccurredAt:      consent.OccurredAt,
			Evidence:        consent.Evidence,
			Reason:          consent.Reason,
			PolicyVersion:   consent.PolicyVersion,
			MailboxVerified: consent.MailboxVerified,
		}
	}
	sub, err := w.subscribers.RecordSignup(ctx, signup.TenantID, capture)
	switch {
	case errors.Is(err, subscribers.ErrErasureBlocked), errors.Is(err, subscribers.ErrEmailTaken):
		return forms.AudienceResult{}, fmt.Errorf("%w: %w", forms.ErrAudienceRefused, err)
	case err != nil:
		return forms.AudienceResult{}, fmt.Errorf("record the form signup's subscriber: %w", err)
	}
	// Joined after the consent grant, so a "joined list" flow that the
	// membership starts sees a subscriber it may already email.
	for _, listID := range signup.ListIDs {
		if _, err := w.lists.AddEmailToListOwned(ctx, signup.TenantID, listID, sub.Email, lists.ListMembershipOwner{
			Source:    formSignupListSource,
			OwnerKey:  "form:" + signup.FormID,
			SourceRef: signup.SubmissionID,
		}); err != nil {
			return forms.AudienceResult{}, fmt.Errorf("add the form signup to its list: %w", err)
		}
	}
	return forms.AudienceResult{
		Subscribed: sub.Status == subscribers.StatusEnabled,
		// Disabled is the status an unsubscribe leaves; a bounce or complaint
		// blocklists the address instead, and no confirmation may go to it.
		NeedsMailboxProof: capture.Consent != nil && !capture.Consent.MailboxVerified &&
			sub.Status == subscribers.StatusDisabled,
	}, nil
}
