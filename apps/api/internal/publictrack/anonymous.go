// SPDX-License-Identifier: AGPL-3.0-only
//
// G-20b — anonymous event ingestion, the sibling of PublicTrackEvent
// (publictrack.go) for visitors who have not been identified yet.
//
// POST /api/public/track/event requires an email/external_id because it
// writes onto the known-subscriber timeline via
// subscribers.Repo.RecordSubscriberEvent. That leaves no public path to
// record pre-identification activity (page views, add-to-cart, etc.) for a
// visitor tracked only by a client-generated anonymous_id — every CDP-grade
// competitor supports this (Segment's anonymousId, Klaviyo's "Active on
// Site"). POST /api/public/track/anonymous is that path.
//
// Tenant resolution shares PublicTrackEvent's strict authority boundary and
// verified-custom-domain lookup. Request Host is authoritative by default;
// X-Forwarded-Host is eligible only behind an explicitly trusted edge. The
// handler keeps a distinct AnonDeps type so anonymous ingestion can be wired
// and reviewed independently from identified-event recording.
//
// Events land in subscriber_anonymous_events (migration 1744) and NEVER
// create a subscriber row — accepting an arbitrary anonymous_id from the
// public internet and materializing a profile from it would be an abuse
// surface (unbounded subscriber creation). Once a real identify call stitches
// the anonymous_id to a known subscriber (subscribers.stitchAnonymous,
// migration 0451's subscriber_anonymous_profiles), a separate stitch
// producer — subscribers.Repo.AttributeAnonymousEvents — copies the
// accrued anonymous activity onto that subscriber's timeline. That producer
// is driven from the identify path (subscribers.attributeAnonymousAfterIdentify),
// not from here: this file's job ends at recording the anonymous row.
package publictrack

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// anonymousTrackMaxBodyBytes mirrors publicTrackMaxBodyBytes; the anonymous
// payload shape is comparably small (no email/external_id fields).
const anonymousTrackMaxBodyBytes int64 = 64 << 10 // 64 KiB

// anonTrackSource namespaces rows written by this endpoint, mirroring
// trackSource's role for the identified-event table.
const anonTrackSource = "first_party_anonymous"

// errMissingAnonymousID is returned by parseAnonymousEventInput's caller
// when anonymous_id is absent — the one required field of this surface.
var errMissingAnonymousID = errors.New("publictrack: anonymous_id is required")

// AnonymousEventInput is the JSON body of POST /api/public/track/anonymous.
// Unlike eventInput, email is intentionally absent: this surface never
// resolves or creates a subscriber.
type AnonymousEventInput struct {
	AnonymousID   string         `json:"anonymous_id"`
	EventName     string         `json:"event_name,omitempty"`
	EventType     string         `json:"event_type,omitempty"`
	Properties    map[string]any `json:"properties,omitempty"`
	SourceEventID string         `json:"source_event_id,omitempty"`
	OccurredAt    *time.Time     `json:"occurred_at,omitempty"`
}

// AnonymousEvent is a persisted row of subscriber_anonymous_events.
type AnonymousEvent struct {
	ID            int64          `json:"id"`
	AnonymousID   string         `json:"anonymous_id"`
	EventName     string         `json:"event_name,omitempty"`
	EventType     string         `json:"event_type"`
	Properties    map[string]any `json:"properties,omitempty"`
	SourceEventID string         `json:"source_event_id,omitempty"`
	OccurredAt    time.Time      `json:"occurred_at"`
	Deduped       bool           `json:"deduped"`
}

// anonymousEventRecorder is the slice of AnonymousRepo this package needs.
// An interface keeps the handler unit-testable with a fake, mirroring
// subscriberEventRecorder in publictrack.go.
type anonymousEventRecorder interface {
	RecordAnonymousEvent(ctx context.Context, tenantID string, in AnonymousEventInput) (*AnonymousEvent, error)
}

// AnonDeps bundles the anonymous-track handler dependencies. It remains
// distinct from publictrack.go's Deps so each public ingestion surface has an
// explicit recorder and trust configuration.
type AnonDeps struct {
	// Pool backs the default host->tenant resolution. May be nil in tests
	// when ResolveTenant is supplied.
	Pool *db.Pool
	// Recorder inserts the resolved event into subscriber_anonymous_events.
	Recorder          anonymousEventRecorder
	UsageMeter        *sharedusage.Meter
	RequireUsageMeter bool
	// Logger is used by httperror.WriteInternal for 5xx server-side detail.
	// nil is tolerated.
	Logger *slog.Logger
	// ResolveTenant maps a normalized request host to a tenant id. Defaults
	// to the custom_domains DB lookup when nil; overridable in tests.
	ResolveTenant func(ctx context.Context, host string) (string, error)
	// TrustForwardedHost opts this handler into resolving the single
	// X-Forwarded-Host value supplied by a trusted edge. It must remain false
	// unless the first reachable proxy strips client-supplied forwarded-host
	// headers and replaces them with the authenticated original host. When
	// true, a missing, chained, repeated, or malformed forwarded host fails
	// closed before tenant resolution.
	TrustForwardedHost bool
}

// MountPublicTrackAnonymousRoutes registers the anonymous event ingestion
// route. Mount it in the same router group as
// publictrack.MountPublicTrackRoutes so it inherits the public 10/min IP
// rate limiter (see main.go r.Use(publicRateLimit.Middleware)) — this
// handler applies no rate limiting of its own.
func MountPublicTrackAnonymousRoutes(r chi.Router, d *AnonDeps) {
	r.Post("/api/public/track/anonymous", d.PublicTrackAnonymousEvent)
}

// PublicTrackAnonymousEvent POST /api/public/track/anonymous.
func (d *AnonDeps) PublicTrackAnonymousEvent(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Recorder == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "tracker_unavailable", "event tracker unavailable")
		return
	}
	host, err := trackingHostFromRequest(r, d.TrustForwardedHost)
	if err != nil {
		message := "invalid host"
		if errors.Is(err, errMissingRequestHost) {
			message = "missing host"
		}
		httperror.Write(w, http.StatusBadRequest, "bad_request", message)
		return
	}
	resolve := d.ResolveTenant
	if resolve == nil {
		resolve = d.resolveTenantByHost
	}
	tenantID, err := resolve(r.Context(), host)
	if err != nil {
		if errors.Is(err, errUnknownHost) {
			// Generic 401 — never reveal which hosts map to tenants.
			httperror.Write(w, http.StatusUnauthorized, "unknown_host", "unrecognized tracking host")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	in, err := parseAnonymousEventInput(r)
	if err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.AnonymousID = strings.TrimSpace(in.AnonymousID)
	if in.AnonymousID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_anonymous_id", errMissingAnonymousID.Error())
		return
	}
	if len(in.AnonymousID) > 512 {
		httperror.Write(w, http.StatusUnprocessableEntity, "event_rejected", "anonymous_id exceeds 512 chars")
		return
	}
	if d.RequireUsageMeter && d.UsageMeter == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "event allowance could not be verified")
		return
	}
	if d.UsageMeter != nil {
		key := ""
		if in.SourceEventID != "" {
			key = "anonymous-track:v1:" + strings.TrimSpace(in.SourceEventID)
		}
		_, reserveErr := d.UsageMeter.Reserve(r.Context(), tenantID, sharedusage.ResourceTrackedEvents, 1, key, "anonymous_track")
		if reserveErr != nil {
			var limitErr *sharedusage.Error
			if errors.As(reserveErr, &limitErr) {
				limit, current := limitErr.Limit, limitErr.Used
				entitlement.Write(w, entitlement.Denial{
					Subject: "workspace", Reason: entitlement.ReasonQuota,
					Code: "tracked_events_limit_exceeded", Message: "Monthly tracked-event allowance reached.",
					Resource: string(sharedusage.ResourceTrackedEvents), Limit: &limit, Current: &current,
				})
				return
			}
			httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "event allowance could not be verified")
			return
		}
	}

	out, err := d.Recorder.RecordAnonymousEvent(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// The contract is a flat 202 {"accepted": true} regardless of dedup —
	// this is a fire-and-forget ingestion surface with no subscriber lookup
	// to fail against, so there is no accepted-but-not-recorded branch like
	// PublicTrackEvent's unknown-subscriber case. deduped/id are additive.
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted": true,
		"id":       out.ID,
		"deduped":  out.Deduped,
	})
}

// resolveTenantByHost maps a canonical hostname through the verified custom
// domain registry. Authority selection and validation happen before this
// database boundary in PublicTrackAnonymousEvent.
func (d *AnonDeps) resolveTenantByHost(ctx context.Context, host string) (string, error) {
	if d.Pool == nil {
		return "", errUnknownHost
	}
	tx, err := d.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_track_host', $1, true)`, host); err != nil {
		return "", err
	}
	var tenantID string
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text FROM custom_domains
 WHERE domain = $1::citext AND verified IS TRUE
 LIMIT 1`, host).Scan(&tenantID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errUnknownHost
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tenantID, nil
}

// parseAnonymousEventInput reads + size-bounds the JSON body.
func parseAnonymousEventInput(r *http.Request) (AnonymousEventInput, error) {
	var in AnonymousEventInput
	body, err := httpbody.ReadAtMost(r.Body, anonymousTrackMaxBodyBytes)
	if err != nil {
		return in, err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return in, nil
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return in, err
	}
	return in, nil
}
