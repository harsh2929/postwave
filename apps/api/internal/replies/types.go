// Package replies owns the reply tracking pipeline that backs the A/B
// winner picker's reply_rate metric. Inbound provider webhooks
// (Postmark, Mailgun, SES) call into this package to classify and
// persist subscriber replies. The A/B winner reads aggregate counts
// out of campaign_replies (migration 0087) instead of using
// (clicks - unsubscribes) as a coarse proxy.
//
// The pipeline has three layers:
//
//  1. Persistence (Store): RLS-scoped CRUD against campaign_replies.
//     Idempotent on (tenant_id, source, raw_message_id) via the
//     partial unique index from 0087.
//
//  2. Matching (Matcher): given an inbound envelope, resolve which
//     campaign + subscriber the reply belongs to. Priority order is
//     In-Reply-To header, then VERP envelope decoding, then a
//     from-address fallback that walks recent campaign sends.
//
//  3. Ingestion (handlers.go): provider-specific signature verification
//     + envelope parsing + Matcher.Resolve + Store.Persist.
//
// Why this is a new package instead of an extension of inbound_email:
// inbound_email already exists for tenant-scoped /api/public/inbound-
// email/{slug} ingest where the per-tenant slug is the credential. The
// reply tracker uses provider-signed webhooks at /api/internal/webhooks/
// inbound/{provider}, mirroring the deliverability webhooks pattern.
// The two pipelines write to different tables (inbound_emails vs
// campaign_replies) and answer different questions: the inbound_email
// flow surfaces threaded conversation history, the reply tracker
// surfaces aggregate counts the A/B picker depends on.
package replies

import (
	"encoding/json"
	"time"
)

// Source enumerates the provenance of a campaign_replies row. Mirrors
// the CHECK domain of campaign_replies.source — values must stay in
// sync with that column.
type Source string

const (
	SourcePostmark   Source = "postmark"
	SourceMailgun    Source = "mailgun"
	SourceSESInbound Source = "ses-inbound"
	SourceIMAP       Source = "imap"
	SourceManual     Source = "manual"
	// SourcePostwaveInbound is the tenant-slug, timestamped-HMAC ingress path.
	// It is distinct from Postmark/Mailgun/SES provider webhooks so one
	// provider identifier cannot accidentally deduplicate across two separately
	// authenticated transports.
	SourcePostwaveInbound Source = "postwave-inbound"
)

func (source Source) Valid() bool {
	switch source {
	case SourcePostmark, SourceMailgun, SourceSESInbound, SourceIMAP, SourceManual,
		SourcePostwaveInbound:
		return true
	default:
		return false
	}
}

// Reply is one parsed inbound reply, ready for persistence. CampaignID
// and SubscriberID may be empty when the matcher couldn't resolve them
// — those rows land for manual review.
type Reply struct {
	ID             string          `json:"id,omitempty"`
	TenantID       string          `json:"tenant_id"`
	CampaignID     string          `json:"campaign_id,omitempty"`
	SubscriberID   string          `json:"subscriber_id,omitempty"`
	RecipientEmail string          `json:"recipient_email"`
	InReplyTo      string          `json:"in_reply_to,omitempty"`
	Subject        string          `json:"subject,omitempty"`
	BodySnippet    string          `json:"body_snippet,omitempty"`
	RawMessageID   string          `json:"raw_message_id,omitempty"`
	Source         Source          `json:"source"`
	ReceivedAt     time.Time       `json:"received_at,omitempty"`
	Metadata       json.RawMessage `json:"metadata,omitempty"`

	// Classification is populated centrally by Store.Persist from the transient
	// classification inputs below. Callers must not pre-classify a production
	// reply: doing so would let an adapter that forgot a provider header turn an
	// automatic response into human engagement.
	Classification ReplyClass `json:"classification,omitempty"`
	// BodyStripped is the body with quoted history and signatures removed. Stored
	// alongside the raw snippet because stripping is heuristic and a bad strip is
	// undiscoverable from the stripped text alone.
	BodyStripped string `json:"body_stripped,omitempty"`

	// EnvelopeRecipient is the SMTP/route recipient (the address in To), not the
	// person who replied. VERP is encoded here. It is used transiently for
	// correlation and is deliberately not serialized or copied into F01 evidence.
	EnvelopeRecipient string `json:"-"`

	// ClassificationHeaders contains only the bounded allow-listed headers used
	// by the deterministic reply classifier. Values are never persisted in the
	// F01 observation; only stable rule identifiers are retained there.
	ClassificationHeaders Headers `json:"-"`

	// ClassificationBody is the transient body used for quote stripping and
	// classification. The bounded raw/stripped snippets above are the only body
	// values persisted on campaign_replies, and no body value or body hash enters
	// the F01 observation.
	ClassificationBody string `json:"-"`

	// MatchMethod is set by Matcher.Resolve. Only cryptographic VERP and exact
	// outbound Message-ID matches are strong enough to emit a canonical replied
	// event. Sender fallback remains useful for manual triage but is not evidence
	// of campaign engagement.
	MatchMethod MatchMethod `json:"match_method,omitempty"`
}

// BodySnippetMaxLen bounds how much plaintext body we persist with each
// reply. The full body lives only in the inbound provider's archive (or
// in inbound_emails for the slug-credential ingest path) — this column
// is for at-a-glance triage in the manual-review UI.
const BodySnippetMaxLen = 500

// ClassificationBodyMaxLen bounds the transient classifier input and the
// safely stripped value retained for manual review. Provider webhooks are
// already request-size bounded, but this smaller limit avoids regex work and
// accidental long-lived copies over attachment-sized payloads.
const ClassificationBodyMaxLen = 64 << 10

// MatchMethod is the closed, durable correlation vocabulary. Do not infer
// strength from arbitrary strings supplied by an adapter.
type MatchMethod string

const (
	MatchNone           MatchMethod = "none"
	MatchInReplyTo      MatchMethod = "in_reply_to"
	MatchVERP           MatchMethod = "verp"
	MatchFromSubscriber MatchMethod = "from_subscriber"
	// MatchManual is an operator's assertion that this reply belongs to this
	// campaign — someone forwarded it, or read it in another inbox. It is
	// deliberately NOT strong: an assertion is not an observation, and strong
	// correlation is what lets a reply emit the canonical engagement event that
	// drives lead scoring and send-time models.
	MatchManual MatchMethod = "manual"
)

func (method MatchMethod) Valid() bool {
	switch method {
	case MatchNone, MatchInReplyTo, MatchVERP, MatchFromSubscriber, MatchManual:
		return true
	default:
		return false
	}
}

func (method MatchMethod) Strong() bool {
	return method == MatchInReplyTo || method == MatchVERP
}
