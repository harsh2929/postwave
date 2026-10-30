// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var defaultAutomationFanoutHTTPClient = &http.Client{Timeout: 10 * time.Second}

const trackJSONMaxBodyBytes int64 = 1 << 20 // 1 MiB

const trackOccurredAtFutureSkewAllowance = 5 * time.Minute

// EventStreamRepository is the narrow read contract needed by the live-tail
// endpoint. Keeping it separate from Repo makes the pre-header bootstrap
// failure path testable without weakening the rest of the Track repository.
type EventStreamRepository interface {
	MaxID(ctx context.Context, tenantID string) (int64, error)
	ListNewerThan(ctx context.Context, tenantID string, sinceID int64, limit int) ([]Event, error)
}

// Deps bundles the track handler dependencies.
type Deps struct {
	Repo                 *Repo
	UsageMeter           *sharedusage.Meter
	RequireUsageMeter    bool
	EventStreamRepo      EventStreamRepository
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
	// FlowRuns is the in-process trigger fan-out. When set, every successful
	// track ingest enqueues a flow_runs row per active flow whose
	// product_event trigger matches the event name. nil-safe: the legacy
	// HTTP fan-out to the automation service still runs independently.
	FlowRuns flowbuilder.RunEnqueuer
	// Revenue bridges an order-shaped track event into the revenue /
	// conversion store (G-49d) so a tracked "Placed Order" produces
	// attributed revenue instead of $0. nil-safe: when unset the bridge is
	// simply skipped and the behavioral event is still recorded + fanned out.
	Revenue RevenueRecorder
	// DelayResolver is consulted only for flow triggers that opt into
	// delay_strategy=optimized. Missing preferences fail open to immediate
	// fanout so old triggers keep their historical behavior.
	DelayResolver DelayResolver
	// Logger is optional; defaults to the standard logger.
	Logger *log.Logger
	// Slog is used by httperror.WriteInternal to record server-side
	// 5xx context (request_id, tenant_id, err) without leaking err
	// text to callers. Optional; nil is tolerated by httperror.WriteInternal.
	Slog *slog.Logger
}

type DelayResolver interface {
	ResolveDelay(ctx context.Context, tenantID, subscriberID, eventName string) (time.Duration, bool, error)
}

// MountRoutes registers /api/v1/track and the read endpoints.
//
// Refined Product Events PR 1: adds event-catalog (distinct names +
// counts + last-seen + 7-day series), insights stats (totals + unique
// subscribers + per-day series), SSE live tail, and CSV export.
func (d *Deps) MountRoutes(r chi.Router) {
	readReports := r.With(apikeys.RequireScope(apikeys.ScopeReadReports))
	readRawEvents := r.With(apikeys.RequireAllScopes(
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	))
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))

	// Ingestion is not a harmless fixture action: a successful write can fan
	// out to live automations, flow runs, and attributed revenue. Keep it
	// administrator-only. Aggregate reports remain viewer-readable, while raw
	// subscriber-linked events additionally require subscriber-read access.
	admin.Post("/api/v1/track", d.Track)
	readRawEvents.Get("/api/v1/track/events", d.ListEvents)
	readReports.Get("/api/v1/track/catalog", d.EventCatalog)
	readReports.Get("/api/v1/track/stats", d.EventStats)
	readRawEvents.Get("/api/v1/track/stream", d.EventStream)
	readRawEvents.Get("/api/v1/track/events.csv", d.ExportEventsCSV)
}

// TrackInput is the POST body.
type TrackInput struct {
	SubscriberID string `json:"subscriber_id,omitempty"`
	Email        string `json:"email,omitempty"`
	EventName    string `json:"event_name"`
	// EventID is an OPTIONAL client-supplied idempotency key. Send the same id
	// on a retry and the event is recorded once. Omitting it keeps the previous
	// behaviour, so no existing integration changes.
	EventID    string                 `json:"event_id,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
	OccurredAt *time.Time             `json:"occurred_at,omitempty"`
}

// Track POST /api/v1/track
func (d *Deps) Track(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in TrackInput
	if err := httpbody.DecodeJSON(w, r, trackJSONMaxBodyBytes, &in); err != nil {
		// httpbody.ErrorCode returns "bad_json" or "payload_too_large" — both
		// are in the safe-to-echo allowlist and the text is authored by
		// httpbody itself, so echo via httperror.Write.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.EventName = strings.TrimSpace(in.EventName)
	in.EventID = strings.TrimSpace(in.EventID)
	if in.EventName == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_event_name", ""))
		return
	}
	if !validEventName(in.EventName) {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"invalid_event_name",
			"event_name must be at most 128 characters and use lowercase snake_case segments separated by dots",
		))
		return
	}
	if in.SubscriberID == "" && in.Email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_subscriber", "subscriber_id or email required"))
		return
	}
	serverNow := time.Now().UTC()
	occurred, err := normalizeTrackOccurredAt(in.OccurredAt, serverNow)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"occurred_at_too_far_future",
			"occurred_at cannot be more than 5 minutes ahead of server time",
		))
		return
	}
	sub, err := d.Repo.ResolveSubscriberIdentity(r.Context(), t.ID, in.SubscriberID, in.Email)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("unknown_subscriber", ""))
			return
		}
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	if in.Properties == nil {
		in.Properties = map[string]interface{}{}
	}
	propsJSON, _ := json.Marshal(in.Properties)
	if d.RequireUsageMeter && d.UsageMeter == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "event allowance could not be verified")
		return
	}
	if d.UsageMeter != nil {
		key := ""
		if in.EventID != "" {
			key = "track:v1:" + in.EventID
		}
		_, reserveErr := d.UsageMeter.Reserve(r.Context(), t.ID, sharedusage.ResourceTrackedEvents, 1, key, "api_track")
		if reserveErr != nil {
			var limitErr *sharedusage.Error
			if errors.As(reserveErr, &limitErr) {
				limit, current := limitErr.Limit, limitErr.Used
				entitlement.Write(w, entitlement.Denial{Subject: "workspace", Reason: entitlement.ReasonQuota, Code: "tracked_events_limit_exceeded", Message: "Monthly tracked-event allowance reached.", Resource: string(sharedusage.ResourceTrackedEvents), Limit: &limit, Current: &current})
				return
			}
			httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "event allowance could not be verified")
			return
		}
	}
	id, err := d.Repo.Insert(r.Context(), t.ID, sub.ID, in.EventName, propsJSON, occurred, in.EventID)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	if d.AutomationServiceURL != "" {
		if !startTrackFanout(
			func() { d.fanout(t.ID, sub.Email, in.EventName, in.Properties, occurred) },
			func(recovered any, stack []byte) {
				d.logf("track: automation fanout panic tenant=%s event=%s recover=%v\n%s", t.ID, in.EventName, recovered, stack)
			},
		) {
			d.logf("track: automation fanout saturated tenant=%s event=%s", t.ID, in.EventName)
		}
	}
	if d.FlowRuns != nil {
		if !startTrackFanout(
			func() { d.fanoutFlowRuns(t.ID, sub.ID, id, in.EventName, occurred) },
			func(recovered any, stack []byte) {
				d.logf("track: flow fanout panic tenant=%s event=%s recover=%v\n%s", t.ID, in.EventName, recovered, stack)
			},
		) {
			d.logf("track: flow fanout saturated tenant=%s event=%s", t.ID, in.EventName)
		}
	}
	if d.Revenue != nil {
		if order, ok := extractOrderConversion(in.EventName, sub.Email, in.Properties); ok {
			if !startTrackFanout(
				func() { d.fanoutRevenue(t.ID, order) },
				func(recovered any, stack []byte) {
					d.logf("track: revenue fanout panic tenant=%s event=%s recover=%v\n%s", t.ID, in.EventName, recovered, stack)
				},
			) {
				d.logf("track: revenue fanout saturated tenant=%s event=%s", t.ID, in.EventName)
			}
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id, "subscriber_id": sub.ID})
}

func normalizeTrackOccurredAt(input *time.Time, serverNow time.Time) (time.Time, error) {
	serverNow = serverNow.UTC()
	if input == nil {
		return serverNow, nil
	}
	occurred := input.UTC()
	if occurred.After(serverNow.Add(trackOccurredAtFutureSkewAllowance)) {
		return time.Time{}, errors.New("occurred_at exceeds the allowed future clock skew")
	}
	return occurred, nil
}

// fanoutFlowRuns looks up every active flow whose product_event trigger
// matches eventName and enqueues a flow_runs row per match. Runs in a
// goroutine so the http response is not blocked; recovers from panics so a
// single bad flow does not poison the rest of the fan-out.
func (d *Deps) fanoutFlowRuns(tenantID, subscriberID string, eventID int64, eventName string, at time.Time) {
	defer func() {
		if rec := recover(); rec != nil {
			d.logf("track: flow-run fanout panic tenant=%s event=%s recover=%v\n%s",
				tenantID, eventName, rec, debug.Stack())
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	matches, err := d.FlowRuns.MatchFlowsForEvent(ctx, tenantID, eventName)
	if err != nil {
		d.logf("track: flow-run match failed tenant=%s event=%s err=%v", tenantID, eventName, err)
		return
	}
	for _, m := range matches {
		eventCopy := eventID
		req := flowbuilder.RunEnqueueRequest{
			FlowID:           m.FlowID,
			SubscriberID:     subscriberID,
			TriggerEventID:   &eventCopy,
			TriggerEventName: eventName,
			ScheduledAt:      at,
		}
		if strings.EqualFold(m.DelayStrategy, "optimized") && d.DelayResolver != nil {
			if delay, ok, delayErr := d.DelayResolver.ResolveDelay(ctx, tenantID, subscriberID, eventName); delayErr != nil {
				d.logf("track: optimized-delay lookup failed tenant=%s flow=%s event=%s err=%v",
					tenantID, m.FlowID, eventName, delayErr)
			} else if ok && delay > 0 {
				req.ScheduledAt = at.Add(delay)
			}
		}
		// Wrap each enqueue so a panic on one flow does not kill the loop.
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					d.logf("track: flow-run enqueue panic tenant=%s flow=%s recover=%v",
						tenantID, m.FlowID, rec)
				}
			}()
			if _, enqErr := d.FlowRuns.EnqueueRun(ctx, tenantID, req); enqErr != nil {
				d.logf("track: flow-run enqueue failed tenant=%s flow=%s err=%v",
					tenantID, m.FlowID, enqErr)
			}
		}()
	}
}

// fanoutRevenue records an order-shaped event into the revenue / conversion
// store. Best-effort and off the request path (mirrors fanoutFlowRuns): the
// behavioral event is already durably stored, so a bridge failure is logged
// rather than surfaced to the caller. Its own timeout + panic recovery keep a
// slow or misbehaving recorder from leaking a goroutine or crashing the process.
func (d *Deps) fanoutRevenue(tenantID string, order OrderConversion) {
	defer func() {
		if rec := recover(); rec != nil {
			d.logf("track: revenue fanout panic tenant=%s event=%s recover=%v\n%s",
				tenantID, order.EventName, rec, debug.Stack())
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := d.Revenue.RecordOrder(ctx, tenantID, order); err != nil {
		d.logf("track: revenue record failed tenant=%s event=%s cents=%d err=%v",
			tenantID, order.EventName, order.AmountCents, err)
	}
}

func (d *Deps) logf(format string, args ...any) {
	if d.Logger != nil {
		_ = d.Logger.Output(2, fmt.Sprintf(format, args...))
		return
	}
	log.Printf(format, args...)
}

// ListEvents GET /api/v1/track/events?subscriber_id=&event_name=&limit=50&before=
//
// Refined Product Events PR 1: gains `event_name` server-side filter
// so the operator can slice by event in one round-trip instead of
// the previous client-side scan.
func (d *Deps) ListEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	sub := r.URL.Query().Get("subscriber_id")
	eventName := strings.TrimSpace(r.URL.Query().Get("event_name"))
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	var before *time.Time
	if raw := strings.TrimSpace(r.URL.Query().Get("before")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_before", "before must be RFC3339"))
			return
		}
		before = &parsed
	}
	var out []Event
	var err error
	switch {
	case sub != "" && eventName != "":
		out, err = d.Repo.ListBySubscriberAndEvent(r.Context(), t.ID, sub, eventName, limit)
	case sub != "":
		out, err = d.Repo.ListBySubscriber(r.Context(), t.ID, sub, limit)
	case eventName != "":
		out, err = d.Repo.ListByEvent(r.Context(), t.ID, eventName, limit, before)
	default:
		out, err = d.Repo.ListRecent(r.Context(), t.ID, limit, before)
	}
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) fanout(tenantID, subscriberEmail, eventName string, props map[string]interface{}, at time.Time) {
	defer func() {
		if rec := recover(); rec != nil {
			d.logf(
				"track: automation fanout panic tenant=%s event=%s recover=%v\n%s",
				tenantID,
				eventName,
				rec,
				debug.Stack(),
			)
		}
	}()
	eventPayload := map[string]interface{}{}
	for k, v := range props {
		eventPayload[k] = v
	}
	eventPayload["event_name"] = eventName
	eventPayload["properties"] = props
	envelope := map[string]any{
		"tenant_id":        tenantID,
		"subscriber_email": subscriberEmail,
		"event_type":       "product_event",
		"at":               at,
		"payload":          eventPayload,
	}
	buf, err := json.Marshal(envelope)
	if err != nil {
		d.logf("track: automation fanout encode failed tenant=%s event=%s err=%v", tenantID, eventName, err)
		return
	}
	client := d.HTTPClient
	if client == nil {
		client = defaultAutomationFanoutHTTPClient
	}
	url, err := automationclient.EventURL(d.AutomationServiceURL)
	if err != nil {
		d.logf("track: automation fanout URL rejected tenant=%s event=%s err=%v", tenantID, eventName, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		d.logf("track: automation fanout request failed tenant=%s event=%s err=%v", tenantID, eventName, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(d.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		d.logf("track: automation fanout transport failed tenant=%s event=%s err=%v", tenantID, eventName, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		d.logf("track: automation fanout response drain failed tenant=%s event=%s status=%d err=%v", tenantID, eventName, resp.StatusCode, err)
		return
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		d.logf("track: automation fanout rejected tenant=%s event=%s status=%d", tenantID, eventName, resp.StatusCode)
	}
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func atoiDefault(s string, def int) int {
	n := 0
	if s == "" {
		return def
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return def
	}
	return n
}
