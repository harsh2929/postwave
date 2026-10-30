// Amazon SES deliverability webhook receiver.
//
// SES delivers events through SNS. Each inbound POST is an SNS message
// envelope that carries either:
//   - SubscriptionConfirmation — sent once when the SNS topic is
//     wired; we MUST hit the SubscribeURL to confirm.
//   - Notification — the SES event payload, with the actual event in
//     the `Message` field as a JSON-string-of-JSON.
//   - UnsubscribeConfirmation — informational; we ignore.
//
// SNS messages are signed with an X.509 cert hosted on Amazon's S3.
// We verify the RSA signature against the certificate fetched from
// `SigningCertURL` per the AWS SNS docs:
//
//	https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
//
// Defence layers in order:
//
//  1. SigningCertURL host validation (must be sns.<region>.amazonaws.com).
//     This prevents an attacker from supplying their own cert URL.
//  2. RSA signature verification against the canonical SNS string.
//     SignatureVersion=1 → SHA1, SignatureVersion=2 → SHA256.
//  3. TopicArn allow-list check (defence in depth — SNS already binds
//     TopicArn into the signed payload, but the allow-list catches a
//     misconfigured operator pointing at a stranger's topic).
//
// Cert fetches are cached by URL in a sync.Map for 24h so a hot bounce
// stream doesn't hammer Amazon's cert host.

package webhooks

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/snsverify"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// snsEnvelope is the outer SNS envelope shape.
type snsEnvelope struct {
	Type             string `json:"Type"`
	MessageID        string `json:"MessageId"`
	TopicArn         string `json:"TopicArn"`
	Subject          string `json:"Subject,omitempty"`
	Message          string `json:"Message"`
	Timestamp        string `json:"Timestamp"`
	SignatureVersion string `json:"SignatureVersion"`
	Signature        string `json:"Signature"`
	SigningCertURL   string `json:"SigningCertURL,omitempty"`
	SubscribeURL     string `json:"SubscribeURL,omitempty"`
	Token            string `json:"Token,omitempty"`
}

// sesMessage is the inner SES event shape carried in
// snsEnvelope.Message as a JSON-encoded string.
type sesMessage struct {
	EventType string `json:"eventType"` // 'Bounce' | 'Complaint' | 'Open' | 'Click' | 'Delivery' | …
	Mail      struct {
		MessageID   string              `json:"messageId"`
		Destination []string            `json:"destination,omitempty"`
		Tags        map[string][]string `json:"tags,omitempty"`
		// Headers carries the original outgoing email headers when SES
		// is configured with "Include Original Headers" on the event
		// destination. The resolver scans this for X-Postwave-Tenant
		// when the messageId lookup misses — see resolveTenant +
		// the tenant_unresolved fallback path in HandleSES.
		Headers []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"headers,omitempty"`
	} `json:"mail"`
	Bounce struct {
		BounceType        string `json:"bounceType"` // 'Permanent' | 'Transient' | 'Undetermined'
		BounceSubType     string `json:"bounceSubType"`
		BouncedRecipients []struct {
			EmailAddress   string `json:"emailAddress"`
			DiagnosticCode string `json:"diagnosticCode,omitempty"`
		} `json:"bouncedRecipients"`
		Timestamp string `json:"timestamp"`
	} `json:"bounce,omitempty"`
	Complaint struct {
		ComplainedRecipients []struct {
			EmailAddress string `json:"emailAddress"`
		} `json:"complainedRecipients"`
		ComplaintFeedbackType string `json:"complaintFeedbackType,omitempty"`
		Timestamp             string `json:"timestamp"`
	} `json:"complaint,omitempty"`
	Open struct {
		IPAddress string `json:"ipAddress,omitempty"`
		Timestamp string `json:"timestamp"`
		UserAgent string `json:"userAgent,omitempty"`
	} `json:"open,omitempty"`
	Click struct {
		IPAddress string `json:"ipAddress,omitempty"`
		Link      string `json:"link"`
		Timestamp string `json:"timestamp"`
		UserAgent string `json:"userAgent,omitempty"`
	} `json:"click,omitempty"`
	Delivery struct {
		Recipients   []string `json:"recipients,omitempty"`
		Timestamp    string   `json:"timestamp"`
		SMTPResponse string   `json:"smtpResponse,omitempty"`
	} `json:"delivery,omitempty"`
}

// Sentinel errors returned from verifySES so tests can assert behaviour
// without screen-scraping HTTP response strings.
// Sentinel errors. Aliases of the shared verifier's, so there is exactly one
// definition of each cause and errors.Is works across the package boundary.
var (
	errInvalidCertURL        = snsverify.ErrInvalidCertURL
	errSignatureMismatch     = snsverify.ErrSignatureMismatch
	errMissingMessageID      = snsverify.ErrMissingMessageID
	errUnsupportedSigVersion = snsverify.ErrUnsupportedSigVersion
	errTopicNotAllowed       = snsverify.ErrTopicNotAllowed
	errCertFetchFailed       = snsverify.ErrCertFetchFailed
	errCertParseFailed       = snsverify.ErrCertParseFailed
	errCertNotRSA            = snsverify.ErrCertNotRSA
	errMissingSignature      = snsverify.ErrMissingSignature
	errSignatureNotBase64    = snsverify.ErrSignatureNotBase64
	errTopicAllowlistEmpty   = snsverify.ErrTopicAllowlistEmpty
)

// webhookSignatureFailures counts every signature verification reject so
// operators can alert on a sudden spike (likely a forgery attempt or an
// AWS-side rotation we missed). Cardinality is bounded by the small set
// of `reason` values we emit.
var webhookSignatureFailures = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "webhook_signature_failures_total",
	Help: "Total inbound webhook signature verification failures, partitioned by provider + reason.",
}, []string{"provider", "reason"})

// sesTenantResolutionFailures counts authenticated SES notifications that
// could not be bound to exactly one tenant. The label set is deliberately
// bounded: operators need an alertable signal without putting message IDs or
// tenant IDs into metric labels.
var sesTenantResolutionFailures = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "ses_tenant_resolution_failures_total",
	Help: "Total authenticated SES notifications not accepted because tenant attribution was missing, invalid, ambiguous, or not committed yet.",
}, []string{"reason"})

// HandleSES verifies + parses + processes one SNS-wrapped SES event.
func (d *DeliverabilityDeps) HandleSES(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 4 << 20
	body, err := readBody(r, maxBodyBytes)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, maxBodyBytes, err)
		return
	}
	var env snsEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	if !d.verifySESHTTP(w, &env) {
		return
	}

	switch env.Type {
	case "SubscriptionConfirmation":
		// Operators confirm out-of-band by hitting env.SubscribeURL.
		// We log the URL so it's discoverable in incident response;
		// auto-confirming would let an attacker who hit our URL with a
		// rogue SubscribeURL trick us into subscribing to a hostile
		// topic.
		d.log().Warn("ses subscription confirmation received — confirm out of band",
			"topic_arn", env.TopicArn, "subscribe_url", env.SubscribeURL)
		writeJSONOK(w, http.StatusOK, map[string]any{"acknowledged": true})
		return
	case "UnsubscribeConfirmation":
		writeJSONOK(w, http.StatusOK, map[string]any{"acknowledged": true})
		return
	case "Notification":
		// fall through
	default:
		writeJSONErrDeliv(w, http.StatusBadRequest, "unknown_sns_type", env.Type)
		return
	}

	var msg sesMessage
	if err := json.Unmarshal([]byte(env.Message), &msg); err != nil {
		httperror.Write(w, http.StatusBadRequest, "bad_inner_json", "inner SNS Message payload is not valid JSON")
		return
	}
	if rejectDeliveryWithoutMessageID(w, sesCorrelationCandidate(msg)) {
		return
	}
	// SES tenant attribution must be message-bound. The generic request-header
	// fallback is intentionally not used here because HTTP headers are outside
	// the SNS signature and could be changed on replay. Resolve from the
	// provider message id first, then from the original outbound header carried
	// inside the signed SNS Message body.
	tenantID, resolution := d.resolveSESTenantState(r.Context(), msg)
	if tenantID == "" {
		if (resolution == sesTenantMissing || resolution == sesTenantLookupFailed) &&
			providerCorrelationNeedsRetry(sesCorrelationCandidate(msg)) {
			sesTenantResolutionFailures.WithLabelValues("correlation_pending").Inc()
			d.log().Warn("deliverability: retrying authenticated SES event with pending tenant correlation",
				"sns_message_id", env.MessageID,
				"ses_message_id", msg.Mail.MessageID,
				"event_type", msg.EventType)
			writeRetryableProviderCorrelation(w)
			return
		}
		// The SNS envelope is valid, so retrying an attribution defect can only
		// create a poison-message loop. Acknowledge while recording an explicit
		// ignored receipt and an operator-visible metric/log. No suppression or
		// event is written when ownership is unresolved or conflicting.
		sesTenantResolutionFailures.WithLabelValues(string(resolution)).Inc()
		d.log().Error("deliverability: ignoring authenticated SES event with unresolved or ambiguous tenant",
			"sns_message_id", env.MessageID,
			"ses_message_id", msg.Mail.MessageID,
			"event_type", msg.EventType)
		writeJSONOK(w, http.StatusAccepted, map[string]any{
			"recorded": 0,
			"ignored":  "tenant_unresolved_or_ambiguous",
		})
		return
	}
	campaignID := resolveSESCampaignID(msg)

	// SES can carry multiple recipients per event for bounces +
	// complaints. Iterate each so suppressions cover every address.
	switch msg.EventType {
	case "Bounce":
		bounceClass := "soft"
		if strings.EqualFold(msg.Bounce.BounceType, "Permanent") {
			bounceClass = "hard"
		}
		ts := parseSESTime(msg.Bounce.Timestamp)
		recorded := 0
		failed := 0
		var processingErr error
		for _, rcpt := range msg.Bounce.BouncedRecipients {
			ev := classifyOutcome{
				Email:        strings.TrimSpace(rcpt.EmailAddress),
				CampaignID:   campaignID,
				EventType:    "bounced",
				BounceClass:  bounceClass,
				ProviderID:   sesRecipientEventID(env.MessageID, rcpt.EmailAddress),
				MessageID:    msg.Mail.MessageID,
				ProviderName: suppressions.SourceSES,
				Reason:       rcpt.DiagnosticCode,
				OccurredAt:   ts,
			}
			if err := d.process(r.Context(), tenantID, ev); err != nil {
				d.log().Error("deliverability: ses bounce process",
					"err", err.Error(), "tenant_id", tenantID, "email_redacted", observability.RedactEmail(ev.Email))
				failed++
				processingErr = errors.Join(processingErr, err)
				continue
			}
			recorded++
		}
		if failed > 0 {
			// Successful recipients are idempotent; a retry can safely finish the
			// failed suffix without duplicating suppressions or event projections.
			d.writeProviderProcessError(w, r,
				fmt.Errorf("ses bounce processing failed for %d recipient(s): %w", failed, processingErr))
			return
		}
		writeJSONOK(w, http.StatusOK, map[string]any{
			"recorded":     recorded,
			"tenants":      1,
			"event":        "bounced",
			"bounce_class": bounceClass,
		})
		return
	case "Complaint":
		ts := parseSESTime(msg.Complaint.Timestamp)
		recorded := 0
		failed := 0
		var processingErr error
		for _, rcpt := range msg.Complaint.ComplainedRecipients {
			ev := classifyOutcome{
				Email:        strings.TrimSpace(rcpt.EmailAddress),
				CampaignID:   campaignID,
				EventType:    "complained",
				ProviderID:   sesRecipientEventID(env.MessageID, rcpt.EmailAddress),
				MessageID:    msg.Mail.MessageID,
				ProviderName: suppressions.SourceSES,
				Reason:       msg.Complaint.ComplaintFeedbackType,
				OccurredAt:   ts,
			}
			if err := d.process(r.Context(), tenantID, ev); err != nil {
				d.log().Error("deliverability: ses complaint process",
					"err", err.Error(), "tenant_id", tenantID, "email_redacted", observability.RedactEmail(ev.Email))
				failed++
				processingErr = errors.Join(processingErr, err)
				continue
			}
			recorded++
		}
		if failed > 0 {
			d.writeProviderProcessError(w, r,
				fmt.Errorf("ses complaint processing failed for %d recipient(s): %w", failed, processingErr))
			return
		}
		writeJSONOK(w, http.StatusOK, map[string]any{
			"recorded": recorded, "event": "complained",
		})
		return
	case "Open":
		ev, ok := classifySESEngagement(env, msg, campaignID)
		if !ok {
			writeJSONOK(w, http.StatusOK, map[string]any{"ignored": "open_recipient_ambiguous"})
			return
		}
		if err := d.process(r.Context(), tenantID, ev); err != nil {
			d.writeProviderProcessError(w, r, fmt.Errorf("ses open processing failed: %w", err))
			return
		}
		writeJSONOK(w, http.StatusOK, map[string]any{"recorded": 1, "event": "opened"})
		return
	case "Click":
		ev, ok := classifySESEngagement(env, msg, campaignID)
		if !ok {
			writeJSONOK(w, http.StatusOK, map[string]any{"ignored": "click_recipient_ambiguous"})
			return
		}
		if err := d.process(r.Context(), tenantID, ev); err != nil {
			d.writeProviderProcessError(w, r, fmt.Errorf("ses click processing failed: %w", err))
			return
		}
		writeJSONOK(w, http.StatusOK, map[string]any{"recorded": 1, "event": "clicked"})
		return
	case "Delivery":
		events := classifySESDeliveries(env, msg, campaignID)
		recorded := 0
		failed := 0
		var processingErr error
		for _, ev := range events {
			if err := d.process(r.Context(), tenantID, ev); err != nil {
				d.log().Error("deliverability: ses delivery process",
					"err", err.Error(), "tenant_id", tenantID,
					"email_redacted", observability.RedactEmail(ev.Email))
				failed++
				processingErr = errors.Join(processingErr, err)
				continue
			}
			recorded++
		}
		if failed > 0 {
			d.writeProviderProcessError(w, r,
				fmt.Errorf("ses delivery processing failed for %d recipient(s): %w", failed, processingErr))
			return
		}
		if len(events) == 0 {
			writeJSONOK(w, http.StatusOK, map[string]any{"ignored": "delivery_no_recipient"})
			return
		}
		writeJSONOK(w, http.StatusOK, map[string]any{
			"recorded": recorded, "event": "delivered",
		})
		return
	default:
		writeJSONOK(w, http.StatusOK, map[string]any{"ignored": msg.EventType})
		return
	}
}

func sesCorrelationCandidate(msg sesMessage) classifyOutcome {
	ev := classifyOutcome{MessageID: strings.TrimSpace(msg.Mail.MessageID)}
	switch msg.EventType {
	case "Delivery":
		ev.EventType = "delivered"
	case "Complaint":
		ev.EventType = "complained"
	case "Bounce":
		ev.EventType = "bounced"
		ev.BounceClass = "soft"
		if strings.EqualFold(msg.Bounce.BounceType, "Permanent") {
			ev.BounceClass = "hard"
		}
	}
	return ev
}

// classifySESDeliveries expands one signed, message-level SNS notification
// into recipient-level canonical facts. SES reuses the SNS MessageId when it
// retries the notification, so the recipient digest makes each fact both
// distinct within a multi-recipient delivery and stable across retries.
func classifySESDeliveries(env snsEnvelope, msg sesMessage, campaignID string) []classifyOutcome {
	recipients := msg.Delivery.Recipients
	if len(recipients) == 0 {
		// Delivery.recipients is authoritative. mail.destination is signed in
		// the same SNS body and is a safe compatibility fallback for payloads
		// that omit the delivery-specific copy.
		recipients = msg.Mail.Destination
	}
	ts := parseSESTime(msg.Delivery.Timestamp)
	seen := make(map[string]struct{}, len(recipients))
	events := make([]classifyOutcome, 0, len(recipients))
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
		ev := classifyOutcome{
			Email:        recipient,
			CampaignID:   campaignID,
			EventType:    "delivered",
			ProviderID:   sesRecipientEventID(env.MessageID, recipient),
			MessageID:    strings.TrimSpace(msg.Mail.MessageID),
			ProviderName: suppressions.SourceSES,
			Reason:       strings.TrimSpace(msg.Delivery.SMTPResponse),
			OccurredAt:   ts,
		}
		if !ts.IsZero() {
			deliveredAt := ts
			ev.DeliveredAt = &deliveredAt
		}
		events = append(events, ev)
	}
	return events
}

// classifySESEngagement accepts only a single, unambiguous signed destination.
// SES's common mail.destination can contain every original recipient; fanning
// one open or click out to that whole set would invent engagement for people
// who did not act. The accepted observation still flows through the shared
// classifier, which hashes identity fields and applies the privacy retention
// policy before persisting derived evidence.
func classifySESEngagement(env snsEnvelope, msg sesMessage, campaignID string) (classifyOutcome, bool) {
	recipients := uniqueProviderRecipients(msg.Mail.Destination)
	if len(recipients) != 1 {
		return classifyOutcome{}, false
	}
	ev := classifyOutcome{
		Email:        recipients[0],
		CampaignID:   campaignID,
		ProviderID:   sesRecipientEventID(env.MessageID, recipients[0]),
		MessageID:    strings.TrimSpace(msg.Mail.MessageID),
		ProviderName: suppressions.SourceSES,
	}
	switch msg.EventType {
	case "Open":
		ev.EventType = "opened"
		ev.OccurredAt = parseSESTime(msg.Open.Timestamp)
		ev.UserAgent = strings.TrimSpace(msg.Open.UserAgent)
		ev.IP = strings.TrimSpace(msg.Open.IPAddress)
	case "Click":
		ev.EventType = "clicked"
		ev.OccurredAt = parseSESTime(msg.Click.Timestamp)
		ev.LinkIdentity = strings.TrimSpace(msg.Click.Link)
		ev.UserAgent = strings.TrimSpace(msg.Click.UserAgent)
		ev.IP = strings.TrimSpace(msg.Click.IPAddress)
	default:
		return classifyOutcome{}, false
	}
	return ev, true
}

const (
	sesTenantTagName      = "postwave_tenant_id"
	sesCampaignHeaderName = "X-Postwave-Campaign"
)

type sesTenantResolution string

const (
	sesTenantResolved     sesTenantResolution = "resolved"
	sesTenantMissing      sesTenantResolution = "missing"
	sesTenantInvalid      sesTenantResolution = "invalid"
	sesTenantAmbiguous    sesTenantResolution = "ambiguous"
	sesTenantLookupFailed sesTenantResolution = "lookup_failed"
)

// resolveSESTenant accepts only attribution cryptographically bound to the SNS
// body: the persisted provider message-id mapping, the server-owned SES tag,
// or X-Postwave-Tenant from original outbound headers embedded in
// sesMessage.Mail. Every populated source must be a valid UUID and all sources
// must agree. It deliberately has no recipient-email or inbound HTTP-header
// fallback.
func (d *DeliverabilityDeps) resolveSESTenant(ctx context.Context, msg sesMessage) string {
	tenantID, _ := d.resolveSESTenantState(ctx, msg)
	return tenantID
}

func (d *DeliverabilityDeps) resolveSESTenantState(
	ctx context.Context,
	msg sesMessage,
) (string, sesTenantResolution) {
	candidates := map[string]struct{}{}
	invalid := false
	lookupFailed := false
	addCandidate := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		parsed, err := uuid.Parse(raw)
		if err != nil {
			invalid = true
			return
		}
		candidates[parsed.String()] = struct{}{}
	}

	if d.TenantResolver != nil && msg.Mail.MessageID != "" {
		resolved, lookupErr := d.TenantResolver.LookupTenantByESPMessageID(
			ctx, msg.Mail.MessageID,
		)
		if lookupErr != nil {
			lookupFailed = true
			d.log().Warn("ses tenant lookup by message id failed", "err", lookupErr.Error())
		} else {
			addCandidate(resolved)
		}
	}
	for key, values := range msg.Mail.Tags {
		if strings.EqualFold(strings.TrimSpace(key), sesTenantTagName) {
			for _, value := range values {
				addCandidate(value)
			}
		}
	}
	for _, header := range msg.Mail.Headers {
		if strings.EqualFold(strings.TrimSpace(header.Name), DeliverabilityTenantHeader) {
			addCandidate(header.Value)
		}
	}
	if invalid {
		return "", sesTenantInvalid
	}
	if len(candidates) > 1 {
		return "", sesTenantAmbiguous
	}
	// A signed tag/header is strong evidence, but a failed message-id lookup
	// means we cannot prove it does not conflict with already persisted
	// ownership. Retry instead of weakening the all-sources-must-agree rule.
	if lookupFailed {
		return "", sesTenantLookupFailed
	}
	if len(candidates) == 0 {
		return "", sesTenantMissing
	}
	for tenantID := range candidates {
		return tenantID, sesTenantResolved
	}
	return "", sesTenantMissing
}

// sesRecipientEventID gives every recipient in a multi-recipient SNS event a
// stable dedupe key. Using the bare SNS MessageId causes the first suppression
// insert to consume the unique key and silently drops every later recipient.
func sesRecipientEventID(snsMessageID, recipient string) string {
	normalized := strings.ToLower(strings.TrimSpace(recipient))
	digest := sha256.Sum256([]byte(normalized))
	return strings.TrimSpace(snsMessageID) + ":" + hex.EncodeToString(digest[:])
}

// resolveSESCampaignID reads only the server-stamped original header embedded
// in the signed SES body. Missing, invalid, or conflicting values deliberately
// degrade to a tenant-scoped event with no campaign attribution.
func resolveSESCampaignID(msg sesMessage) string {
	candidates := map[string]struct{}{}
	invalid := false
	for _, header := range msg.Mail.Headers {
		if !strings.EqualFold(strings.TrimSpace(header.Name), sesCampaignHeaderName) {
			continue
		}
		parsed, err := uuid.Parse(strings.TrimSpace(header.Value))
		if err != nil {
			invalid = true
			continue
		}
		candidates[parsed.String()] = struct{}{}
	}
	if invalid || len(candidates) != 1 {
		return ""
	}
	for campaignID := range candidates {
		return campaignID
	}
	return ""
}

// verifySESHTTP is the HTTP-aware wrapper. It calls verifySES (which
// returns sentinel errors for testability) and translates the result
// into a 4xx response. It also records the prom counter on every reject.
func (d *DeliverabilityDeps) verifySESHTTP(w http.ResponseWriter, env *snsEnvelope) bool {
	err := d.verifySES(env)
	if err == nil {
		return true
	}
	reason := signatureFailureReason(err)
	webhookSignatureFailures.WithLabelValues("ses", reason).Inc()
	d.log().Warn("ses signature verification failed",
		"reason", reason, "err", err.Error(),
		"message_id", env.MessageID, "topic_arn", env.TopicArn)
	httperror.Write(w, http.StatusUnauthorized, reason, "SNS signature verification failed")
	return false
}

// signatureFailureReason maps a sentinel error to the prom-label string.
// Keep these short + lowercase so they read well in dashboards.
func signatureFailureReason(err error) string { return snsverify.FailureReason(err) }

// verifySES applies full RSA-cert verification per AWS SNS docs.
// Returns nil on success; a sentinel error on failure. Callers MUST
// treat any non-nil return as a hard reject.
//
// Verification order (each step rejects before the next runs):
//
//  1. AllowUnverifiedSignatures dev bypass — only effective when not in
//     production. Logs a slog.Warn for every bypass so a misconfigured
//     prod deploy is auditable.
//  2. Required-field guards (MessageId, Signature, SignatureVersion).
//  3. SigningCertURL must match snsCertURLPattern (prevents attacker-
//     supplied cert host).
//  4. Cert fetch + parse (cached per-URL).
//  5. Build canonical string + RSA verify.
//  6. TopicArn allow-list (defence in depth; SNS itself binds TopicArn
//     into the signed payload but a misconfigured operator pointing at
//     a stranger's topic would still be rejected here).
func (d *DeliverabilityDeps) verifySES(env *snsEnvelope) error {
	if d.AllowUnverifiedSignatures && !isProductionEnvForWebhooks() {
		d.log().Warn("ses: AllowUnverifiedSignatures bypass — accepting unverified payload",
			"message_id", env.MessageID, "topic_arn", env.TopicArn)
		return nil
	}
	// Legacy compat: AllowUnsignedDevBypass was the V1 flag. Keep honouring it
	// (gated on !production) so existing dev environments don't break, but
	// prefer AllowUnverifiedSignatures for new wiring.
	if d.AllowUnsignedDevBypass && !isProductionEnvForWebhooks() {
		d.log().Warn("ses: AllowUnsignedDevBypass bypass — accepting unverified payload",
			"message_id", env.MessageID, "topic_arn", env.TopicArn)
		return nil
	}
	// The crypto and the topic allow-list live in snsverify so this path and
	// internal/replies cannot drift apart. The bypass above stays here because
	// it is operator policy, and it needs the env check and the logger that
	// make a bypass auditable.
	return snsverify.Verifier{AllowedTopicARNs: d.SESTopicARNs}.Verify(env.toShared())
}

// toShared converts the package's wire type into the verifier's envelope.
func (env *snsEnvelope) toShared() snsverify.Envelope {
	return snsverify.Envelope{
		Type: env.Type, MessageID: env.MessageID, TopicArn: env.TopicArn,
		Subject: env.Subject, Message: env.Message, Timestamp: env.Timestamp,
		SignatureVersion: env.SignatureVersion, Signature: env.Signature,
		SigningCertURL: env.SigningCertURL, SubscribeURL: env.SubscribeURL,
		Token: env.Token,
	}
}

// The cert-URL guard, cert fetch/cache, PEM parse, canonical string and digest
// all moved to internal/snsverify. These thin wrappers keep the names this
// package's tests exercise while leaving exactly one implementation.

func validateSNSCertURL(raw string) bool { return snsverify.ValidateCertURL(raw) }

func parsePEMRSAPublicKey(pemBytes []byte) (*rsa.PublicKey, error) {
	return snsverify.ParsePEMRSAPublicKey(pemBytes)
}

func canonicalSNSString(env *snsEnvelope) string {
	return snsverify.CanonicalString(env.toShared())
}

// isProductionEnvForWebhooks mirrors apps/api/main.go's isProductionEnv
// helper. Defined here because main.go is in package main and we can't
// import it; the env var check stays in lock-step.
func isProductionEnvForWebhooks() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

// parseSESTime tolerates both RFC3339 and RFC3339Nano timestamps. SES
// uses RFC3339 with sub-second precision in practice.
func parseSESTime(in string) time.Time {
	in = strings.TrimSpace(in)
	if in == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, in); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, in); err == nil {
		return t.UTC()
	}
	return time.Time{}
}
