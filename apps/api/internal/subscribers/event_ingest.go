package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
)

type SubscriberEventInput struct {
	EventName     string         `json:"event_name"`
	EventType     string         `json:"event_type"`
	CampaignID    string         `json:"campaign_id"`
	LinkURL       string         `json:"link_url"`
	UserAgent     string         `json:"user_agent"`
	IP            string         `json:"ip"`
	OccurredAt    *time.Time     `json:"occurred_at,omitempty"`
	Source        string         `json:"source"`
	SourceEventID string         `json:"source_event_id"`
	Metadata      map[string]any `json:"metadata"`

	// NetworkASN / NetworkASNSource are set SERVER-SIDE from
	// engagementclassification.ObservedNetworkASN and never from the request
	// body — hence json:"-" rather than a name.
	//
	// The machine-source registry MATCHES on ASN, so a client-declared value
	// would let a sender choose its own classification. The tag is the
	// enforcement: a field with no JSON name cannot be populated by a decoder,
	// so this cannot be reintroduced by someone adding a key to a payload.
	NetworkASN       *uint32                                   `json:"-"`
	NetworkASNSource engagementclassification.NetworkASNSource `json:"-"`
}

type SubscriberEvent struct {
	ID              int64          `json:"id"`
	SubscriberID    string         `json:"subscriber_id"`
	SubscriberEmail string         `json:"subscriber_email"`
	EventName       string         `json:"event_name,omitempty"`
	EventType       string         `json:"event_type"`
	CampaignID      string         `json:"campaign_id,omitempty"`
	Source          string         `json:"source"`
	SourceEventID   string         `json:"source_event_id,omitempty"`
	Metadata        map[string]any `json:"metadata"`
	At              time.Time      `json:"at"`
	Deduped         bool           `json:"deduped"`
}

// MountSubscriberEventRoutes registers the subscriber event ingest route.
// Wrapped with observability.RecordSurfaceFunc so pw_subscribers_record_event_total +
// pw_subscribers_duration_seconds are emitted (Phase 4
// p4d-recordsurface-wire-subscribers).
func MountSubscriberEventRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/{id}/events",
			observability.RecordSurfaceFunc("subscribers", "record_event", d.RecordSubscriberEvent))
}

func (d *Deps) RecordSubscriberEvent(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SubscriberEventInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.RecordSubscriberEvent(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.event.created", map[string]any{
		"id":               out.ID,
		"subscriber_id":    out.SubscriberID,
		"subscriber_email": out.SubscriberEmail,
		"event_type":       out.EventType,
		"event_name":       out.EventName,
		"at":               out.At,
		"deduped":          out.Deduped,
	})
	// SUB-029: enqueue the tenant's segments for fast-path recompute so
	// membership flips within seconds of this event (the segments
	// SegmentEventWorker drains segment_event_queue on a ~1s cadence).
	// Skipped for deduped events (no new signal) and best-effort — a
	// failure here must not fail the ingest, since the 5-minute batch
	// materialiser remains the safety net.
	if !out.Deduped {
		if err := d.Repo.EnqueueSegmentRecompute(r.Context(), t.ID, out.SubscriberID, out.EventType, out.At); err != nil && d.Logger != nil {
			d.Logger.Warn("segment-event-enqueue failed",
				"tenant_id", t.ID, "subscriber_id", out.SubscriberID, "err", err.Error())
		}
	}
	status := http.StatusCreated
	if out.Deduped {
		status = http.StatusOK
	}
	writeJSON(w, status, out)
}

func (r *Repo) RecordSubscriberEvent(ctx context.Context, tenantID, subscriberID string, in SubscriberEventInput) (*SubscriberEvent, error) {
	if err := normalizeSubscriberEventInput(&in); err != nil {
		return nil, err
	}
	// The classifier deliberately refuses to grant itself worker authority.
	// When it is composed, the canonical event writer opens the stronger
	// tenant-worker transaction up front; the disabled path retains the ordinary
	// tenant transaction. Without this branch a real Runtime (unlike a test spy)
	// rejects every event at bindClassifierScope after the event insert.
	var tx pgx.Tx
	var err error
	projectCampaignReport := r.CampaignReportProjector != nil && in.CampaignID != "" &&
		campaignreportprojection.EligibleCanonicalEventType(in.EventType)
	if r.EngagementClassifier != nil || projectCampaignReport {
		tx, err = db.WithTenantWorker(ctx, r.Pool, tenantID)
	} else {
		tx, err = db.WithTenant(ctx, r.Pool, tenantID)
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	at := time.Now().UTC()
	if in.OccurredAt != nil {
		at = in.OccurredAt.UTC()
	}
	meta := nonNilMap(in.Metadata)
	if in.EventName != "" {
		meta["event_name"] = in.EventName
	}
	metaRaw, _ := json.Marshal(meta)

	var out SubscriberEvent
	out.SubscriberID = sub.ID
	out.SubscriberEmail = sub.Email
	out.EventName = in.EventName
	out.EventType = in.EventType
	out.CampaignID = in.CampaignID
	out.Source = in.Source
	out.SourceEventID = in.SourceEventID
	out.Metadata = meta

	if in.SourceEventID != "" {
		claim, claimErr := subscriberevents.ClaimDedupKey(ctx, tx, tenantID, in.Source, in.SourceEventID)
		if claimErr != nil {
			return nil, claimErr
		}
		if !claim.Claimed {
			out.ID = claim.ExistingID
			out.At = claim.ExistingAt
			out.Deduped = true
		} else {
			err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, campaign_id, link_url,
     user_agent, ip, at, source, source_event_id, metadata)
VALUES ($1::uuid, $2, $3, NULLIF($4, '')::uuid, NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, '')::inet, $8, $9, $10, $11::jsonb)
RETURNING id, at`,
				tenantID, sub.Email, in.EventType, in.CampaignID, in.LinkURL,
				in.UserAgent, in.IP, at, in.Source, in.SourceEventID, string(metaRaw)).
				Scan(&out.ID, &out.At)
			if err == nil {
				err = subscriberevents.BindDedupKey(ctx, tx, tenantID, in.Source, in.SourceEventID, out.ID, out.At)
			}
		}
	} else {
		err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, campaign_id, link_url,
     user_agent, ip, at, source, metadata)
VALUES ($1::uuid, $2, $3, NULLIF($4, '')::uuid, NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, '')::inet, $8, $9, $10::jsonb)
RETURNING id, at, false`,
			tenantID, sub.Email, in.EventType, in.CampaignID, in.LinkURL,
			in.UserAgent, in.IP, at, in.Source, string(metaRaw)).
			Scan(&out.ID, &out.At, &out.Deduped)
	}
	if err != nil {
		return nil, fmt.Errorf("insert subscriber_event: %w", err)
	}

	// Raw observation + shadow classification, in the SAME transaction as the
	// insert. An event that committed without its observation is permanently
	// invisible to reclassification, and the row looks complete — which is how the
	// corpus came to cover one writer out of several.
	//
	// Skipped for a deduplicated event: the observation for the original already
	// exists, and recording a second would double-count the evidence.
	if r.EngagementClassifier != nil && !out.Deduped {
		if err := r.EngagementClassifier.RecordProviderEvent(ctx, tx, tenantID,
			engagementclassification.ProviderEventInput{
				EventRef: engagementclassification.EventRef{ID: out.ID, At: out.At},
				Source:   in.Source, SourceEventID: in.SourceEventID,
				IdempotencyKey: fmt.Sprintf("subscriber-event:%d:%s", out.ID,
					out.At.UTC().Format(time.RFC3339Nano)),
				EventSchemaVersion: engagementclassification.ObservationSchemaV1,
				EventType:          in.EventType,
				OccurredAt:         out.At,
				IngestedAt:         time.Now().UTC(),
				RecipientAddress:   sub.Email,
				UserAgent:          in.UserAgent,
				IP:                 in.IP,
				NetworkASN:         in.NetworkASN,
				NetworkASNSource:   in.NetworkASNSource,
				// This path carries no ordered request headers. The absence is
				// PRESERVED rather than filled from the HTTP gateway: a header set
				// the recipient never sent would be fingerprint evidence this
				// deployment invented.
				OrderedHeaders:         []engagementclassification.Header{},
				OrderedHeadersComplete: false,
			}); err != nil {
			return nil, fmt.Errorf("classify subscriber event: %w", err)
		}
	}
	if projectCampaignReport && !out.Deduped {
		if err := r.CampaignReportProjector.ProjectCanonicalEvent(
			ctx, tx, tenantID, campaignreportprojection.CanonicalEvent{
				EventRef:  campaignreportprojection.EventRef{ID: out.ID, At: out.At},
				EventType: in.EventType, CampaignID: in.CampaignID,
			},
		); err != nil {
			return nil, fmt.Errorf("project subscriber campaign report event: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// EnqueueSegmentRecompute inserts one segment_event_queue row per
// segment the tenant owns, tagged with the subscriber + event that
// triggered it (SUB-029). The segments.SegmentEventWorker drains these
// and rewrites segment_subscribers so membership reflects the new event
// within seconds. A bounded fan-out (eventSegmentEnqueueCap) keeps the
// hot ingest path cheap for tenants with many segments — the rest are
// covered by the periodic batch materialiser, which rewrites their
// membership and forwards their entrants on its own, slower cadence.
//
// If the tenant has no segments, this is a no-op (zero rows inserted).
func (r *Repo) EnqueueSegmentRecompute(ctx context.Context, tenantID, subscriberID, eventType string, occurredAt time.Time) error {
	if tenantID == "" || subscriberID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// INSERT ... SELECT enqueues every (capped) segment in one round
	// trip. occurred_at carries the triggering event time for debugging
	// / future affected-segment filtering; the worker only reads
	// segment_id today.
	if _, err := tx.Exec(ctx, `
INSERT INTO segment_event_queue
       (tenant_id, segment_id, subscriber_id, event_type, occurred_at)
SELECT s.tenant_id, s.id, $2::uuid, $3, $4
  FROM segments s
 WHERE s.tenant_id = $1::uuid
 ORDER BY s.updated_at DESC
 LIMIT $5`, tenantID, subscriberID, eventType, occurredAt, eventSegmentEnqueueCap); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// eventSegmentEnqueueCap bounds how many segments a single event
// enqueues for recompute, protecting the ingest hot path. Segments
// beyond the cap still refresh on the periodic batch cadence.
const eventSegmentEnqueueCap = 200

func normalizeSubscriberEventInput(in *SubscriberEventInput) error {
	in.EventName = strings.TrimSpace(in.EventName)
	in.EventType = strings.ToLower(strings.TrimSpace(in.EventType))
	if in.EventType == "" {
		in.EventType = "custom"
	}
	if !validSubscriberEventType(in.EventType) {
		return fmt.Errorf("%w: unsupported event_type", ErrInvalidInput)
	}
	if in.EventType == "custom" && in.EventName == "" {
		return fmt.Errorf("%w: event_name is required for custom events", ErrInvalidInput)
	}
	if len(in.EventName) > 128 {
		return fmt.Errorf("%w: event_name exceeds 128 chars", ErrInvalidInput)
	}
	in.CampaignID = strings.TrimSpace(in.CampaignID)
	in.LinkURL = strings.TrimSpace(in.LinkURL)
	in.UserAgent = strings.TrimSpace(in.UserAgent)
	in.IP = strings.TrimSpace(in.IP)
	in.Source = defaulted(strings.ToLower(strings.TrimSpace(in.Source)), "api")
	in.SourceEventID = strings.TrimSpace(in.SourceEventID)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	return nil
}

func validSubscriberEventType(v string) bool {
	switch v {
	case "opened", "clicked", "bounced", "complained", "unsubscribed", "replied",
		"custom", "identified", "merged", "suppressed", "status_changed",
		"consent_changed", "lifecycle_stage_changed":
		return true
	default:
		return false
	}
}
