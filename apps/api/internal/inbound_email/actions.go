// SPDX-License-Identifier: AGPL-3.0-only
//
// actions.go — execute the action pipeline attached to an inbound
// route after a match. Wired into Ingest via Deps.runActionsAsync.
//
// Five action kinds, executed in the order they appear on the route:
//
//   tag                 array_append on inbound_emails.tags
//   automation_trigger  POST to the automation service (event_type)
//   webhook             POST to a tenant-configured URL with optional
//                       Bearer / HMAC auth, via the SSRF-safe transport
//   forward             re-emit the parsed body via the ListmonkSender
//                       to a new To: address
//   store_only          no-op (the inbound_emails row already exists;
//                       this is a "halt without side-effects" marker)
//
// Per-action failures are logged but do NOT halt the rest of the
// pipeline — the inbound_emails row write is the durable contract,
// downstream fanout is best-effort. This mirrors the docstring on the
// inbound_email package.

package inbound_email

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// Sender is the narrow shape this package needs from the sending
// pipeline. apps/api/internal/sending.ListmonkSender satisfies it;
// tests pass a fake. Kept here (not imported from `sending`) so
// inbound_email doesn't pull in the entire send pipeline as a
// compile-time dependency.
type Sender interface {
	Send(ctx context.Context, tenantID, email, subject, htmlBody string) error
}

// ActionDeps wires the action executor. All fields are optional:
//
//   - Pool        (required) — `tag` action writes to inbound_emails.
//   - HTTP        used by `webhook` action. Defaults to the SSRF-safe
//     transport from outbound_webhooks; nil falls back to
//     a basic 10s client.
//   - Sender      used by `forward` action. When nil, the action fails and
//     records "no sender configured".
//   - AutomationServiceURL + InternalAPIToken — used by
//     `automation_trigger`. Empty URL fails and is recorded.
//   - Logger      where per-action results are written. nil → /dev/null.
type ActionDeps struct {
	Pool                 *db.Pool
	HTTP                 *http.Client
	Sender               Sender
	AutomationServiceURL string
	InternalAPIToken     string
	Logger               *slog.Logger
}

// ExecuteActions runs every action on `route` in order against the
// supplied email + (already-persisted) inbound_emails row id.
//
// v2 changes (driven by the comprehensive inbound-routes audit):
//
//   - Honours the per-route retry budget (Route.ActionRetryMax with
//     exponential backoff on Route.ActionRetryBackoffSeconds). Only
//     retryable kinds (webhook, automation_trigger, forward) are
//     retried; tag and store_only run once.
//
//   - Writes one inbound_route_action_runs row per action attempt
//     capturing kind / status / attempts / http_status (when
//     applicable) / response_snippet / error / duration so the UI
//     can answer "did my webhook actually fire?" without a slog
//     archaeology session.
//
//   - Increments the Prometheus InboundRouteMatchesTotal counter
//     (declared since v1 but never `.Inc()`'d). Grafana dashboards
//     keyed on this metric now show real data.
//
// `matchID` may be 0 when the caller doesn't have one (replay flow);
// the run-row writes NULL match_id in that case.
func (a *ActionDeps) ExecuteActions(
	ctx context.Context,
	tenantID string,
	route Route,
	email Email,
	inboundEmailID int64,
	matchID int64,
) {
	if a == nil || a.Pool == nil {
		return
	}
	for i, act := range route.Actions {
		start := time.Now()
		res, attempts := a.executeWithRetry(ctx, tenantID, route, act, email, inboundEmailID)
		duration := time.Since(start)
		// Run-row capture is best-effort; failure to write the audit
		// trail can't fail the action pipeline (and the action's own
		// failure has already been logged regardless).
		a.recordActionRun(ctx, tenantID, route, i, matchID, act.Kind, attempts, res, duration)
		if res.err != nil {
			a.log("action failed",
				"route_id", route.ID,
				"route_name", route.Name,
				"action_index", i,
				"action_kind", act.Kind,
				"attempts", attempts,
				"err", res.err.Error(),
			)
		}
	}
}

// executeOne dispatches by kind. Returned error is logged by the
// caller; we keep this signature returning error so unit tests can
// assert the failure mode.
func (a *ActionDeps) executeOne(
	ctx context.Context,
	tenantID string,
	route Route,
	act RouteAction,
	email Email,
	inboundEmailID int64,
) error {
	switch act.Kind {
	case "tag":
		return a.doTag(ctx, tenantID, act, inboundEmailID)
	case "automation_trigger":
		return a.doAutomationTrigger(ctx, tenantID, route, act, email)
	case "webhook":
		_, _, err := a.doWebhook(ctx, tenantID, route, act, email, inboundEmailID)
		return err
	case "forward":
		return a.doForward(ctx, tenantID, route, act, email)
	case "store_only":
		// Intentional no-op. The inbound_emails row exists; nothing
		// more to do. Returning nil avoids logging a noisy "unknown
		// kind" error.
		return nil
	default:
		return fmt.Errorf("unknown action kind %q", act.Kind)
	}
}

/* ---------- tag ---------- */

// doTag appends the configured tag to inbound_emails.tags. Idempotent —
// re-firing the same action doesn't duplicate.
//
// Uses array_append + array_remove(...) to keep the list deduped
// while preserving insertion order. The whole UPDATE runs inside the
// tenant-scoped tx so RLS applies.
func (a *ActionDeps) doTag(
	ctx context.Context,
	tenantID string,
	act RouteAction,
	inboundEmailID int64,
) error {
	tag := strings.TrimSpace(act.Tag)
	if tag == "" {
		return errors.New("tag action: tag value is empty")
	}
	tx, err := db.WithTenant(ctx, a.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// array_remove first so we end with a deduped list. Postgres
	// array_append on an absent value is what we want — set semantics
	// without losing ordering vs an unordered jsonb set.
	if _, err := tx.Exec(ctx, `
UPDATE inbound_emails
   SET tags = array_append(array_remove(COALESCE(tags, '{}'::text[]), $2), $2)
 WHERE id = $1`, inboundEmailID, tag); err != nil {
		return fmt.Errorf("tag update: %w", err)
	}
	return tx.Commit(ctx)
}

/* ---------- automation_trigger ---------- */

// doAutomationTrigger POSTs to the automation service so the matching
// automation fires for the email's sender (treated as the subscriber
// touched by this event).
//
// Body shape mirrors the existing inbound-email fanout (handlers.go)
// so the automation service doesn't need a new event handler — only
// the event_type changes.
func (a *ActionDeps) doAutomationTrigger(
	ctx context.Context,
	tenantID string,
	route Route,
	act RouteAction,
	email Email,
) error {
	if a.AutomationServiceURL == "" {
		return errors.New("automation_trigger: AutomationServiceURL not configured")
	}
	eventType := strings.TrimSpace(act.EventType)
	if eventType == "" {
		return errors.New("automation_trigger: event_type is empty")
	}
	url, err := automationclient.EventURL(a.AutomationServiceURL)
	if err != nil {
		return fmt.Errorf("automation_trigger: bad URL: %w", err)
	}
	payload := map[string]any{
		"tenant_id":        tenantID,
		"event_type":       eventType,
		"subscriber_email": email.From,
		"campaign_id":      email.CampaignID,
		"payload": map[string]any{
			"subject":    email.Subject,
			"body":       email.BodyText,
			"body_text":  email.BodyText,
			"body_html":  email.BodyHTML,
			"route_id":   route.ID,
			"route_name": route.Name,
		},
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := strings.TrimSpace(a.InternalAPIToken); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := a.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("automation_trigger: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("automation_trigger: upstream %d", resp.StatusCode)
	}
	return nil
}

/* ---------- webhook ---------- */

// doWebhook POSTs the parsed email to the route's configured URL with
// optional Bearer or HMAC auth. Uses the SSRF-safe transport so a
// tenant can't point this at an internal-network address.
//
// The signature header matches the audit-sinks generic-http path:
//
//	X-Postwave-Inbound-Signature: sha256=<hex(hmac(secret, body))>
//
// We include route_id + match metadata in the envelope so receivers
// can dedupe (same inbound_email → multiple route matches → multiple
// webhook POSTs).
//
// Returns (status, snippet, error) so the retry executor records the
// REAL upstream HTTP status + a small response-body sample on the
// audit row, without needing a separate "rich" duplicate of this
// function.
//
// Phase-0 (p0-inbound-routes-double-emit) collapsed the prior trio of
// doWebhookEmitWithResp / doWebhookRich / doWebhookWithCapture into
// this single executor. The old layering allowed the retry budget to
// trigger up to 2× the intended POSTs per attempt because each "rich"
// helper re-entered doWebhook to issue another HTTP request just to
// capture the response. There is now EXACTLY ONE HTTP POST per call.
func (a *ActionDeps) doWebhook(
	ctx context.Context,
	tenantID string,
	route Route,
	act RouteAction,
	email Email,
	inboundEmailID int64,
) (int, string, error) {
	url := strings.TrimSpace(act.URL)
	if url == "" {
		return 0, "", errors.New("webhook: url is empty")
	}
	payload := map[string]any{
		"tenant_id":  tenantID,
		"route_id":   route.ID,
		"route_name": route.Name,
		"matched_at": time.Now().UTC().Format(time.RFC3339Nano),
		"email": map[string]any{
			"id":          inboundEmailID,
			"from":        email.From,
			"to":          email.To,
			"subject":     email.Subject,
			"body_text":   email.BodyText,
			"body_html":   email.BodyHTML,
			"message_id":  email.MessageID,
			"in_reply_to": email.InReplyTo,
		},
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// Bearer auth from action.extra is intentionally NOT supported —
	// action.extra is operator-supplied JSONB and routing through it
	// would let an operator set "Authorization: ..." on a webhook to
	// an arbitrary URL via the UI. Keep auth scoped to the dedicated
	// fields the action editor exposes; future kinds can declare more.
	if secret := extraString(act, "hmac_secret"); secret != "" {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		req.Header.Set("X-Postwave-Inbound-Signature",
			"sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := a.httpClient().Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("webhook: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	snippet := readSnippet(resp.Body)
	status := resp.StatusCode
	if status >= 400 {
		return status, snippet, fmt.Errorf("webhook: upstream %d", status)
	}
	return status, snippet, nil
}

/* ---------- forward ---------- */

// doForward re-sends the email to a new To: address using the
// tenant's configured ListmonkSender. The Subject is prefixed with
// "Fwd:" only when the original subject doesn't already start with it
// (case-insensitive). The body is the original HTML if present, else
// the text body wrapped in a <pre> so whitespace survives.
//
// IMPORTANT: this uses the *transactional* path on ListmonkSender,
// which still flows through tenant_sending_settings (rate limit +
// quiet hours). A forward fired during quiet hours will be deferred
// by the sender, not lost.
func (a *ActionDeps) doForward(
	ctx context.Context,
	tenantID string,
	route Route,
	act RouteAction,
	email Email,
) error {
	if a.Sender == nil {
		return errors.New("forward: no ListmonkSender configured")
	}
	to := strings.TrimSpace(act.To)
	if to == "" {
		return errors.New("forward: to is empty")
	}
	subject := email.Subject
	if !strings.HasPrefix(strings.ToLower(subject), "fwd:") &&
		!strings.HasPrefix(strings.ToLower(subject), "re:") {
		subject = "Fwd: " + subject
	}
	html := email.BodyHTML
	if html == "" {
		// Wrap plain text in <pre> so paragraph breaks survive the
		// Listmonk HTML-only transport.
		html = "<pre style=\"font-family:inherit;white-space:pre-wrap\">" +
			htmlEscape(email.BodyText) +
			"</pre>"
	}
	header := fmt.Sprintf(
		`<p style="color:#888;font-size:12px;margin-bottom:8px">Forwarded by Moosewave route %q. Original from %s, to %s.</p>`,
		route.Name, htmlEscape(email.From), htmlEscape(email.To))
	return a.Sender.Send(ctx, tenantID, to, subject, header+html)
}

/* ---------- helpers ---------- */

func (a *ActionDeps) httpClient() *http.Client {
	if a.HTTP != nil {
		return a.HTTP
	}
	// Default to the SSRF-safe transport so misconfigured webhook
	// URLs can't be pointed at the internal network. 10s mirrors the
	// outbound_webhooks default.
	return outbound_webhooks.NewSecureHTTPClient(nil)
}

func (a *ActionDeps) log(msg string, kv ...any) {
	if a.Logger == nil {
		return
	}
	a.Logger.Warn(msg, kv...)
}

// extraString reads a string value out of RouteAction.Extra. Returns
// "" when the key is absent or non-string. Used by doWebhook so the
// HMAC secret + future per-action knobs can live on action.extra
// without bloating the RouteAction struct with kind-specific fields.
func extraString(a RouteAction, key string) string {
	if a.Extra == nil {
		return ""
	}
	v, ok := a.Extra[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

// htmlEscape is a tiny HTML-escaper for the forward body wrapper.
// Avoids pulling in html/template just to escape four characters.
func htmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
	)
	return r.Replace(s)
}
