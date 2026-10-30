// SPDX-License-Identifier: AGPL-3.0-only
//
// Package publictrack: first-party, server-side event ingestion (SUB-122).
//
// POST /api/public/track/event is a public, no-auth endpoint that
// storefronts/apps call server-side OR over a first-party CNAME so
// subscriber activity is collected without third-party cookies.
//
// Tenant resolution: the request Host is mapped to a tenant via the
// custom_domains table, which the operator has already pointed at us via a
// verified CNAME. The lookup runs WITHOUT a tenant context (we don't know
// the tenant yet) using the app.public_track_host GUC + the
// custom_domains_public_host_lookup RLS policy (migration 1116). Only
// VERIFIED domains resolve, so an unverified/spoofed Host cannot attribute
// events to a tenant — the verified first-party CNAME IS the credential,
// which is the whole point of a cookieless first-party surface.
//
// Event storage + idempotency reuse subscribers.Repo.RecordSubscriberEvent,
// which writes subscriber_events with ON CONFLICT (tenant_id, source,
// source_event_id) dedup keyed on a client-supplied event id. The store is
// shared with the authenticated /api/v1/subscribers/{id}/events surface, so
// first-party events show up in the same activity timeline.
package publictrack

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

const publicTrackMaxBodyBytes int64 = 64 << 10 // 64 KiB

// trackSource namespaces the events recorded by this endpoint. It also
// scopes the (tenant_id, source, source_event_id) dedup index so a
// first-party event id can never collide with an api/webhook one.
const trackSource = "first_party"

// subscriberEventRecorder is the slice of *subscribers.Repo this package
// needs. An interface keeps the handler unit-testable with a fake.
type subscriberEventRecorder interface {
	RecordSubscriberEvent(ctx context.Context, tenantID, subscriberID string, in subscribers.SubscriberEventInput) (*subscribers.SubscriberEvent, error)
}

// Deps bundles the public-track handler dependencies.
type Deps struct {
	// Pool backs the default host->tenant resolution. May be nil in tests
	// when ResolveTenant is supplied.
	Pool *db.Pool
	// Subs records the resolved event into subscriber_events.
	Subs              subscriberEventRecorder
	UsageMeter        *sharedusage.Meter
	RequireUsageMeter bool
	// Logger is used by httperror.WriteInternal for 5xx server-side detail
	// without leaking err text to callers. nil is tolerated.
	Logger *slog.Logger
	// ResolveTenant maps a normalized request host to a tenant id. Defaults
	// to the custom_domains DB lookup when nil; overridable in tests.
	ResolveTenant func(ctx context.Context, host string) (string, error)
	// TrustForwardedHost opts this handler into resolving the single
	// X-Forwarded-Host value supplied by a trusted edge. It must remain false
	// unless the first reachable proxy strips client-supplied forwarded-host
	// headers and replaces them with the authenticated original host. When
	// true, a missing, chained, or malformed forwarded host fails closed.
	TrustForwardedHost bool
	// TrustForwardedIPHeaders opts this handler into reading the ASN the edge
	// measured, on the same terms and for the same reason as TrustForwardedHost.
	//
	// This beacon is the highest-value place to learn an ASN, because it is the
	// one path where the TCP peer genuinely IS the engaging client rather than a
	// mailbox provider fetching on someone's behalf. It is also the reason the
	// flag must default false: an ASN honoured from an untrusted peer is
	// attacker-chosen, and the machine-source registry matches on it, so a
	// sender could select its own classification.
	TrustForwardedIPHeaders bool
}

var (
	// errUnknownHost is the sentinel for "no verified custom domain matches".
	errUnknownHost = errors.New("publictrack: unrecognized tracking host")
	// errMissingRequestHost separates an absent authority from malformed
	// syntax while keeping both failures outside tenant resolution.
	errMissingRequestHost = errors.New("publictrack: request host is missing")
	errInvalidRequestHost = errors.New("publictrack: request host is invalid")
)

// eventInput is the JSON body of POST /api/public/track/event.
type eventInput struct {
	Email         string         `json:"email,omitempty"`
	ExternalID    string         `json:"external_id,omitempty"`
	EventName     string         `json:"event_name,omitempty"`
	EventType     string         `json:"event_type,omitempty"`
	Properties    map[string]any `json:"properties,omitempty"`
	SourceEventID string         `json:"source_event_id,omitempty"`
	OccurredAt    *time.Time     `json:"occurred_at,omitempty"`
}

// MountPublicTrackRoutes registers the public event ingestion route. It is
// mounted under the /api/public group, which already applies the public
// 10/min IP rate limiter (see main.go r.Use(publicRateLimit.Middleware)).
func MountPublicTrackRoutes(r chi.Router, d *Deps) {
	r.Post("/api/public/track/event", d.PublicTrackEvent)
}

// PublicTrackEvent POST /api/public/track/event.
func (d *Deps) PublicTrackEvent(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Subs == nil {
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

	in, err := parseEventInput(r)
	if err != nil {
		// httpbody error text is operator-safe (bad_json / payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	identifier := strings.TrimSpace(in.Email)
	if identifier == "" {
		// external_id alone cannot resolve a subscriber via the shared
		// recorder (it keys on id-or-email); require email for attribution.
		httperror.Write(w, http.StatusBadRequest, "missing_email", "email is required")
		return
	}

	// Measured at the HTTP boundary, never taken from the body. Returns
	// (nil, edge_unconfigured) when no trusted edge is configured, so an
	// unmeasured row is distinguishable from a row measured as "no ASN" — the
	// distinction that lets an operator tell a switched-off signal from a quiet
	// week, instead of reading one as the other.
	asn, asnSource := engagementclassification.ObservedNetworkASN(r, d.TrustForwardedIPHeaders)

	evt := subscribers.SubscriberEventInput{
		NetworkASN:       asn,
		NetworkASNSource: asnSource,
		EventName:        strings.TrimSpace(in.EventName),
		EventType:        strings.ToLower(strings.TrimSpace(in.EventType)),
		OccurredAt:       in.OccurredAt,
		Source:           trackSource,
		SourceEventID:    strings.TrimSpace(in.SourceEventID),
		Metadata:         mergeExternalID(in.Properties, in.ExternalID),
	}
	if d.RequireUsageMeter && d.UsageMeter == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "event allowance could not be verified")
		return
	}
	if d.UsageMeter != nil {
		key := ""
		if evt.SourceEventID != "" {
			key = "public-track:v1:" + evt.SourceEventID
		}
		_, reserveErr := d.UsageMeter.Reserve(r.Context(), tenantID, sharedusage.ResourceTrackedEvents, 1, key, "public_track")
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

	out, err := d.Subs.RecordSubscriberEvent(r.Context(), tenantID, identifier, evt)
	if err != nil {
		switch {
		case errors.Is(err, subscribers.ErrNotFound):
			// Fire-and-forget: an unknown subscriber is accepted-and-ignored
			// so the caller's pipeline never blocks and we never leak which
			// emails exist. The public endpoint does NOT create subscribers.
			writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "recorded": false})
		case errors.Is(err, subscribers.ErrInvalidInput):
			httperror.Write(w, http.StatusUnprocessableEntity, "event_rejected", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted": true,
		"recorded": true,
		"id":       out.ID,
		"deduped":  out.Deduped,
	})
}

// resolveTenantByHost maps a verified custom domain to its tenant WITHOUT a
// tenant context. It binds app.public_track_host for the tx so the
// custom_domains_public_host_lookup permissive policy + the widened
// restrictive gate (migration 1116) admit the single verified row.
func (d *Deps) resolveTenantByHost(ctx context.Context, host string) (string, error) {
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

// trackingHostFromRequest selects and canonicalizes the authority used by the
// identified public-event endpoint. The request Host is authoritative by
// default; an untrusted X-Forwarded-Host is ignored. Trusted-edge mode is an
// explicit dependency opt-in and deliberately requires one forwarded value
// rather than falling back to Host, so a misconfigured direct-origin request
// fails closed.
func trackingHostFromRequest(r *http.Request, trustForwardedHost bool) (string, error) {
	if r == nil {
		return "", errMissingRequestHost
	}
	raw := r.Host
	if trustForwardedHost {
		values := r.Header.Values("X-Forwarded-Host")
		if len(values) == 0 {
			return "", errMissingRequestHost
		}
		if len(values) != 1 {
			return "", errInvalidRequestHost
		}
		raw = values[0]
	}
	return normalizeTrackingHost(raw)
}

// normalizeTrackingHost returns the canonical ASCII DNS hostname stored in
// custom_domains. It accepts an optional valid numeric port, but rejects
// forwarded lists, IP literals, user-info, paths, malformed ports, empty DNS
// labels, and ambiguous punctuation instead of truncating them.
func normalizeTrackingHost(raw string) (string, error) {
	hostPort := strings.TrimSpace(raw)
	if hostPort == "" {
		return "", errMissingRequestHost
	}
	if strings.Contains(hostPort, ",") || strings.ContainsAny(hostPort, "/\\?#@") {
		return "", errInvalidRequestHost
	}

	host := hostPort
	switch strings.Count(hostPort, ":") {
	case 0:
	case 1:
		separator := strings.LastIndexByte(hostPort, ':')
		host = hostPort[:separator]
		portText := hostPort[separator+1:]
		for i := 0; i < len(portText); i++ {
			if portText[i] < '0' || portText[i] > '9' {
				return "", errInvalidRequestHost
			}
		}
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return "", errInvalidRequestHost
		}
	default:
		// Custom-domain resolution supports DNS hostnames, never IPv6 or an
		// unbracketed colon-delimited authority.
		return "", errInvalidRequestHost
	}

	host = strings.ToLower(host)
	if strings.HasSuffix(host, ".") {
		host = strings.TrimSuffix(host, ".")
	}
	if host == "" || len(host) > 253 || net.ParseIP(host) != nil {
		return "", errInvalidRequestHost
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errInvalidRequestHost
		}
		for i := 0; i < len(label); i++ {
			char := label[i]
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
				return "", errInvalidRequestHost
			}
		}
	}
	return host, nil
}

// parseEventInput reads + size-bounds the JSON body.
func parseEventInput(r *http.Request) (eventInput, error) {
	var in eventInput
	body, err := httpbody.ReadAtMost(r.Body, publicTrackMaxBodyBytes)
	if err != nil {
		return in, err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return in, nil
	}
	if err := json.Unmarshal(body, &in); err != nil {
		// httpbody.{StatusCode,ErrorCode} map any non-oversize error to
		// 400 / "bad_json", so returning the decode error is sufficient.
		return in, err
	}
	return in, nil
}

// mergeExternalID folds a client external_id into the event metadata so the
// raw identifier is preserved even though attribution keys on email.
func mergeExternalID(props map[string]any, externalID string) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	if id := strings.TrimSpace(externalID); id != "" {
		props["external_id"] = id
	}
	return props
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
