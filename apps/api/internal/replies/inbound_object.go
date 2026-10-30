// SPDX-License-Identifier: AGPL-3.0-only
//
// The S3 half of the SES inbound path (PRD F05).
//
// SES's receipt rule writes the whole RFC 5322 message to S3 and publishes a
// pointer to it; the SNS notification carries the pointer, the envelope
// recipients and the scan verdicts, but not one byte of the body. Until this
// file existed the SES receiver read only the notification's inline shape and
// logged a warning when the pointer was present, so the classifier, the quoted-
// history stripper and the canonical `replied` event had no caller on the path
// SES actually delivers over. infra/terraform/ses-inbound is the other half.
//
// This file parses; it does not decide. Classification and stripping stay in
// classify.go and strip.go, invoked once, centrally, by Store.Persist — the
// same single authority every provider webhook goes through. A worker that
// classified its own replies would be the second copy of a rule whose whole
// design note says five copies is five chances to write it four times
// correctly.

package replies

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"sync/atomic"
	"time"
)

// Permanent failures. Every one of these means "this object will never
// succeed"; a caller that retries on them retries forever. They are
// deliberately distinct from a transient S3 or database error, which the caller
// SHOULD retry.
var (
	// ErrMalformedObject is the guard the fuzzing world walks into: an inbound
	// object is bytes a stranger sent us, so "it is a parseable message" is a
	// hypothesis, never a precondition.
	ErrMalformedObject = errors.New("replies: inbound object is not a parseable RFC 5322 message")

	// ErrObjectTooLarge bounds memory. SES caps inbound mail at 40 MiB, so an
	// object above the configured ceiling is either a misconfiguration or an
	// attempt to make the worker allocate.
	ErrObjectTooLarge = errors.New("replies: inbound object exceeds the configured ceiling")

	// ErrNoObjectPointer means the notification carried no S3 action, so there
	// is nothing for this worker to fetch. Callers use it to fall back to the
	// inline shape rather than failing the request.
	ErrNoObjectPointer = errors.New("replies: SES notification carries no S3 action")

	// ErrNoStableMessageID means the object cannot be given a replay key.
	//
	// campaign_replies deduplicates on (tenant_id, source, raw_message_id). A
	// row inserted without one is a row a redelivered notification inserts
	// again, and a second `replied` event is a second +10 on the lead score.
	ErrNoStableMessageID = errors.New("replies: inbound object has no stable SES message id")

	// ErrNoStableTimestamp means the object cannot be given a replay-stable
	// received_at.
	//
	// Store.Persist fills a zero ReceivedAt from the clock, and its duplicate-
	// verification SELECT compares received_at exactly. A clock-derived value
	// therefore turns the SECOND delivery of the same message into an
	// idempotency conflict rather than a recognised duplicate. Refusing up
	// front names the reason; accepting it produces a confusing failure one
	// redelivery later.
	ErrNoStableTimestamp = errors.New("replies: inbound object has no stable received timestamp")
)

// MaxInboundObjectBytes is the default ceiling on a fetched object. Matches
// SES's own 40 MiB inbound limit: anything larger cannot have come from the
// receipt rule.
const MaxInboundObjectBytes int64 = 40 << 20

// maxInboundMIMEParts and maxInboundMIMEDepth bound the MIME walk. A message
// is attacker-supplied structure as much as attacker-supplied text, and
// "multipart nested inside itself 10,000 times" is a cheap message to send.
const (
	maxInboundMIMEParts = 32
	maxInboundMIMEDepth = 6
)

// ObjectRef points at one stored inbound message.
type ObjectRef struct {
	Bucket string
	Key    string
}

// ObjectSource fetches the bytes behind an ObjectRef. Production wires
// S3ObjectSource; tests inject a map. Returning a ReadCloser rather than a
// []byte keeps the ceiling enforcement in the worker, where it can be tested
// without a 40 MiB fixture.
type ObjectSource interface {
	GetInboundObject(ctx context.Context, ref ObjectRef) (io.ReadCloser, error)
}

// InboundDelivery is one SES S3-action notification: the pointer to the stored
// object plus the facts that exist ONLY in the notification.
//
// Recipients in particular cannot be recovered from the stored bytes. The
// envelope recipient is what SMTP RCPT TO carried, which is where VERP lives;
// the To: header is what the sender chose to write and is routinely neither.
type InboundDelivery struct {
	Object       ObjectRef
	SESMessageID string
	Recipients   []string
	SpamVerdict  string
	VirusVerdict string
	ReceivedAt   time.Time
}

// ReplyMatcher is the correlation seam. *Matcher is the production
// implementation; the interface exists so a worker test can assert what happens
// on a strong match without standing up the outbound send tables.
//
// TenantFromVERPRecipient is part of it rather than a separate optional
// interface on purpose. A type assertion that silently misses would make the
// worker fall back to the global subscriber-email guess while holding a
// deployment-signed answer, and nothing would say so; a method on the interface
// makes the same mistake a compile error.
type ReplyMatcher interface {
	Resolve(ctx context.Context, tenantID string, r Reply) (MatchResult, error)
	TenantFromVERPRecipient(recipient string) (string, bool)
}

var _ ReplyMatcher = (*Matcher)(nil)

// InboundObjectWorker turns a stored object into a persisted, classified reply.
type InboundObjectWorker struct {
	Objects        ObjectSource
	Store          *Store
	Matcher        ReplyMatcher
	TenantResolver TenantResolver

	// EnvelopeDomainSuffix mirrors Deps.EnvelopeDomainSuffix so the two ingress
	// paths resolve a tenant slug identically.
	EnvelopeDomainSuffix string

	// MaxObjectBytes overrides MaxInboundObjectBytes.
	MaxObjectBytes int64

	// UnmappedCounter counts objects dropped because no tenant could be
	// resolved — the same meaning as Deps.UnmappedCounter and the same
	// inbound_replies_unmapped_total series.
	UnmappedCounter *atomic.Int64

	// RejectedCounter counts objects dropped by a scan verdict.
	RejectedCounter *atomic.Int64

	Logger *slog.Logger
}

// ObjectOutcome reports what one object became. Dropped is empty exactly when a
// row was written.
type ObjectOutcome struct {
	TenantID  string
	ReplyID   string
	Duplicate bool
	Dropped   string
}

// Drop reasons. Closed set so a caller can act on them.
const (
	DropTenantUnmapped = "tenant_unmapped"
	DropVirus          = "virus_verdict_fail"
	DropSpam           = "spam_verdict_fail"
)

func (w *InboundObjectWorker) log() *slog.Logger {
	if w != nil && w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func (w *InboundObjectWorker) maxObjectBytes() int64 {
	if w != nil && w.MaxObjectBytes > 0 {
		return w.MaxObjectBytes
	}
	return MaxInboundObjectBytes
}

// ProcessObject fetches one object, parses it, and hands it to the one
// production classification authority.
//
// Every permanent failure is returned as a sentinel above so a caller can
// dead-letter it instead of retrying. A malformed object is the expected case,
// not the exceptional one: these bytes came from a stranger.
func (w *InboundObjectWorker) ProcessObject(
	ctx context.Context, delivery InboundDelivery,
) (ObjectOutcome, error) {
	if w == nil || w.Objects == nil || w.Store == nil {
		return ObjectOutcome{}, errors.New("replies: inbound object worker not initialised")
	}
	if strings.TrimSpace(delivery.Object.Bucket) == "" ||
		strings.TrimSpace(delivery.Object.Key) == "" {
		return ObjectOutcome{}, ErrNoObjectPointer
	}

	// The replay key is OURS, never the sender's. A Message-ID header is
	// attacker-chosen: reusing one already stored would make a second reply
	// collapse into the first, and omitting it would make every redelivery a
	// fresh row. The SES message id is assigned by SES and is the S3 key.
	rawMessageID := strings.TrimSpace(delivery.SESMessageID)
	if rawMessageID == "" {
		rawMessageID = objectKeyMessageID(delivery.Object.Key)
	}
	if rawMessageID == "" {
		return ObjectOutcome{}, ErrNoStableMessageID
	}

	// Verdicts before bytes. Fetching an object we are going to drop costs a
	// GetObject and puts a virus-flagged message in the worker's memory for no
	// reason. FAIL is the only status that means "SES is sure"; GRAY and
	// PROCESSING_FAILED are not, and dropping on them would silently discard
	// legitimate replies whenever the scanner was degraded.
	if strings.EqualFold(strings.TrimSpace(delivery.VirusVerdict), "FAIL") {
		return w.drop(DropVirus, delivery), nil
	}
	if strings.EqualFold(strings.TrimSpace(delivery.SpamVerdict), "FAIL") {
		return w.drop(DropSpam, delivery), nil
	}

	raw, err := w.fetch(ctx, delivery.Object)
	if err != nil {
		return ObjectOutcome{}, err
	}
	parsed, err := parseInboundMessage(raw)
	if err != nil {
		return ObjectOutcome{}, err
	}

	// received_at must be derivable from the message or the notification, never
	// from the clock — see ErrNoStableTimestamp.
	receivedAt := parsed.Date
	if receivedAt.IsZero() {
		receivedAt = delivery.ReceivedAt.UTC()
	}
	if receivedAt.IsZero() {
		return ObjectOutcome{}, ErrNoStableTimestamp
	}

	// Bounded here rather than only in Persist, because these values also go
	// into the metadata document below, and Persist bounds the columns it owns
	// — not a blob a caller built.
	envelopeRecipient := boundedUTF8(firstNonEmpty(
		append(append([]string{}, delivery.Recipients...),
			parsed.DeliveredTo, parsed.OriginalTo, parsed.To)...), 998)

	// Marshalled rather than fmt.Sprintf'd into a JSON literal.
	//
	// %q emits a GO quoted string, and the two notations agree only on printable
	// ASCII: Go writes a control byte as \x01, which is not a JSON escape at
	// all, so one control character anywhere in an address or an S3 key produces
	// a metadata blob that fails Persist's json.Unmarshal and dead-letters a
	// perfectly good reply. boundedUTF8 additionally removes NUL, which json
	// WOULD escape correctly and jsonb would then reject.
	metadata, err := json.Marshal(map[string]string{
		"to":        envelopeRecipient,
		"s3_bucket": boundedUTF8(delivery.Object.Bucket, 255),
		"s3_key":    boundedUTF8(delivery.Object.Key, 1024),
	})
	if err != nil {
		return ObjectOutcome{}, fmt.Errorf("replies: build inbound object metadata: %w", err)
	}

	reply := Reply{
		RecipientEmail:        parsed.From,
		EnvelopeRecipient:     envelopeRecipient,
		InReplyTo:             firstThreadCandidate(parsed.InReplyTo, parsed.References),
		Subject:               parsed.Subject,
		BodySnippet:           snippet(parsed.Body),
		ClassificationBody:    boundedUTF8(parsed.Body, ClassificationBodyMaxLen),
		ClassificationHeaders: parsed.Headers,
		RawMessageID:          rawMessageID,
		ReceivedAt:            receivedAt,
		Source:                SourceSESInbound,
		Metadata:              json.RawMessage(metadata),
	}

	tenantID := w.resolveTenant(ctx, envelopeRecipient, reply.RecipientEmail)
	if tenantID == "" {
		if w.UnmappedCounter != nil {
			w.UnmappedCounter.Add(1)
		}
		w.log().Warn("replies: dropping unmapped inbound object",
			"bucket", delivery.Object.Bucket, "key", delivery.Object.Key,
			"source", SourceSESInbound, "raw_message_id", rawMessageID,
		)
		return ObjectOutcome{Dropped: DropTenantUnmapped}, nil
	}
	reply.TenantID = tenantID

	if w.Matcher != nil {
		result, err := w.Matcher.Resolve(ctx, tenantID, reply)
		if err != nil {
			w.log().Warn("replies: matcher.Resolve error on inbound object",
				"tenant", tenantID, "err", err.Error())
		} else {
			reply.CampaignID = result.CampaignID
			reply.SubscriberID = result.SubscriberID
			reply.MatchMethod = result.Method
		}
	}

	// Store.Persist is the seam: it strips quoted history, classifies, decides
	// whether the reply is human enough to emit `replied`, and deduplicates on
	// (tenant_id, source, raw_message_id). None of that is repeated here.
	id, duplicate, err := w.Store.Persist(ctx, tenantID, reply)
	if err != nil {
		return ObjectOutcome{TenantID: tenantID}, err
	}
	return ObjectOutcome{TenantID: tenantID, ReplyID: id, Duplicate: duplicate}, nil
}

// objectKeyMessageID takes the SES message id out of an object key.
//
// Deliberately not path.Base: path.Base("inbound/") is "inbound", so a pointer
// at the PREFIX rather than at an object would be accepted and every such
// pointer would share one replay key. Taking everything after the last
// separator gives "" there, which is what ErrNoStableMessageID exists to catch.
func objectKeyMessageID(key string) string {
	key = strings.TrimSpace(key)
	if index := strings.LastIndex(key, "/"); index >= 0 {
		key = key[index+1:]
	}
	return strings.TrimSpace(key)
}

// resolveTenant walks the same order Deps.resolveTenant walks — signed VERP
// token, then the `replies-<slug>` envelope tag, then the subscriber-email
// lookup, then give up.
//
// It is a second copy of that order and it should not stay one: the two paths
// disagreeing about which tenant owns a message is exactly the class of bug
// this package's own comments keep warning about. The merge belongs in
// handlers.go, which this change does not own; see the shared-file request that
// accompanies it. What is NOT duplicated is the part that would drift
// meaningfully — extractTenantSlug and TenantFromVERPRecipient are both called,
// not reimplemented, so the rules themselves have one definition each.
func (w *InboundObjectWorker) resolveTenant(ctx context.Context, toEnvelope, fromEmail string) string {
	if resolver, ok := w.TenantResolver.(ReplyCorrelationTenantResolver); ok {
		if id, err := resolver.LookupTenantByReplyCorrelation(ctx, toEnvelope); err == nil && id != "" {
			return id
		}
	}
	if w.Matcher != nil {
		if id, ok := w.Matcher.TenantFromVERPRecipient(toEnvelope); ok && id != "" {
			return id
		}
	}
	if w.TenantResolver == nil {
		return ""
	}
	if slug := extractTenantSlug(toEnvelope, w.EnvelopeDomainSuffix); slug != "" {
		if id, err := w.TenantResolver.LookupTenantBySlug(ctx, slug); err == nil && id != "" {
			return id
		}
	}
	if fromEmail != "" {
		if id, err := w.TenantResolver.LookupTenantBySubscriberEmail(ctx, fromEmail); err == nil && id != "" {
			return id
		}
	}
	return ""
}

func (w *InboundObjectWorker) drop(reason string, delivery InboundDelivery) ObjectOutcome {
	if w.RejectedCounter != nil {
		w.RejectedCounter.Add(1)
	}
	w.log().Warn("replies: dropping scanned-unsafe inbound object",
		"reason", reason, "bucket", delivery.Object.Bucket, "key", delivery.Object.Key)
	return ObjectOutcome{Dropped: reason}
}

// fetch reads at most maxObjectBytes+1 so the ceiling is detectable rather than
// silently truncating a message into a different message.
func (w *InboundObjectWorker) fetch(ctx context.Context, ref ObjectRef) ([]byte, error) {
	body, err := w.Objects.GetInboundObject(ctx, ref)
	if err != nil {
		return nil, fmt.Errorf("replies: fetch inbound object: %w", err)
	}
	defer func() { _ = body.Close() }()

	limit := w.maxObjectBytes()
	raw, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("replies: read inbound object: %w", err)
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("%w: %d bytes", ErrObjectTooLarge, limit)
	}
	return raw, nil
}

// ---------------------------------------------------------------------------
// RFC 5322 parsing
// ---------------------------------------------------------------------------

type parsedInbound struct {
	From        string
	To          string
	DeliveredTo string
	OriginalTo  string
	Subject     string
	InReplyTo   string
	References  string
	Date        time.Time
	Headers     Headers
	Body        string
}

// parseInboundMessage extracts exactly what the reply pipeline consumes.
//
// Nothing in here trusts the input. Every failure path returns
// ErrMalformedObject rather than a partially-populated struct, because a struct
// with an empty Subject and an empty Body classifies as a human reply and would
// turn an unparseable object into engagement.
func parseInboundMessage(raw []byte) (parsedInbound, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return parsedInbound{}, fmt.Errorf("%w: empty object", ErrMalformedObject)
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return parsedInbound{}, fmt.Errorf("%w: %v", ErrMalformedObject, err)
	}
	if message == nil || message.Body == nil {
		return parsedInbound{}, fmt.Errorf("%w: no message body", ErrMalformedObject)
	}

	out := parsedInbound{
		From:        headerAddress(message.Header, "From"),
		To:          headerAddress(message.Header, "To"),
		DeliveredTo: headerAddress(message.Header, "Delivered-To"),
		OriginalTo:  headerAddress(message.Header, "X-Original-To"),
		Subject:     decodeHeaderWords(message.Header.Get("Subject")),
		InReplyTo:   strings.TrimSpace(message.Header.Get("In-Reply-To")),
		References:  strings.TrimSpace(message.Header.Get("References")),
		Date:        parseMailDate(message.Header.Get("Date")),
		Headers:     inboundClassificationHeaders(message.Header),
	}
	out.Body = extractInboundText(
		message.Header.Get("Content-Type"),
		message.Header.Get("Content-Transfer-Encoding"),
		message.Body, 0,
	)
	return out, nil
}

// inboundClassificationHeaders projects the message onto the SAME bounded
// allow-list the webhook adapters use. Reading classificationHeaderNames rather
// than restating it is the point: a header added to the classifier arrives here
// with no edit, and one removed cannot linger here as an unused capture.
func inboundClassificationHeaders(header mail.Header) Headers {
	out := Headers{}
	for _, canonical := range classificationHeaderNames {
		if value := strings.TrimSpace(header.Get(canonical)); value != "" {
			out[canonical] = boundedUTF8(value, 4096)
		}
	}
	return out
}

// headerAddress returns the bare address from an address header, falling back to
// the raw value. A reply from a sender whose display name confuses the parser is
// still a reply; Store.Persist lowercases and validates what comes out.
func headerAddress(header mail.Header, name string) string {
	raw := strings.TrimSpace(header.Get(name))
	if raw == "" {
		return ""
	}
	if parsed, err := mail.ParseAddress(raw); err == nil && parsed.Address != "" {
		return parsed.Address
	}
	if list, err := mail.ParseAddressList(raw); err == nil && len(list) > 0 {
		return list[0].Address
	}
	return raw
}

// decodeHeaderWords resolves RFC 2047 encoded-words. Undecodable input returns
// unchanged rather than empty: the OOO subject patterns are the strongest
// classification signal there is, and losing the subject promotes an
// out-of-office notice to engagement.
func decodeHeaderWords(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	decoded, err := new(mime.WordDecoder).DecodeHeader(raw)
	if err != nil || strings.TrimSpace(decoded) == "" {
		return raw
	}
	return decoded
}

// extractInboundText walks the MIME tree for the reply text.
//
// text/plain wins over text/html, matching what the Postmark and Mailgun
// adapters already do (firstNonEmpty(TextBody, HtmlBody)) so the same message
// classifies identically whichever transport delivered it.
//
// Best-effort by construction: a body that cannot be walked yields "" and the
// reply is stored with an empty snippet rather than rejected. That is the
// conservative direction — an unreadable body classifies as human, which
// over-counts by one rather than discarding a real reply.
func extractInboundText(contentType, transferEncoding string, body io.Reader, depth int) string {
	if depth > maxInboundMIMEDepth {
		return ""
	}
	mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(contentType))
	if err != nil || mediaType == "" {
		// No parseable Content-Type is RFC-legal and means text/plain US-ASCII.
		return decodeTransferEncoded(transferEncoding, body)
	}
	mediaType = strings.ToLower(mediaType)

	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			return ""
		}
		reader := multipart.NewReader(body, boundary)
		var htmlFallback string
		for index := 0; index < maxInboundMIMEParts; index++ {
			// NextRawPart, not NextPart: NextPart silently decodes
			// quoted-printable and strips the header that said so, which makes
			// the encoding of a part unknowable to the code below.
			part, partErr := reader.NextRawPart()
			if partErr != nil {
				break
			}
			partType := strings.ToLower(strings.TrimSpace(part.Header.Get("Content-Type")))
			// An attachment is not the reply text even when it is text/plain.
			if disposition := strings.ToLower(part.Header.Get("Content-Disposition")); strings.HasPrefix(disposition, "attachment") {
				_ = part.Close()
				continue
			}
			text := extractInboundText(
				part.Header.Get("Content-Type"),
				part.Header.Get("Content-Transfer-Encoding"),
				part, depth+1,
			)
			_ = part.Close()
			if strings.TrimSpace(text) == "" {
				continue
			}
			if strings.HasPrefix(partType, "text/html") {
				if htmlFallback == "" {
					htmlFallback = text
				}
				continue
			}
			return text
		}
		return htmlFallback
	}

	if !strings.HasPrefix(mediaType, "text/") {
		return ""
	}
	return decodeTransferEncoded(transferEncoding, body)
}

// decodeTransferEncoded undoes Content-Transfer-Encoding under a bound.
//
// A decode error keeps whatever decoded cleanly before it. Discarding the whole
// body because its last line was truncated would turn a slightly-damaged reply
// into an empty one, and an empty body classifies as human.
func decodeTransferEncoded(encoding string, body io.Reader) string {
	reader := body
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		reader = base64.NewDecoder(base64.StdEncoding, body)
	case "quoted-printable":
		reader = quotedprintable.NewReader(body)
	}
	// One byte over the classifier bound so nothing downstream has to guess
	// whether it received a whole body; boundedUTF8 does the final cut.
	decoded, _ := io.ReadAll(io.LimitReader(reader, int64(ClassificationBodyMaxLen)+1))
	return boundedUTF8(strings.TrimSpace(string(decoded)), ClassificationBodyMaxLen)
}

// ---------------------------------------------------------------------------
// SES notification
// ---------------------------------------------------------------------------

// sesReceivedNotification is the subset of SES's "Received" notification the
// worker needs. It is the JSON inside the SNS envelope's Message field.
type sesReceivedNotification struct {
	NotificationType string `json:"notificationType"`
	Mail             struct {
		Timestamp   string   `json:"timestamp"`
		MessageID   string   `json:"messageId"`
		Source      string   `json:"source"`
		Destination []string `json:"destination"`
	} `json:"mail"`
	Receipt struct {
		Timestamp    string   `json:"timestamp"`
		Recipients   []string `json:"recipients"`
		SpamVerdict  verdict  `json:"spamVerdict"`
		VirusVerdict verdict  `json:"virusVerdict"`
		Action       struct {
			Type       string `json:"type"`
			BucketName string `json:"bucketName"`
			ObjectKey  string `json:"objectKey"`
		} `json:"action"`
	} `json:"receipt"`
}

type verdict struct {
	Status string `json:"status"`
}

// ParseSESInboundNotification reads the SES notification carried in an SNS
// Message field and returns the delivery it points at.
//
// Returns ErrNoObjectPointer — not a parse error — when the notification is
// well-formed but carries no S3 action, so a caller can fall back to the inline
// shape instead of rejecting a legitimate notification.
func ParseSESInboundNotification(message []byte) (InboundDelivery, error) {
	var notification sesReceivedNotification
	if err := json.Unmarshal(message, &notification); err != nil {
		return InboundDelivery{}, fmt.Errorf("replies: parse SES notification: %w", err)
	}
	if !strings.EqualFold(strings.TrimSpace(notification.Receipt.Action.Type), "S3") {
		return InboundDelivery{}, ErrNoObjectPointer
	}
	bucket := strings.TrimSpace(notification.Receipt.Action.BucketName)
	key := strings.TrimSpace(notification.Receipt.Action.ObjectKey)
	if bucket == "" || key == "" {
		return InboundDelivery{}, ErrNoObjectPointer
	}

	recipients := make([]string, 0, len(notification.Receipt.Recipients)+len(notification.Mail.Destination))
	for _, recipient := range notification.Receipt.Recipients {
		if value := strings.TrimSpace(recipient); value != "" {
			recipients = append(recipients, value)
		}
	}
	// Envelope first, headers second. mail.destination is derived from the
	// message's own address headers and is the weaker of the two.
	for _, recipient := range notification.Mail.Destination {
		if value := strings.TrimSpace(recipient); value != "" {
			recipients = append(recipients, value)
		}
	}

	receivedAt := parseRFC3339Timestamp(notification.Receipt.Timestamp)
	if receivedAt.IsZero() {
		receivedAt = parseRFC3339Timestamp(notification.Mail.Timestamp)
	}

	return InboundDelivery{
		Object:       ObjectRef{Bucket: bucket, Key: key},
		SESMessageID: strings.TrimSpace(notification.Mail.MessageID),
		Recipients:   recipients,
		SpamVerdict:  strings.TrimSpace(notification.Receipt.SpamVerdict.Status),
		VirusVerdict: strings.TrimSpace(notification.Receipt.VirusVerdict.Status),
		ReceivedAt:   receivedAt,
	}, nil
}
