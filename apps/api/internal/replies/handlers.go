// SPDX-License-Identifier: AGPL-3.0-only
//
// Inbound reply webhook receivers — Postmark, Mailgun, SES.
//
// Each handler performs:
//
//   1. Provider signature verification BEFORE parsing. Same patterns
//      used by webhooks.DeliverabilityDeps:
//        - Postmark: HMAC-SHA256-hex(body, postmarkSecret) in
//          X-Postmark-Webhook-Signature.
//        - Mailgun: HMAC-SHA256(timestamp+token, signingKey) embedded in
//          the JSON body's `signature` object.
//        - SES: SNS-wrapped envelope; we accept TopicArn allow-list +
//          shared-secret header (per-deployment) since the full SNS
//          signature verification ceremony is owned by the deliverability
//          receivers and we don't want to duplicate the RSA-cert
//          fetching state machine. Operators wire SES → SNS → API
//          Gateway with an HMAC-shared-secret header on the API Gateway
//          stage so we can verify cheaply.
//
//   2. Tenant resolution. Order:
//        a. `To` envelope tag (replies-<tenantSlug>@reply.<domain>).
//        b. recipient_email subscriber-owner lookup.
//        c. drop with warn + counter.
//
//   3. Envelope parsing → Reply struct.
//
//   4. Matcher.Resolve → campaign + subscriber ids.
//
//   5. Store.Persist → idempotent insert.
//
//   6. 200 OK in <5s. Heavy lifting (the matcher's database lookups)
//      already runs synchronously since each is O(1) indexed reads;
//      the goroutine fallback in step 7 of the spec is only triggered
//      for parsing very large multipart bodies, which we cap at 5MB.

package replies

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/snsverify"
)

// MaxBodyBytes caps the inbound webhook body. Postmark/Mailgun inbound
// payloads with attachments can run a few hundred KB; 5MB is a generous
// upper bound that still rejects pathological bodies.
const MaxBodyBytes = 5 << 20

// PostmarkSignatureHeader, MailgunSignatureHeaderTimestamp, etc. names
// match the deliverability receivers so the operator-facing config
// surface stays consistent.
const (
	PostmarkSignatureHeader = "X-Postmark-Webhook-Signature"
	MailgunReplayWindow     = 5 * time.Minute
	SESSharedSecretHeader   = "X-Postwave-SES-Inbound-Secret"
)

var errReplyBodyTooLarge = errors.New("reply webhook payload too large")

// TenantResolver maps a recipient envelope or sender email back to a
// tenant id. Implementations should be safe to call concurrently.
type TenantResolver interface {
	// LookupTenantBySlug returns ("", nil) on a miss. The slug is the
	// `replies-<slug>` portion of the inbound envelope's local-part.
	LookupTenantBySlug(ctx context.Context, slug string) (string, error)
	// LookupTenantBySubscriberEmail returns the tenant that owns a
	// given subscriber email, or ("", nil) on a miss.
	LookupTenantBySubscriberEmail(ctx context.Context, email string) (string, error)
}

// ReplyCorrelationTenantResolver is an optional, stronger pre-tenant lookup.
// It resolves only an exact opaque token commitment from the accepted send
// ledger; no tenant/campaign/recipient identifier is decoded from the address.
type ReplyCorrelationTenantResolver interface {
	LookupTenantByReplyCorrelation(ctx context.Context, recipient string) (string, error)
}

// Deps bundles handler dependencies. Constructed from main.go.
type Deps struct {
	Store   *Store
	Matcher *Matcher

	// Provider secrets. Empty in dev with AllowUnsignedDevBypass set;
	// otherwise required.
	PostmarkSecret    string
	MailgunSigningKey string
	SESSharedSecret   string

	// SESTopicARNs enables SNS signature verification when set. Empty keeps
	// the previous shared-secret-only behaviour rather than failing closed on
	// upgrade, which would take a working inbound path down on deploy.
	SESTopicARNs []string

	// AllowUnsignedDevBypass disables signature verification
	// entirely. Production preflight in main.go refuses to boot with
	// this set, mirroring the deliverability path.
	AllowUnsignedDevBypass bool

	// EnvelopeDomainSuffix is the trailing reply-tag domain we expect
	// inbound `To:` headers to use, e.g. "reply.moosewave.com". Used to
	// extract the tenant slug from "replies-<slug>@reply.moosewave.com".
	// When empty, the slug-based tenant resolution branch is skipped.
	EnvelopeDomainSuffix string

	TenantResolver TenantResolver

	// UnmappedCounter, when non-nil, is incremented every time we drop
	// an inbound reply because no tenant could be resolved. Mirrors
	// the spec's `inbound_replies_unmapped_total` counter.
	UnmappedCounter *atomic.Int64

	Logger *slog.Logger

	// Now overrides time.Now for deterministic tests of the Mailgun
	// replay-window check.
	Now func() time.Time

	// ObjectWorker handles the SES S3 action — the shape the receipt rule in
	// infra/terraform/ses-inbound actually delivers.
	//
	// Nil keeps the historical inline-only behaviour, so this field IS the
	// feature flag. A deployment with no bucket configured behaves exactly as
	// before rather than failing on a notification shape it cannot fetch.
	ObjectWorker *InboundObjectWorker
}

// MountRoutes registers the three inbound webhook routes on r.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Post("/api/internal/webhooks/inbound/postmark", d.HandlePostmark)
	r.Post("/api/internal/webhooks/inbound/mailgun", d.HandleMailgun)
	r.Post("/api/internal/webhooks/inbound/ses", d.HandleSES)
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

// ---------------------------------------------------------------------------
// Postmark inbound
// ---------------------------------------------------------------------------

// postmarkInbound is the slim view of Postmark's inbound JSON envelope.
// See: https://postmarkapp.com/developer/user-guide/inbound/parse-an-email
type postmarkInbound struct {
	MessageID         string            `json:"MessageID"`
	From              string            `json:"From"`
	FromFull          postmarkAddress   `json:"FromFull"`
	To                string            `json:"To"`
	ToFull            []postmarkAddress `json:"ToFull"`
	OriginalRecipient string            `json:"OriginalRecipient"`
	Subject           string            `json:"Subject"`
	TextBody          string            `json:"TextBody"`
	HtmlBody          string            `json:"HtmlBody"`
	Headers           []postmarkHeader  `json:"Headers"`
}

type postmarkAddress struct {
	Email string `json:"Email"`
	Name  string `json:"Name"`
}

type postmarkHeader struct {
	Name  string `json:"Name"`
	Value string `json:"Value"`
}

// HandlePostmark verifies + parses + persists a single inbound reply.
func (d *Deps) HandlePostmark(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, MaxBodyBytes)
	if err != nil {
		if errors.Is(err, errReplyBodyTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "inbound reply payload exceeds 5 MiB")
			return
		}
		httperror.WriteValidation(w, "read_body", "request could not be processed")
		return
	}
	if !d.verifyPostmark(w, r, body) {
		return
	}
	var p postmarkInbound
	if err := json.Unmarshal(body, &p); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	from := firstNonEmpty(p.FromFull.Email, p.From)
	to := firstNonEmpty(p.OriginalRecipient, p.To, addressOf(p.ToFull))
	inReplyTo := headerValue(p.Headers, "In-Reply-To")
	references := headerValue(p.Headers, "References")
	bodyText := firstNonEmpty(p.TextBody, p.HtmlBody)
	receivedAt := parseMailDate(headerValue(p.Headers, "Date"))
	rep := Reply{
		RecipientEmail:    from,
		EnvelopeRecipient: to,
		// The chain is tokenized rather than concatenated: storing the whole
		// References string in a field compared against one Message-ID is a
		// comparison that can never succeed.
		InReplyTo:             firstThreadCandidate(inReplyTo, references),
		Subject:               p.Subject,
		BodySnippet:           snippet(bodyText),
		ClassificationBody:    boundedUTF8(bodyText, ClassificationBodyMaxLen),
		ClassificationHeaders: postmarkClassificationHeaders(p.Headers),
		RawMessageID:          p.MessageID,
		ReceivedAt:            receivedAt,
		Source:                SourcePostmark,
		Metadata:              replyMetadataJSON(map[string]string{"to": to}),
	}
	d.ingest(r.Context(), w, to, rep)
}

func (d *Deps) verifyPostmark(w http.ResponseWriter, r *http.Request, body []byte) bool {
	if d.PostmarkSecret == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		httperror.Write(w, http.StatusUnauthorized, "webhook_secret_required",
			"Postmark inbound secret not configured")
		return false
	}
	sig := strings.TrimSpace(r.Header.Get(PostmarkSignatureHeader))
	if sig == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature",
			PostmarkSignatureHeader+" required")
		return false
	}
	want := hashHMACSHA256(d.PostmarkSecret, body)
	if !constantTimeEqHex(want, sig) {
		httperror.Write(w, http.StatusUnauthorized, "bad_signature", "invalid Postmark webhook signature")
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Mailgun inbound
// ---------------------------------------------------------------------------
//
// Mailgun delivers inbound emails as multipart/form-data by default. We
// accept either:
//   - the modern JSON shape Mailgun ships when "Format URLs" is set, or
//   - the multipart form fields Mailgun ships otherwise.
//
// Signature verification is identical to the deliverability webhook:
// HMAC-SHA256(timestamp+token, signing_key) over the literal
// concatenation, hex-encoded.

type mailgunInboundJSON struct {
	Signature struct {
		Timestamp string `json:"timestamp"`
		Token     string `json:"token"`
		Signature string `json:"signature"`
	} `json:"signature"`
	EventData struct {
		MessageID  string                 `json:"id"`
		From       string                 `json:"from"`
		To         string                 `json:"to"`
		Subject    string                 `json:"subject"`
		Recipient  string                 `json:"recipient"`
		Sender     string                 `json:"sender"`
		BodyPlain  string                 `json:"body-plain"`
		BodyHTML   string                 `json:"body-html"`
		InReplyTo  string                 `json:"In-Reply-To"`
		References string                 `json:"References"`
		ReplyTo    string                 `json:"Reply-To"`
		Headers    map[string]interface{} `json:"message-headers"`
	} `json:"event-data"`
}

// HandleMailgun verifies + parses + persists a single inbound reply.
func (d *Deps) HandleMailgun(w http.ResponseWriter, r *http.Request) {
	contentType := r.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(contentType, "application/json"):
		d.handleMailgunJSON(w, r)
	case strings.HasPrefix(contentType, "multipart/form-data") ||
		strings.HasPrefix(contentType, "application/x-www-form-urlencoded"):
		d.handleMailgunForm(w, r)
	default:
		// Be lenient: try JSON first, then form. Some staging configs
		// send without an explicit Content-Type.
		d.handleMailgunJSON(w, r)
	}
}

func (d *Deps) handleMailgunJSON(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, MaxBodyBytes)
	if err != nil {
		if errors.Is(err, errReplyBodyTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Mailgun inbound payload exceeds 5 MiB")
			return
		}
		httperror.WriteValidation(w, "read_body", "request could not be processed")
		return
	}
	var p mailgunInboundJSON
	if err := json.Unmarshal(body, &p); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	if !d.verifyMailgun(w, p.Signature.Timestamp, p.Signature.Token, p.Signature.Signature) {
		return
	}
	from := firstNonEmpty(p.EventData.Sender, p.EventData.From)
	to := firstNonEmpty(p.EventData.Recipient, p.EventData.To)
	bodyText := firstNonEmpty(p.EventData.BodyPlain, p.EventData.BodyHTML)
	receivedAt := parseUnixTimestamp(p.Signature.Timestamp)
	rep := Reply{
		RecipientEmail:        from,
		EnvelopeRecipient:     to,
		InReplyTo:             firstThreadCandidate(p.EventData.InReplyTo, p.EventData.References),
		Subject:               p.EventData.Subject,
		BodySnippet:           snippet(bodyText),
		ClassificationBody:    boundedUTF8(bodyText, ClassificationBodyMaxLen),
		ClassificationHeaders: mapClassificationHeaders(p.EventData.Headers),
		RawMessageID:          p.EventData.MessageID,
		ReceivedAt:            receivedAt,
		Source:                SourceMailgun,
		Metadata:              replyMetadataJSON(map[string]string{"to": to}),
	}
	d.ingest(r.Context(), w, to, rep)
}

func (d *Deps) handleMailgunForm(w http.ResponseWriter, r *http.Request) {
	// Cap the form body up front; ParseMultipartForm doesn't honour
	// MaxBytesReader unless we wrap r.Body explicitly.
	if r.ContentLength > MaxBodyBytes {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Mailgun inbound payload exceeds 5 MiB")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	if err := r.ParseMultipartForm(MaxBodyBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Mailgun inbound payload exceeds 5 MiB")
			return
		}
		// Form-encoded (non-multipart) parses through ParseForm.
		if err := r.ParseForm(); err != nil {
			if errors.As(err, &maxErr) {
				httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Mailgun inbound payload exceeds 5 MiB")
				return
			}
			httperror.WriteValidation(w, "parse_form", "request payload is invalid")
			return
		}
	}
	// Mailgun's form fields: timestamp, token, signature, sender,
	// recipient, From, To, subject, body-plain, body-html, Message-Id,
	// In-Reply-To, References, etc.
	get := func(k string) string { return strings.TrimSpace(r.FormValue(k)) }
	if !d.verifyMailgun(w, get("timestamp"), get("token"), get("signature")) {
		return
	}
	from := firstNonEmpty(get("sender"), get("from"), get("From"))
	to := firstNonEmpty(get("recipient"), get("to"), get("To"))
	bodyText := firstNonEmpty(get("body-plain"), get("stripped-text"), get("body-html"))
	receivedAt := parseUnixTimestamp(get("timestamp"))
	rep := Reply{
		RecipientEmail:        from,
		EnvelopeRecipient:     to,
		InReplyTo:             firstThreadCandidate(get("In-Reply-To"), firstNonEmpty(get("references"), get("References"))),
		Subject:               firstNonEmpty(get("subject"), get("Subject")),
		BodySnippet:           snippet(bodyText),
		ClassificationBody:    boundedUTF8(bodyText, ClassificationBodyMaxLen),
		ClassificationHeaders: formClassificationHeaders(get),
		RawMessageID:          firstNonEmpty(get("Message-Id"), get("Message-ID"), get("message-id")),
		ReceivedAt:            receivedAt,
		Source:                SourceMailgun,
		Metadata:              replyMetadataJSON(map[string]string{"to": to}),
	}
	d.ingest(r.Context(), w, to, rep)
}

func (d *Deps) verifyMailgun(w http.ResponseWriter, timestamp, token, signature string) bool {
	if d.MailgunSigningKey == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		httperror.Write(w, http.StatusUnauthorized, "webhook_secret_required",
			"Mailgun signing key not configured")
		return false
	}
	if timestamp == "" || token == "" || signature == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature",
			"Mailgun signature triple incomplete")
		return false
	}
	tsUnix, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "bad_timestamp", "Mailgun timestamp not a valid unix epoch")
		return false
	}
	drift := d.now().Sub(time.Unix(tsUnix, 0).UTC())
	if drift < 0 {
		drift = -drift
	}
	if drift > MailgunReplayWindow {
		httperror.Write(w, http.StatusUnauthorized, "stale_timestamp",
			"outside Mailgun replay window")
		return false
	}
	want := hashHMACSHA256(d.MailgunSigningKey, []byte(timestamp+token))
	if !constantTimeEqHex(want, signature) {
		httperror.Write(w, http.StatusUnauthorized, "bad_signature", "invalid Mailgun webhook signature")
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// SES inbound (SNS-wrapped)
// ---------------------------------------------------------------------------
//
// We accept the SNS Notification envelope. Full RSA-cert verification
// is owned by the deliverability receivers (deliverability_ses.go); the
// reply pipeline uses a shared-secret header set on the API Gateway
// stage instead so the ingestion path stays simple. Payloads carry
// either:
//   - a Postmark-compatible inbound shape inline in `Message`, or
//   - an S3 reference (placed by SES + S3 Action). For v1 we accept
//     the inline shape only and log a warning when the S3 path is
//     present, leaving full S3 fetch for a follow-up.

type snsEnvelope struct {
	Type      string `json:"Type"`
	MessageID string `json:"MessageId"`
	TopicArn  string `json:"TopicArn"`
	Subject   string `json:"Subject"`
	Message   string `json:"Message"`
	Timestamp string `json:"Timestamp"`
	// Signature fields. Previously absent, which is why this endpoint could
	// not verify anything even in principle — it never decoded the proof.
	SignatureVersion string `json:"SignatureVersion"`
	Signature        string `json:"Signature"`
	SigningCertURL   string `json:"SigningCertURL,omitempty"`
	SubscribeURL     string `json:"SubscribeURL,omitempty"`
	Token            string `json:"Token,omitempty"`
}

func (env snsEnvelope) toShared() snsverify.Envelope {
	return snsverify.Envelope{
		Type: env.Type, MessageID: env.MessageID, TopicArn: env.TopicArn,
		Subject: env.Subject, Message: env.Message, Timestamp: env.Timestamp,
		SignatureVersion: env.SignatureVersion, Signature: env.Signature,
		SigningCertURL: env.SigningCertURL, SubscribeURL: env.SubscribeURL,
		Token: env.Token,
	}
}

// verifySESSignature adds SNS signature verification on top of the shared
// secret. It runs only when SESTopicARNs is configured, so an existing
// deployment keeps working while a configured one gets cryptographic proof
// that a payload came from Amazon rather than from whoever learned the secret.
//
// The shared secret is NOT replaced. A secret travels in every request and can
// leak into a log or a proxy; a signature cannot be replayed onto different
// content. Requiring both is strictly stronger than either.
func (d *Deps) verifySESSignature(w http.ResponseWriter, env snsEnvelope) bool {
	if len(d.SESTopicARNs) == 0 {
		return true
	}
	if err := (snsverify.Verifier{AllowedTopicARNs: d.SESTopicARNs}).Verify(env.toShared()); err != nil {
		d.log().Warn("replies: SES SNS signature rejected",
			"reason", snsverify.FailureReason(err),
			"message_id", env.MessageID, "topic_arn", env.TopicArn)
		httperror.Write(w, http.StatusUnauthorized, "bad_signature",
			"SNS signature verification failed")
		return false
	}
	return true
}

type sesInboundInline struct {
	// SES inbound mirrors the "Mail" + "Receipt" + "Content" wrap. We
	// only need the subset that lets us synthesise a Reply.
	Mail struct {
		MessageID     string   `json:"messageId"`
		Source        string   `json:"source"`
		Destination   []string `json:"destination"`
		CommonHeaders struct {
			From      []string `json:"from"`
			To        []string `json:"to"`
			Subject   string   `json:"subject"`
			MessageID string   `json:"messageId"`
		} `json:"commonHeaders"`
		Headers []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"headers"`
	} `json:"mail"`
	Content string `json:"content"`
}

// HandleSES verifies + parses + persists an SNS-wrapped SES inbound.
func (d *Deps) HandleSES(w http.ResponseWriter, r *http.Request) {
	if !d.verifySESSharedSecret(w, r) {
		return
	}
	body, err := readBody(r, MaxBodyBytes)
	if err != nil {
		if errors.Is(err, errReplyBodyTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "SES inbound payload exceeds 5 MiB")
			return
		}
		httperror.WriteValidation(w, "read_body", "request could not be processed")
		return
	}
	var env snsEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	// SNS subscription confirmation arrives as Type=SubscriptionConfirmation;
	// we ack with 200 since the deliverability path handles confirmation
	// elsewhere. The inbound webhook is wired only after confirmation.
	if !d.verifySESSignature(w, env) {
		return
	}
	if env.Type != "Notification" {
		writeJSONOK(w, http.StatusOK, map[string]any{"ignored": env.Type})
		return
	}

	// The S3 action, before the inline path. A receipt rule that writes to a
	// bucket sends a notification carrying the object reference and NO message
	// body, so the inline decoder below would read it as an empty mail and
	// discard a real reply silently.
	if d.ObjectWorker != nil {
		delivery, parseErr := ParseSESInboundNotification([]byte(env.Message))
		if parseErr == nil {
			outcome, procErr := d.ObjectWorker.ProcessObject(r.Context(), delivery)
			switch {
			case procErr == nil:
				// `dropped` is reported rather than flattened into a bare ok.
				// A reply discarded for a virus verdict and a reply stored are
				// both 200s to SNS, and an operator needs to tell them apart.
				writeJSONOK(w, http.StatusOK, map[string]any{
					"processed": true,
					"duplicate": outcome.Duplicate,
					"dropped":   outcome.Dropped,
				})
				return
			case errors.Is(procErr, ErrMalformedObject), errors.Is(procErr, ErrObjectTooLarge):
				// ACKED, not retried. SNS redelivers on a non-2xx, and an object
				// that will never parse would be redelivered forever — a poison
				// message that costs more every hour it is retried. The failure
				// is logged so it is visible rather than merely absent.
				d.log().Warn("replies: inbound object permanently unprocessable",
					"err", procErr.Error(), "bucket", delivery.Object.Bucket)
				writeJSONOK(w, http.StatusOK, map[string]any{
					"processed": false, "permanent": true,
				})
				return
			default:
				// Transient (S3 unavailable, database down). A non-2xx asks SNS
				// to retry, which is what we want for a failure that may clear.
				d.log().Error("replies: inbound object processing failed",
					"err", procErr.Error())
				httperror.WriteInternal(w, d.log(), procErr, r.Context())
				return
			}
		}
		// Not an S3-action notification. Fall through to the inline path rather
		// than rejecting: one SES receiver may legitimately serve both shapes.
	}

	var inline sesInboundInline
	if err := json.Unmarshal([]byte(env.Message), &inline); err != nil {
		httperror.WriteValidation(w, "bad_inner_json", "request payload is invalid")
		return
	}
	from := firstNonEmpty(inline.Mail.Source, addressOfSlice(inline.Mail.CommonHeaders.From))
	to := firstNonEmpty(addressOfSlice(inline.Mail.CommonHeaders.To), addressOfSlice(inline.Mail.Destination))
	inReplyTo := headerValueRaw(inline.Mail.Headers, "In-Reply-To")
	references := headerValueRaw(inline.Mail.Headers, "References")
	receivedAt := parseRFC3339Timestamp(env.Timestamp)
	rep := Reply{
		RecipientEmail:    from,
		EnvelopeRecipient: to,
		// The chain is tokenized rather than concatenated: storing the whole
		// References string in a field compared against one Message-ID is a
		// comparison that can never succeed.
		InReplyTo:             firstThreadCandidate(inReplyTo, references),
		Subject:               inline.Mail.CommonHeaders.Subject,
		BodySnippet:           snippet(inline.Content),
		ClassificationBody:    boundedUTF8(inline.Content, ClassificationBodyMaxLen),
		ClassificationHeaders: sesClassificationHeaders(inline.Mail.Headers),
		RawMessageID:          firstNonEmpty(inline.Mail.MessageID, inline.Mail.CommonHeaders.MessageID, env.MessageID),
		ReceivedAt:            receivedAt,
		Source:                SourceSESInbound,
		Metadata: replyMetadataJSON(map[string]string{
			"to": to, "sns_topic": env.TopicArn,
		}),
	}
	d.ingest(r.Context(), w, to, rep)
}

func (d *Deps) verifySESSharedSecret(w http.ResponseWriter, r *http.Request) bool {
	if d.SESSharedSecret == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		httperror.Write(w, http.StatusUnauthorized, "webhook_secret_required",
			"SES inbound shared secret not configured")
		return false
	}
	got := strings.TrimSpace(r.Header.Get(SESSharedSecretHeader))
	if got == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature",
			SESSharedSecretHeader+" required")
		return false
	}
	if !hmac.Equal([]byte(got), []byte(d.SESSharedSecret)) {
		httperror.Write(w, http.StatusUnauthorized, "bad_signature", "invalid SES inbound shared secret")
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Shared ingest path
// ---------------------------------------------------------------------------

// ingest is the post-parsing pipeline shared by all three providers.
// It resolves the tenant, runs the matcher, and persists the row.
// Always returns 200 OK on accepted (or intentionally dropped) events.
func (d *Deps) ingest(ctx context.Context, w http.ResponseWriter, toEnvelope string, rep Reply) {
	tenantID := d.resolveTenant(ctx, toEnvelope, rep.RecipientEmail)
	if tenantID == "" {
		if d.UnmappedCounter != nil {
			d.UnmappedCounter.Add(1)
		}
		d.log().Warn("replies: dropping unmapped inbound reply",
			"from", rep.RecipientEmail,
			"to", toEnvelope,
			"source", rep.Source,
			"raw_message_id", rep.RawMessageID,
		)
		writeJSONOK(w, http.StatusOK, map[string]any{"dropped": "tenant_unmapped"})
		return
	}
	rep.TenantID = tenantID

	if d.Matcher != nil {
		res, err := d.Matcher.Resolve(ctx, tenantID, rep)
		if err != nil {
			d.log().Warn("replies: matcher.Resolve error",
				"tenant", tenantID, "err", err.Error())
		} else {
			rep.CampaignID = res.CampaignID
			rep.SubscriberID = res.SubscriberID
			rep.MatchMethod = res.Method
		}
	}

	id, isDup, err := d.Store.Persist(ctx, tenantID, rep)
	if err != nil {
		d.log().Error("replies: persist failed",
			"tenant", tenantID, "err", err.Error())
		httperror.WriteInternal(w, d.Logger, err, ctx)
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{
		"id":        id,
		"duplicate": isDup,
		"campaign":  rep.CampaignID,
		"unmapped":  rep.CampaignID == "",
	})
}

// resolveTenant walks tenant resolution strongest signal first:
//
//  1. signed VERP envelope (reply+<token>@<domain>),
//  2. envelope tag (replies-<slug>@<envelopeDomain>),
//  3. subscriber-owner lookup by recipient_email,
//  4. give up.
//
// VERP leads because it is the only branch whose answer this deployment
// signed: the slug is a plaintext claim written into an address, and the
// email fallback is a global lookup that is ambiguous whenever the same
// address is a subscriber of two tenants. It also has to lead for the send
// path to work at all — a VERP address carries no `replies-` tag, so before
// this branch existed every reply to one fell straight through to the email
// guess, or was dropped as unmapped while holding full signed attribution.
//
// Note the deliberate asymmetry with the other branches: no TenantResolver is
// required, because there is no lookup to do. The tenant is inside the token.
func (d *Deps) resolveTenant(ctx context.Context, toEnvelope, fromEmail string) string {
	if resolver, ok := d.TenantResolver.(ReplyCorrelationTenantResolver); ok {
		if id, err := resolver.LookupTenantByReplyCorrelation(ctx, toEnvelope); err == nil && id != "" {
			return id
		}
	}
	if id, ok := d.Matcher.TenantFromVERPRecipient(toEnvelope); ok && id != "" {
		return id
	}
	if d.TenantResolver == nil {
		return ""
	}
	if slug := extractTenantSlug(toEnvelope, d.EnvelopeDomainSuffix); slug != "" {
		if id, err := d.TenantResolver.LookupTenantBySlug(ctx, slug); err == nil && id != "" {
			return id
		}
	}
	if fromEmail != "" {
		if id, err := d.TenantResolver.LookupTenantBySubscriberEmail(ctx, fromEmail); err == nil && id != "" {
			return id
		}
	}
	return ""
}

// extractTenantSlug pulls "<slug>" out of "replies-<slug>@<domain>"
// when domain matches the configured suffix. Returns "" on any
// mismatch — empty suffix disables this branch entirely.
func extractTenantSlug(toEnvelope, suffix string) string {
	toEnvelope = strings.TrimSpace(toEnvelope)
	if toEnvelope == "" || suffix == "" {
		return ""
	}
	local, domain := splitLocalDomain(toEnvelope)
	if local == "" || !strings.EqualFold(domain, suffix) {
		return ""
	}
	const prefix = "replies-"
	if !strings.HasPrefix(strings.ToLower(local), prefix) {
		return ""
	}
	return strings.ToLower(local[len(prefix):])
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func readBody(r *http.Request, max int64) ([]byte, error) {
	if max <= 0 {
		max = MaxBodyBytes
	}
	body, err := httpbody.ReadAtMost(r.Body, max)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			return nil, errReplyBodyTooLarge
		}
		return nil, err
	}
	return body, nil
}

func writeJSONOK(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	body, _ := json.Marshal(payload)
	_, _ = w.Write(body)
}

func hashHMACSHA256(key string, body []byte) []byte {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write(body)
	return mac.Sum(nil)
}

func constantTimeEqHex(want []byte, gotHex string) bool {
	got, err := hex.DecodeString(strings.TrimSpace(gotHex))
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

// snippet caps a body to BodySnippetMaxLen runes, trimming whitespace.
// We slice on bytes for simplicity; the column is text and a UTF-8 cut
// in the middle of a code-point only loses the trailing partial rune.
func snippet(in string) string {
	in = strings.TrimSpace(in)
	if len(in) <= BodySnippetMaxLen {
		return in
	}
	return in[:BodySnippetMaxLen]
}

// headerValue scans Postmark's Headers array for a given header name,
// case-insensitive.
func headerValue(headers []postmarkHeader, name string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return strings.TrimSpace(h.Value)
		}
	}
	return ""
}

// headerValueRaw is the SES variant where each header is a {name,value}
// struct.
func headerValueRaw(headers []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}, name string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return strings.TrimSpace(h.Value)
		}
	}
	return ""
}

func postmarkClassificationHeaders(headers []postmarkHeader) Headers {
	out := Headers{}
	for _, header := range headers {
		if canonical, ok := classificationHeaderNames[strings.ToLower(strings.TrimSpace(header.Name))]; ok {
			out[canonical] = boundedUTF8(strings.TrimSpace(header.Value), 4096)
		}
	}
	return out
}

func sesClassificationHeaders(headers []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}) Headers {
	out := Headers{}
	for _, header := range headers {
		if canonical, ok := classificationHeaderNames[strings.ToLower(strings.TrimSpace(header.Name))]; ok {
			out[canonical] = boundedUTF8(strings.TrimSpace(header.Value), 4096)
		}
	}
	return out
}

func formClassificationHeaders(get func(string) string) Headers {
	out := Headers{}
	for _, canonical := range classificationHeaderNames {
		if value := get(canonical); value != "" {
			out[canonical] = boundedUTF8(value, 4096)
		}
	}
	return out
}

func mapClassificationHeaders(input map[string]interface{}) Headers {
	out := Headers{}
	for name, raw := range input {
		canonical, ok := classificationHeaderNames[strings.ToLower(strings.TrimSpace(name))]
		if !ok {
			continue
		}
		value, ok := raw.(string)
		if !ok {
			continue
		}
		out[canonical] = boundedUTF8(strings.TrimSpace(value), 4096)
	}
	return out
}

func parseMailDate(raw string) time.Time {
	parsed, err := mail.ParseDate(strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

func parseUnixTimestamp(raw string) time.Time {
	seconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || seconds <= 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0).UTC()
}

func parseRFC3339Timestamp(raw string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

// addressOf returns the first email in a Postmark ToFull array.
func addressOf(addrs []postmarkAddress) string {
	for _, a := range addrs {
		if a.Email != "" {
			return a.Email
		}
	}
	return ""
}

// addressOfSlice returns the first non-empty entry in a string slice.
func addressOfSlice(addrs []string) string {
	for _, a := range addrs {
		if s := strings.TrimSpace(a); s != "" {
			return s
		}
	}
	return ""
}

// ErrUnknown is returned by TenantResolver implementations on a miss.
// Defined here so callers can distinguish "no match" from "lookup
// failed" without importing the resolver concretely.
var ErrUnknown = errors.New("replies: tenant unknown")

// firstThreadCandidate picks the Message-ID a reply is most likely answering.
//
// In-Reply-To wins when present: it names exactly one parent. Otherwise the LAST
// entry of References is the immediate parent per RFC 5322, which ParseMessageIDs
// returns first.
func firstThreadCandidate(inReplyTo, references string) string {
	if candidates := ParseMessageIDs(inReplyTo); len(candidates) > 0 {
		return candidates[0]
	}
	if candidates := ParseMessageIDs(references); len(candidates) > 0 {
		return candidates[0]
	}
	return ""
}

// replyMetadataJSON builds the metadata blob with a JSON encoder rather than
// with fmt %q.
//
// %q is GO quoting, not JSON quoting. The two agree on ordinary text and
// diverge exactly where untrusted input lives: %q renders 0x00 as the literal
// \x00, which JSON has no such escape for. Store.Persist json.Unmarshals this
// blob and rejects it, so one NUL in a stranger's To header dead-letters the
// reply — and on an at-least-once ingest a rejected insert is retried forever
// rather than dropped.
//
// Marshalling a map cannot produce invalid JSON for any input, so the class is
// closed by construction instead of by remembering to sanitise at four call
// sites. It returns nil on the impossible error rather than a broken blob:
// Persist treats absent metadata as absent, which is the safe direction.
func replyMetadataJSON(fields map[string]string) json.RawMessage {
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil
	}
	return json.RawMessage(encoded)
}
