// SPDX-License-Identifier: AGPL-3.0-only
//
// Package outbound_webhooks owns the public outbound-webhooks API:
// customers configure URLs + a list of event types in their tenant
// settings; we POST a signed JSON body whenever a matching event fires.
//
// Surface:
//
//   - GET    /api/v1/outbound-webhooks                     — list
//   - POST   /api/v1/outbound-webhooks                     — create (returns
//     plaintext signing secret ONCE; envelope-encrypted at rest thereafter)
//   - PATCH  /api/v1/outbound-webhooks/{id}                — update url/desc/events/active
//   - DELETE /api/v1/outbound-webhooks/{id}                — tombstone while
//     retaining evidence; ?soft=1 only deactivates the visible endpoint
//   - POST   /api/v1/outbound-webhooks/{id}/test           — synthesize +
//     synchronously deliver a test event, return result inline
//   - GET    /api/v1/outbound-webhooks/{id}/deliveries     — recent log
//
// Why a new package alongside the existing internal `webhooks` pkg:
// the internal one is for Moosewave's own product webhooks (driven by
// the outbox + SendGrid-style replays); this one is the public-facing
// integration surface that Zapier (+ third parties) consume. Mixing
// the two would mean every change to one risks breaking the other,
// and the auth + scope shape is cleaner kept apart.
//
// Signature scheme (Stripe-style, intentionally):
//
//	X-Postwave-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
//
// where the HMAC is computed over `t + "." + raw_body` with the
// webhook's plaintext secret. We pick the Stripe shape over GitHub's
// `sha256=...` form because the leading `t=` timestamp lets customers
// reject replays cheaply (no nonce table needed); GitHub's form skips
// it on the assumption the receiver checks delivery-id, which is more
// state. Both Stripe and Slack ship this pattern, so most webhook
// libraries already understand it out of the box.
package outbound_webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Errors surfaced to handlers.
var (
	ErrNotFound            = errors.New("outbound_webhooks: not found")
	ErrInvalidURL          = errors.New("outbound_webhooks: invalid URL")
	ErrInvalidDescription  = errors.New("outbound_webhooks: invalid description")
	ErrInvalidListID       = errors.New("outbound_webhooks: invalid list_id")
	ErrListNotFound        = errors.New("outbound_webhooks: list not found")
	ErrRedactedDestination = fmt.Errorf(
		"%w: the display-only destination cannot be saved", ErrInvalidURL,
	)
	ErrEventsRequired        = errors.New("outbound_webhooks: at least one event type required")
	ErrCipherUnconfigured    = errors.New("outbound_webhooks: envelope cipher not configured")
	ErrInvalidEvent          = errors.New("outbound_webhooks: invalid event type")
	ErrInvalidFilter         = errors.New("outbound_webhooks: invalid filter expression")
	ErrInvalidTransform      = errors.New("outbound_webhooks: invalid transform template")
	ErrInvalidAuthConfig     = errors.New("outbound_webhooks: invalid auth_config")
	ErrAuthConfigPending     = errors.New("outbound_webhooks: receiver auth migration pending")
	ErrAuthConfigInvalid     = errors.New("outbound_webhooks: receiver auth is invalid")
	ErrDeliveryInProgress    = errors.New("outbound_webhooks: delivery is still in progress")
	ErrWebhookInactive       = errors.New("outbound_webhooks: webhook is inactive")
	ErrLeaseLost             = errors.New("outbound_webhooks: delivery lease was lost")
	ErrDestinationPending    = errors.New("outbound_webhooks: destination migration pending")
	ErrDestinationInvalid    = errors.New("outbound_webhooks: destination is invalid")
	ErrDeliveryPolicyInvalid = errors.New(
		"outbound_webhooks: delivery policy is invalid",
	)
)

const (
	maxWebhookDescriptionRunes = 512

	// MaxWebhookConfigVersion keeps the public JSON revision exactly
	// representable by every generated JavaScript/TypeScript client. Reaching
	// this bound would require more than nine quadrillion capability changes;
	// refusing the next mutation is safer than emitting an ambiguous revision.
	MaxWebhookConfigVersion int64 = 1<<53 - 1
)

// SignatureHeader is the HTTP header name for the request signature.
const SignatureHeader = "X-Postwave-Signature"

// KeyIDHeader carries key fingerprints for primary/secondary rotation.
const KeyIDHeader = "X-Postwave-Key-Id"

// EventHeader is the HTTP header that names the event type.
const EventHeader = "X-Postwave-Event"

// EventIDHeader carries the stable source-event identity. It remains the same
// across automatic delivery retries and manual replays.
const EventIDHeader = "X-Postwave-Event-Id"

// DeliveryHeader is the HTTP header carrying the delivery row id.
const DeliveryHeader = "X-Postwave-Delivery"

// TestHeader distinguishes operator-initiated probes from production event
// deliveries without changing the signed body contract.
const TestHeader = "X-Postwave-Test"

// MaxResponseBodyBytes caps how much of a non-2xx response body we
// retain on a delivery row for debugging. 4KiB is plenty for an error
// JSON envelope without bloating the row.
const MaxResponseBodyBytes = 4 * 1024

// MaxAttempts caps the retry count before a delivery is marked
// 'exhausted'. Aligned with the BackoffSchedule below.
const MaxAttempts = 7

// BackoffSchedule is the per-attempt wait. Index 0 = first retry
// (after the initial attempt fails), so attempt N is scheduled with
// BackoffSchedule[N-1] when 0 < N <= len(schedule). Past the end →
// 'exhausted'. 30s → 5m → 30m → 2h → 8h → 1d → 1d.
//
// Total clock budget is just over two days of retries; a webhook URL
// down for two full days is almost certainly unmonitored, and the
// auto-disable threshold (consecutive_failures >= 100) catches the
// long-tail.
var BackoffSchedule = []time.Duration{
	30 * time.Second,
	5 * time.Minute,
	30 * time.Minute,
	2 * time.Hour,
	8 * time.Hour,
	24 * time.Hour,
	24 * time.Hour,
}

// AutoDisableThreshold — once consecutive_failures reaches this, the
// retry worker flips active=false and emails the tenant owner. Set high
// enough that a flaky day doesn't auto-disable a real integration.
const AutoDisableThreshold = 100

// Named event type constants. The string values are the canonical
// topic names emitted on the in-process events.Bus and the literal
// values surfaced over the wire in the outbound JSON envelope's
// `event.type` field. Keep these in sync with AllowedEvents (the
// validator) and the Zapier app / dashboard chip list.
//
// list.subscriber.* events carry { list_id, subscriber_id, email, … }
// in the payload and are filtered by the dispatcher against the
// webhook's optional list_id scope (see migration 0225).
const (
	EventListSubscriberAdded = "list.subscriber.added"
	// EventSubscriberUnsubscribed is the tenant-wide unsubscribe
	// fanout — fires once per global opt-out (RFC 8058 one-click,
	// admin manual unsubscribe, etc.) and carries the email + reason
	// + source channel in the payload. Distinct from list-scoped membership
	// events; subscribers who use this don't want a list filter.
	EventSubscriberUnsubscribed = "subscriber.unsubscribed"

	// Transactional outcomes. The `email.` prefix matches what a developer
	// integrating a transactional API expects to subscribe to, and keeps them
	// distinct from the campaign/subscriber topics that share this catalog.
	EventEmailBounced    = "email.bounced"
	EventEmailComplained = "email.complained"
	EventEmailDelivered  = "email.delivered"

	// Campaign Assurance outcomes. Assurance gates dispatch, so a blocked run
	// is something an integrator has to react to rather than discover when the
	// campaign never sends.
	//
	// Only the terminal outcome is a topic. Run-started and per-extraction
	// events fire at model-fanout rates and carry no decision. There is
	// deliberately no "passed" topic either: a run that finished without
	// complete evidence is `incomplete`, never green, and a separate success
	// topic would invite integrators to treat it as one. The decision travels
	// inside the completed payload.
	EventAssuranceRunCompleted = "assurance.run.completed"
	EventAssuranceRunBlocked   = "assurance.run.blocked"
)

// AllowedEvents is the canonical list of event types tenants can
// subscribe to. Additions go here, the Zapier app, and the dashboard
// chip list — keep the three in sync.
var AllowedEvents = []string{
	"campaign.sent",
	"subscriber.added",
	"subscriber.removed",
	EventSubscriberUnsubscribed,
	"approval.requested",
	"approval.decided",
	"audit.created",
	"bounce.received",
	"list_health.degraded",
	EventListSubscriberAdded,
	// Transactional message outcomes, per RECIPIENT.
	//
	// `bounce.received` already exists and is about an ADDRESS — it is the
	// deliverability signal that drives suppression, and a subscriber-list
	// consumer wants it. These are about a MESSAGE: "the receipt I sent for
	// order #4131 never arrived". A transactional sender integrating against
	// this API cannot use bounce.received for that, because it does not say
	// which of their messages it was.
	EventEmailBounced,
	EventEmailComplained,
	EventEmailDelivered,
	EventAssuranceRunCompleted,
	EventAssuranceRunBlocked,
}

// IsAllowedEvent reports whether eventType is in AllowedEvents.
func IsAllowedEvent(eventType string) bool {
	for _, e := range AllowedEvents {
		if e == eventType {
			return true
		}
	}
	return false
}

// validateEvents rejects empty + unknown event types. Returns a
// deduplicated, trimmed slice ready to insert into Postgres text[].
func validateEvents(in []string) ([]string, error) {
	if len(in) == 0 {
		return nil, ErrEventsRequired
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, raw := range in {
		e := strings.TrimSpace(raw)
		if e == "" {
			continue
		}
		if !IsAllowedEvent(e) {
			return nil, fmt.Errorf("%w: %q", ErrInvalidEvent, e)
		}
		if _, dup := seen[e]; dup {
			continue
		}
		seen[e] = struct{}{}
		out = append(out, e)
	}
	if len(out) == 0 {
		return nil, ErrEventsRequired
	}
	return out, nil
}

func normalizeDescription(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxWebhookDescriptionRunes {
		return "", ErrInvalidDescription
	}
	return value, nil
}

// newSecret returns a fresh 32-byte signing secret encoded as
// "owhsec_" + hex. Customers see it once at create time.
func newSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "owhsec_" + hex.EncodeToString(b[:]), nil
}

// SignBody computes the X-Postwave-Signature value for body at time t
// with the given secret. Format: `t=<unix>,v1=<hex>`.
func SignBody(secret string, t time.Time, body []byte) string {
	ts := strconvFormatI64(t.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// VerifySignature checks an `X-Postwave-Signature` header against body
// + secret. Tolerance bounds the timestamp skew (e.g. 5min). Returns
// nil on success. Used by tests + (future) inbound replay tooling;
// customers re-implement this in their own language.
func VerifySignature(header string, body []byte, secret string, now time.Time, tolerance time.Duration) error {
	var tsStr, sigHex string
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		switch {
		case strings.HasPrefix(part, "t="):
			tsStr = strings.TrimPrefix(part, "t=")
		case strings.HasPrefix(part, "v1="):
			sigHex = strings.TrimPrefix(part, "v1=")
		}
	}
	if tsStr == "" || sigHex == "" {
		return errors.New("signature: missing t/v1")
	}
	tsInt, err := strconvParseI64(tsStr)
	if err != nil {
		return errors.New("signature: bad timestamp")
	}
	if tolerance > 0 {
		skew := now.Sub(time.Unix(tsInt, 0))
		if skew < 0 {
			skew = -skew
		}
		if skew > tolerance {
			return errors.New("signature: timestamp outside tolerance")
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(tsStr))
	mac.Write([]byte("."))
	mac.Write(body)
	want := mac.Sum(nil)
	got, err := hex.DecodeString(sigHex)
	if err != nil {
		return errors.New("signature: bad hex")
	}
	if !hmac.Equal(want, got) {
		return errors.New("signature: mismatch")
	}
	return nil
}

// EnvelopeEncryptor is the minimum interface this package needs from
// the crypto package. Mirrors sending.EnvelopeEncryptor so callers can
// pass the same instance.
type EnvelopeEncryptor interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// Webhook is the public projection of an outbound_webhooks row. The
// private signing material (HMAC secret / private key) is omitted —
// it's only returned once at create / rotate time. Public keys (for
// ECDSA / Ed25519) are surfaced so subscribers can verify without
// contacting us.
type Webhook struct {
	ID                  string     `json:"id"`
	TenantID            string     `json:"tenant_id"`
	URL                 string     `json:"url"`
	Description         string     `json:"description,omitempty"`
	Events              []string   `json:"events"`
	Active              bool       `json:"active"`
	CreatedByUserID     string     `json:"created_by_user_id,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	ConfigVersion       int64      `json:"config_version"`
	LastSucceededAt     *time.Time `json:"last_succeeded_at,omitempty"`
	LastFailedAt        *time.Time `json:"last_failed_at,omitempty"`
	ConsecutiveFailures int        `json:"consecutive_failures"`
	DisabledReason      string     `json:"disabled_reason,omitempty"`
	DisabledAt          *time.Time `json:"disabled_at,omitempty"`

	// SigningAlgorithm is one of hmac_sha256 | ecdsa_p256 | ed25519.
	SigningAlgorithm string `json:"signing_algorithm"`
	// SigningPublicKey is PEM-encoded; populated only for the
	// asymmetric algorithms. Customers verify deliveries with it.
	SigningPublicKey string `json:"signing_public_key,omitempty"`
	// SecondaryPublicKey + SecondaryExpiresAt describe the rotation
	// grace window. While set, deliveries are dual-signed.
	SecondaryPublicKey string     `json:"secondary_public_key,omitempty"`
	SecondaryExpiresAt *time.Time `json:"secondary_expires_at,omitempty"`
	RotatedAt          *time.Time `json:"rotated_at,omitempty"`

	// ListID is the optional audience scope (migration 0225). When
	// set, the dispatcher filters list.subscriber.* events whose
	// payload list_id matches; tenant-wide events still flow.
	ListID string `json:"list_id,omitempty"`

	// AuthConfig is value-free metadata on read. Credential values are accepted
	// on create/update and stored only in auth_config_envelope.
	AuthConfig       *AuthConfig `json:"auth_config,omitempty"`
	AuthConfigStatus string      `json:"auth_config_status,omitempty"`
	URLStatus        string      `json:"url_status,omitempty"`

	// FilterExpression and TransformTemplate are the optional, bounded
	// delivery rules applied before signing. They contain no credentials and
	// are returned so operators can inspect and edit the exact active policy.
	FilterExpression     string         `json:"filter_expression,omitempty"`
	TransformTemplate    map[string]any `json:"transform_template,omitempty"`
	DeliveryPolicyStatus string         `json:"delivery_policy_status,omitempty"`
}

// CreateInput is the body for POST /api/v1/outbound-webhooks.
type CreateInput struct {
	URL         string   `json:"url"`
	Description string   `json:"description,omitempty"`
	Events      []string `json:"events"`
	// Algorithm picks the signing scheme. Empty defaults to
	// hmac_sha256 so existing API clients keep working.
	Algorithm string `json:"algorithm,omitempty"`
	// ListID, when non-empty, scopes this webhook to one audience.
	// Only list.subscriber.* events whose payload list_id matches
	// will be delivered. Empty = tenant-wide (legacy behaviour).
	ListID     string      `json:"list_id,omitempty"`
	AuthConfig *AuthConfig `json:"auth_config,omitempty"`
	// FilterExpression uses the documented non-executable filter DSL.
	// TransformTemplate maps output field names to RFC 6901 pointers.
	FilterExpression  string         `json:"filter_expression,omitempty"`
	TransformTemplate map[string]any `json:"transform_template,omitempty"`
}

// CreateResponse returns the row alongside freshly minted customer
// verification material. The shared HMAC secret is shown once.
// Asymmetric private keys remain server-side and envelope-encrypted;
// only the public key is returned.
type CreateResponse struct {
	Webhook       *Webhook `json:"webhook"`
	SigningSecret string   `json:"signing_secret,omitempty"` // HMAC only
	PublicKeyPEM  string   `json:"public_key_pem,omitempty"` // ECDSA / Ed25519
}

// UpdateInput is the body for PATCH /api/v1/outbound-webhooks/{id}.
type UpdateInput struct {
	URL               *string         `json:"url,omitempty"`
	Description       *string         `json:"description,omitempty"`
	Events            *[]string       `json:"events,omitempty"`
	Active            *bool           `json:"active,omitempty"`
	AuthConfig        *AuthConfig     `json:"auth_config,omitempty"`
	FilterExpression  *string         `json:"filter_expression,omitempty"`
	TransformTemplate *map[string]any `json:"transform_template,omitempty"`

	authConfigPresent        bool
	filterExpressionPresent  bool
	transformTemplatePresent bool
}

// UnmarshalJSON preserves PATCH's three receiver-auth operations:
//
//   - field omitted: leave the existing credentials unchanged
//   - field null (or {"type":"none"}): clear credentials
//   - credential object: atomically replace credentials
//
// A plain *AuthConfig cannot distinguish an omitted field from JSON null.
func (in *UpdateInput) UnmarshalJSON(data []byte) error {
	type alias UpdateInput
	var decoded alias
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*in = UpdateInput(decoded)
	_, in.authConfigPresent = fields["auth_config"]
	_, in.filterExpressionPresent = fields["filter_expression"]
	_, in.transformTemplatePresent = fields["transform_template"]
	return nil
}

func (in UpdateInput) changesAuthConfig() bool {
	return in.authConfigPresent || in.AuthConfig != nil
}

func (in UpdateInput) changesFilterExpression() bool {
	return in.filterExpressionPresent || in.FilterExpression != nil
}

func (in UpdateInput) changesTransformTemplate() bool {
	return in.transformTemplatePresent || in.TransformTemplate != nil
}

// Delivery is the public projection of an outbound_webhook_deliveries
// row.
type Delivery struct {
	ID                        string     `json:"id"`
	WebhookID                 string     `json:"webhook_id"`
	EventType                 string     `json:"event_type"`
	AttemptCount              int        `json:"attempt_count"`
	NextAttemptAt             *time.Time `json:"next_attempt_at,omitempty"`
	Status                    string     `json:"status"`
	LastStatusCode            *int       `json:"last_status_code,omitempty"`
	LastResponseBodyTruncated string     `json:"last_response_body_truncated,omitempty"`
	LastError                 string     `json:"last_error,omitempty"`
	CreatedAt                 time.Time  `json:"created_at"`
	DeliveredAt               *time.Time `json:"delivered_at,omitempty"`
}

// strconvFormat / Parse — tiny helpers so this file can stay free of
// strconv import noise. Keeps SignBody hot path readable.
func strconvFormatI64(n int64) string {
	// Equivalent to strconv.FormatInt(n, 10) but without the import.
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func strconvParseI64(s string) (int64, error) {
	if s == "" {
		return 0, errors.New("empty")
	}
	neg := false
	i := 0
	if s[0] == '-' {
		neg = true
		i = 1
	}
	if i == len(s) {
		return 0, errors.New("empty")
	}
	var n int64
	for ; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int64(c-'0')
	}
	if neg {
		n = -n
	}
	return n, nil
}
