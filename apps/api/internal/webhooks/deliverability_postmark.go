// Postmark deliverability webhook receiver.
//
// Postmark fires one webhook per event (NOT a batch). The same URL
// receives Bounce, SpamComplaint, Open, Click, and SubscriptionChange
// events; the body's `RecordType` discriminator tells us which.
//
// Signature verification: Postmark's public webhook docs document IP
// allowlisting and Basic HTTP authentication, not a provider-native HMAC
// signature header. This handler verifies a Moosewave edge/proxy signature
// header for deployments that terminate Postmark Basic auth at the edge and
// forward a raw-body HMAC internally. That means the catalog must treat
// Postmark deliverability as a partial foundation until provider-native setup
// and edge configuration are both verified end-to-end.
//
// Reference:
//   https://postmarkapp.com/developer/webhooks/

package webhooks

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// PostmarkSignatureHeader is Moosewave's internal edge header carrying the
// HMAC-SHA256-hex(body, postmarkWebhookSecret) signature.
const PostmarkSignatureHeader = "X-Postmark-Webhook-Signature"

// PostmarkTraceIDHeader is Postmark's provider-issued per-webhook identity.
// Delivery/open/click payloads do not carry the bounce-only numeric ID, so the
// trace header is the preferred dedup key when the edge preserves it.
const PostmarkTraceIDHeader = "X-PM-Webhook-Trace-Id"

// postmarkDateSkew is how far the HTTP Date header may drift from
// our clock before we reject the request. Postmark's signature
// scheme — unlike Stripe / Slack / Mailgun — does NOT bind a
// timestamp into the HMAC, so a sophisticated attacker who
// captured a signed body can replay it with a fresh Date header
// and pass this check. This guard catches only the casual case
// (replaying a request log entry verbatim, no header rewriting).
//
// The catastrophic-impact replay class (suppression injection) is
// covered at the suppressions store via the unique
// (tenant_id, source, source_event_id) constraint — Postmark's
// stable per-event ID dedupes a replayed payload to a no-op. Engagement events
// use the same subscriber_event_dedup_keys claim added by migration 1727, so
// open/click redelivery is covered by the same durable provider identity.
const postmarkDateSkew = 5 * time.Minute

// postmarkPayload is the slim view of Postmark's webhook envelope.
// Different RecordType values populate different fields; we only
// declare those we need for classification.
type postmarkPayload struct {
	RecordType  string `json:"RecordType"`
	MessageID   string `json:"MessageID"`
	Email       string `json:"Email"`
	Recipient   string `json:"Recipient"`
	Type        string `json:"Type"` // bounce sub-type
	Description string `json:"Description"`
	Details     string `json:"Details"`
	BouncedAt   string `json:"BouncedAt"`
	ReceivedAt  string `json:"ReceivedAt"`
	DeliveredAt string `json:"DeliveredAt"`
	UserAgent   string `json:"UserAgent"`
	Geo         struct {
		IP string `json:"IP"`
	} `json:"Geo,omitempty"`
	OriginalLink struct {
		OriginalLink string `json:"OriginalLink"`
	} `json:"OriginalLink,omitempty"`
	// SuppressSending is sent on SubscriptionChange events; true means
	// the subscriber was unsubscribed / suppressed via Postmark's
	// hosted unsubscribe page.
	SuppressSending bool `json:"SuppressSending,omitempty"`

	// `ID` is the global event id that Postmark guarantees stable
	// across re-deliveries. We pin source_event_id to this so a
	// duplicate webhook delivery is a no-op.
	ID json.Number `json:"ID,omitempty"`
}

// HandlePostmark verifies + parses + processes one Postmark event.
// Always responds 200 on accepted events (Postmark retries on 4xx /
// 5xx). Verification failure returns 401; payload-level reject (e.g.
// no tenant) returns 400.
func (d *DeliverabilityDeps) HandlePostmark(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := readBody(r, maxBodyBytes)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, maxBodyBytes, err)
		return
	}
	if !d.verifyPostmark(w, r, body) {
		return
	}
	var p postmarkPayload
	if err := json.Unmarshal(body, &p); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	ev := classifyPostmark(p, body, r.Header.Get(PostmarkTraceIDHeader))
	if ev.EventType == "" {
		ignored := p.RecordType
		if strings.EqualFold(p.RecordType, "subscriptionchange") && !p.SuppressSending {
			ignored = "subscription_resubscribe"
		}
		writeJSONOK(w, http.StatusOK, map[string]any{"ignored": ignored})
		return
	}
	if rejectDeliveryWithoutMessageID(w, ev) {
		return
	}
	tenantID := d.resolveTenant(r.Context(), r, p.MessageID)
	if tenantID == "" {
		if providerCorrelationNeedsRetry(ev) {
			writeRetryableProviderCorrelation(w)
		} else {
			writeJSONErrDeliv(w, http.StatusBadRequest, "tenant_unresolved",
				"could not resolve tenant from MessageID or "+DeliverabilityTenantHeader)
		}
		return
	}

	if err := d.process(r.Context(), tenantID, ev); err != nil {
		d.log().Error("deliverability: postmark process",
			"err", err.Error(), "tenant_id", tenantID, "email_redacted", observability.RedactEmail(ev.Email))
		d.writeProviderProcessError(w, r, err)
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{
		"recorded": ev.EventType,
		"email":    ev.Email,
	})
}

func classifyPostmark(p postmarkPayload, raw []byte, traceID string) classifyOutcome {
	ev := classifyOutcome{
		Email:        firstNonEmpty(p.Email, p.Recipient),
		MessageID:    strings.TrimSpace(p.MessageID),
		ProviderID:   firstNonEmpty(string(p.ID), traceID),
		ProviderName: suppressions.SourcePostmark,
		Reason:       strings.TrimSpace(p.Description + " " + p.Details),
		Raw:          json.RawMessage(append([]byte(nil), raw...)),
		UserAgent:    strings.TrimSpace(p.UserAgent),
		IP:           strings.TrimSpace(p.Geo.IP),
	}
	switch strings.ToLower(p.RecordType) {
	case "bounce":
		ev.EventType = "bounced"
		switch p.Type {
		case "HardBounce":
			ev.BounceClass = "hard"
		case "SoftBounce", "Transient":
			ev.BounceClass = "soft"
		default:
			ev.BounceClass = "soft"
		}
		ev.OccurredAt = ParsePostmarkUnixOrRFC3339(p.BouncedAt)
	case "spamcomplaint":
		ev.EventType = "complained"
		ev.OccurredAt = ParsePostmarkUnixOrRFC3339(p.BouncedAt)
	case "open":
		ev.EventType = "opened"
		ev.OccurredAt = ParsePostmarkUnixOrRFC3339(p.ReceivedAt)
	case "click":
		ev.EventType = "clicked"
		ev.LinkIdentity = strings.TrimSpace(p.OriginalLink.OriginalLink)
		ev.OccurredAt = ParsePostmarkUnixOrRFC3339(p.ReceivedAt)
	case "delivery":
		ev.EventType = "delivered"
		ev.OccurredAt = ParsePostmarkUnixOrRFC3339(firstNonEmpty(p.DeliveredAt, p.ReceivedAt))
	case "subscriptionchange":
		if p.SuppressSending {
			ev.EventType = "unsubscribed"
		}
	}
	return ev
}

// verifyPostmark applies the X-Postmark-Webhook-Signature check.
// Returns false (and writes the response) when verification fails.
func (d *DeliverabilityDeps) verifyPostmark(w http.ResponseWriter, r *http.Request, body []byte) bool {
	if d.PostmarkToken == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		writeJSONErrDeliv(w, http.StatusUnauthorized, "webhook_secret_required",
			"Postmark webhook secret not configured; refusing to accept unsigned event")
		return false
	}
	sig := strings.TrimSpace(r.Header.Get(PostmarkSignatureHeader))
	if sig == "" {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "missing_signature",
			PostmarkSignatureHeader+" required")
		return false
	}
	want := hashHMACSHA256(d.PostmarkToken, body)
	if !constantTimeEqHex(want, sig) {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "bad_signature", "")
		return false
	}
	// Date freshness — see postmarkDateSkew doc for the threat model.
	// Missing Date is tolerated because not all HTTP clients send it.
	if raw := strings.TrimSpace(r.Header.Get("Date")); raw != "" {
		parsed, err := http.ParseTime(raw)
		if err == nil {
			drift := time.Since(parsed)
			if drift < 0 {
				drift = -drift
			}
			if drift > postmarkDateSkew {
				writeJSONErrDeliv(w, http.StatusUnauthorized, "stale_request",
					"Date header drifts more than "+postmarkDateSkew.String()+" from server clock")
				return false
			}
		}
	}
	return true
}

// firstNonEmpty returns the first non-empty trimmed string, useful for
// Postmark's variable use of Email vs Recipient across event types.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" {
			return v
		}
	}
	return ""
}
