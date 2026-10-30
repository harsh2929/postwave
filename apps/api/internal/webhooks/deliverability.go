// Deliverability webhook receivers — Postmark, Mailgun, SES, SendGrid,
// Resend, SparkPost, and MailerSend.
//
// This file owns the shared inbound delivery, bounce, and engagement loop.
// Each provider lands here through its dedicated authenticated handler where:
//
//   1. Provider signature verification runs FIRST. We never parse a
//      payload we haven't authenticated. Each provider has its own
//      shape — Postmark uses an account-wide HMAC token in a header,
//      Mailgun signs `timestamp + token` with the webhook signing key,
//      SES wraps everything in an SNS envelope whose `Signature` field
//      cryptographically binds to the SNS message canonical form, and the
//      remaining handlers require the configured trusted-edge token.
//
//   2. Tenant resolution. Like the existing feedback pipeline, we
//      resolve the tenant via esp_message_id lookup with TenantHeader
//      as a fallback when the receiver is provisioned per-tenant.
//
//   3. Event classification. Delivery, bounce, complaint, unsubscribe, and
//      raw engagement facts append to subscriber_events. Hard failures also
//      enforce suppression. Transactional mailbox outcomes project through
//      feedback; only delivered/bounced/complained can reach outbound email.*
//      fanout. Open/click instead pass through engagementclassification.
//
//   4. Idempotency. A provider event id is kept distinct from the provider
//      message id. When the payload has no event id, we derive a stable,
//      privacy-safe digest from the signed event facts. The resulting key is
//      passed to suppressions.Store.Add and subscriber_event_dedup_keys so
//      webhook re-deliveries collapse without merging separate messages.
//
// Why this lives in webhooks/ alongside the OUTBOUND dispatcher: the
// scope assignment for the deliverability agent puts inbound provider
// receivers in apps/api/internal/webhooks/. The legacy feedback/
// package handles the bounce+complaint half via a different table
// (campaign_report_events) and stays as-is for the Mailchimp-compat
// surface.

package webhooks

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/feedback"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// DeliverabilityDeps bundles the runtime config for the seven provider
// receivers. Each *Secret is required unless AllowUnsignedDevBypass is
// set; with bypass off (production) a missing secret hard-fails the
// inbound request rather than silently accepting an unsigned payload.
// TransactionalEngagementClassifier mirrors the listmonk_events contract so one
// runtime serves both ingest paths.
//
// Declared here rather than imported so this package keeps its narrow dependency
// surface; the shape is checked by the wiring guard, not by a shared type.
type TransactionalEngagementClassifier interface {
	RecordProviderEvent(
		context.Context,
		pgx.Tx,
		string,
		engagementclassification.ProviderEventInput,
	) error
}

type TransactionalCampaignReportProjector interface {
	ProjectCanonicalEvent(
		context.Context,
		pgx.Tx,
		string,
		campaignreportprojection.CanonicalEvent,
	) error
}

// TransactionalOutcomeProjector is implemented by feedback.Repo, the current
// owner of recipient-level transactional outcomes. The caller supplies its
// transaction so the canonical event, classification evidence, outcome, and
// outbound webhook intent share one commit.
type TransactionalOutcomeProjector interface {
	ProjectTransactionalOutcome(
		context.Context,
		pgx.Tx,
		string,
		feedback.TransactionalProviderOutcome,
	) error
}

type DeliverabilityDeps struct {
	Pool *db.Pool
	// EngagementClassifier records the raw observation + classification for
	// events arriving on the SEVEN ESP webhooks.
	//
	// Without this, only the Listmonk path wrote observations, so
	// "any derived layer can be rebuilt from raw_event" — the PRD's §19
	// reclassification guarantee — was true for one writer out of several. A
	// monthly rebuild would have silently produced a partial corpus, and a
	// partial corpus is worse than none: the numbers come out lower and nothing
	// says why.
	EngagementClassifier TransactionalEngagementClassifier
	// CampaignReportProjector materializes eligible provider feedback in the
	// compatibility report ledger atomically with subscriber_events. nil keeps
	// the provider path canonical-only while the explicit projection gate is off.
	CampaignReportProjector TransactionalCampaignReportProjector
	Suppressions            *suppressions.Store
	PostmarkToken           string   // shared X-Postmark-Token (account-wide)
	MailgunKey              string   // Mailgun webhook signing key
	SESTopicARNs            []string // allow-list of SNS topic ARNs that may post
	SendGridToken           string   // shared edge token for SendGrid event webhooks
	ResendToken             string   // shared edge token for Resend event webhooks
	SparkPostToken          string   // shared edge token for SparkPost event webhooks
	MailerSendToken         string   // shared edge token for MailerSend event webhooks

	// AllowUnsignedDevBypass disables verification entirely. NEVER set
	// in production — main.go gates this on the same env flag the
	// other inbound receivers use, and the production-mode preflight
	// in main.go refuses to start with bypass on.
	//
	// DEPRECATED for SES: prefer AllowUnverifiedSignatures, which is
	// hard-gated on !isProductionEnvForWebhooks() so a misconfigured
	// production deploy can never accept an unverified payload.
	// AllowUnsignedDevBypass is retained for the Postmark + Mailgun
	// receivers and is honoured by SES only when not in production.
	AllowUnsignedDevBypass bool

	// AllowUnverifiedSignatures, when true AND when the runtime is not
	// production (POSTWAVE_ENV / ENVIRONMENT / NODE_ENV all unset or
	// non-production), skips RSA verification on SES payloads. Every
	// bypass logs a slog.Warn carrying the SNS MessageId + TopicArn so
	// a misconfigured prod deploy is auditable in the access log.
	AllowUnverifiedSignatures bool

	// Now overrides time.Now for deterministic tests of the replay
	// window check on Mailgun timestamps.
	Now func() time.Time

	// TenantResolver maps a provider message-id to a tenant. Reuses the
	// same lookup the feedback pipeline uses (esp_message_id →
	// tenant). Falls back to the X-Postwave-Tenant header.
	TenantResolver TenantResolver
	// TransactionalOutcomes is optional for tests and alternate compositions.
	// Production needs no second wiring site: its TenantResolver is the same
	// feedback.Repo that implements this interface, and transactionalProjector
	// discovers that capability below.
	TransactionalOutcomes TransactionalOutcomeProjector

	Logger *slog.Logger
}

// TenantResolver is the slim interface we depend on for tenant
// resolution. Defined here so the receiver tests can stub it without
// pulling in a database.
type TenantResolver interface {
	LookupTenantByESPMessageID(ctx context.Context, messageID string) (string, error)
}

// DeliverabilityTenantHeader is the fallback tenant id header used
// when the inbound payload doesn't carry an esp_message_id we can map.
// Operators set this on the edge proxy when each provider webhook URL
// is dedicated to a single tenant.
const DeliverabilityTenantHeader = "X-Postwave-Tenant"

// MailgunReplayWindow bounds how stale a Mailgun-signed timestamp can
// be before we reject the request as a replay. Aligns with the rest
// of the inbound HMAC surface.
const MailgunReplayWindow = 5 * time.Minute

// MailgunSignatureHeaderTimestamp is unused on the JSON-body Mailgun
// webhook (timestamp + token + signature live in the body's
// `signature` object); kept as a named constant only so the legacy
// form-encoded webhook variant can pick it up later if we add it.
const (
	MailgunSignatureHeaderTimestamp = "X-Mailgun-Timestamp"
)

func (d *DeliverabilityDeps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d *DeliverabilityDeps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// resolveTenant performs the same shape as feedback.resolveTenant:
// esp_message_id lookup first, header fallback. Empty return means we
// could not identify a tenant; the caller MUST refuse to record the
// event in that case (no global suppression list).
func (d *DeliverabilityDeps) resolveTenant(ctx context.Context, r *http.Request, espMessageID string) string {
	if d.TenantResolver != nil && espMessageID != "" {
		if id, err := d.TenantResolver.LookupTenantByESPMessageID(ctx, espMessageID); err == nil && id != "" {
			return id
		} else if err != nil {
			d.log().Warn("deliverability: tenant lookup by esp_message_id failed", "err", err.Error())
		}
	}
	return strings.TrimSpace(r.Header.Get(DeliverabilityTenantHeader))
}

func providerCorrelationNeedsRetry(ev classifyOutcome) bool {
	return strings.TrimSpace(ev.MessageID) != "" && transactionalOutcomeFor(ev) != ""
}

func rejectDeliveryWithoutMessageID(w http.ResponseWriter, ev classifyOutcome) bool {
	if ev.EventType != "delivered" || strings.TrimSpace(ev.MessageID) != "" {
		return false
	}
	writeJSONErrDeliv(w, http.StatusBadRequest, "provider_message_id_required",
		"delivery event is missing its provider message identity")
	return true
}

func writeRetryableProviderCorrelation(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "30")
	writeJSONErrDeliv(w, http.StatusServiceUnavailable, "provider_correlation_pending",
		"provider message correlation is not committed yet; retry the event")
}

func (d *DeliverabilityDeps) writeProviderProcessError(
	w http.ResponseWriter,
	r *http.Request,
	err error,
) {
	if errors.Is(err, feedback.ErrProviderMessageCorrelationPending) {
		writeRetryableProviderCorrelation(w)
		return
	}
	httperror.WriteInternal(w, d.log(), err, r.Context())
}

// classifyOutcome is the small union returned by the per-provider
// parsers so the event-fan-out below can stay provider-agnostic.
type classifyOutcome struct {
	Email       string
	Recipients  []string // every recipient for message-level delivery events
	CampaignID  string   // optional server-bound campaign UUID
	EventType   string   // 'delivered', 'bounced', 'complained', 'unsubscribed', 'opened', 'clicked'
	BounceClass string   // 'hard', 'soft', '' (empty when not a bounce)
	// BounceCategory (SUB-048) is the fine-grained sub-classification a
	// provider parser can set when the bounce code / diagnostic reveals a
	// spamtrap hit, role account, DNS failure, or invalid address. Empty
	// means "fall back to the coarse hard/soft classification". When set
	// on a hard bounce, process() routes the suppression through the
	// matching Klaviyo-parity reason instead of the generic hard_bounce.
	BounceCategory suppressions.BounceCategory
	ProviderID     string // provider event/webhook identity used for replay deduplication
	MessageID      string // provider message identity used for tenant/send/seed correlation
	ProviderName   suppressions.Source
	Reason         string // free-text diagnostic for metadata
	Raw            json.RawMessage
	OccurredAt     time.Time
	DeliveredAt    *time.Time
	// Engagement evidence is a deliberately bounded projection of provider
	// fields. Raw provider payloads and plaintext clicked URLs never cross the
	// classification boundary; Runtime commits recipient/message/link identity
	// before persistence and applies its privacy expiry.
	LinkIdentity    string
	UserAgent       string
	IP              string
	ProviderSignals map[string]any
}

// ensureProviderEventID gives providers without an in-body event id a stable
// replay key. The compound follows the provider guidance used by Postmark:
// message + recipient + kind + occurrence time, with clicked-link identity
// included so two distinct clicks at the same timestamp do not collapse. The
// digest prevents a recipient or URL from leaking into the dedup ledger.
func ensureProviderEventID(ev *classifyOutcome) {
	if ev == nil || strings.TrimSpace(ev.ProviderID) != "" || ev.OccurredAt.IsZero() ||
		strings.TrimSpace(ev.MessageID) == "" || strings.TrimSpace(ev.Email) == "" ||
		strings.TrimSpace(ev.EventType) == "" || strings.TrimSpace(string(ev.ProviderName)) == "" {
		return
	}
	material := strings.Join([]string{
		strings.TrimSpace(string(ev.ProviderName)),
		strings.TrimSpace(ev.MessageID),
		strings.ToLower(strings.TrimSpace(ev.Email)),
		strings.TrimSpace(ev.EventType),
		ev.OccurredAt.UTC().Format(time.RFC3339Nano),
		strings.TrimSpace(ev.LinkIdentity),
	}, "\x00")
	digest := sha256.Sum256([]byte(material))
	ev.ProviderID = "derived:" + hex.EncodeToString(digest[:])
}

func uniqueProviderRecipients(recipients []string) []string {
	seen := make(map[string]struct{}, len(recipients))
	unique := make([]string, 0, len(recipients))
	for _, recipient := range recipients {
		recipient = strings.TrimSpace(recipient)
		key := strings.ToLower(recipient)
		if recipient == "" {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, recipient)
	}
	return unique
}

// process is the shared post-classification fan-out. Every supported provider
// fact appends to subscriber_events. Hard bounces, complaints, and
// unsubscribes additionally hit suppressions.Store.Add; soft bounces also trip
// the threshold check. Transactional mailbox outcomes and public fanout are
// projected by appendEvent in the same transaction as the canonical fact.
func (d *DeliverabilityDeps) process(ctx context.Context, tenantID string, ev classifyOutcome) error {
	if tenantID == "" {
		return errors.New("process: empty tenant id")
	}
	if ev.Email == "" {
		return errors.New("process: empty email")
	}
	ensureProviderEventID(&ev)
	now := d.now()
	controlledSeed, err := d.isControlledSeedEvent(ctx, tenantID, ev.MessageID)
	if err != nil {
		return fmt.Errorf("resolve controlled seed origin: %w", err)
	}
	if controlledSeed {
		// Preserve provider evidence, but a mailbox operated by Moosewave must
		// never suppress or score a tenant subscriber. The insert trigger stamps
		// the durable origin and default analytics RLS hides it.
		if err := d.appendEvent(ctx, tenantID, ev, now); err != nil {
			return fmt.Errorf("append controlled seed event: %w", err)
		}
		return nil
	}

	switch {
	case ev.EventType == "bounced" && ev.BounceClass == "hard":
		// SUB-048: route the fine-grained categorisation (spamtrap /
		// role_account / dns_failure / invalid_address) when the provider
		// parser detected it; otherwise derive it from the diagnostic +
		// recipient, falling back to generic hard_bounce. The raw category
		// is persisted alongside as bounce_category so it survives a later
		// operator reclassification of `reason`.
		cat := ev.BounceCategory
		if cat == "" {
			cat = detectBounceCategory(ev.Reason, ev.Email)
		}
		reason, category := classifyHardBounceReason(cat)
		_, err := d.Suppressions.AddWithCategory(ctx, tenantID, ev.Email,
			reason, ev.ProviderName, ev.ProviderID, nil,
			map[string]any{"reason": ev.Reason}, category)
		if err != nil {
			return fmt.Errorf("hard bounce suppress: %w", err)
		}
		// Suppression is the enforcement record; subscriber_events is the
		// canonical analytics projection consumed by the Hub, bounce charts,
		// and subscriber scoring. A retry first observes the existing
		// suppression and then idempotently finishes this event projection.
		projection := ev
		projection.BounceClass = subscriberBounceType(cat, "hard")
		if err := d.appendEvent(ctx, tenantID, projection, now); err != nil {
			return fmt.Errorf("append hard bounce: %w", err)
		}
	case ev.EventType == "complained":
		_, err := d.Suppressions.AddWithCategory(ctx, tenantID, ev.Email,
			suppressions.ReasonSpamComplaint, ev.ProviderName, ev.ProviderID, nil,
			map[string]any{"reason": ev.Reason}, suppressions.CategoryComplaint)
		if err != nil {
			return fmt.Errorf("complaint suppress: %w", err)
		}
		if err := d.appendEvent(ctx, tenantID, ev, now); err != nil {
			return fmt.Errorf("append complaint: %w", err)
		}
	case ev.EventType == "unsubscribed":
		_, err := d.Suppressions.Add(ctx, tenantID, ev.Email,
			suppressions.ReasonManualUnsubscribe, ev.ProviderName, ev.ProviderID, nil,
			map[string]any{"reason": ev.Reason})
		if err != nil {
			return fmt.Errorf("unsubscribe suppress: %w", err)
		}
		// Suppression enforces future delivery; the canonical event is the
		// immutable campaign/timeline fact. Provider unsubscribe used to stop at
		// the suppression row, so neither subscriber_events nor the report
		// projection could ever show it. Dedup makes a retry converge after a
		// partial suppression/event failure.
		if err := d.appendEvent(ctx, tenantID, ev, now); err != nil {
			return fmt.Errorf("append unsubscribe: %w", err)
		}
	case ev.EventType == "bounced" && ev.BounceClass == "soft":
		// 1. Append the soft bounce to subscriber_events for analytics.
		if err := d.appendEvent(ctx, tenantID, ev, now); err != nil {
			return fmt.Errorf("append soft bounce: %w", err)
		}
		// 2. Threshold check: ≥5 in 30d auto-suppresses.
		windowStart := now.Add(-suppressions.SoftBounceWindow)
		count, err := d.Suppressions.CountSoftBouncesSince(ctx, tenantID, ev.Email, windowStart)
		if err != nil {
			d.log().Warn("deliverability: soft bounce count failed",
				"err", err.Error(), "email_redacted", observability.RedactEmail(ev.Email))
			return nil
		}
		if count >= suppressions.SoftBounceThreshold {
			expiresAt := now.Add(suppressions.SoftBounceSuppressionDuration)
			if _, err := d.Suppressions.Add(ctx, tenantID, ev.Email,
				suppressions.ReasonSoftBounceThreshold, ev.ProviderName,
				"", &expiresAt,
				map[string]any{"soft_count": count, "window_days": 30},
			); err != nil {
				return fmt.Errorf("soft threshold suppress: %w", err)
			}
		}
	case ev.EventType == "opened" || ev.EventType == "clicked":
		// Engagement → subscriber_events only. The analytics digest
		// reads from this table to compute opens_total / clicks_total
		// on the subscribers row.
		if err := d.appendEvent(ctx, tenantID, ev, now); err != nil {
			return fmt.Errorf("append engagement: %w", err)
		}
	case ev.EventType == "delivered":
		// Delivery is both the campaign reach denominator and the clock used by
		// machine-prefetch classification. It must be a canonical event even
		// though it has no suppression side effect. For a transactional send,
		// appendEvent also records the recipient outcome and enqueues
		// email.delivered in this same transaction.
		if err := d.appendEvent(ctx, tenantID, ev, now); err != nil {
			return fmt.Errorf("append delivery: %w", err)
		}
	default:
		// Unknown event type — no-op but log so we can spot a
		// parser/contract drift early.
		d.log().Info("deliverability: ignored event",
			"event", ev.EventType, "email_redacted", observability.RedactEmail(ev.Email))
	}
	return nil
}

// subscriberBounceType maps the richer suppression taxonomy onto the legacy
// subscriber_events CHECK constraint ('hard'|'soft'|'spam_trap').
func subscriberBounceType(category suppressions.BounceCategory, fallback string) string {
	if category == suppressions.CategorySpamtrap {
		return "spam_trap"
	}
	if strings.EqualFold(strings.TrimSpace(fallback), "soft") {
		return "soft"
	}
	return "hard"
}

// appendEvent writes a row to subscriber_events. Mirrors the shape of
// the listmonk_events writer but classified through bounce_type so
// the analytics layer can break out hard vs soft.
//
// Provider dedup: when ev carries a stable per-event id from the upstream
// provider, the key is claimed in subscriber_event_dedup_keys before the
// partitioned event insert. A replayed webhook with the same id is a no-op.
//
// Backwards compatibility: rows with no ProviderID still insert
// unconditionally (the partial index ignores NULL source_event_id).
// That preserves the legacy listmonk_events ingester path.
func (d *DeliverabilityDeps) appendEvent(ctx context.Context, tenantID string, ev classifyOutcome, now time.Time) error {
	// A production classifier only accepts a caller-owned tenant-worker
	// transaction; it never self-escalates. Preserve the ordinary tenant scope
	// while the feature is disabled, and open worker scope before any write when
	// it is enabled so the event and its evidence still share one commit.
	var tx pgx.Tx
	var err error
	projectCampaignReport := d.CampaignReportProjector != nil &&
		strings.TrimSpace(ev.CampaignID) != "" &&
		campaignreportprojection.EligibleCanonicalEventType(ev.EventType)
	projectTransactionalOutcome := d.transactionalProjector() != nil &&
		strings.TrimSpace(ev.MessageID) != "" &&
		transactionalOutcomeFor(ev) != ""
	if d.EngagementClassifier != nil || projectCampaignReport {
		tx, err = db.WithTenantWorker(ctx, d.Pool, tenantID)
	} else {
		tx, err = db.WithTenant(ctx, d.Pool, tenantID)
	}
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	at := ev.OccurredAt
	if at.IsZero() {
		at = now
	}
	ev.OccurredAt = at
	if ev.EventType == "delivered" && ev.DeliveredAt == nil {
		deliveredAt := at
		ev.DeliveredAt = &deliveredAt
	}
	source := strings.TrimSpace(string(ev.ProviderName))
	sourceEventID := strings.TrimSpace(ev.ProviderID)
	campaignID := strings.TrimSpace(ev.CampaignID)
	if campaignID != "" {
		parsed, parseErr := uuid.Parse(campaignID)
		if parseErr != nil {
			return fmt.Errorf("subscriber_events insert: invalid campaign id")
		}
		campaignID = parsed.String()
	}
	const ins = `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, bounce_type, at, source, source_event_id, campaign_id, message_id)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), $5, NULLIF($6,''), NULLIF($7,''), NULLIF($8,'')::uuid, NULLIF($9,''))
RETURNING id, at`
	if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','true',true)`); err != nil {
		return fmt.Errorf("subscriber_events insert scope: %w", err)
	}
	var eventID int64
	var eventAt time.Time
	if source != "" && sourceEventID != "" {
		claim, err := subscriberevents.ClaimDedupKey(ctx, tx, tenantID, source, sourceEventID)
		if err != nil {
			return err
		}
		if !claim.Claimed {
			// The canonical event may predate transactional outcome projection.
			// Re-run only the independently idempotent projection so a provider
			// retry can heal that historical half-written state.
			if projectTransactionalOutcome {
				if err := d.projectTransactionalOutcome(ctx, tx, tenantID, ev); err != nil {
					return err
				}
			}
			return tx.Commit(ctx)
		}
		err = tx.QueryRow(ctx, ins,
			tenantID, ev.Email, ev.EventType, ev.BounceClass, at, source, sourceEventID, campaignID, ev.MessageID,
		).Scan(&eventID, &eventAt)
		if err == nil {
			err = subscriberevents.BindDedupKey(ctx, tx, tenantID, source, sourceEventID, eventID, eventAt)
		}
		if err != nil {
			return fmt.Errorf("subscriber_events insert: %w", err)
		}
		if err := d.recordEngagementObservation(ctx, tx, tenantID, ev, source, sourceEventID, eventID, eventAt); err != nil {
			return err
		}
	} else {
		// QueryRow, not Exec: the observation is keyed to the canonical event id,
		// so discarding the RETURNING here would leave this branch permanently
		// unable to record one — which is how the corpus gap arose in the first
		// place.
		if err := tx.QueryRow(ctx, ins,
			tenantID, ev.Email, ev.EventType, ev.BounceClass, at, source, sourceEventID, campaignID, ev.MessageID,
		).Scan(&eventID, &eventAt); err != nil {
			return fmt.Errorf("subscriber_events insert: %w", err)
		}
		if err := d.recordEngagementObservation(ctx, tx, tenantID, ev, source, sourceEventID, eventID, eventAt); err != nil {
			return err
		}
	}
	if projectTransactionalOutcome {
		if err := d.projectTransactionalOutcome(ctx, tx, tenantID, ev); err != nil {
			return err
		}
	}
	if projectCampaignReport {
		if err := d.CampaignReportProjector.ProjectCanonicalEvent(
			ctx, tx, tenantID, campaignreportprojection.CanonicalEvent{
				EventRef:  campaignreportprojection.EventRef{ID: eventID, At: eventAt},
				EventType: ev.EventType, CampaignID: campaignID,
			},
		); err != nil {
			return fmt.Errorf("project provider campaign report event: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (d *DeliverabilityDeps) transactionalProjector() TransactionalOutcomeProjector {
	if d == nil {
		return nil
	}
	if d.TransactionalOutcomes != nil {
		return d.TransactionalOutcomes
	}
	projector, _ := d.TenantResolver.(TransactionalOutcomeProjector)
	return projector
}

// transactionalOutcomeFor is intentionally a closed mailbox-outcome mapping.
// Open/click do not belong here: they remain raw analytics observations until
// the engagement classifier labels them human, machine, or unknown, and there
// is no customer email.opened/email.clicked topic that could bypass that
// authority.
func transactionalOutcomeFor(ev classifyOutcome) string {
	switch ev.EventType {
	case "delivered", "complained":
		return ev.EventType
	case "bounced":
		if strings.EqualFold(strings.TrimSpace(ev.BounceClass), "hard") {
			return "bounced"
		}
		return "deferred"
	default:
		return ""
	}
}

func (d *DeliverabilityDeps) projectTransactionalOutcome(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ev classifyOutcome,
) error {
	projector := d.transactionalProjector()
	outcome := transactionalOutcomeFor(ev)
	if projector == nil || outcome == "" || strings.TrimSpace(ev.MessageID) == "" {
		return nil
	}
	recipients := append([]string(nil), ev.Recipients...)
	if strings.TrimSpace(ev.Email) != "" {
		recipients = append(recipients, ev.Email)
	}
	if err := projector.ProjectTransactionalOutcome(
		ctx, tx, tenantID, feedback.TransactionalProviderOutcome{
			ProviderMessageID: ev.MessageID,
			Recipients:        recipients,
			Outcome:           outcome,
			Reason:            ev.Reason,
			ESP:               string(ev.ProviderName),
			OccurredAt:        ev.OccurredAt,
		},
	); err != nil {
		return fmt.Errorf("project transactional provider outcome: %w", err)
	}
	return nil
}

func (d *DeliverabilityDeps) isControlledSeedEvent(ctx context.Context, tenantID, messageID string) (bool, error) {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return false, nil
	}
	normalized := strings.ToLower(messageID)
	if len(normalized) >= 2 && strings.HasPrefix(normalized, "<") && strings.HasSuffix(normalized, ">") {
		normalized = strings.TrimSpace(normalized[1 : len(normalized)-1])
	}
	rawDigest := sha256.Sum256([]byte(messageID))
	normalizedDigest := sha256.Sum256([]byte(normalized))
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var controlled bool
	err = tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM inbox_reality_seed_dispatches
     WHERE tenant_id=$1::uuid
       AND (
           source_message_id_sha256=$2
           OR provider_message_id_sha256 IN ($2,$3)
       )
)`, tenantID, hex.EncodeToString(normalizedDigest[:]), hex.EncodeToString(rawDigest[:])).Scan(&controlled)
	if err != nil {
		return false, err
	}
	return controlled, tx.Commit(ctx)
}

// constantTimeEqHex compares two hex-encoded HMAC outputs in
// constant time. Returns false on length mismatch / decode failure.
func constantTimeEqHex(want []byte, gotHex string) bool {
	got, err := hex.DecodeString(strings.TrimSpace(gotHex))
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}

// readBody caps the inbound body. SES SNS payloads can run a few KB on
// large bounces (the SMTP transcript is included); 4MB is intentionally
// generous.
func readBody(r *http.Request, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = 4 << 20
	}
	return httpbody.ReadAtMost(r.Body, maxBytes)
}

func (d *DeliverabilityDeps) writeReadBodyErrDeliv(w http.ResponseWriter, r *http.Request, maxBytes int64, err error) {
	if errors.Is(err, httpbody.ErrTooLarge) {
		writeJSONErrDeliv(w, http.StatusRequestEntityTooLarge, "payload_too_large",
			fmt.Sprintf("deliverability webhook payload exceeds %d bytes", maxBytes))
		return
	}
	// Generic body read failure (network read error, malformed chunked
	// transfer, etc.). The underlying io error text is not safe to echo
	// to the client — route through httperror.WriteInternal so we log
	// with request_id/tenant_id context and respond with the canonical
	// opaque 500 envelope.
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

// writeJSONErr is a local copy so we don't depend on the file-private
// helper in handlers.go that's shaped slightly differently.
func writeJSONErrDeliv(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
	_, _ = w.Write(body)
}

func writeJSONOK(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	body, _ := json.Marshal(payload)
	_, _ = w.Write(body)
}

// ParsePostmarkUnixOrRFC3339 tolerates both unix-second and RFC3339
// timestamp formats since different Postmark webhook variants ship
// each. Empty / unparsable yields zero (caller falls back to now()).
func ParsePostmarkUnixOrRFC3339(in string) time.Time {
	in = strings.TrimSpace(in)
	if in == "" {
		return time.Time{}
	}
	if n, err := strconv.ParseInt(in, 10, 64); err == nil {
		return time.Unix(n, 0).UTC()
	}
	if t, err := time.Parse(time.RFC3339Nano, in); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, in); err == nil {
		return t.UTC()
	}
	return time.Time{}
}

// hashHMACSHA256 returns the raw HMAC-SHA256 of body under key. Used
// by every provider verifier so the constant-time compare lives in
// one spot.
func hashHMACSHA256(key string, body []byte) []byte {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write(body)
	return mac.Sum(nil)
}

// recordEngagementObservation attaches the raw observation + shadow
// classification to an ESP-webhook event, in the SAME transaction as the insert.
//
// Same transaction on purpose: an event that committed without its observation
// would be permanently invisible to reclassification, and there is no way to
// notice that later — the row looks complete.
//
// A nil classifier is the disabled rollout and is not an error.
func (d *DeliverabilityDeps) recordEngagementObservation(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ev classifyOutcome,
	source, sourceEventID string,
	eventID int64,
	eventAt time.Time,
) error {
	if d.EngagementClassifier == nil {
		return nil
	}
	err := d.EngagementClassifier.RecordProviderEvent(ctx, tx, tenantID,
		engagementclassification.ProviderEventInput{
			EventRef: engagementclassification.EventRef{ID: eventID, At: eventAt},
			Source:   source, SourceEventID: sourceEventID,
			IdempotencyKey: fmt.Sprintf("esp-webhook:%d:%s", eventID,
				eventAt.UTC().Format(time.RFC3339Nano)),
			EventSchemaVersion: engagementclassification.ObservationSchemaV1,
			EventType:          ev.EventType,
			OccurredAt:         eventAt,
			IngestedAt:         time.Now().UTC(),
			DeliveredAt:        ev.DeliveredAt,
			RecipientAddress:   ev.Email,
			MessageIdentity:    ev.MessageID,
			ProviderMessageID:  ev.MessageID,
			LinkIdentity:       ev.LinkIdentity,
			UserAgent:          ev.UserAgent,
			IP:                 ev.IP,
			ProviderSignals:    ev.ProviderSignals,
			// Provider event payloads do not carry the recipient HTTP request's
			// ordered headers. Preserve that absence rather than substituting
			// gateway headers the recipient never sent.
			OrderedHeaders:         []engagementclassification.Header{},
			OrderedHeadersComplete: false,
		})
	if err != nil {
		return fmt.Errorf("classify esp webhook event: %w", err)
	}
	return nil
}
