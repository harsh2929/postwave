// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// inboundEmailHTMLSanitizer strips active content (script, iframe,
// event handlers, javascript: URLs) from inbound HTML bodies before
// they're persisted. The strict policy is intentional: inbound email
// HTML is subscriber-supplied and the dashboard renders it for the
// operator — an unsanitized BodyHTML lets a subscriber XSS the
// operator's session. Audit (inbound-email CRITICAL #1).
//
// We use bluemonday.StrictPolicy() which keeps text content + minimal
// formatting (br, p) and strips everything else. If operators
// complain about losing email formatting in the inbox view, escalate
// to bluemonday.UGCPolicy() — but never to a permissive policy.
var inboundEmailHTMLSanitizer = bluemonday.StrictPolicy()

// inboundEmailHeaderSafe strips CR/LF/NUL from a header-derived
// string. Used on subject + in_reply_to so a future forward-action
// can re-emit them as MIME headers without injection.
// Audit (inbound-email HIGH #3).
func inboundEmailHeaderSafe(s string) string {
	if s == "" {
		return s
	}
	r := strings.NewReplacer("\r", " ", "\n", " ", "\x00", "")
	out := r.Replace(s)
	if len(out) > 998 { // RFC 5322 max line length
		out = out[:998]
	}
	return out
}

// inboundEmailMaxFieldBytes caps individual string fields before DB
// insert. Total body is capped at 5 MiB at the read layer; per-field
// caps prevent one field consuming the whole budget.
// Audit (inbound-email MED #5).
const inboundEmailMaxFieldBytes = 64 * 1024 // 64 KiB

func inboundEmailFieldCap(s string) string {
	if len(s) > inboundEmailMaxFieldBytes {
		return s[:inboundEmailMaxFieldBytes]
	}
	return s
}

// Deps bundles handler dependencies.
//
// Actions is the inbound-route action executor. When nil, route matches
// still get recorded to inbound_route_matches but no side-effects fire.
// main.go wires the production executor with a Sender + AutomationServiceURL.
type Deps struct {
	Repo                 *Repo
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
	Actions              *ActionDeps
	Logger               *slog.Logger
	// Classifier (G3 follow-up), when set, is invoked off the request
	// path right after an inbound reply linked to a campaign is stored,
	// so the reply is auto-classified. nil = classification stays
	// operator-triggered (the reply-loop kill-switch leaves it nil).
	Classifier func(ctx context.Context, tenantID string, emailID int64)
	// Mirror, when set, lands the inbound email in the support spine
	// (service_suite) so first-party replies appear in the helpdesk inbox.
	// nil = no mirroring. Fired off the request path; best-effort.
	Mirror func(ctx context.Context, tenantID string, em Email)
}

var defaultAutomationFanoutHTTPClient = &http.Client{Timeout: 10 * time.Second}

const inboundEmailIngestMaxBodyBytes int64 = 5 << 20 // 5 MiB

var (
	inboundEmailAuthRejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "inbound_email_auth_rejected_total",
		Help: "Signed inbound-email requests rejected for unavailable secrets, timestamps, or HMAC verification.",
	})
	inboundEmailReplayIdentityRejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "inbound_email_replay_identity_rejected_total",
		Help: "Signed inbound-email requests rejected because their stable replay identity was missing or invalid.",
	})
	inboundEmailDuplicateAcceptedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "inbound_email_duplicate_accepted_total",
		Help: "Exact inbound-email retries acknowledged without re-running route or automation side effects.",
	})
	inboundEmailReplayConflictTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "inbound_email_replay_conflict_total",
		Help: "Inbound-email requests rejected because an existing replay identity was reused with different raw bytes.",
	})
)

// MountAdminRoutes registers the tenant-scoped admin endpoints.
func (d *Deps) MountAdminRoutes(r chi.Router) {
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/inbound-emails", d.List)
	r.With(admin).Get("/api/v1/inbound-emails/endpoint", d.GetEndpoint)
	r.With(admin).Post("/api/v1/inbound-emails/endpoint/rotate", d.RotateEndpoint)
}

// MountPublicRoutes registers the unauthenticated ingest endpoint.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	r.Post("/api/public/inbound-email/{slug}", d.Ingest)
}

// GetEndpoint returns only metadata for the tenant's inbound-email endpoint.
// It never provisions or decrypts a signing secret.
func (d *Deps) GetEndpoint(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	ep, err := d.Repo.GetEndpoint(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "endpoint_not_found", "inbound email endpoint is not provisioned; rotate to create one")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, ep)
}

// RotateEndpoint creates or rotates the signing secret and reveals plaintext
// exactly once. Later GETs return metadata only.
func (d *Deps) RotateEndpoint(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	ep, err := d.Repo.RotateSecret(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrSecretUnavailable) {
			if d.Logger != nil {
				d.Logger.Error("inbound-email signing-secret rotation unavailable", "tenant_id", t.ID, "err", err)
			}
			httperror.Write(w, http.StatusServiceUnavailable, "signing_unavailable", "inbound email signing encryption is unavailable")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	audit.EmitOrLog(
		r.Context(), d.Repo.Pool,
		"inbound_email.endpoint_secret_rotated", "inbound_email_endpoint", ep.ID,
		nil,
		map[string]any{
			"secret_configured": true,
			"rotation_required": false,
		},
		map[string]any{"one_time_reveal": true},
	)
	writeJSON(w, http.StatusOK, ep)
}

// List GET /api/v1/inbound-emails?subscriber_id=&campaign_id=&limit=
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	q := r.URL.Query()
	out, err := d.Repo.List(r.Context(), t.ID,
		q.Get("subscriber_id"), q.Get("campaign_id"),
		atoiDefault(q.Get("limit"), 50))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// IngestPayload accepts a Postmark/SES-style JSON envelope after the handler
// authenticates the timestamped raw bytes and claims a stable replay identity.
// Only the fields needed by routing and reply attribution are parsed.
type IngestPayload struct {
	From      string                 `json:"from"`
	FromFull  map[string]interface{} `json:"FromFull,omitempty"`
	To        string                 `json:"to"`
	Subject   string                 `json:"subject"`
	TextBody  string                 `json:"text"`
	HtmlBody  string                 `json:"html"`
	MessageID string                 `json:"message_id"`
	InReplyTo string                 `json:"in_reply_to"`
	// Postmark variants.
	PMTextBody  string                   `json:"TextBody,omitempty"`
	PMHtmlBody  string                   `json:"HtmlBody,omitempty"`
	PMSubject   string                   `json:"Subject,omitempty"`
	PMMessageID string                   `json:"MessageID,omitempty"`
	PMHeaders   []map[string]interface{} `json:"Headers,omitempty"`
}

func (p IngestPayload) flat() (from, to, subject, msgID, inReplyTo, text, html string) {
	from = p.From
	to = p.To
	subject = first(p.Subject, p.PMSubject)
	msgID = first(p.MessageID, p.PMMessageID)
	inReplyTo = p.InReplyTo
	text = first(p.TextBody, p.PMTextBody)
	html = first(p.HtmlBody, p.PMHtmlBody)
	for _, h := range p.PMHeaders {
		name, _ := h["Name"].(string)
		val, _ := h["Value"].(string)
		switch strings.ToLower(name) {
		case "in-reply-to":
			if inReplyTo == "" {
				inReplyTo = val
			}
		case "message-id":
			if msgID == "" {
				msgID = val
			}
		}
	}
	return
}

// replyClassificationHeaders returns only the bounded header vocabulary used
// by the deterministic canonical reply classifier. Unknown provider headers
// never cross the package boundary, and raw values remain transient.
func (p IngestPayload) replyClassificationHeaders() map[string]string {
	allowed := map[string]string{
		"auto-submitted":           "Auto-Submitted",
		"precedence":               "Precedence",
		"x-autoreply":              "X-Autoreply",
		"x-autorespond":            "X-Autorespond",
		"x-auto-response-suppress": "X-Auto-Response-Suppress",
		"content-type":             "Content-Type",
		"return-path":              "Return-Path",
	}
	out := map[string]string{}
	for _, header := range p.PMHeaders {
		name, _ := header["Name"].(string)
		value, _ := header["Value"].(string)
		canonical, ok := allowed[strings.ToLower(strings.TrimSpace(name))]
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		out[canonical] = inboundEmailFieldCap(inboundEmailHeaderSafe(value))
	}
	return out
}

// Ingest POST /api/public/inbound-email/{slug}
func (d *Deps) Ingest(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	_, tenantID, secret, lookupErr := d.Repo.LookupBySlug(r.Context(), slug)
	if lookupErr != nil {
		if errors.Is(lookupErr, ErrSecretUnavailable) {
			inboundEmailAuthRejectedTotal.Inc()
			if d.Logger != nil {
				d.Logger.Error("inbound-email signing-secret lookup unavailable", "err", lookupErr)
			}
			httperror.Write(w, http.StatusServiceUnavailable, "signing_unavailable", "inbound email endpoint must be rotated before use")
			return
		}
		if !errors.Is(lookupErr, ErrNotFound) {
			httperror.WriteInternal(w, d.Logger, lookupErr, r.Context())
			return
		}
		httperror.Write(w, http.StatusNotFound, "unknown_endpoint", "inbound email endpoint not found")
		return
	}
	defer clearSecret(secret)
	body, lookupErr := httpbody.ReadAtMost(r.Body, inboundEmailIngestMaxBodyBytes)
	if lookupErr != nil {
		if errors.Is(lookupErr, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "inbound email payload exceeds 5 MiB")
			return
		}
		httperror.WriteValidation(w, "read_failed", "request could not be processed")
		return
	}
	// Authentication is strict and replay-bounded: the signature covers
	// `<unix-seconds>.<raw-body>`, and no legacy empty-secret/body-only path
	// can reach parsing or persistence.
	authErr := authenticateInboundEmail(
		secret,
		body,
		r.Header.Get("X-Postwave-Inbound-Timestamp"),
		r.Header.Get("X-Postwave-Inbound-Signature"),
		time.Now(),
	)
	if authErr != nil {
		inboundEmailAuthRejectedTotal.Inc()
		if errors.Is(authErr, errInboundEmailSecretUnavailable) {
			httperror.Write(w, http.StatusServiceUnavailable, "signing_unavailable", "inbound email endpoint must be rotated before use")
			return
		}
		code := "bad_signature"
		switch {
		case errors.Is(authErr, errInboundEmailMissingTimestamp):
			code = "missing_timestamp"
		case errors.Is(authErr, errInboundEmailBadTimestamp):
			code = "bad_timestamp"
		case errors.Is(authErr, errInboundEmailStaleTimestamp):
			code = "stale_timestamp"
		}
		httperror.Write(w, http.StatusUnauthorized, code, "request authentication failed")
		return
	}
	var p IngestPayload
	if err := json.Unmarshal(body, &p); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	from, to, subject, msgID, inReplyTo, text, html := p.flat()
	if from == "" {
		httperror.WriteValidation(w, "missing_field", "from address is required")
		return
	}
	eventID := strings.TrimSpace(r.Header.Get("X-Postwave-Inbound-Event-Id"))
	if eventID == "" {
		eventID = msgID
	}
	replayKey, lookupErr := inboundEmailReplayKey(eventID)
	if lookupErr != nil {
		inboundEmailReplayIdentityRejectedTotal.Inc()
		code := "missing_event_id"
		if errors.Is(lookupErr, errInboundEmailEventIDTooLong) {
			code = "invalid_event_id"
		}
		httperror.WriteValidation(w, code, lookupErr.Error())
		return
	}
	// Header-safe + field-cap + HTML-sanitize subscriber-supplied
	// content before persistence. Audit CRITICAL #1 + HIGH #3 + MED #5.
	subject = inboundEmailFieldCap(inboundEmailHeaderSafe(subject))
	msgID = inboundEmailHeaderSafe(msgID)
	inReplyTo = inboundEmailHeaderSafe(inReplyTo)
	from = inboundEmailFieldCap(from)
	to = inboundEmailFieldCap(to)
	text = inboundEmailFieldCap(text)
	html = inboundEmailFieldCap(inboundEmailHTMLSanitizer.Sanitize(html))
	subID, lookupErr := d.Repo.SubscriberByEmail(r.Context(), tenantID, from)
	if lookupErr != nil {
		httperror.WriteInternal(w, d.Logger, lookupErr, r.Context())
		return
	}
	campID, lookupErr := d.Repo.CampaignByMessageID(r.Context(), tenantID, inReplyTo)
	if lookupErr != nil {
		if errors.Is(lookupErr, ErrInvalidMessageID) {
			// Sender-controlled threading headers are allowed to be malformed;
			// retain the message for manual review, but grant them no campaign
			// identity. A malformed header must not create a provider retry loop.
			campID = ""
		} else {
			// Persisting an otherwise valid inbound message without its campaign
			// identity would make an exact provider retry look successful while
			// permanently losing reply attribution. Fail before the replay claim so
			// the provider can retry after the lookup or ambiguity is repaired.
			if errors.Is(lookupErr, ErrAmbiguousMessageID) {
				httperror.Write(w, http.StatusServiceUnavailable, "reply_identity_ambiguous", "reply identity is temporarily unavailable")
				return
			}
			httperror.WriteInternal(w, d.Logger, lookupErr, r.Context())
			return
		}
	}
	em := Email{
		SubscriberID: subID,
		CampaignID:   campID,
		From:         from,
		To:           to,
		Subject:      subject,
		MessageID:    msgID,
		InReplyTo:    inReplyTo,
		BodyText:     text,
		BodyHTML:     html,
		ReplyHeaders: p.replyClassificationHeaders(),
	}
	id, duplicate, lookupErr := d.Repo.InsertIdempotent(
		r.Context(), tenantID, em, replayKey, inboundEmailBodyHash(body),
	)
	if lookupErr != nil {
		if errors.Is(lookupErr, ErrReplayConflict) {
			inboundEmailReplayConflictTotal.Inc()
			httperror.Write(w, http.StatusConflict, "event_id_conflict", "event id was already used for a different payload")
			return
		}
		if errors.Is(lookupErr, ErrCanonicalReplyWriterUnavailable) {
			httperror.Write(w, http.StatusServiceUnavailable, "canonical_reply_unavailable", "canonical reply ingestion is temporarily unavailable")
			return
		}
		httperror.WriteInternal(w, d.Logger, lookupErr, r.Context())
		return
	}
	if duplicate {
		inboundEmailDuplicateAcceptedTotal.Inc()
		writeJSON(w, http.StatusAccepted, map[string]any{"id": id, "duplicate": true})
		return
	}
	// Run the route matcher against this email. Side effects (counter
	// bump + history record) are best-effort and fired in a goroutine
	// so they don't slow the 202 path.
	//
	// NOTE: action execution (webhook/forward/automation_trigger) is
	// The matcher records hits + bumps counters; when Actions is wired
	// (production) each matched rule's action pipeline runs too —
	// tag / webhook / automation_trigger / forward / store_only.
	go d.recordRouteMatchesAsync(tenantID, to, subject, from, id, em)
	if d.AutomationServiceURL != "" && subID != "" {
		go d.fanout(tenantID, from, campID, text)
	}
	// G3 follow-up: auto-classify campaign replies off the request path.
	// Fresh timeout context — the request ctx is canceled once we 202.
	if campID != "" && d.Classifier != nil {
		go func(emailID int64) {
			cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			d.Classifier(cctx, tenantID, emailID)
		}(id)
	}
	// Mirror into the support spine off the request path (fresh ctx, the
	// request ctx is canceled once we 202). Best-effort.
	if d.Mirror != nil {
		go func(e Email) {
			cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			d.Mirror(cctx, tenantID, e)
		}(em)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id})
}

func clearSecret(secret []byte) {
	for i := range secret {
		secret[i] = 0
	}
}

// recordRouteMatchesAsync runs MatchRoutes off the request path and:
//
//  1. records the hits to inbound_route_matches
//  2. bumps the rule summary (last_matched_at + match_count)
//  3. executes each matched rule's action pipeline (tag / webhook /
//     automation_trigger / forward / store_only)
//
// All errors are swallowed — the routing system is best-effort and a
// failing webhook should never bubble back to the public ingest as a
// 5xx (the email was already persisted; the retry would re-insert).
//
// Action execution has a generous 30s budget because webhook / forward
// may need to wait on their respective upstreams. Matching + counter
// updates fit comfortably under 5s and run before the action loop.
func (d *Deps) recordRouteMatchesAsync(
	tenantID, recipient, subject, fromEmail string,
	inboundEmailID int64,
	parsedEmail Email,
) {
	if d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	matchCtx, matchCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer matchCancel()
	matches, err := MatchRoutes(matchCtx, d.Repo.Pool, tenantID, recipient, subject, fromEmail)
	if err != nil || len(matches) == 0 {
		return
	}
	ids := make([]string, 0, len(matches))
	for _, m := range matches {
		ids = append(ids, m.ID)
	}
	BumpRouteHits(matchCtx, d.Repo.Pool, tenantID, ids)
	// v2: capture per-route match ids so action runs can be linked
	// back to the match row that fired them.
	matchByRoute := RecordRouteMatches(matchCtx, d.Repo.Pool, tenantID, ids, inboundEmailID,
		recipient, subject, fromEmail)

	// Side-effects. Skip when Actions is nil (test / dev mode where
	// the operator hasn't wired a Sender + automation URL yet).
	if d.Actions == nil {
		return
	}
	actCtx, actCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer actCancel()
	for _, m := range matches {
		matchID := matchByRoute[m.ID]
		d.Actions.ExecuteActions(actCtx, tenantID, m, parsedEmail, inboundEmailID, matchID)
	}
}

// LinkByMessageID is the exported helper used by the unit test for
// message-id linking semantics. It calls CampaignByMessageID.
func LinkByMessageID(repo *Repo, ctx context.Context, tenantID, messageID string) (string, error) {
	return repo.CampaignByMessageID(ctx, tenantID, messageID)
}

func (d *Deps) fanout(tenantID, subscriberEmail, campID, body string) {
	payload := map[string]any{
		"tenant_id":        tenantID,
		"event_type":       "email_reply",
		"subscriber_email": subscriberEmail,
		"campaign_id":      campID,
		"payload": map[string]any{
			"body":      body,
			"body_text": body,
		},
	}
	buf, _ := json.Marshal(payload)
	client := d.HTTPClient
	if client == nil {
		client = defaultAutomationFanoutHTTPClient
	}
	url, err := automationclient.EventURL(d.AutomationServiceURL)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(d.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
}

func first(opts ...string) string {
	for _, s := range opts {
		if s != "" {
			return s
		}
	}
	return ""
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
