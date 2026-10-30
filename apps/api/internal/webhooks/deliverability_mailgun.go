// Mailgun deliverability webhook receiver.
//
// Mailgun's modern webhooks ship a JSON body with three top-level
// keys: `signature`, `event-data`, and metadata. The `signature`
// object carries:
//
//   {
//     "timestamp": "1614379200",
//     "token":     "<random>",
//     "signature": "<hex HMAC-SHA256(timestamp + token, signing_key)>"
//   }
//
// The signing key is the Mailgun webhook signing key (not the API
// key). Verification is HMAC-SHA256 over the literal concatenation
// `timestamp + token` (no separator), hex-encoded.
//
// Reference:
//   https://documentation.mailgun.com/en/latest/user_manual.html#webhooks-1

package webhooks

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// mailgunPayload is the slim view of Mailgun's event-data envelope.
type mailgunPayload struct {
	Signature struct {
		Timestamp string `json:"timestamp"`
		Token     string `json:"token"`
		Signature string `json:"signature"`
	} `json:"signature"`
	EventData struct {
		Event       string  `json:"event"`    // 'delivered', 'failed', 'complained', 'opened', 'clicked', 'unsubscribed'
		Severity    string  `json:"severity"` // 'permanent' | 'temporary' on 'failed'
		Reason      string  `json:"reason"`
		ID          string  `json:"id"`
		Timestamp   float64 `json:"timestamp"`
		DeliveredAt any     `json:"delivered-at"`
		Recipient   string  `json:"recipient"`
		IP          string  `json:"ip"`
		URL         string  `json:"url"`
		ClientInfo  struct {
			UserAgent string `json:"user-agent"`
			Bot       any    `json:"bot"`
		} `json:"client-info"`
		Message struct {
			Headers struct {
				MessageID string `json:"message-id"`
			} `json:"headers"`
		} `json:"message"`
		DeliveryStatus struct {
			Code        int    `json:"code"`
			Description string `json:"description"`
			Message     string `json:"message"`
		} `json:"delivery-status"`
	} `json:"event-data"`
}

// HandleMailgun verifies + parses + processes one Mailgun event.
func (d *DeliverabilityDeps) HandleMailgun(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := readBody(r, maxBodyBytes)
	if err != nil {
		d.writeReadBodyErrDeliv(w, r, maxBodyBytes, err)
		return
	}
	var p mailgunPayload
	if err := json.Unmarshal(body, &p); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	if !d.verifyMailgun(w, &p) {
		return
	}

	ev := classifyMailgun(p, body)
	if ev.EventType == "" {
		writeJSONOK(w, http.StatusOK, map[string]any{"ignored": p.EventData.Event})
		return
	}
	if rejectDeliveryWithoutMessageID(w, ev) {
		return
	}
	tenantID := d.resolveTenant(r.Context(), r, p.EventData.Message.Headers.MessageID)
	if tenantID == "" {
		if providerCorrelationNeedsRetry(ev) {
			writeRetryableProviderCorrelation(w)
		} else {
			writeJSONErrDeliv(w, http.StatusBadRequest, "tenant_unresolved",
				"could not resolve tenant from message-id or "+DeliverabilityTenantHeader)
		}
		return
	}

	if err := d.process(r.Context(), tenantID, ev); err != nil {
		d.log().Error("deliverability: mailgun process",
			"err", err.Error(), "tenant_id", tenantID, "email_redacted", observability.RedactEmail(ev.Email))
		d.writeProviderProcessError(w, r, err)
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{
		"recorded": ev.EventType,
		"email":    ev.Email,
	})
}

func classifyMailgun(p mailgunPayload, raw []byte) classifyOutcome {
	ev := classifyOutcome{
		Email:        strings.TrimSpace(p.EventData.Recipient),
		ProviderID:   strings.TrimSpace(p.EventData.ID),
		MessageID:    strings.TrimSpace(p.EventData.Message.Headers.MessageID),
		ProviderName: suppressions.SourceMailgun,
		Reason:       strings.TrimSpace(p.EventData.Reason),
		Raw:          json.RawMessage(append([]byte(nil), raw...)),
		LinkIdentity: strings.TrimSpace(p.EventData.URL),
		UserAgent:    strings.TrimSpace(p.EventData.ClientInfo.UserAgent),
		IP:           strings.TrimSpace(p.EventData.IP),
	}
	if p.EventData.ClientInfo.Bot != nil {
		ev.ProviderSignals = map[string]any{"client_info_bot": p.EventData.ClientInfo.Bot}
	}
	if p.EventData.Timestamp > 0 {
		ev.OccurredAt = unixFloat(p.EventData.Timestamp)
	}
	if deliveredAt := unixFromAny(p.EventData.DeliveredAt); !deliveredAt.IsZero() {
		ev.DeliveredAt = &deliveredAt
	}
	switch strings.ToLower(p.EventData.Event) {
	case "failed":
		ev.EventType = "bounced"
		// `severity` discriminates hard vs soft. Mailgun uses
		// "permanent" for hard, "temporary" for soft. Empty severity
		// is treated as soft so we don't aggressively suppress on a
		// payload-shape change.
		switch strings.ToLower(p.EventData.Severity) {
		case "permanent":
			ev.BounceClass = "hard"
		default:
			ev.BounceClass = "soft"
		}
	case "complained":
		ev.EventType = "complained"
	case "unsubscribed":
		ev.EventType = "unsubscribed"
	case "delivered":
		ev.EventType = "delivered"
		ev.Reason = strings.TrimSpace(firstNonEmpty(
			p.EventData.DeliveryStatus.Message,
			p.EventData.DeliveryStatus.Description,
			p.EventData.Reason,
		))
	case "opened":
		ev.EventType = "opened"
	case "clicked":
		ev.EventType = "clicked"
	}
	return ev
}

// verifyMailgun verifies the Mailgun signature object embedded in the
// JSON body. Returns false (and writes the response) on any failure.
func (d *DeliverabilityDeps) verifyMailgun(w http.ResponseWriter, p *mailgunPayload) bool {
	if d.MailgunKey == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		writeJSONErrDeliv(w, http.StatusUnauthorized, "webhook_secret_required",
			"Mailgun webhook signing key not configured")
		return false
	}
	if p.Signature.Timestamp == "" || p.Signature.Token == "" || p.Signature.Signature == "" {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "missing_signature",
			"Mailgun signature object missing timestamp/token/signature")
		return false
	}
	// Replay-window guard. Mailgun timestamps are unix seconds.
	tsUnix, err := strconv.ParseInt(p.Signature.Timestamp, 10, 64)
	if err != nil {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "bad_timestamp", "")
		return false
	}
	drift := d.now().Sub(unixFloat(float64(tsUnix)))
	if drift < 0 {
		drift = -drift
	}
	if drift > MailgunReplayWindow {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "stale_timestamp",
			"outside Mailgun replay window")
		return false
	}
	want := hashHMACSHA256(d.MailgunKey,
		[]byte(p.Signature.Timestamp+p.Signature.Token))
	if !constantTimeEqHex(want, p.Signature.Signature) {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "bad_signature", "")
		return false
	}
	return true
}

// unixFloat converts a unix-second-as-float (Mailgun's preferred
// timestamp encoding) into a UTC time.Time. Sub-second precision is
// preserved.
func unixFloat(f float64) time.Time {
	sec := int64(f)
	nsec := int64((f - float64(sec)) * 1e9)
	return time.Unix(sec, nsec).UTC()
}
