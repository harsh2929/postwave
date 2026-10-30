package sms

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const smsProviderWebhookMaxBodyBytes int64 = 1 << 20 // 1 MiB
const maxBandwidthWebhookEvents = 100

var errSMSProviderWebhookBodyTooLarge = errors.New("sms provider webhook payload too large")
var errSMSProviderReplayIdentityMissing = errors.New("stable provider message id is required")

type normalizedProviderWebhook struct {
	Provider          string
	EventID           string
	EventType         string
	Direction         string
	SenderProfileID   string
	From              string
	To                string
	Body              string
	ProviderMessageID string
	Status            string
	ErrorCode         string
	ErrorMessage      string
	ProviderProfileID string
	Metadata          map[string]any
}

func (d *Deps) TelnyxWebhook(w http.ResponseWriter, r *http.Request) {
	if !smsProviderCallbackReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_callback_release_held", "hosted SMS provider callbacks require a tenant-bound credential and provider-account ownership resolver"))
		return
	}
	tenantID := chi.URLParam(r, "tenant_id")
	if tenantID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_tenant", "tenant_id path parameter is required"))
		return
	}
	body, err := readProviderWebhookBody(r, smsProviderWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, errSMSProviderWebhookBodyTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "provider webhook payload exceeds 1 MiB"))
			return
		}
		if errors.Is(err, httpbody.ErrUnsupportedMediaType) {
			httpbody.WriteError(w, err)
			return
		}
		httperror.WriteValidation(w, "bad_body", "provider webhook body could not be read")
		return
	}
	if !validTelnyxRequest(os.Getenv("TELNYX_PUBLIC_KEY"), r.Header.Get("telnyx-timestamp"), body, r.Header.Get("telnyx-signature-ed25519"), time.Now()) {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "invalid Telnyx signature"))
		return
	}
	event, err := parseTelnyxWebhook(body)
	if err != nil {
		httperror.WriteValidation(w, "bad_webhook", "provider webhook payload could not be parsed")
		return
	}
	if event.Direction != "ignored" {
		destination := event.To
		if event.Direction == "outbound" {
			destination = event.From
		}
		event.SenderProfileID, err = d.store().ResolveProviderWebhookSender(r.Context(), tenantID, event.Provider, destination, event.ProviderProfileID)
		if err != nil {
			d.writeProviderBindingError(w, r, tenantID, err)
			return
		}
	}
	if err := d.applyProviderWebhook(r, tenantID, event); err != nil {
		d.writeProviderWebhookApplyError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) BandwidthWebhook(w http.ResponseWriter, r *http.Request) {
	if !smsProviderCallbackReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_callback_release_held", "hosted SMS provider callbacks require a tenant-bound credential and provider-account ownership resolver"))
		return
	}
	tenantID := chi.URLParam(r, "tenant_id")
	if tenantID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_tenant", "tenant_id path parameter is required"))
		return
	}
	if !validBandwidthRequest(r) {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "invalid Bandwidth webhook credentials"))
		return
	}
	body, err := readProviderWebhookBody(r, smsProviderWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, errSMSProviderWebhookBodyTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "provider webhook payload exceeds 1 MiB"))
			return
		}
		if errors.Is(err, httpbody.ErrUnsupportedMediaType) {
			httpbody.WriteError(w, err)
			return
		}
		httperror.WriteValidation(w, "bad_body", "provider webhook body could not be read")
		return
	}
	events, err := parseBandwidthWebhooks(body)
	if err != nil {
		httperror.WriteValidation(w, "bad_webhook", "provider webhook payload could not be parsed")
		return
	}
	for _, event := range events {
		if event.Direction != "ignored" {
			destination := event.To
			if event.Direction == "outbound" {
				destination = event.From
			}
			event.SenderProfileID, err = d.store().ResolveProviderWebhookSender(r.Context(), tenantID, event.Provider, destination, event.ProviderProfileID)
			if err != nil {
				d.writeProviderBindingError(w, r, tenantID, err)
				return
			}
		}
		if err := d.applyProviderWebhook(r, tenantID, event); err != nil {
			d.writeProviderWebhookApplyError(w, r, tenantID, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "events": len(events)})
}

func (d *Deps) writeProviderBindingError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrProviderTenantBinding) {
		writeJSON(w, http.StatusForbidden, errEnv("webhook_tenant_binding_mismatch", "provider receiver identity does not belong to this tenant"))
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func (d *Deps) applyProviderWebhook(r *http.Request, tenantID string, event normalizedProviderWebhook) error {
	switch event.Direction {
	case "inbound":
		if strings.TrimSpace(event.ProviderMessageID) == "" {
			return errSMSProviderReplayIdentityMissing
		}
		msg, autoReply, duplicate, err := d.store().RecordInbound(
			r.Context(),
			tenantID,
			event.SenderProfileID,
			event.Provider,
			event.From,
			event.Body,
			event.ProviderMessageID,
			event.Metadata,
		)
		if err != nil {
			return err
		}
		if duplicate {
			return nil
		}
		observeSMSInbound(event.Provider, ClassifyInbound(event.Body))
		// Same announcement the Twilio webhook makes (COMMERCE#2). Wired at
		// BOTH inbound entry points on purpose: an operator on Telnyx or
		// Bandwidth is no less entitled to know a subscriber replied.
		d.notifyInbound(tenantID, msg, event.Body, autoReply)
		// Custom automatic dispatch is release-held. A webhook acknowledgement
		// must not bypass live suppression/consent, recipient-time policy,
		// financial reservation, idempotency or durable outbound evidence.
		_ = autoReply
		return nil
	case "outbound":
		if event.ProviderMessageID == "" {
			return fmt.Errorf("provider message id is required")
		}
		_, err := d.store().UpdateDeliveryStatus(
			r.Context(),
			tenantID,
			event.SenderProfileID,
			event.Provider,
			event.ProviderMessageID,
			event.Status,
			event.ErrorCode,
			event.ErrorMessage,
			event.Metadata,
		)
		if err == nil {
			observeSMSDelivery(event.Provider, event.Status)
		}
		return err
	case "", "ignored":
		return nil
	default:
		return fmt.Errorf("unsupported webhook direction %q", event.Direction)
	}
}

func (d *Deps) writeProviderWebhookApplyError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrSMSBodyOutsideContract) {
		httperror.WriteValidation(w, "sms_body_outside_contract", "SMS body must be non-empty valid UTF-8 within 16384 bytes and 4800 Unicode code points")
		return
	}
	if errors.Is(err, errSMSProviderReplayIdentityMissing) {
		httperror.WriteValidation(w, "missing_provider_message_id", "stable provider message id is required")
		return
	}
	if errors.Is(err, ErrProviderReplayConflict) {
		httperror.Write(w, http.StatusConflict, "provider_replay_conflict", "provider message id was already used for different content")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

type providerAutoReplyPlan struct {
	Dispatch bool
	Outbound ProviderOutbound
	Record   SendInput
}

func planProviderAutoReply(event normalizedProviderWebhook, autoReply InboundAutoReply, inbound Message, sender *SenderProfile, statusCallbackURL string) providerAutoReplyPlan {
	provider := defaulted(strings.ToLower(strings.TrimSpace(event.Provider)), ProviderTwilio)
	body := strings.TrimSpace(autoReply.Body)
	if !autoReply.Matched || body == "" || !oneOf(provider, ProviderTelnyx, ProviderBandwidth) || strings.TrimSpace(event.From) == "" {
		return providerAutoReplyPlan{}
	}

	senderID := strings.TrimSpace(event.SenderProfileID)
	fromNumber := strings.TrimSpace(event.To)
	messagingServiceSID := ""
	if sender != nil {
		if SenderPaused(sender.Metadata) {
			return providerAutoReplyPlan{}
		}
		senderID = defaulted(strings.TrimSpace(sender.ID), senderID)
		fromNumber = defaulted(strings.TrimSpace(sender.PhoneNumber), fromNumber)
		messagingServiceSID = strings.TrimSpace(sender.MessagingServiceSID)
	}

	return providerAutoReplyPlan{
		Dispatch: true,
		Outbound: ProviderOutbound{
			Provider:            provider,
			To:                  strings.TrimSpace(event.From),
			Body:                body,
			FromNumber:          fromNumber,
			MessagingServiceSID: messagingServiceSID,
			StatusCallbackURL:   statusCallbackURL,
		},
		Record: SendInput{
			SenderProfileID: senderID,
			To:              strings.TrimSpace(event.From),
			Body:            body,
			Metadata: map[string]any{
				"source":                      "keyword_auto_reply",
				"inbound_message_id":          inbound.ID,
				"keyword":                     autoReply.Keyword,
				"keyword_action":              autoReply.Action,
				"inbound_provider_event_type": safeProviderIdentifier(event.EventType, 64),
			},
		},
	}
}

func (d *Deps) sendProviderAutoReply(ctx context.Context, tenantID string, event normalizedProviderWebhook, inbound Message, autoReply InboundAutoReply) error {
	// Deliberately held even if this helper is reached by an adjacent caller.
	// Re-enable only through the same durable dispatch spine as inbox replies.
	return nil
	/*
		provider := defaulted(strings.ToLower(strings.TrimSpace(event.Provider)), ProviderTwilio)
		if !oneOf(provider, ProviderTelnyx, ProviderBandwidth) || !autoReply.Matched || strings.TrimSpace(autoReply.Body) == "" {
			return nil
		}
		if d.Provider == nil {
			return errors.New("sms provider not configured")
		}
		toPhone, operationErr := NormalizePhoneUSCA(event.From)
		if operationErr != nil {
			return operationErr
		}
		event.From = toPhone
		if fromNumber, err := NormalizePhoneUSCA(event.To); err == nil {
			event.To = fromNumber
		}

		var sender *SenderProfile
		if event.SenderProfileID != "" {
			loaded, err := d.store().GetSender(ctx, tenantID, event.SenderProfileID)
			if err != nil {
				return fmt.Errorf("load sender for keyword auto-reply: %w", err)
			}
			sender = &loaded
		}

		plan := planProviderAutoReply(event, autoReply, inbound, sender, d.statusCallbackURL(provider, tenantID, event.SenderProfileID))
		if !plan.Dispatch {
			return nil
		}
		result, operationErr := safeProviderSend(ctx, d.Provider, plan.Outbound)
		observeSMSProviderSend(provider, operationErr, result.PriceMicros)
		if operationErr != nil {
			return operationErr
		}
		decision := GateDecision{Allowed: true, Segments: SegmentCount(plan.Record.Body)}
		_, operationErr = d.store().RecordOutbound(ctx, tenantID, plan.Record, plan.Outbound.To, decision, result)
		return operationErr
	*/
}

func parseTelnyxWebhook(body []byte) (normalizedProviderWebhook, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return normalizedProviderWebhook{}, err
	}
	data := mapFromAny(raw["data"])
	payload := mapFromAny(data["payload"])
	eventType := stringFromAny(data["event_type"])
	messageID := stringFromAny(payload["id"])
	to := firstPhone(payload["to"])
	from := phoneFromAny(payload["from"])
	status := firstStatus(payload["to"])
	normalizedStatus := ""
	if eventType == "message.sent" && strings.TrimSpace(status) == "" {
		normalizedStatus = "sent"
	} else if eventType == "message.finalized" || eventType == "message.sent" {
		var ok bool
		normalizedStatus, ok = classifyProviderDeliveryStatus(status)
		if !ok {
			return normalizedProviderWebhook{}, fmt.Errorf("unsupported Telnyx delivery status")
		}
	}
	errCode, errMsg := firstProviderError(payload["errors"])
	event := normalizedProviderWebhook{
		Provider:          ProviderTelnyx,
		EventID:           stringFromAny(data["id"]),
		EventType:         eventType,
		SenderProfileID:   "",
		From:              from,
		To:                to,
		Body:              stringFromAny(payload["text"]),
		ProviderMessageID: messageID,
		Status:            normalizedStatus,
		ErrorCode:         errCode,
		ErrorMessage:      errMsg,
		ProviderProfileID: stringFromAny(payload["messaging_profile_id"]),
		Metadata: inboundProviderEvidence(ProviderTelnyx, map[string]any{
			"provider_event_id":   stringFromAny(data["id"]),
			"provider_event_type": eventType,
		}),
	}
	switch eventType {
	case "message.received":
		event.Direction = "inbound"
	case "message.sent", "message.finalized":
		event.Direction = "outbound"
	default:
		event.Direction = "ignored"
	}
	return event, nil
}

func parseBandwidthWebhooks(body []byte) ([]normalizedProviderWebhook, error) {
	var callbacks []map[string]any
	if err := json.Unmarshal(body, &callbacks); err != nil {
		return nil, err
	}
	if len(callbacks) > maxBandwidthWebhookEvents {
		return nil, fmt.Errorf("too many Bandwidth webhook events: max %d", maxBandwidthWebhookEvents)
	}
	out := make([]normalizedProviderWebhook, 0, len(callbacks))
	for _, raw := range callbacks {
		typ := strings.ToLower(strings.TrimSpace(stringFromAny(raw["type"])))
		message := mapFromAny(raw["message"])
		to := firstString(message["to"])
		normalizedStatus, deliveryStatus := classifyProviderDeliveryStatus(typ)
		event := normalizedProviderWebhook{
			Provider:          ProviderBandwidth,
			EventID:           stringFromAny(raw["id"]),
			EventType:         typ,
			From:              stringFromAny(message["from"]),
			To:                to,
			Body:              stringFromAny(message["text"]),
			ProviderMessageID: stringFromAny(message["id"]),
			Status:            normalizedStatus,
			ErrorCode:         stringFromAny(raw["errorCode"]),
			ErrorMessage:      defaulted(stringFromAny(raw["description"]), stringFromAny(raw["errorMessage"])),
			ProviderProfileID: defaulted(stringFromAny(message["applicationId"]), stringFromAny(raw["applicationId"])),
			Metadata: inboundProviderEvidence(ProviderBandwidth, map[string]any{
				"provider_event_id":   stringFromAny(raw["id"]),
				"provider_event_type": typ,
			}),
		}
		switch {
		case typ == "message-received" || strings.ToLower(stringFromAny(message["direction"])) == "in":
			event.Direction = "inbound"
		case event.ProviderMessageID != "" && deliveryStatus:
			event.Direction = "outbound"
		default:
			event.Direction = "ignored"
		}
		out = append(out, event)
	}
	return out, nil
}

func readProviderWebhookBody(r *http.Request, max int64) ([]byte, error) {
	if max <= 0 {
		max = smsProviderWebhookMaxBodyBytes
	}
	body, err := httpbody.ReadJSONAtMost(r, max, httpbody.Options{})
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			return nil, errSMSProviderWebhookBodyTooLarge
		}
		return nil, err
	}
	return body, nil
}

func validTelnyxRequest(publicKey, timestamp string, body []byte, signature string, now time.Time) bool {
	publicKey = strings.TrimSpace(publicKey)
	if publicKey == "" {
		return allowUnsignedProviderWebhooks()
	}
	ts, err := parseTelnyxTimestamp(timestamp)
	if err != nil {
		return false
	}
	if delta := now.Sub(ts); delta > 5*time.Minute || delta < -5*time.Minute {
		return false
	}
	key, err := decodeTelnyxPublicKey(publicKey)
	if err != nil {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil {
		return false
	}
	msg := append([]byte(strings.TrimSpace(timestamp)+"|"), body...)
	return ed25519.Verify(key, msg, sig)
}

// validBandwidthRequest authenticates an inbound Bandwidth webhook.
//
// Bandwidth does NOT sign requests cryptographically — their auth
// model is a shared bearer token (or HTTP Basic credentials). That
// means a leaked token is sufficient for full impersonation, with
// no replay-protection signal in the request itself. To partially
// compensate, this function ALSO enforces an optional source-IP
// CIDR allowlist (BANDWIDTH_WEBHOOK_ALLOWED_CIDRS) when configured.
// Bandwidth publishes their webhook egress IP ranges at
// https://dev.bandwidth.com/docs/messaging/webhooks/#bandwidth-ips —
// operators are encouraged to set the env var (comma-separated
// CIDRs) and review it quarterly. When the env var is empty the
// allowlist check is skipped (back-compat).
//
// The token / Basic credential check is constant-time via
// subtle.ConstantTimeCompare to avoid timing oracles.
func validBandwidthRequest(r *http.Request) bool {
	if !bandwidthIPAllowed(r) {
		return false
	}
	// Token-rotation grace window (parallel to webhook-rotation
	// CRITICAL #1). Bandwidth's auth model is a shared token with
	// no signature scheme — rotating means flipping the env var,
	// which would create a verification outage for any retries
	// still using the old token. Honor both BANDWIDTH_WEBHOOK_TOKEN
	// (primary) and BANDWIDTH_WEBHOOK_TOKEN_SECONDARY (grace) so
	// the operator can rotate without downtime: set secondary to
	// the old value before flipping primary, then clear secondary
	// after upstream's retries drain.
	token := strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_TOKEN"))
	secondary := strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_TOKEN_SECONDARY"))
	if token != "" || secondary != "" {
		got := strings.TrimSpace(r.Header.Get("X-Postwave-Webhook-Token"))
		if token != "" && constantTimeStringEqual(got, token) {
			return true
		}
		if secondary != "" && constantTimeStringEqual(got, secondary) {
			observeBandwidthSecondaryTokenAccepted()
			return true
		}
		return false
	}
	user := strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_USERNAME"))
	pass := strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_PASSWORD"))
	if user == "" && pass == "" {
		return allowUnsignedProviderWebhooks()
	}
	gotUser, gotPass, ok := r.BasicAuth()
	return ok && constantTimeStringEqual(gotUser, user) && constantTimeStringEqual(gotPass, pass)
}

// bandwidthIPAllowed evaluates BANDWIDTH_WEBHOOK_ALLOWED_CIDRS. An
// unset / blank env var returns true (back-compat). A populated env
// var requires the resolved client IP to match at least one entry.
func bandwidthIPAllowed(r *http.Request) bool {
	raw := strings.TrimSpace(os.Getenv("BANDWIDTH_WEBHOOK_ALLOWED_CIDRS"))
	if raw == "" {
		return true
	}
	cidrs := strings.Split(raw, ",")
	clientIP := middleware.ResolveClientIPString(r, true)
	if clientIP == "" {
		return false
	}
	return middleware.IPMatchesAllowlist(clientIP, cidrs)
}

func constantTimeStringEqual(got, want string) bool {
	if got == "" || want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// ValidateProviderWebhookSecurityConfig rejects the unsigned-provider bypass
// outside an explicitly named local/development/test runtime. Protected or
// missing environment labels fail closed, even if the bypass value is truthy.
// Production calls this during startup and readiness independently checks the
// same invariant.
func ValidateProviderWebhookSecurityConfig(env func(string) string) error {
	if env == nil {
		env = os.Getenv
	}
	if strings.TrimSpace(env("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS")) == "" {
		return nil
	}
	if !localSMSWebhookRuntime(env) {
		return errors.New("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS is local-development only and must be unset in protected or unspecified runtimes")
	}
	return nil
}

func localSMSWebhookRuntime(env func(string) string) bool {
	local := false
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT", "NODE_ENV"} {
		switch strings.ToLower(strings.TrimSpace(env(key))) {
		case "production", "prod", "staging", "stage":
			return false
		case "development", "dev", "local", "test", "testing":
			local = true
		}
	}
	return local
}

// allowUnsignedProviderWebhooks reports whether explicitly local SMS provider
// simulators may bypass signature verification. It intentionally delegates to
// the environment validator so a misconfigured process cannot accept unsigned
// callbacks merely because startup validation was skipped.
func allowUnsignedProviderWebhooks() bool {
	if ValidateProviderWebhookSecurityConfig(os.Getenv) != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS"))) {
	case "1", "true", "yes":
		return true
	}
	return false
}

func anyProviderWebhookConfigured(configured map[string]bool) bool {
	for _, ok := range configured {
		if ok {
			return true
		}
	}
	return false
}

func webhookConfiguredForProvider(configured map[string]bool, provider string) bool {
	provider = defaulted(strings.ToLower(strings.TrimSpace(provider)), ProviderTwilio)
	return configured[provider]
}

func parseTelnyxTimestamp(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, fmt.Errorf("missing timestamp")
	}
	if sec, err := strconvParseInt(raw); err == nil {
		return time.Unix(sec, 0), nil
	}
	return time.Parse(time.RFC3339, raw)
}

func decodeTelnyxPublicKey(raw string) (ed25519.PublicKey, error) {
	raw = strings.TrimSpace(raw)
	if b, err := hex.DecodeString(raw); err == nil && len(b) == ed25519.PublicKeySize {
		return ed25519.PublicKey(b), nil
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid Telnyx public key length")
	}
	return ed25519.PublicKey(b), nil
}

func strconvParseInt(raw string) (int64, error) {
	var n int64
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("not an integer")
		}
		n = n*10 + int64(ch-'0')
	}
	return n, nil
}

func phoneFromAny(value any) string {
	if m := mapFromAny(value); len(m) > 0 {
		return stringFromAny(m["phone_number"])
	}
	return stringFromAny(value)
}

func firstPhone(value any) string {
	switch x := value.(type) {
	case []any:
		if len(x) == 0 {
			return ""
		}
		return phoneFromAny(x[0])
	default:
		return phoneFromAny(value)
	}
}

func firstStatus(value any) string {
	if items, ok := value.([]any); ok && len(items) > 0 {
		return stringFromAny(mapFromAny(items[0])["status"])
	}
	return ""
}

func firstString(value any) string {
	switch x := value.(type) {
	case []any:
		if len(x) == 0 {
			return ""
		}
		return stringFromAny(x[0])
	default:
		return stringFromAny(value)
	}
}

func firstProviderError(value any) (string, string) {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return "", ""
	}
	item := mapFromAny(items[0])
	return stringFromAny(item["code"]), defaulted(stringFromAny(item["detail"]), stringFromAny(item["title"]))
}
