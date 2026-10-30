// SPDX-License-Identifier: AGPL-3.0-only
//
// VERP dispatch identity — stamps an outbound campaign send with a reply
// address that carries its own cryptographically signed attribution.
//
// WHY THIS EXISTS
//
// Reply attribution normally rides on RFC 5322 threading: the send pipeline
// writes a Message-ID, the reply copies it into In-Reply-To or References, and
// replies.Matcher resolves it back through campaign_send_deliveries. Those are
// exactly the headers an intermediary rewrites. An assistant that reads,
// summarises and answers mail on a person's behalf composes a NEW message —
// no In-Reply-To, no References, and a subject it wrote itself. The matcher
// then falls to its from-address branch, which guesses the most recent
// campaign within a 30-day window, or to manual review.
//
// The reply ADDRESS survives that, because the sender copies it verbatim: it
// is where the reply is going, not metadata about where it came from.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// A VERP address encoding the wrong identifier is worse than no VERP, because
// the result carries a valid signature and is treated as strong correlation
// (MatchMethod.Strong gates the canonical replied event). So this file mints
// nothing it cannot mint completely: every failure — unset secret, unset
// domain, a campaign id that is not a canonical UUID, an over-budget local
// part — returns the empty string and leaves the campaign's own Reply-To
// exactly as configured. There is no partial, unsigned, or best-effort VERP
// address anywhere in this path.
//
// PLACEMENT: Reply-To, not Return-Path
//
// VERP was invented for the ENVELOPE sender, where it catches bounces. It is
// on Reply-To here because this is about REPLIES, and a reply goes where the
// replying client is told to send it: Reply-To when present, otherwise From.
// The inbound side agrees — replies.Matcher reads Reply.EnvelopeRecipient,
// which every ingest adapter populates from the delivered-to/To address, not
// from Return-Path.
//
// The envelope Return-Path is NOT stamped, and that is a verified external
// blocker rather than an omission: campaigntransport.validateCompiled requires
// message.EnvelopeFrom to equal the RFC822 From address and returns
// ErrInvalidMessage otherwise, so a VERP return path would fail every bound
// send. Extending it is a change in packages this file does not own.
//
// BOTH DISPATCH BRANCHES
//
// The two paths out of dispatchPrepared carry the address differently and both
// are stamped, because attribution that depends on which branch a row happened
// to take is attribution nobody can reason about:
//
//   - Assurance-bound rows: BoundDispatchInput.ReplyTo. The raw runtime builds
//     the envelope from it and deletes any Reply-To found in the header map.
//   - Legacy Listmonk rows: the `Reply-To` header, which campaignHeaders
//     already emits from the same campaign column and which /api/tx applies to
//     the outgoing message. The VERP value replaces it rather than joining it.

package sending

import (
	"net/mail"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/replies"
)

// VERPReplyToPolicy decides how a minted VERP address interacts with a
// campaign's own configured Reply-To. It exists because "capture the reply"
// and "honour the tenant's reply routing" genuinely conflict: whichever
// address wins, replies go there and not to the other one. There is no
// setting that does both — closing that gap needs the inbound pipeline to
// forward an attributed reply on to the tenant's mailbox, which does not
// exist yet.
type VERPReplyToPolicy string

const (
	// VERPReplyToWhenAbsent is the default (the zero value maps to it). VERP
	// takes Reply-To only when the campaign left it unset, in which case
	// replies would otherwise land on the From mailbox by default rather than
	// by anyone's decision. A campaign that DID configure a Reply-To made an
	// explicit routing choice and is left alone.
	VERPReplyToWhenAbsent VERPReplyToPolicy = "when_absent"

	// VERPReplyToAlways overrides a configured Reply-To. Operators who route
	// all reply handling through the tracker choose this knowingly: the
	// tenant's configured mailbox stops receiving replies directly.
	VERPReplyToAlways VERPReplyToPolicy = "always"

	// VERPReplyToOff keeps the identity configured but stamps nothing. Useful
	// for staging a secret and MX before changing any outbound mail.
	VERPReplyToOff VERPReplyToPolicy = "off"
)

var (
	// verpReplyToStamped counts minted addresses by policy branch.
	verpReplyToStamped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sending_verp_reply_to_stamped_total",
		Help: "Outbound sends stamped with a signed VERP Reply-To, by policy branch (when_absent|always).",
	}, []string{"policy"})

	// verpReplyToSkipped counts every send that did NOT get a VERP address, by
	// reason. This is the observability that keeps the feature from being
	// dark: `unconfigured`, `policy_off` and `reply_to_configured` are all
	// expected steady states, but any `mint_failed` or `header_rejected` means
	// VERP is configured and silently not applying to some population.
	// verpReturnPathStamped counts envelopes that carried a signed return path.
	// Separate from the Reply-To counter because the two can diverge: a
	// deployment with a reply domain and no bounce domain stamps one and not the
	// other, and a single counter would hide that.
	verpReturnPathStamped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sending_verp_return_path_stamped_total",
		Help: "Outbound sends whose SMTP envelope sender carried a signed VERP return path.",
	})

	verpReplyToSkipped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sending_verp_reply_to_skipped_total",
		Help: "Outbound sends that received no VERP Reply-To, by reason (unconfigured|policy_off|reply_to_configured|mint_failed|header_rejected).",
	}, []string{"reason"})
)

const (
	verpSkipUnconfigured      = "unconfigured"
	verpSkipPolicyOff         = "policy_off"
	verpSkipReplyToConfigured = "reply_to_configured"
	verpSkipMintFailed        = "mint_failed"
	verpSkipHeaderRejected    = "header_rejected"
	verpSkipBounceDomainUnset = "bounce_domain_unset"
)

// VERPReplyToHeader is the header name the legacy Listmonk path carries the
// signed reply address in. campaignHeaders already emits this header from the
// campaign's own reply_to, so a VERP address REPLACES that value.
const VERPReplyToHeader = "Reply-To"

// withVERPReplyToHeader returns a copy of headers with the signed reply
// address installed, or the original headers untouched when the address cannot
// be rendered as a valid RFC 5322 mailbox.
//
// The copy is not defensive noise: the caller's map is per-recipient today,
// and an aliasing bug that let one recipient's signed identity survive into
// the next row's headers would attribute their reply to the wrong person with
// a valid signature attached.
func withVERPReplyToHeader(headers map[string]string, address string) map[string]string {
	rendered, ok := renderVERPMailbox(address)
	if !ok {
		observeVERPSkip(verpSkipHeaderRejected)
		return headers
	}
	out := make(map[string]string, len(headers)+1)
	for key, value := range headers {
		// Header names are case-insensitive. Dropping any existing spelling
		// prevents emitting both `Reply-To` and `reply-to`, which some agents
		// fold into a two-address list — and a reply sent to the campaign's
		// own mailbox instead of the signed one is silently unattributable.
		if strings.EqualFold(strings.TrimSpace(key), VERPReplyToHeader) {
			continue
		}
		out[key] = value
	}
	out[VERPReplyToHeader] = rendered
	return out
}

// renderVERPMailbox normalises the minted address the same way campaignHeaders
// normalises a campaign reply_to, and fails closed if it is not parseable.
func renderVERPMailbox(address string) (string, bool) {
	address = strings.TrimSpace(address)
	if address == "" {
		return "", false
	}
	parsed, err := mail.ParseAddress(address)
	if err != nil || !strings.EqualFold(parsed.Address, address) {
		return "", false
	}
	return parsed.String(), true
}

// verpConfigured reports whether BOTH halves of the identity are present.
// Neither half is useful alone: a secret with no domain has nowhere to point,
// and a domain with no secret could only produce an unsigned address, which is
// the one output this package must never emit.
func (g *Guard) verpConfigured() bool {
	return g != nil && len(g.VERPSecret) > 0 && strings.TrimSpace(g.VERPDomain) != ""
}

// verpPolicy resolves the effective policy, mapping the zero value to the
// documented default.
func (g *Guard) verpPolicy() VERPReplyToPolicy {
	if g == nil {
		return VERPReplyToOff
	}
	switch g.VERPReplyToPolicy {
	case VERPReplyToAlways:
		return VERPReplyToAlways
	case VERPReplyToOff:
		return VERPReplyToOff
	case VERPReplyToWhenAbsent, "":
		return VERPReplyToWhenAbsent
	default:
		// An unrecognised policy string is a configuration error. Fail to the
		// least surprising behaviour rather than guessing at intent.
		return VERPReplyToOff
	}
}

// verpReplyTo returns the Reply-To this send should carry, plus whether it is
// a VERP address. campaignReplyTo is the campaign's own configured value; it
// is returned unchanged whenever no complete VERP address can be minted.
//
// subscriberID is subscribers.id, resolved from the recipient address by
// loadSubscriberIDs. It may be empty — a recipient with no subscriber row
// still gets campaign-level attribution, which beats the from-address fallback
// the reply would otherwise land in. See the layout comment in
// internal/replies/match.go for why it is the subscriber id and not
// campaign_recipients.id: the decoded value is written to
// campaign_replies.subscriber_id, a uuid column, and must live in the same
// identity space as every other match branch.
func (g *Guard) verpReplyTo(tenantID, campaignID, subscriberID, campaignReplyTo string) (string, bool) {
	if !g.verpConfigured() {
		observeVERPSkip(verpSkipUnconfigured)
		return campaignReplyTo, false
	}
	policy := g.verpPolicy()
	if policy == VERPReplyToOff {
		observeVERPSkip(verpSkipPolicyOff)
		return campaignReplyTo, false
	}
	if policy == VERPReplyToWhenAbsent && strings.TrimSpace(campaignReplyTo) != "" {
		observeVERPSkip(verpSkipReplyToConfigured)
		return campaignReplyTo, false
	}
	address, err := replies.FormatVERPRecipient(
		g.VERPSecret, tenantID, campaignID, subscriberID, strings.TrimSpace(g.VERPDomain),
	)
	if err != nil || address == "" {
		// Refusing here is the point. The identifiers the encoder rejects are
		// exactly the ones the decoder could not turn back into a persistable
		// row, so a "best effort" address would be a signature over something
		// that cannot be stored.
		observeVERPSkip(verpSkipMintFailed)
		return campaignReplyTo, false
	}
	verpReplyToStamped.WithLabelValues(string(policy)).Inc()
	return address, true
}

func observeVERPSkip(reason string) {
	verpReplyToSkipped.WithLabelValues(reason).Inc()
}

// verpReturnPath mints the SMTP envelope sender (PRD F05).
//
// Separate from verpReplyTo and deliberately NOT subject to the Reply-To
// policy. The two catch different traffic and answer to different rules:
//
//   - Reply-To is a HUMAN-facing header a campaign may legitimately own, so
//     VERPReplyToWhenAbsent yields to a configured value. Overriding it would
//     stop a tenant's own mailbox receiving the replies it expects.
//   - The return path is MACHINE-facing. Nobody configures a campaign-level
//     bounce address, and bounces and RFC 3834 auto-replies carry no References
//     header for the matcher, so the envelope is the only place their identity
//     can live. A "when absent" rule here would mean the attribution depended on
//     whether somebody had filled in an unrelated field.
//
// Returns "" when VERP is unconfigured, when no bounce domain is set, or when
// the mint refuses — and "" means the envelope keeps the RFC822 From, exactly as
// before F05. An unsigned or partial return path is never emitted: it would look
// like a VERP address to the inbound side, which would then accept an identity
// nobody signed.
func (g *Guard) verpReturnPath(tenantID, campaignID, subscriberID string) string {
	if !g.verpConfigured() {
		return ""
	}
	if strings.TrimSpace(g.VERPBounceDomain) == "" {
		// No bounce domain means the operator has published no SPF record for
		// one. Stamping the envelope anyway would move MAIL FROM to a domain
		// nothing authorises and turn a deliverability improvement into a
		// deliverability failure.
		observeVERPSkip(verpSkipBounceDomainUnset)
		return ""
	}
	address, err := replies.FormatVERPRecipient(
		g.VERPSecret, tenantID, campaignID, subscriberID,
		strings.TrimSpace(g.VERPBounceDomain),
	)
	if err != nil || address == "" {
		observeVERPSkip(verpSkipMintFailed)
		return ""
	}
	verpReturnPathStamped.Inc()
	return address
}
