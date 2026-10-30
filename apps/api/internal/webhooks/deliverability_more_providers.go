// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

const providerTokenHeader = "X-Postwave-Provider-Token"

// Resend uses Svix for webhook delivery. The body identifies the email, while
// this header identifies the webhook message and is therefore the replay key.
const resendEventIDHeader = "Svix-Id"

// HandleSendGrid accepts SendGrid event-webhook payloads behind a Moosewave
// edge token. Official SendGrid signed event webhooks use ECDSA with
// X-Twilio-Email-Event-Webhook-* headers over timestamp+raw body; that direct
// verification path is still provider-driver work and must not be advertised as
// fully native SendGrid support.
func (d *DeliverabilityDeps) HandleSendGrid(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, 2<<20)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, 2<<20, err)
		return
	}
	if !d.verifySharedProviderToken(w, r, "sendgrid", d.SendGridToken) {
		return
	}
	var events []map[string]any
	if err := json.Unmarshal(body, &events); err != nil {
		var one map[string]any
		if err := json.Unmarshal(body, &one); err != nil {
			httperror.WriteValidation(w, "bad_json", "request payload is invalid")
			return
		}
		events = []map[string]any{one}
	}
	recorded := 0
	for _, item := range events {
		ev := classifySendGrid(item, body)
		if ev.EventType == "" {
			continue
		}
		if rejectDeliveryWithoutMessageID(w, ev) {
			return
		}
		tenantID := d.resolveTenant(r.Context(), r, sendGridMessageID(item))
		if tenantID == "" {
			if providerCorrelationNeedsRetry(ev) {
				writeRetryableProviderCorrelation(w)
			} else {
				writeJSONErrDeliv(w, http.StatusBadRequest, "tenant_unresolved", "could not resolve tenant")
			}
			return
		}
		if err := d.process(r.Context(), tenantID, ev); err != nil {
			d.log().Error("deliverability: sendgrid process", "err", err.Error(),
				"tenant_id", tenantID, "email_redacted", observability.RedactEmail(ev.Email))
			d.writeProviderProcessError(w, r, err)
			return
		}
		recorded++
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"recorded": recorded})
}

func (d *DeliverabilityDeps) HandleResend(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, 2<<20)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, 2<<20, err)
		return
	}
	if !d.verifySharedProviderToken(w, r, "resend", d.ResendToken) {
		return
	}
	var item map[string]any
	if err := json.Unmarshal(body, &item); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	ev := classifyResend(item, body)
	ev.ProviderID = resendEventID(item, r.Header.Get(resendEventIDHeader))
	if ev.EventType == "" {
		writeJSONOK(w, http.StatusOK, map[string]any{"ignored": firstString(item, "type", "event")})
		return
	}
	if rejectDeliveryWithoutMessageID(w, ev) {
		return
	}
	events, unambiguous := recipientScopedProviderOutcomes(ev)
	if !unambiguous {
		// One message can address several recipients, but an open/click/bounce
		// observation does not identify which member of that set acted or
		// failed. Do not fabricate per-recipient engagement or suppression.
		if ev.EventType == "opened" || ev.EventType == "clicked" {
			writeJSONOK(w, http.StatusOK, map[string]any{"ignored": "recipient_ambiguous"})
		} else {
			writeJSONErrDeliv(w, http.StatusBadRequest, "provider_recipient_ambiguous",
				"provider event does not identify one affected recipient")
		}
		return
	}
	tenantID := d.resolveTenant(r.Context(), r, resendMessageID(item))
	if tenantID == "" {
		if providerCorrelationNeedsRetry(ev) {
			writeRetryableProviderCorrelation(w)
		} else {
			writeJSONErrDeliv(w, http.StatusBadRequest, "tenant_unresolved", "could not resolve tenant")
		}
		return
	}
	for _, recipientEvent := range events {
		if err := d.process(r.Context(), tenantID, recipientEvent); err != nil {
			d.writeProviderProcessError(w, r, err)
			return
		}
	}
	writeJSONOK(w, http.StatusOK, map[string]any{
		"recorded": ev.EventType, "recipients": len(events),
	})
}

func (d *DeliverabilityDeps) HandleSparkPost(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, 2<<20)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, 2<<20, err)
		return
	}
	if !d.verifySharedProviderToken(w, r, "sparkpost", d.SparkPostToken) {
		return
	}
	items := sparkpostEvents(body)
	recorded := 0
	for _, item := range items {
		ev := classifySparkPost(item, body)
		if ev.EventType == "" {
			continue
		}
		if rejectDeliveryWithoutMessageID(w, ev) {
			return
		}
		tenantID := d.resolveTenant(r.Context(), r, sparkPostMessageID(item))
		if tenantID == "" {
			if providerCorrelationNeedsRetry(ev) {
				writeRetryableProviderCorrelation(w)
			} else {
				writeJSONErrDeliv(w, http.StatusBadRequest, "tenant_unresolved", "could not resolve tenant")
			}
			return
		}
		if err := d.process(r.Context(), tenantID, ev); err != nil {
			d.writeProviderProcessError(w, r, err)
			return
		}
		recorded++
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"recorded": recorded})
}

func (d *DeliverabilityDeps) HandleMailerSend(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, 2<<20)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, 2<<20, err)
		return
	}
	if !d.verifySharedProviderToken(w, r, "mailersend", d.MailerSendToken) {
		return
	}
	var item map[string]any
	if err := json.Unmarshal(body, &item); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	ev := classifyMailerSend(item, body)
	if ev.EventType == "" {
		writeJSONOK(w, http.StatusOK, map[string]any{"ignored": firstString(item, "type", "event")})
		return
	}
	if rejectDeliveryWithoutMessageID(w, ev) {
		return
	}
	tenantID := d.resolveTenant(r.Context(), r, mailerSendMessageID(item))
	if tenantID == "" {
		if providerCorrelationNeedsRetry(ev) {
			writeRetryableProviderCorrelation(w)
		} else {
			writeJSONErrDeliv(w, http.StatusBadRequest, "tenant_unresolved", "could not resolve tenant")
		}
		return
	}
	if err := d.process(r.Context(), tenantID, ev); err != nil {
		d.writeProviderProcessError(w, r, err)
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"recorded": ev.EventType, "email": ev.Email})
}

func (d *DeliverabilityDeps) verifySharedProviderToken(w http.ResponseWriter, r *http.Request, provider, token string) bool {
	if token == "" {
		token = d.providerTokenForRequest(r, provider)
	}
	if token == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		writeJSONErrDeliv(w, http.StatusUnauthorized, "webhook_secret_required",
			provider+" webhook token not configured")
		return false
	}
	got := strings.TrimSpace(r.Header.Get(providerTokenHeader))
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Authorization")), "bearer ") {
		got = strings.TrimSpace(r.Header.Get("Authorization")[7:])
	}
	if got == "" || !providerTokenMatches(got, token, provider) {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "bad_signature", "")
		return false
	}
	return true
}

func (d *DeliverabilityDeps) providerTokenForRequest(r *http.Request, provider string) string {
	if d == nil || d.Pool == nil || r == nil {
		return ""
	}
	tenantID := strings.TrimSpace(r.Header.Get(DeliverabilityTenantHeader))
	if tenantID == "" {
		return ""
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return ""
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var token string
	_ = tx.QueryRow(r.Context(), `
SELECT CASE
         WHEN NULLIF(config->>'webhook_token_hash', '') IS NOT NULL
           THEN 'hmac-sha256:' || (config->>'webhook_token_hash')
         ELSE COALESCE(config->>'webhook_token', config->>'token', '')
       END
  FROM tenant_deliverability_providers
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND active = true
 ORDER BY updated_at DESC
 LIMIT 1`, tenantID, provider).Scan(&token)
	_ = tx.Commit(r.Context())
	return strings.TrimSpace(token)
}

func providerTokenMatches(got, token, provider string) bool {
	if digest, ok := strings.CutPrefix(token, "hmac-sha256:"); ok {
		return constantTimeEqHex(
			hashHMACSHA256(got, []byte(providerWebhookTokenDigestDomain)),
			digest,
		)
	}
	if hmac.Equal([]byte(got), []byte(token)) {
		return true
	}
	return constantTimeEqHex(hashHMACSHA256(token, []byte(provider)), got)
}

// Per-provider message-id extractors are shared by tenant resolution and event
// classification. If those two steps read different fields, an event can be
// authenticated and attributed to the right tenant yet silently fail to join
// the transactional message it describes.
func sendGridMessageID(item map[string]any) string {
	return firstString(item, "sg_message_id", "smtp-id", "message_id")
}

func resendMessageID(item map[string]any) string {
	return nestedString(item, "data", "email_id")
}

func resendEventID(item map[string]any, svixID string) string {
	return firstNonEmpty(firstString(item, "id"), svixID)
}

func sparkPostMessageID(item map[string]any) string {
	// message_id is SparkPost's cluster-wide identifier for one message.
	// transmission_id groups the messages produced by a submission and is not
	// interchangeable with it, so using the transmission as a fallback could
	// project one recipient's event onto the wrong transactional row.
	return firstString(item, "message_id")
}

func mailerSendMessageID(item map[string]any) string {
	// Webhook v2 puts the message identity directly on data.message_id. Keep
	// the documented v1/SMTP nesting as a compatibility fallback.
	if id := nestedString(item, "data", "message_id"); id != "" {
		return id
	}
	if id := nestedString(item, "data", "email", "message", "id"); id != "" {
		return id
	}
	return nestedString(item, "data", "message", "id")
}

func classifySendGrid(item map[string]any, raw []byte) classifyOutcome {
	ev := baseProviderOutcome(item, raw, suppressions.SourceSendGrid,
		firstString(item, "email"), firstString(item, "sg_event_id", "event_id"),
		sendGridMessageID(item))
	switch strings.ToLower(firstString(item, "event")) {
	case "delivered":
		ev.EventType = "delivered"
	case "bounce", "dropped":
		ev.EventType = "bounced"
		ev.BounceClass = "hard"
		ev.Reason = firstString(item, "reason", "status", "type")
	case "deferred":
		ev.EventType = "bounced"
		ev.BounceClass = "soft"
		ev.Reason = firstString(item, "reason", "response")
	case "spamreport":
		ev.EventType = "complained"
	case "unsubscribe", "group_unsubscribe":
		ev.EventType = "unsubscribed"
	case "open":
		ev.EventType = "opened"
		ev.UserAgent = firstString(item, "useragent", "user_agent")
		ev.IP = firstString(item, "ip")
	case "click":
		ev.EventType = "clicked"
		ev.LinkIdentity = firstString(item, "url")
		ev.UserAgent = firstString(item, "useragent", "user_agent")
		ev.IP = firstString(item, "ip")
	}
	if machine, ok := item["sg_machine_open"].(bool); ok {
		ev.ProviderSignals = map[string]any{"sg_machine_open": machine}
	}
	ev.OccurredAt = unixFromAny(item["timestamp"])
	return ev
}

func classifyResend(item map[string]any, raw []byte) classifyOutcome {
	data := mapAt(item, "data")
	recipients := stringSliceFromAny(data["to"])
	email := firstEmailFromAny(data["to"])
	if email == "" {
		email = firstString(data, "recipient", "email")
	}
	ev := baseProviderOutcome(data, raw, suppressions.SourceResend, email,
		firstString(item, "id"), resendMessageID(item))
	ev.Recipients = recipients
	switch strings.ToLower(firstString(item, "type", "event")) {
	case "email.delivered":
		ev.EventType = "delivered"
	case "email.bounced", "email.delivery_delayed":
		ev.EventType = "bounced"
		ev.BounceClass = "hard"
		if strings.Contains(strings.ToLower(firstString(item, "type")), "delayed") {
			ev.BounceClass = "soft"
		}
	case "email.complained":
		ev.EventType = "complained"
	case "email.opened":
		ev.EventType = "opened"
		open := mapAt(data, "open")
		ev.UserAgent = firstString(open, "userAgent", "user_agent")
		ev.IP = firstString(open, "ipAddress", "ip_address", "ip")
		if at := timeFromString(firstString(open, "timestamp")); !at.IsZero() {
			ev.OccurredAt = at
		}
	case "email.clicked":
		ev.EventType = "clicked"
		click := mapAt(data, "click")
		ev.LinkIdentity = firstString(click, "link", "url")
		ev.UserAgent = firstString(click, "userAgent", "user_agent")
		ev.IP = firstString(click, "ipAddress", "ip_address", "ip")
		if at := timeFromString(firstString(click, "timestamp")); !at.IsZero() {
			ev.OccurredAt = at
		}
	}
	ev.Reason = nestedString(item, "data", "bounce", "message")
	if ev.OccurredAt.IsZero() {
		ev.OccurredAt = timeFromString(firstString(item, "created_at", "createdAt"))
	}
	return ev
}

func classifySparkPost(item map[string]any, raw []byte) classifyOutcome {
	ev := baseProviderOutcome(item, raw, suppressions.SourceSparkPost,
		firstString(item, "rcpt_to", "raw_rcpt_to", "recipient", "email"),
		firstString(item, "event_id"), sparkPostMessageID(item))
	switch strings.ToLower(firstString(item, "type", "event")) {
	case "delivery":
		ev.EventType = "delivered"
	case "bounce", "out_of_band", "policy_rejection":
		ev.EventType = "bounced"
		ev.BounceClass = "hard"
		if strings.Contains(strings.ToLower(firstString(item, "bounce_class", "reason")), "soft") {
			ev.BounceClass = "soft"
		}
	case "delay":
		ev.EventType = "bounced"
		ev.BounceClass = "soft"
	case "spam_complaint":
		ev.EventType = "complained"
	case "list_unsubscribe", "link_unsubscribe":
		ev.EventType = "unsubscribed"
	case "open", "initial_open", "amp_open", "amp_initial_open":
		ev.EventType = "opened"
		ev.UserAgent = firstString(item, "user_agent", "useragent")
		ev.IP = firstString(item, "ip_address", "ip")
	case "click", "amp_click":
		ev.EventType = "clicked"
		ev.LinkIdentity = firstString(item, "target_link_url", "raw_url")
		ev.UserAgent = firstString(item, "user_agent", "useragent")
		ev.IP = firstString(item, "ip_address", "ip")
	}
	ev.Reason = firstString(item, "reason", "raw_reason", "bounce_class")
	ev.OccurredAt = timeFromString(firstString(item, "timestamp"))
	return ev
}

func classifyMailerSend(item map[string]any, raw []byte) classifyOutcome {
	data := mapAt(item, "data")
	recipient := mapAt(data, "recipient")
	ev := baseProviderOutcome(data, raw, suppressions.SourceMailerSend,
		firstNonEmpty(firstString(data, "email"), firstString(recipient, "email")),
		firstNonEmpty(firstString(data, "id"), firstString(item, "id")),
		mailerSendMessageID(item))
	switch strings.ToLower(firstString(item, "type", "event")) {
	case "activity.delivered", "delivered":
		ev.EventType = "delivered"
	case "activity.hard_bounced", "hard_bounced":
		ev.EventType = "bounced"
		ev.BounceClass = "hard"
	case "activity.soft_bounced", "soft_bounced", "activity.deferred", "deferred":
		ev.EventType = "bounced"
		ev.BounceClass = "soft"
	case "activity.spam_complaint", "spam_complaint":
		ev.EventType = "complained"
	case "activity.unsubscribed", "unsubscribed":
		ev.EventType = "unsubscribed"
	case "activity.opened", "activity.opened_unique", "opened", "opened_unique":
		ev.EventType = "opened"
		ev.UserAgent = firstString(data, "user_agent", "userAgent")
		ev.IP = firstString(data, "ip", "ip_address", "ipAddress")
	case "activity.clicked", "activity.clicked_unique", "clicked", "clicked_unique":
		ev.EventType = "clicked"
		ev.LinkIdentity = firstString(data, "url", "link")
		ev.UserAgent = firstString(data, "user_agent", "userAgent")
		ev.IP = firstString(data, "ip", "ip_address", "ipAddress")
	}
	ev.Reason = firstString(data, "reason", "bounce_message")
	ev.OccurredAt = timeFromString(firstString(item, "created_at"))
	return ev
}

func baseProviderOutcome(
	item map[string]any,
	raw []byte,
	source suppressions.Source,
	email, eventID, messageID string,
) classifyOutcome {
	return classifyOutcome{
		Email:        strings.TrimSpace(email),
		ProviderID:   strings.TrimSpace(eventID),
		MessageID:    strings.TrimSpace(messageID),
		ProviderName: source,
		Raw:          json.RawMessage(append([]byte(nil), raw...)),
	}
}

// recipientScopedProviderOutcomes expands a message-level delivery into
// recipient-level facts. Other event kinds are accepted only when the provider
// names at most one recipient: assigning one bounce/open/click to an entire To
// list would be unsafe. The provider webhook ID remains the replay identity,
// with a recipient digest added only when one notification contains multiple
// independently stored delivery facts.
func recipientScopedProviderOutcomes(ev classifyOutcome) ([]classifyOutcome, bool) {
	recipients := uniqueProviderRecipients(ev.Recipients)
	if len(recipients) <= 1 {
		return []classifyOutcome{ev}, true
	}
	if ev.EventType != "delivered" {
		return nil, false
	}
	events := make([]classifyOutcome, 0, len(recipients))
	for _, recipient := range recipients {
		recipientEvent := ev
		recipientEvent.Email = recipient
		recipientEvent.Recipients = nil
		if ev.ProviderID != "" {
			recipientEvent.ProviderID = recipientScopedProviderEventID(ev.ProviderID, recipient)
		}
		events = append(events, recipientEvent)
	}
	return events, true
}

func recipientScopedProviderEventID(providerEventID, recipient string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(recipient))))
	return strings.TrimSpace(providerEventID) + ":" + hex.EncodeToString(digest[:])
}

func sparkpostEvents(raw []byte) []map[string]any {
	var batch []map[string]any
	if json.Unmarshal(raw, &batch) == nil {
		out := make([]map[string]any, 0, len(batch))
		for _, item := range batch {
			if msys := mapAt(item, "msys"); len(msys) > 0 {
				for _, key := range []string{"message_event", "track_event", "unsubscribe_event"} {
					if m := mapAt(msys, key); len(m) > 0 {
						out = append(out, m)
					}
				}
				continue
			}
			out = append(out, item)
		}
		return out
	}
	var one map[string]any
	if json.Unmarshal(raw, &one) != nil {
		return nil
	}
	if msys := mapAt(one, "msys"); len(msys) > 0 {
		for _, key := range []string{"message_event", "track_event", "unsubscribe_event"} {
			if m := mapAt(msys, key); len(m) > 0 {
				return []map[string]any{m}
			}
		}
	}
	return []map[string]any{one}
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			switch x := v.(type) {
			case string:
				if strings.TrimSpace(x) != "" {
					return strings.TrimSpace(x)
				}
			case json.Number:
				return x.String()
			case float64:
				return strconv.FormatFloat(x, 'f', -1, 64)
			}
		}
	}
	return ""
}

func mapAt(m map[string]any, keys ...string) map[string]any {
	var cur any = m
	for _, key := range keys {
		cm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = cm[key]
	}
	out, _ := cur.(map[string]any)
	return out
}

func nestedString(m map[string]any, keys ...string) string {
	return firstString(mapAt(m, keys[:len(keys)-1]...), keys[len(keys)-1])
}

func firstEmailFromAny(v any) string {
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			if s, ok := item.(string); ok && strings.Contains(s, "@") {
				return strings.TrimSpace(s)
			}
		}
	case string:
		if strings.Contains(x, "@") {
			return strings.TrimSpace(x)
		}
	}
	return ""
}

func stringSliceFromAny(v any) []string {
	var raw []string
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			if value, ok := item.(string); ok {
				raw = append(raw, value)
			}
		}
	case []string:
		raw = append(raw, x...)
	case string:
		raw = append(raw, x)
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func unixFromAny(v any) time.Time {
	switch x := v.(type) {
	case float64:
		return time.Unix(int64(x), 0).UTC()
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return time.Unix(n, 0).UTC()
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64); err == nil {
			return time.Unix(n, 0).UTC()
		}
		return timeFromString(x)
	}
	return time.Time{}
}

func timeFromString(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC()
	}
	// MailerSend's v2 examples use a space rather than RFC3339's `T` while
	// retaining an explicit UTC designator and microseconds.
	if t, err := time.Parse("2006-01-02 15:04:05.999999999Z07:00", raw); err == nil {
		return t.UTC()
	}
	return time.Time{}
}
