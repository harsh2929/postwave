package listmonk_events

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
)

// SignatureHeader is the HMAC header Listmonk sends with each webhook.
const SignatureHeader = "X-Listmonk-Signature"

// TimestampHeader carries the unix-second-resolution send time. Both
// signature verification AND a freshness window check use it; together
// they prevent passive-capture replay of historic events. Stripe's
// webhook contract is the reference here — see billing/webhook.go.
const TimestampHeader = "X-Listmonk-Timestamp"

// ReplayTolerance is how far the request timestamp may drift from the
// gateway clock before we reject. Five minutes matches Stripe's default
// and accounts for sender clock skew + queueing delay during outages.
const ReplayTolerance = 5 * time.Minute

const listmonkEventMaxBodyBytes int64 = 1 << 20 // 1 MiB

// Deps bundles handler dependencies.
type Deps struct {
	Pool *db.Pool
	// Secret is the shared HMAC-SHA256 secret. Empty secrets fail closed
	// unless AllowUnsignedDevBypass is explicitly enabled for local dev.
	Secret string
	// AllowUnsignedDevBypass skips HMAC verification when Secret is empty.
	// This is intended for local development only and defaults closed.
	AllowUnsignedDevBypass bool
	// AutomationServiceURL is the runtime endpoint that receives dispatched
	// events. e.g. http://localhost:8084
	AutomationServiceURL string
	// InternalAPIToken is forwarded as a bearer token when dispatching to the
	// automation sidecar protected by POSTWAVE_INTERNAL_API_TOKEN.
	InternalAPIToken string
	// HTTPClient is used to dispatch to the automation runtime; defaults to
	// a 10s-timeout client.
	HTTPClient *http.Client
	Logger     *slog.Logger
	// Now overrides time.Now for deterministic replay-window tests.
	Now func() time.Time
	// SubscriberEvents receives selected canonical events as product-event
	// fanout inputs. Delivered events use this to drive
	// subscriber.delivered flow triggers in-process after durable ingest.
	SubscriberEvents SubscriberEventRecorder
	// Bus, when non-nil, bridges engagement webhooks to the in-process SSE
	// stream (SUB-119). After an inbound bounce/complaint (and the other
	// engagement wires) is durably persisted, the matching subscriber.* topic
	// is published to the Bus so the desktop's "subscriber.*" wildcard sees the
	// same lifecycle moment the outbound webhook catalog advertises — closing
	// the gap where subscriber.bounced / subscriber.complained never reached
	// SSE. nil-safe: a nil Bus disables the bridge entirely.
	Bus EventBus
	// Notify, when non-nil, fans notification-worthy engine events (hard
	// bounces, spam complaints) to the tenant's operators through the
	// unified notification fanout. Implementations MUST be non-blocking
	// (detach internally): this is called on the webhook ingest path.
	Notify EngineEventNotifier
	// EngagementSnapshotter, when non-nil, backs the SUB-096 real-time
	// engagement counter on the subscriber detail slideover. After a NEW
	// open/click is durably persisted, the handler loads the subscriber's
	// fresh 90-day open/click/send counters and publishes a
	// subscriber.engagement_updated event on the Bus so the slideover can
	// increment its Contact Performance counters live. nil-safe: a nil
	// snapshotter (or nil Bus) disables the live counter entirely; durable
	// ingest is unaffected. The concrete *subscribers.Repo satisfies this in
	// main.go without listmonk_events importing the subscribers package.
	EngagementSnapshotter EngagementSnapshotter
	// CanonicalWebhooks persists customer-webhook delivery intent on the same
	// transaction as provider event ingestion. The realtime Bus remains a
	// presentation channel and is never the durable delivery path.
	CanonicalWebhooks TransactionalWebhookFanout
	// EngagementClassifier atomically attaches the short-lived raw/provenance
	// observation and the shadow human|machine|unknown classification to the
	// canonical subscriber_events row. nil keeps the rollout disabled. When
	// configured, a classifier failure rolls the entire provider event back.
	EngagementClassifier TransactionalEngagementClassifier
	// CampaignReportProjector binds an eligible canonical event to the legacy
	// campaign_report_events read model in this same transaction. nil preserves
	// the pre-1959 writer path while the explicit projection gate is disabled.
	CampaignReportProjector TransactionalCampaignReportProjector

	// persistEvent is an internal test seam for HTTP batch failure behavior.
	// Production always leaves it nil and uses persist, which owns the complete
	// tenant transaction.
	persistEvent func(context.Context, CanonicalEvent) (canonicalPersistResult, error)
}

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

// TransactionalWebhookEvent is the package-local fanout contract used to keep
// listmonk_events independent of the outbound_webhooks package.
type TransactionalWebhookEvent struct {
	TenantID      string
	EventType     string
	SourceEventID string
	Body          map[string]any
	OccurredAt    time.Time
}

type TransactionalWebhookFanout func(
	ctx context.Context,
	tx pgx.Tx,
	event TransactionalWebhookEvent,
) (int, error)

// EngagementSnapshotter loads the per-subscriber engagement counter rollup
// keyed by email (SUB-096). Package-local + nil-safe so listmonk_events does
// not import the subscribers package; main.go adapts the concrete
// *subscribers.Repo (its EngagementByEmail method) to this shape.
type EngagementSnapshotter interface {
	EngagementByEmail(ctx context.Context, tenantID, email string) (EngagementSnapshot, error)
}

// EngagementSnapshot mirrors subscribers.EngagementSnapshot as a package-local
// value type so the interface above stays import-free. The main.go adapter
// maps the concrete struct's fields onto this one.
type EngagementSnapshot struct {
	SubscriberID string
	Email        string
	Sends        int
	Opens        int
	Clicks       int
}

type SubscriberEventRecorder interface {
	RecordSubscriberEvent(ctx context.Context, ev SubscriberEventRecord) error
}

// EventBus is the minimal slice of events.Bus the engagement bridge needs
// (SUB-119). Package-local + nil-safe so listmonk_events does not import the
// events package; main.go adapts the concrete *events.Bus to this shape.
type EventBus interface {
	Publish(tenantID, topic string, payload map[string]any)
}

// EngineEventNotifier receives notification-worthy engine events. The
// concrete implementation (main's operatorNotifyAdapter) resolves the
// tenant's operators and dispatches through notifyfanout with a shared
// cross-channel notification identity.
type EngineEventNotifier interface {
	NotifyEngineEvent(ev CanonicalEvent)
}

type SubscriberEventRecord struct {
	TenantID        string
	SubscriberEmail string
	EventName       string
	CampaignID      string
	MessageID       string
	Properties      map[string]any
	At              time.Time
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

// Mount registers POST /api/internal/listmonk/events on r. The caller is
// responsible for NOT putting tenant middleware in front of this route —
// it's an internal trusted endpoint authenticated by HMAC.
func Mount(r interface {
	Post(pattern string, handler http.HandlerFunc)
}, d *Deps) {
	r.Post("/api/internal/listmonk/events", d.Handle)
}

// Handle ingests a Listmonk webhook payload (single envelope or array),
// verifies HMAC, persists each event, and dispatches to the runtime.
func (d *Deps) Handle(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, listmonkEventMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Listmonk event payload exceeds 1 MiB")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	if d.Secret == "" {
		if !d.AllowUnsignedDevBypass {
			writeErr(w, http.StatusUnauthorized, "webhook_secret_required",
				"LISTMONK_WEBHOOK_SECRET required")
			return
		}
	} else {
		sig := strings.TrimSpace(r.Header.Get(SignatureHeader))
		if sig == "" {
			writeErr(w, http.StatusUnauthorized, "missing_signature",
				"X-Listmonk-Signature required")
			return
		}
		// Timestamp must accompany the signature. We bind it into the signed
		// string so passive-capture replay loses freshness once the window
		// closes. Senders that don't yet emit the header are rejected: that
		// is the entire point of the tightening.
		tsHeader := strings.TrimSpace(r.Header.Get(TimestampHeader))
		if tsHeader == "" {
			writeErr(w, http.StatusUnauthorized, "missing_timestamp",
				"X-Listmonk-Timestamp required")
			return
		}
		tsUnix, err := strconv.ParseInt(tsHeader, 10, 64)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "bad_timestamp",
				"X-Listmonk-Timestamp must be unix seconds")
			return
		}
		ts := time.Unix(tsUnix, 0).UTC()
		drift := d.now().Sub(ts)
		if drift < 0 {
			drift = -drift
		}
		if drift > ReplayTolerance {
			writeErr(w, http.StatusUnauthorized, "stale_timestamp",
				"signed timestamp outside replay window")
			return
		}
		if !verifyHMAC(d.Secret, body, sig, tsHeader) {
			writeErr(w, http.StatusUnauthorized, "bad_signature", "")
			return
		}
	}

	envelopes, err := decodeEnvelopes(body)
	if err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	if len(envelopes) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"accepted": 0})
		return
	}

	accepted := 0
	persistFailed := false
	for _, env := range envelopes {
		ev, terr := Translate(env)
		if terr != nil {
			d.log().Warn("listmonk_events: drop invalid envelope",
				"err", terr.Error(), "type", env.Type)
			continue
		}
		if ev.TenantID == "" {
			d.log().Warn("listmonk_events: drop event without tenant_id",
				"type", env.Type, "email", ev.SubscriberEmail)
			continue
		}
		result, err := d.persistCanonicalEvent(r.Context(), ev)
		if err != nil {
			d.log().Error("listmonk_events: persist failed", "err", err.Error())
			// Do not let one failing envelope starve a valid suffix in the same
			// provider batch. Each envelope owns one complete tenant transaction,
			// and stable provider IDs make the eventual whole-request retry safe:
			// successful siblings dedupe while failed items retry. Events without
			// a provider ID retain legacy at-least-once semantics and can duplicate
			// on such a partial-batch retry.
			persistFailed = true
			continue
		}
		if !result.Inserted {
			accepted++
			continue
		}
		if result.ControlledSeed {
			// Preserve canonical evidence without turning controlled-mailbox
			// automation into recipient engagement or customer-facing effects.
			accepted++
			continue
		}
		// Best-effort dispatch — runtime down should not fail webhook ingest.
		if err := d.dispatch(r.Context(), ev); err != nil {
			d.log().Warn("listmonk_events: dispatch failed",
				"err", err.Error(), "type", string(ev.EventType))
		}
		if ev.EventType == EventDelivered && d.SubscriberEvents != nil {
			if err := d.SubscriberEvents.RecordSubscriberEvent(r.Context(), SubscriberEventRecord{
				TenantID:        ev.TenantID,
				SubscriberEmail: ev.SubscriberEmail,
				EventName:       "subscriber.delivered",
				CampaignID:      ev.CampaignID,
				MessageID:       ev.MessageID,
				Properties:      eventMetadata(ev),
				At:              ev.At,
			}); err != nil {
				d.log().Warn("listmonk_events: delivered fanout failed",
					"err", err.Error(), "email", ev.SubscriberEmail)
			}
		}
		// SUB-119: bridge the engagement event to the in-process SSE Bus so the
		// desktop's "subscriber.*" wildcard sees subscriber.bounced /
		// subscriber.complained (and the other engagement wires) the moment they
		// durably persist. Only fires inside the `inserted` branch so replayed /
		// deduped webhook deliveries don't double-publish. nil-safe.
		d.emitBus(ev)
		// SUB-096: live engagement counter. Only opens/clicks move the
		// Contact Performance counters on the subscriber detail slideover;
		// this loads a fresh 90-day rollup and publishes
		// subscriber.engagement_updated on the Bus. Inside the `inserted`
		// branch so deduped redeliveries don't re-emit. nil-safe.
		d.emitEngagementUpdated(r.Context(), ev)
		accepted++
	}
	if persistFailed {
		w.Header().Set("Retry-After", "1")
		writeErr(w, http.StatusServiceUnavailable, "event_persist_failed",
			"One or more Listmonk events failed to persist; retry the request")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"accepted": accepted})
}

type canonicalPersistResult struct {
	Inserted       bool
	ControlledSeed bool
	SeedTestID     string
}

func (d *Deps) persistCanonicalEvent(ctx context.Context, ev CanonicalEvent) (canonicalPersistResult, error) {
	if d.persistEvent != nil {
		return d.persistEvent(ctx, ev)
	}
	return d.persistWithOrigin(ctx, ev)
}

// decodeEnvelopes accepts either a single envelope object or a JSON array.
func decodeEnvelopes(body []byte) ([]WebhookEnvelope, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return nil, nil
	}
	if body[0] == '[' {
		var arr []WebhookEnvelope
		if err := json.Unmarshal(body, &arr); err != nil {
			return nil, err
		}
		return arr, nil
	}
	var one WebhookEnvelope
	if err := json.Unmarshal(body, &one); err != nil {
		return nil, err
	}
	return []WebhookEnvelope{one}, nil
}

func (d *Deps) persist(ctx context.Context, ev CanonicalEvent) (bool, error) {
	result, err := d.persistWithOrigin(ctx, ev)
	return result.Inserted, err
}

func (d *Deps) persistWithOrigin(ctx context.Context, ev CanonicalEvent) (canonicalPersistResult, error) {
	var (
		tx  pgx.Tx
		err error
	)
	projectCampaignReport := d.CampaignReportProjector != nil &&
		strings.TrimSpace(ev.CampaignID) != "" &&
		campaignreportprojection.EligibleCanonicalEventType(string(ev.EventType))
	if d.EngagementClassifier != nil || projectCampaignReport {
		tx, err = db.WithTenantWorker(ctx, d.Pool, ev.TenantID)
	} else {
		tx, err = db.WithTenant(ctx, d.Pool, ev.TenantID)
	}
	if err != nil {
		return canonicalPersistResult{}, fmt.Errorf("with tenant: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	campaign := nullableUUID(ev.CampaignID)
	ip := nullableIP(ev.IP)
	ua := nullableString(ev.UserAgent)
	link := nullableString(ev.LinkURL)
	source := eventSource(ev)
	providerEventID := strings.TrimSpace(ev.ProviderEventID)
	rawMeta, err := json.Marshal(eventMetadata(ev))
	if err != nil {
		return canonicalPersistResult{}, fmt.Errorf("marshal metadata: %w", err)
	}

	claimedProviderKey := false
	if providerEventID != "" {
		claim, err := subscriberevents.ClaimDedupKey(
			ctx, tx, ev.TenantID, source, providerEventID,
		)
		if err != nil {
			return canonicalPersistResult{}, fmt.Errorf("claim provider event: %w", err)
		}
		if !claim.Claimed {
			if err := tx.Commit(ctx); err != nil {
				return canonicalPersistResult{}, fmt.Errorf("commit provider-event replay: %w", err)
			}
			return canonicalPersistResult{}, nil
		}
		// Migration 1727 seeded the global ledger from source_event_id, while
		// the legacy Listmonk writer populated provider_event_id. Adopt the
		// earliest pre-ledger canonical row before attempting a new partitioned
		// insert. This is deliberately in the claimed transaction: a concurrent
		// retry waits on the ledger key and observes the bound pointer after
		// commit, while any lookup/bind failure rolls the empty claim back.
		existingID, existingAt, found, err := findExistingProviderEvent(
			ctx, tx, ev.TenantID, source, providerEventID,
		)
		if err != nil {
			return canonicalPersistResult{}, fmt.Errorf("adopt legacy provider event: %w", err)
		}
		if found {
			if err := subscriberevents.BindDedupKey(
				ctx, tx, ev.TenantID, source, providerEventID, existingID, existingAt,
			); err != nil {
				return canonicalPersistResult{}, fmt.Errorf("bind legacy provider event: %w", err)
			}
			if err := tx.Commit(ctx); err != nil {
				return canonicalPersistResult{}, fmt.Errorf("commit legacy provider-event replay: %w", err)
			}
			return canonicalPersistResult{}, nil
		}
		claimedProviderKey = true
	}

	var (
		eventID     int64
		eventAt     time.Time
		eventOrigin string
		seedTestID  string
	)
	// INSERT ... RETURNING must be able to read the row it just classified.
	// The narrow transaction-local scope is reset immediately after the insert;
	// normal analytics sessions never receive this capability.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','true',true)`); err != nil {
		return canonicalPersistResult{}, fmt.Errorf("enable controlled seed origin resolution: %w", err)
	}
	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
	    (tenant_id, subscriber_email, event_type, campaign_id, link_url, user_agent, ip, at,
	     source, provider_event_id, source_event_id, message_id, metadata)
VALUES
	    ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::inet, $8, $9,
	     NULLIF($10, ''), NULLIF($10, ''), NULLIF($11, ''), $12::jsonb)
RETURNING id, at, event_origin, COALESCE(controlled_seed_test_id::text, '')`,
		ev.TenantID, ev.SubscriberEmail, string(ev.EventType),
		campaign, link, ua, ip, ev.At, source, providerEventID, ev.MessageID, string(rawMeta)).
		Scan(&eventID, &eventAt, &eventOrigin, &seedTestID)
	if err != nil {
		return canonicalPersistResult{}, fmt.Errorf("insert subscriber_events: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','false',true)`); err != nil {
		return canonicalPersistResult{}, fmt.Errorf("close controlled seed origin resolution: %w", err)
	}
	if d.EngagementClassifier != nil {
		if err := d.EngagementClassifier.RecordProviderEvent(
			ctx,
			tx,
			ev.TenantID,
			engagementclassification.ProviderEventInput{
				EventRef: engagementclassification.EventRef{ID: eventID, At: eventAt},
				Source:   eventSource(ev), SourceEventID: providerEventID,
				IdempotencyKey: fmt.Sprintf(
					"subscriber-event:%d:%s", eventID,
					eventAt.UTC().Format(time.RFC3339Nano),
				),
				EventSchemaVersion: engagementclassification.ObservationSchemaV1,
				EventType:          string(ev.EventType), OccurredAt: ev.At,
				IngestedAt: d.now(), RecipientAddress: ev.SubscriberEmail,
				MessageIdentity: ev.MessageID, LinkIdentity: ev.LinkURL,
				ProviderMessageID: ev.MessageID,
				// Listmonk's current wire has no distinct request id and no
				// ordered request-header capture. Preserve both absences rather
				// than manufacturing completeness from HTTP gateway headers.
				OrderedHeaders:         []engagementclassification.Header{},
				OrderedHeadersComplete: false,
				UserAgent:              ev.UserAgent, IP: ev.IP,
				ProviderSignals: engagementProviderSignals(ev),
			},
		); err != nil {
			return canonicalPersistResult{}, fmt.Errorf("classify canonical subscriber event: %w", err)
		}
	}
	if claimedProviderKey {
		if err := subscriberevents.BindDedupKey(
			ctx, tx, ev.TenantID, source, providerEventID, eventID, eventAt,
		); err != nil {
			return canonicalPersistResult{}, fmt.Errorf("bind provider event: %w", err)
		}
	}
	if campaign != nil {
		if err := d.persistCampaignReport(ctx, tx, ev, campaign, ip, source, rawMeta); err != nil {
			return canonicalPersistResult{}, err
		}
		if projectCampaignReport {
			if err := d.CampaignReportProjector.ProjectCanonicalEvent(
				ctx, tx, ev.TenantID, campaignreportprojection.CanonicalEvent{
					EventRef:  campaignreportprojection.EventRef{ID: eventID, At: eventAt},
					EventType: string(ev.EventType), CampaignID: ev.CampaignID,
				},
			); err != nil {
				return canonicalPersistResult{}, fmt.Errorf("project canonical campaign report event: %w", err)
			}
		}
	}
	controlledSeed := eventOrigin == "controlled_seed"
	if !controlledSeed {
		if err := d.persistContactActivity(ctx, tx, ev, campaign, source, rawMeta); err != nil {
			return canonicalPersistResult{}, err
		}
		if err := d.applySuppression(ctx, tx, ev, campaign, source, rawMeta); err != nil {
			return canonicalPersistResult{}, err
		}
		if event, ok := bounceWebhookEvent(ev); ok && d.CanonicalWebhooks != nil {
			if _, err := d.CanonicalWebhooks(ctx, tx, event); err != nil {
				return canonicalPersistResult{}, fmt.Errorf("persist bounce webhook intent: %w", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return canonicalPersistResult{}, err
	}
	return canonicalPersistResult{Inserted: true, ControlledSeed: controlledSeed, SeedTestID: seedTestID}, nil
}

func engagementProviderSignals(ev CanonicalEvent) map[string]any {
	// Only classifier-relevant, bounded provider flags cross into the raw
	// observation. Do not copy arbitrary metadata/reasons, which may contain a
	// recipient address or provider payload fragments.
	const wireType = "wire_type"
	allowed := map[string]struct{}{
		wireType: {}, "sg_machine_open": {}, "machine_open": {},
		"x-mailer-mpp": {}, "is_machine_open": {}, "bounce_type": {},
		"complaint_source": {},
	}
	out := make(map[string]any, len(allowed))
	for key, value := range ev.Metadata {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if _, ok := allowed[normalized]; ok && value != nil {
			out[normalized] = value
		}
	}
	return out
}

func findExistingProviderEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, source, providerEventID string,
) (int64, time.Time, bool, error) {
	var (
		eventID int64
		eventAt time.Time
	)
	err := tx.QueryRow(ctx, `
SELECT id, at
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND source = $2
   AND (source_event_id = $3 OR provider_event_id = $3)
 ORDER BY at, id
 LIMIT 1`, tenantID, source, providerEventID).Scan(&eventID, &eventAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, time.Time{}, false, nil
	}
	if err != nil {
		return 0, time.Time{}, false, err
	}
	return eventID, eventAt, true, nil
}

func bounceWebhookEvent(ev CanonicalEvent) (TransactionalWebhookEvent, bool) {
	if ev.EventType != EventBounced || strings.TrimSpace(ev.TenantID) == "" {
		return TransactionalWebhookEvent{}, false
	}
	sourceIdentity := strings.TrimSpace(ev.ProviderEventID)
	if sourceIdentity == "" {
		sourceIdentity = strings.TrimSpace(ev.MessageID)
	}
	// Provider event IDs are preferred. The deterministic fallback uses only
	// fields persisted with the inbound event, so an exact provider replay
	// converges even when the upstream omitted its event identifier.
	sourceKey := strings.Join([]string{
		"listmonk-bounce",
		sourceIdentity,
		strings.ToLower(strings.TrimSpace(ev.SubscriberEmail)),
		strings.TrimSpace(ev.CampaignID),
		ev.At.UTC().Format(time.RFC3339Nano),
	}, ":")
	body := map[string]any{
		"email":             ev.SubscriberEmail,
		"bounce_type":       ev.BounceType,
		"reason":            ev.Reason,
		"campaign_id":       ev.CampaignID,
		"provider_event_id": ev.ProviderEventID,
		"message_id":        ev.MessageID,
	}
	return TransactionalWebhookEvent{
		TenantID:      ev.TenantID,
		EventType:     "bounce.received",
		SourceEventID: sourceKey,
		Body:          body,
		OccurredAt:    ev.At,
	}, true
}

func (d *Deps) persistCampaignReport(ctx context.Context, tx pgx.Tx, ev CanonicalEvent, campaign, ip any, source string, rawMeta []byte) error {
	eventType := string(ev.EventType)
	_, err := tx.Exec(ctx, `
	INSERT INTO campaign_report_events (
	    tenant_id, campaign_id, subscriber_email, event_type, link_url, user_agent, ip,
	    metadata, at, source, provider_event_id, message_id
	)
	SELECT
	    $1::uuid, $2::uuid, NULLIF($3, ''), $4, $5, $6,
	    $7::inet, $8::jsonb, $9, $10, NULLIF($11, ''), NULLIF($12, '')
	WHERE EXISTS (
	    SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid
	)`,
		ev.TenantID, campaign, ev.SubscriberEmail, eventType, nullableString(ev.LinkURL), nullableString(ev.UserAgent),
		ip, string(rawMeta), ev.At, source, ev.ProviderEventID, ev.MessageID)
	if err != nil {
		return fmt.Errorf("insert campaign_report_events: %w", err)
	}
	return nil
}

func (d *Deps) persistContactActivity(ctx context.Context, tx pgx.Tx, ev CanonicalEvent, campaign any, source string, rawMeta []byte) error {
	activity := mapContactActivity(ev.EventType)
	if activity == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `
INSERT INTO contact_activity (tenant_id, subscriber_email, activity_type, campaign_id, metadata, source, at)
VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6, $7)`,
		ev.TenantID, ev.SubscriberEmail, activity, campaign, string(rawMeta), source, ev.At)
	if err != nil {
		return fmt.Errorf("insert contact_activity: %w", err)
	}
	return nil
}

func (d *Deps) applySuppression(ctx context.Context, tx pgx.Tx, ev CanonicalEvent, campaign any, source string, rawMeta []byte) error {
	reason, subscriberStatus, mailchimpStatus := suppressionMapping(ev)
	if reason == "" {
		return nil
	}
	detail := firstNonEmpty(ev.Reason, reason)
	_, err := tx.Exec(ctx, `
	INSERT INTO email_suppressions (
	    tenant_id, email, reason, source, provider_event_id, campaign_id, metadata, suppressed_at
	)
	SELECT $1::uuid, $2::citext, $3, $4, NULLIF($5, ''), $6::uuid, $7::jsonb, $8
	WHERE NOT EXISTS (
	    SELECT 1
	      FROM subscribers
	     WHERE tenant_id = $1::uuid
	       AND lower(email::text) = lower($2::text)
	       AND mailchimp_last_changed IS NOT NULL
	       AND mailchimp_last_changed > $8
	)
	ON CONFLICT (tenant_id, email, reason) DO UPDATE SET
	    source = EXCLUDED.source,
	    provider_event_id = COALESCE(EXCLUDED.provider_event_id, email_suppressions.provider_event_id),
	    campaign_id = COALESCE(EXCLUDED.campaign_id, email_suppressions.campaign_id),
	    metadata = email_suppressions.metadata || EXCLUDED.metadata,
	    suppressed_at = GREATEST(email_suppressions.suppressed_at, EXCLUDED.suppressed_at),
	    expires_at = NULL
	WHERE email_suppressions.suppressed_at <= EXCLUDED.suppressed_at`,
		ev.TenantID, ev.SubscriberEmail, reason, source, ev.ProviderEventID, campaign, string(rawMeta), ev.At)
	if err != nil {
		return fmt.Errorf("insert suppression: %w", err)
	}
	_, err = tx.Exec(ctx, `
	UPDATE subscribers
	   SET status = CASE
	         WHEN $3 = 'blocklisted' THEN 'blocklisted'
	         WHEN $3 = 'disabled' THEN CASE
	           WHEN status = 'blocklisted' THEN status
	           ELSE 'disabled'
	         END
	         ELSE status
	       END,
	       mailchimp_status = CASE
	         WHEN $4 = 'cleaned' THEN CASE
	           WHEN mailchimp_status IN ('archived', 'deleted') THEN mailchimp_status
	           ELSE 'cleaned'
	         END
	         WHEN $4 = 'unsubscribed' THEN CASE
	           WHEN mailchimp_status IN ('cleaned', 'archived', 'deleted') THEN mailchimp_status
	           ELSE 'unsubscribed'
	         END
	         ELSE mailchimp_status
	       END,
	       unsubscribe_reason = CASE
	         WHEN NULLIF($5, '') IS NULL THEN unsubscribe_reason
	         WHEN COALESCE(unsubscribe_reason, '') = '' THEN $5
	         ELSE unsubscribe_reason
	       END,
	       mailchimp_last_changed = $6,
	       activity_summary = jsonb_set(
	           COALESCE(activity_summary, '{}'::jsonb),
	           ARRAY[$7],
           to_jsonb($6::timestamptz),
           true
	       ),
	       updated_at = now()
	 WHERE tenant_id = $1::uuid
	   AND lower(email::text) = lower($2::text)
	   AND (mailchimp_last_changed IS NULL OR mailchimp_last_changed <= $6)`,
		ev.TenantID, ev.SubscriberEmail, subscriberStatus, mailchimpStatus, detail, ev.At, string(ev.EventType))
	if err != nil {
		return fmt.Errorf("update subscriber suppression: %w", err)
	}
	return nil
}

// dispatch forwards the canonical event to the automation runtime.
//
// Endpoint contract: POST {AutomationServiceURL}/v1/automations/event with
// the CanonicalEvent JSON. The runtime is responsible for matching it
// against active automations. We do NOT pass tenant headers — the runtime
// treats this as internal and trusts the body.
func (d *Deps) dispatch(ctx context.Context, ev CanonicalEvent) error {
	if d.AutomationServiceURL == "" {
		return nil
	}
	cli := d.HTTPClient
	if cli == nil {
		cli = &http.Client{Timeout: 10 * time.Second}
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	url, err := automationclient.EventURL(d.AutomationServiceURL)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(d.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return fmt.Errorf("automation runtime: %s", resp.Status)
	}
	return nil
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// emitBus publishes a freshly-persisted engagement event onto the in-process
// SSE Bus as the matching subscriber.* topic (SUB-119). nil-safe: a nil Bus,
// empty tenant, or a canonical type that has no subscriber.* topic is a no-op.
// The payload carries the redaction-safe fields the desktop timeline needs;
// the raw email is included because engagement webhooks key on it (unlike the
// delete event, which redacts).
func (d *Deps) emitBus(ev CanonicalEvent) {
	if d == nil || ev.TenantID == "" {
		return
	}
	// Operator notification fanout is independent of the SSE bridge: a
	// deployment without an SSE bus still notifies on hard bounces and
	// complaints (the notifier detaches internally, so ingest never blocks).
	if d.Notify != nil {
		switch ev.EventType {
		case EventBounced, EventComplained:
			d.Notify.NotifyEngineEvent(ev)
		}
	}
	if d.Bus == nil {
		return
	}
	topic := busTopicForEvent(ev.EventType)
	if topic == "" {
		return
	}
	payload := map[string]any{
		"email":      ev.SubscriberEmail,
		"event_type": string(ev.EventType),
	}
	if ev.CampaignID != "" {
		payload["campaign_id"] = ev.CampaignID
	}
	if ev.BounceType != "" {
		payload["bounce_type"] = ev.BounceType
	}
	if ev.Reason != "" {
		payload["reason"] = ev.Reason
	}
	d.Bus.Publish(ev.TenantID, topic, payload)
}

// engagementUpdatedTopic is the SSE topic the SUB-096 live counter consumes.
// Kept as a package-local string (not imported from subscribers) so this
// package stays import-free of the subscribers package; the value MUST match
// subscribers.EventSubscriberEngagementUpdated.
const engagementUpdatedTopic = "subscriber.engagement_updated"

// emitEngagementUpdated publishes a subscriber.engagement_updated event after a
// freshly-persisted open/click (SUB-096). It loads the subscriber's current
// 90-day open/click/send rollup via the snapshotter and includes it in the
// payload so the detail slideover can update its Contact Performance counters
// live. Fully nil-safe: a nil Bus, nil snapshotter, empty tenant, or a
// non-open/click event type is a no-op. A snapshot lookup error is swallowed
// (logged) — durable ingest must never fail on a best-effort UI affordance.
func (d *Deps) emitEngagementUpdated(ctx context.Context, ev CanonicalEvent) {
	if d == nil || d.Bus == nil || d.EngagementSnapshotter == nil || ev.TenantID == "" {
		return
	}
	if ev.EventType != EventOpened && ev.EventType != EventClicked {
		return
	}
	snap, err := d.EngagementSnapshotter.EngagementByEmail(ctx, ev.TenantID, ev.SubscriberEmail)
	if err != nil {
		d.log().Warn("listmonk_events: engagement snapshot failed",
			"err", err.Error(), "email", ev.SubscriberEmail)
		return
	}
	payload := map[string]any{
		"subscriber_id": snap.SubscriberID,
		"email":         snap.Email,
		"event_type":    string(ev.EventType),
		"sends":         snap.Sends,
		"opens":         snap.Opens,
		"clicks":        snap.Clicks,
	}
	d.Bus.Publish(ev.TenantID, engagementUpdatedTopic, payload)
}

// busTopicForEvent maps a canonical engagement type to the subscriber.* SSE
// topic the desktop wildcard subscription consumes. Returns "" for types that
// have no subscriber.* bridge. The strings mirror the Wire* constants in
// events.go (the outbound webhook catalog uses the same topic names).
func busTopicForEvent(t CanonicalEventType) string {
	switch t {
	case EventBounced:
		return WireBounced
	case EventComplained:
		return WireComplained
	case EventUnsubscribed:
		return WireUnsubscribed
	case EventOpened:
		return WireOpened
	case EventClicked:
		return WireClicked
	case EventDelivered:
		return WireDelivered
	default:
		return ""
	}
}

func mapContactActivity(t CanonicalEventType) string {
	switch t {
	case EventOpened:
		return "email_opened"
	case EventClicked:
		return "email_clicked"
	case EventDelivered:
		return "email_delivered"
	case EventBounced:
		return "bounced"
	case EventComplained:
		return "complained"
	case EventUnsubscribed:
		return "unsubscribed"
	default:
		return ""
	}
}

func suppressionMapping(ev CanonicalEvent) (reason, subscriberStatus, mailchimpStatus string) {
	switch ev.EventType {
	case EventBounced:
		bounceType := strings.ToLower(strings.TrimSpace(ev.BounceType))
		if bounceType == "" {
			if typ, _ := ev.Metadata["bounce_type"].(string); typ != "" {
				bounceType = strings.ToLower(strings.TrimSpace(typ))
			}
		}
		if bounceType == "soft" {
			return "", "", ""
		}
		return "hard_bounce", "blocklisted", "cleaned"
	case EventComplained:
		return "complaint", "blocklisted", "cleaned"
	case EventUnsubscribed:
		return "unsubscribe", "disabled", "unsubscribed"
	default:
		return "", "", ""
	}
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func isUUID(value string) bool {
	return uuidPattern.MatchString(strings.TrimSpace(value))
}

func nullableUUID(value string) any {
	if !isUUID(value) {
		return nil
	}
	return strings.TrimSpace(value)
}

func nullableIP(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || net.ParseIP(trimmed) == nil {
		return nil
	}
	return trimmed
}

func nullableString(value string) any {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return nil
}

func eventSource(ev CanonicalEvent) string {
	if source := strings.TrimSpace(ev.Source); source != "" {
		return source
	}
	return "listmonk"
}

func eventMetadata(ev CanonicalEvent) map[string]any {
	out := map[string]any{}
	for key, value := range nonNilMap(ev.Metadata) {
		out[key] = value
	}
	out["source"] = eventSource(ev)
	if ev.ProviderEventID != "" {
		out["provider_event_id"] = strings.TrimSpace(ev.ProviderEventID)
	}
	if ev.MessageID != "" {
		out["message_id"] = strings.TrimSpace(ev.MessageID)
	}
	if ev.BounceType != "" {
		out["bounce_type"] = strings.ToLower(strings.TrimSpace(ev.BounceType))
	}
	if ev.Reason != "" {
		out["reason"] = strings.TrimSpace(ev.Reason)
	}
	if campaignID := strings.TrimSpace(ev.CampaignID); campaignID != "" && !isUUID(campaignID) {
		out["campaign_id_raw"] = campaignID
	}
	return out
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// verifyHMAC is constant-time. The signed string is `timestamp.body` so
// the same body submitted at a different time produces a different MAC —
// preventing reuse of captured (sig, body) pairs across the replay window.
// timestamp is the raw header value (unix seconds as a string) — it MUST
// be the byte-for-byte string the sender used.
func verifyHMAC(secret string, body []byte, sigHex, timestamp string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	want := mac.Sum(nil)
	got, err := hex.DecodeString(strings.TrimSpace(sigHex))
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
