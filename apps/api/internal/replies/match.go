// SPDX-License-Identifier: AGPL-3.0-only
//
// Reply matching — resolves an inbound reply envelope to a (campaign,
// subscriber) pair so the A/B winner picker can attribute it correctly.
//
// Priority order (first match wins):
//
//  1. In-Reply-To header. The send pipeline writes a stable Message-ID
//     into outbound mail; replies copy it into In-Reply-To. We probe
//     the database for a row that maps that header back to a campaign.
//
//  2. VERP envelope. The recipient address `reply+<token>@<domain>`
//     carries an HMAC-signed token whose plaintext is
//     `<campaign_id>:<subscriber_id>`. Forging requires the per-
//     deployment VERP secret.
//
//  3. From-address fallback. Look up the subscriber by
//     recipient_email (case-insensitive citext), then their most-recent
//     campaign send within the last 30 days.
//
//  4. None of the above — return ("", "") so the caller stores the
//     reply with NULL campaign_id for manual review.

package replies

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
)

// VERPTokenPrefix is the local-part prefix every VERP-tagged inbound
// recipient carries. Operators MUST configure their MX to route
// reply+*@<domain> into the inbound webhook for this to be useful.
const VERPTokenPrefix = "reply+"

// VERPMACBytes bounds the truncated HMAC the token carries. Full
// SHA-256 is 32 bytes; we keep 16 (128 bits of forgery resistance).
const VERPMACBytes = 16

// verpFormatVersion leads the signed payload. It is INSIDE the MAC, so a
// future format cannot be substituted for this one under a replayed
// signature. Version 0 (the pre-wiring text format described below) was
// never emitted by anything — EncodeVERP had no callers — so no token in
// that shape can exist in the wild and this decoder deliberately refuses
// it rather than carrying an ambiguous second acceptor forever.
const verpFormatVersion byte = 1

// verpMACLabel domain-separates this HMAC from every other use of the
// deployment secret.
const verpMACLabel = "postwave.verp.v1\x00"

// verpUUIDBytes is the raw (not textual) width of every identifier the
// token carries. Fixed-width binary fields are the whole point: the
// previous layout was `mac || ':' || campaign || ':' || subscriber` with
// TEXTUAL ids and a SplitN(payload, ":", 2) decoder, so an id containing a
// colon re-split at a different offset while producing the SAME MAC —
// HMAC over `a:b` + ":" + `sub` and over `a` + ":" + `b:sub` are byte
// identical. That is a valid signature over a different (campaign,
// subscriber) pair, i.e. exactly the authoritative-looking misattribution
// VERP must never produce. Fixed offsets make the framing unambiguous by
// construction; requiring canonical UUIDs removes the delimiter entirely.
const verpUUIDBytes = 16

// verpPayloadBytes is version(1) + tenant(16) + campaign(16) + subscriber(16).
const verpPayloadBytes = 1 + 3*verpUUIDBytes

// verpTokenBytes is the full pre-base32 token: MAC followed by payload.
const verpTokenBytes = VERPMACBytes + verpPayloadBytes

// VERPMaxLocalPartBytes bounds `reply+<token>`. 65 raw bytes encode to
// exactly 104 unpadded base32 characters, so the local part is 110 bytes.
//
// This deliberately exceeds RFC 5321 4.5.3.1.1's 64-octet local-part
// FLOOR. That figure is the minimum a receiver must accept, not a ceiling
// a sender may not pass (4.5.3.1.10 asks implementations to impose no
// limits), and the receiver here is our own inbound MX. It cannot be made
// to fit: two canonical UUIDs are 32 raw bytes = 52 base32 characters
// before any MAC or version byte, leaving under 4 bytes for a signature
// inside a 64-octet budget. The alternative is a database-backed opaque
// handle, which trades a stateless signature for a row per recipient per
// send. TestVERPLocalPartStaysWithinBudget holds this number honest;
// changing the layout without changing the bound fails that test.
const VERPMaxLocalPartBytes = 110

// VERPLookbackDays bounds the from-address fallback's "recent send"
// window. A reply more than 30 days after the most-recent send is
// considered ambiguous and falls through to manual review.
const VERPLookbackDays = 30

// Matcher resolves an inbound reply to a (campaign, subscriber) pair.
type Matcher struct {
	// Store is the persistence layer; held only for its *db.Pool, but
	// taking the Store keeps the dependency graph tidy and lets tests
	// substitute a fake.
	Store *Store

	// VERPSecret is the HMAC key for VERP token signing. When empty,
	// VERP decoding is disabled (returns no match) — useful for local
	// dev where MX routing isn't wired up.
	VERPSecret []byte

	// ReplyCorrelation verifies the compact opaque v2 address against the exact
	// tenant-scoped campaign_send_deliveries row. VERPSecret remains only as a
	// dormant decoder for historical stateless tokens; new production sends do
	// not mint that over-budget format.
	ReplyCorrelation *replycorrelation.Service

	// Now overrides time.Now for deterministic tests of the lookback
	// window.
	Now func() time.Time
}

// MatchResult is the outcome of Resolve. Either field may be empty:
// CampaignID empty + SubscriberID set means "we know who replied but
// not which campaign"; both empty means "manual review".
type MatchResult struct {
	CampaignID   string
	SubscriberID string
	// Method records which priority branch matched (for telemetry).
	// Values: "in_reply_to", "verp", "from_subscriber", "none".
	Method MatchMethod
}

// Resolve walks the priority order. Errors from any individual lookup
// are non-fatal — they degrade to "no match on this branch" so a
// transient database glitch on the In-Reply-To probe doesn't poison
// the whole resolution.
func (m *Matcher) Resolve(ctx context.Context, tenantID string, r Reply) (MatchResult, error) {
	if m == nil {
		return MatchResult{Method: MatchNone}, errors.New("replies: matcher not initialised")
	}
	if tenantID == "" {
		return MatchResult{Method: MatchNone}, errors.New("replies: empty tenant id")
	}

	// 1. In-Reply-To header.
	if cid, sid, ok := m.matchByInReplyTo(ctx, tenantID, r.InReplyTo); ok {
		return MatchResult{CampaignID: cid, SubscriberID: sid, Method: MatchInReplyTo}, nil
	}

	// 2. VERP envelope.
	if cid, sid, ok := m.matchByVERPWithContext(ctx, tenantID, r.EnvelopeRecipient); ok {
		return MatchResult{CampaignID: cid, SubscriberID: sid, Method: MatchVERP}, nil
	}

	// 3. From-address fallback.
	if cid, sid, ok := m.matchBySubscriber(ctx, tenantID, r.RecipientEmail); ok {
		return MatchResult{CampaignID: cid, SubscriberID: sid, Method: MatchFromSubscriber}, nil
	}

	return MatchResult{Method: MatchNone}, nil
}

// matchByInReplyTo probes outbox_events + inbound_emails for a row
// referencing the given Message-ID. Run under the outbox-worker GUC so
// it can read across tenants the same way the bounce/feedback path
// does, then cross-checked against tenantID to keep RLS semantics
// honest.
func (m *Matcher) matchByInReplyTo(ctx context.Context, tenantID, inReplyTo string) (string, string, bool) {
	inReplyTo = stripAngleBrackets(inReplyTo)
	if inReplyTo == "" || m.Store == nil || m.Store.Pool == nil {
		return "", "", false
	}
	tx, err := m.Store.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", "", false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.outbox_worker', 'true', true),
       set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", "", false
	}
	// The PRIMARY lookup is campaign_send_deliveries.message_id — the per-send
	// RFC Message-ID the delivery writer actually records (campaigndelivery
	// repo.go's INSERT names the column).
	//
	// This used to query outbox_events.payload->>'esp_message_id' on the belief
	// that the send pipeline wrote it. Nothing does: a repo-wide search finds
	// only readers, and the live table holds zero rows carrying that key. So the
	// matcher's own primary branch could never resolve — every threaded reply
	// fell through to VERP or subscriber matching, and one that had neither
	// landed in manual review looking exactly like a reply to a message we never
	// sent. The matcher was correct and unreachable.
	//
	// The old query is kept as a FALLBACK rather than deleted, because a
	// deployment whose pipeline does populate it should keep working — but it is
	// second now, so the key that exists is tried first.
	if campaign, subscriber, ok := m.matchBySendDeliveryMessageID(ctx, tx, tenantID, inReplyTo); ok {
		return campaign, subscriber, true
	}
	var (
		gotTenant string
		campaign  *string
		recipient *string
	)
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text,
       payload->>'campaign_id',
       payload->>'recipient_email'
  FROM outbox_events
 WHERE payload->>'esp_message_id' = $1
 ORDER BY created_at DESC
 LIMIT 1`, inReplyTo).Scan(&gotTenant, &campaign, &recipient)
	if err != nil {
		return "", "", false
	}
	if gotTenant != tenantID {
		// Cross-tenant match would be a contract violation — refuse
		// rather than leak.
		return "", "", false
	}
	cid := ""
	if campaign != nil {
		cid = *campaign
	}
	// We don't have a subscriber id in the outbox payload by default;
	// the from-address fallback would catch it on a follow-up call,
	// but plumbing it from the outbox is cheaper. Best-effort.
	sid := ""
	if recipient != nil && *recipient != "" {
		if id, ok := m.subscriberByEmail(ctx, tenantID, *recipient); ok {
			sid = id
		}
	}
	if cid == "" {
		return "", "", false
	}
	return cid, sid, true
}

// matchByVERP decodes a `reply+<token>@domain` recipient and verifies the
// HMAC. Returns (campaign, subscriber, true) on success.
//
// The tenant check is not belt-and-braces. Before it existed this branch
// returned whatever campaign the token named, with no relationship to the
// tenant the inbound handler had resolved — so a reply ingested under tenant B
// could be attributed to tenant A's campaign and stamped MatchVERP, the label
// that marks correlation strong enough to emit a canonical replied event.
// matchByInReplyTo has always refused a cross-tenant row explicitly; this is
// the same rule for the same reason.
func (m *Matcher) matchByVERP(tenantID, recipient string) (string, string, bool) {
	return m.matchByVERPWithContext(context.Background(), tenantID, recipient)
}

func (m *Matcher) matchByVERPWithContext(ctx context.Context, tenantID, recipient string) (string, string, bool) {
	if cid, sid, ok := m.matchByOpaqueReplyCorrelation(ctx, tenantID, recipient); ok {
		return cid, sid, true
	}
	if len(m.VERPSecret) == 0 {
		return "", "", false
	}
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return "", "", false
	}
	token, ok := verpTokenFromRecipient(recipient)
	if !ok {
		return "", "", false
	}
	tid, cid, sid, ok := DecodeVERP(m.VERPSecret, token)
	if !ok {
		return "", "", false
	}
	if !strings.EqualFold(tid, tenantID) {
		return "", "", false
	}
	return cid, sid, true
}

func (m *Matcher) matchByOpaqueReplyCorrelation(ctx context.Context, tenantID, recipient string) (string, string, bool) {
	if m == nil || m.ReplyCorrelation == nil || m.Store == nil || m.Store.Pool == nil || strings.TrimSpace(tenantID) == "" {
		return "", "", false
	}
	parsed, err := replycorrelation.ParseAddress(recipient)
	if err != nil {
		return "", "", false
	}
	tx, err := db.WithTenant(ctx, m.Store.Pool, tenantID)
	if err != nil {
		return "", "", false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var binding replycorrelation.Binding
	var subscriber string
	err = tx.QueryRow(ctx, `
SELECT delivery.tenant_id::text, delivery.campaign_id::text, delivery.id::text,
       delivery.reply_to, delivery.reply_correlation_token_hash,
       delivery.reply_correlation_version, delivery.reply_correlation_key_id,
       delivery.reply_correlation_expires_at,
       COALESCE(subscriber.id::text, '')
  FROM campaign_send_deliveries AS delivery
  JOIN campaign_recipients AS recipient
    ON recipient.tenant_id = delivery.tenant_id
   AND recipient.campaign_id = delivery.campaign_id
   AND recipient.id = delivery.campaign_recipient_id
  LEFT JOIN subscribers AS subscriber
    ON subscriber.tenant_id = recipient.tenant_id
   AND subscriber.email = recipient.subscriber_email
 WHERE delivery.tenant_id = $1::uuid
   AND delivery.reply_correlation_token_hash = $2
   AND delivery.reply_to = $3
   AND delivery.transport_contract_version = 'postwave.campaign-transport.v2'
   AND delivery.state = 'accepted'
 LIMIT 1`, tenantID, parsed.TokenHash, parsed.Address).Scan(
		&binding.TenantID, &binding.CampaignID, &binding.DeliveryID,
		&binding.Address, &binding.TokenHash, &binding.Version, &binding.KeyID,
		&binding.ExpiresAt, &subscriber,
	)
	if err != nil || m.ReplyCorrelation.Verify(recipient, binding) != nil {
		return "", "", false
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", false
	}
	return binding.CampaignID, subscriber, true
}

// TenantFromVERPRecipient resolves the owning tenant of a VERP-addressed
// inbound envelope. It exists because tenant resolution necessarily runs
// BEFORE the matcher: `reply+<token>@domain` carries no `replies-<slug>` tag,
// so without this the strongest signal on the envelope would be ignored in
// favour of a global subscriber-email guess, or the reply dropped as unmapped.
//
// Unlike the slug tag — a plaintext claim anyone can write into an address —
// the value returned here was signed by this deployment's own secret.
func (m *Matcher) TenantFromVERPRecipient(recipient string) (string, bool) {
	if m == nil || len(m.VERPSecret) == 0 {
		return "", false
	}
	token, ok := verpTokenFromRecipient(recipient)
	if !ok {
		return "", false
	}
	tid, _, _, ok := DecodeVERP(m.VERPSecret, token)
	if !ok {
		return "", false
	}
	return tid, true
}

// verpTokenFromRecipient peels `reply+` off an inbound recipient's local part.
func verpTokenFromRecipient(recipient string) (string, bool) {
	local, _ := splitLocalDomain(recipient)
	if local == "" || !strings.HasPrefix(strings.ToLower(local), VERPTokenPrefix) {
		return "", false
	}
	return local[len(VERPTokenPrefix):], true
}

// matchBySubscriber walks subscribers + recent campaign sends. Only
// considers sends within VERPLookbackDays so a reply to an ancient
// campaign doesn't inadvertently re-attribute itself to a fresh send.
func (m *Matcher) matchBySubscriber(ctx context.Context, tenantID, recipientEmail string) (string, string, bool) {
	recipientEmail = strings.TrimSpace(recipientEmail)
	if recipientEmail == "" {
		return "", "", false
	}
	sid, ok := m.subscriberByEmail(ctx, tenantID, recipientEmail)
	if !ok || sid == "" {
		return "", "", false
	}
	// Look up the most-recent campaign this subscriber received within
	// the lookback window. We use subscriber_events as the canonical
	// per-recipient send log because every send pipeline writes there.
	tx, err := db.WithTenant(ctx, m.Store.Pool, tenantID)
	if err != nil {
		return "", "", false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := m.now().Add(-time.Duration(VERPLookbackDays) * 24 * time.Hour)
	var cid string
	err = tx.QueryRow(ctx, `
SELECT campaign_id::text
  FROM subscriber_events
 WHERE subscriber_email = $1
   AND at >= $2
   AND campaign_id IS NOT NULL
 ORDER BY at DESC
 LIMIT 1`, recipientEmail, cutoff).Scan(&cid)
	if err != nil {
		// Missing campaign attribution is fine — we still know the
		// subscriber, so return that and let the caller persist a
		// row with campaign_id NULL.
		return "", sid, sid != ""
	}
	if err := tx.Commit(ctx); err != nil {
		return "", sid, sid != ""
	}
	return cid, sid, true
}

// subscriberByEmail returns the subscriber id for a recipient email,
// or "" when not in our system.
func (m *Matcher) subscriberByEmail(ctx context.Context, tenantID, email string) (string, bool) {
	if m.Store == nil || m.Store.Pool == nil {
		return "", false
	}
	tx, err := db.WithTenant(ctx, m.Store.Pool, tenantID)
	if err != nil {
		return "", false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx,
		`SELECT id::text FROM subscribers WHERE email = $1::citext LIMIT 1`,
		email).Scan(&id)
	if err != nil {
		return "", false
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false
	}
	return id, true
}

func (m *Matcher) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now().UTC()
}

// ----- VERP token encode / decode ------------------------------------------
//
// Token layout (unpadded lowercase base32 of exactly verpTokenBytes bytes):
//
//	mac[0:VERPMACBytes] || version(1) || tenant(16) || campaign(16) || subscriber(16)
//
// mac = HMAC-SHA256(secret, verpMACLabel || version || tenant || campaign ||
// subscriber)[:VERPMACBytes].
//
// WHICH IDENTIFIER THE TOKEN CARRIES, AND WHY
//
// The subscriber field is subscribers.id, NOT campaign_recipients.id. This is
// forced, not preferred, and getting it wrong is worse than shipping no VERP
// at all because a signed address is authoritative-looking:
//
//   - DecodeVERP's third return value is handed to MatchResult.SubscriberID →
//     Reply.SubscriberID → campaign_replies.subscriber_id, which is a `uuid`
//     column. A campaign_recipients.id is a bigint in a different identity
//     space; writing it there is a type error at best.
//   - The sibling strong branch, matchBySendDeliveryMessageID, resolves the
//     subscriber as subscribers.id (it LEFT JOINs subscribers on the
//     recipient's email). Two strong branches must land in the same identity
//     space or the same reply resolves to two different "subscribers".
//   - Store.Persist's cross-branch dedup key is `verp:<campaign>:<subscriber>`
//     (replyMessageIdentity), which is only meaningful if <subscriber> means
//     the same thing everywhere.
//
// Encode therefore requires canonical lowercase UUIDs, and decode returns
// canonical lowercase UUIDs, so DecodeVERP(EncodeVERP(x)) == x exactly. An
// identifier the store could not persist can never be minted into a token.
//
// The subscriber field MAY be the nil UUID, which decodes to "": a send whose
// recipient address does not resolve to a subscriber row still gets campaign
// attribution, which strictly beats falling through to the from-address
// fallback. Fixed field widths mean "absent" costs the same 16 bytes and
// changes no offset.
//
// The tenant is carried and signed for two reasons. First, matchByVERP would
// otherwise return a campaign id without checking it belongs to the resolving
// tenant — matchByInReplyTo already refuses that explicitly, and VERP had no
// equivalent. Second, the inbound handler's tenant resolution runs BEFORE the
// matcher: a `reply+<token>@domain` address does not match the
// `replies-<slug>@domain` tag, so without a tenant in the token every
// VERP-addressed reply would fall to a global subscriber-email lookup or be
// dropped as unmapped.
//
// The reply DOMAIN is deliberately outside the signature. The decoder reads
// only the local part, so the domain is not a trusted field; leaving it
// unsigned lets an operator alias or rotate reply domains without invalidating
// mail already in flight.

var verpEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

// verpNilUUID is the all-zero identifier meaning "no subscriber".
var verpNilUUID = make([]byte, verpUUIDBytes)

// EncodeVERP produces a token suitable for embedding as the local-part
// suffix in `reply+<token>@<domain>`.
//
// tenantID and campaignID must be canonical lowercase UUIDs. subscriberID
// must be a canonical lowercase UUID or empty. Anything else — including an
// unset secret — is an error and yields NO token, because a partial or
// unsigned address that merely looks like VERP is the failure this whole
// mechanism exists to avoid.
func EncodeVERP(secret []byte, tenantID, campaignID, subscriberID string) (string, error) {
	if len(secret) == 0 {
		return "", errors.New("replies: VERP secret required")
	}
	tenant, err := canonicalUUIDBytes(tenantID)
	if err != nil {
		return "", fmt.Errorf("replies: VERP tenant id: %w", err)
	}
	campaign, err := canonicalUUIDBytes(campaignID)
	if err != nil {
		return "", fmt.Errorf("replies: VERP campaign id: %w", err)
	}
	subscriber := verpNilUUID
	if strings.TrimSpace(subscriberID) != "" {
		subscriber, err = canonicalUUIDBytes(subscriberID)
		if err != nil {
			return "", fmt.Errorf("replies: VERP subscriber id: %w", err)
		}
	}

	payload := make([]byte, 0, verpPayloadBytes)
	payload = append(payload, verpFormatVersion)
	payload = append(payload, tenant...)
	payload = append(payload, campaign...)
	payload = append(payload, subscriber...)

	token := make([]byte, 0, verpTokenBytes)
	token = append(token, computeVERPMAC(secret, payload)...)
	token = append(token, payload...)
	return strings.ToLower(verpEnc.EncodeToString(token)), nil
}

// DecodeVERP verifies + decodes a VERP token into (tenantID, campaignID,
// subscriberID). Returns false on any signature mismatch, decode failure, or
// shape mismatch — never a partial match. Every field it returns is covered by
// the MAC it verified; there is no field the caller may trust that an attacker
// could have chosen.
func DecodeVERP(secret []byte, token string) (tenantID, campaignID, subscriberID string, ok bool) {
	if len(secret) == 0 || token == "" {
		return "", "", "", false
	}
	raw, err := verpEnc.DecodeString(strings.ToUpper(strings.TrimSpace(token)))
	if err != nil || len(raw) != verpTokenBytes {
		return "", "", "", false
	}
	gotMAC := raw[:VERPMACBytes]
	payload := raw[VERPMACBytes:]
	if payload[0] != verpFormatVersion {
		return "", "", "", false
	}
	if !hmac.Equal(gotMAC, computeVERPMAC(secret, payload)) {
		return "", "", "", false
	}
	fields := payload[1:]
	tenant := uuidTextOrEmpty(fields[0:verpUUIDBytes])
	campaign := uuidTextOrEmpty(fields[verpUUIDBytes : 2*verpUUIDBytes])
	subscriber := uuidTextOrEmpty(fields[2*verpUUIDBytes : 3*verpUUIDBytes])
	// A signed token whose required fields are nil is structurally invalid.
	// Returning it would hand the caller an empty tenant that still carries the
	// "cryptographically verified" MatchVERP label.
	if tenant == "" || campaign == "" {
		return "", "", "", false
	}
	return tenant, campaign, subscriber, true
}

// computeVERPMAC is the shared HMAC step used by both encode + decode. It
// covers the label and the ENTIRE payload, which is every byte DecodeVERP
// subsequently reads.
func computeVERPMAC(secret, payload []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(verpMACLabel))
	_, _ = mac.Write(payload)
	return mac.Sum(nil)[:VERPMACBytes]
}

// canonicalUUIDBytes accepts only the exact canonical lowercase textual form
// and returns its 16 raw bytes. uuid.Parse alone is too permissive here — it
// also accepts braced, URN and undashed spellings, which would let two
// different strings mint the same token and break the
// decode(encode(x)) == x identity the store depends on.
func canonicalUUIDBytes(value string) ([]byte, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return nil, errors.New("must be a canonical UUID")
	}
	if parsed.String() != value {
		return nil, errors.New("must be a canonical lowercase UUID")
	}
	if parsed == uuid.Nil {
		return nil, errors.New("must not be the nil UUID")
	}
	out := make([]byte, verpUUIDBytes)
	copy(out, parsed[:])
	return out, nil
}

// uuidTextOrEmpty renders 16 raw bytes as canonical lowercase text, mapping
// the nil UUID to "" (the "no such identifier" encoding).
func uuidTextOrEmpty(raw []byte) string {
	var value uuid.UUID
	copy(value[:], raw)
	if value == uuid.Nil {
		return ""
	}
	return value.String()
}

// stripAngleBrackets normalises a Message-ID for lookup. RFC 5322
// permits both `<id>` and `id`; senders are inconsistent.
func stripAngleBrackets(in string) string {
	in = strings.TrimSpace(in)
	if len(in) >= 2 && in[0] == '<' && in[len(in)-1] == '>' {
		return in[1 : len(in)-1]
	}
	return in
}

// splitLocalDomain returns the local + domain parts of an email
// address. Returns ("", "") on a missing or duplicate '@'.
func splitLocalDomain(addr string) (local, domain string) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", ""
	}
	at := strings.LastIndexByte(addr, '@')
	if at <= 0 || at == len(addr)-1 {
		return "", ""
	}
	return addr[:at], addr[at+1:]
}

// FormatVERPRecipient assembles `reply+<token>@<domain>`. Used by the send
// pipeline (internal/sending) to stamp a campaign send with a
// cryptographically attributable reply address. Kept here so encode and
// recipient assembly live in one spot and cannot drift apart.
//
// It is all-or-nothing on purpose. An unset secret, an unset domain, or an
// identifier the encoder will not sign returns an error and no address, never
// a bare or half-formed one: something shaped like a VERP address that carries
// no signature is worse than no VERP at all, because the decoder rejects it
// and the operator sees an address that looks like the feature is working.
func FormatVERPRecipient(secret []byte, tenantID, campaignID, subscriberID, domain string) (string, error) {
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return "", errors.New("replies: VERP domain required")
	}
	if strings.ContainsAny(domain, "@ \t\r\n<>,;\"") {
		return "", errors.New("replies: VERP domain is not a bare hostname")
	}
	tok, err := EncodeVERP(secret, tenantID, campaignID, subscriberID)
	if err != nil {
		return "", err
	}
	address := fmt.Sprintf("%s%s@%s", VERPTokenPrefix, tok, domain)
	if local, _ := splitLocalDomain(address); len(local) > VERPMaxLocalPartBytes {
		return "", fmt.Errorf("replies: VERP local part is %d bytes, over the %d budget",
			len(local), VERPMaxLocalPartBytes)
	}
	return address, nil
}

// ParseMessageIDs tokenizes an In-Reply-To or References header.
//
// A References header is a CHAIN — "<a@x> <b@x> <c@x>" — and the ingest path
// stored the whole string in a field the matcher compares against ONE
// Message-ID. So a reply carrying References and no In-Reply-To could never
// match, however correct the rest of the matcher was: the comparison was between
// a chain and a single id, and it silently returned no rows.
//
// Returned MOST SPECIFIC FIRST. RFC 5322 puts the immediate parent last in
// References, and the immediate parent is the message this is a reply to — so the
// list is reversed, and a caller trying candidates in order attributes to the
// message actually replied to rather than to the oldest ancestor in a long
// thread.
//
// Angle brackets are stripped and whitespace, commas and newlines all treated as
// separators, because folded headers arrive with any of them.
func ParseMessageIDs(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	replacer := strings.NewReplacer("\r", " ", "\n", " ", "\t", " ", ",", " ")
	fields := strings.Fields(replacer.Replace(raw))

	seen := make(map[string]struct{}, len(fields))
	out := make([]string, 0, len(fields))
	for i := len(fields) - 1; i >= 0; i-- {
		token := strings.TrimSpace(fields[i])
		token = strings.TrimPrefix(token, "<")
		token = strings.TrimSuffix(token, ">")
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		// An id with no "@" is not a Message-ID. Skipping them keeps a mangled
		// header from producing a lookup that cannot match anything anyway.
		if !strings.Contains(token, "@") {
			continue
		}
		if _, duplicate := seen[token]; duplicate {
			continue
		}
		seen[token] = struct{}{}
		out = append(out, token)
	}
	return out
}

// matchBySendDeliveryMessageID resolves a Message-ID through the send ledger.
//
// This lookup is deliberately tenant-bound. campaign_send_deliveries has a
// restrictive tenant scope policy even for workers, so pretending an unscoped
// lookup works would silently send every threaded reply down a weaker fallback.
// It returns (campaign, subscriber), matching the MatchResult field order.
func (m *Matcher) matchBySendDeliveryMessageID(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, messageID string,
) (string, string, bool) {
	if strings.TrimSpace(tenantID) == "" {
		return "", "", false
	}
	var campaign, subscriber string
	err := tx.QueryRow(ctx, `
SELECT delivery.campaign_id::text, COALESCE(subscriber.id::text, '')
  FROM campaign_send_deliveries AS delivery
  JOIN campaign_recipients AS recipient
    ON recipient.tenant_id = delivery.tenant_id
   AND recipient.campaign_id = delivery.campaign_id
   AND recipient.id = delivery.campaign_recipient_id
  LEFT JOIN subscribers AS subscriber
    ON subscriber.tenant_id = recipient.tenant_id
   AND subscriber.email = recipient.subscriber_email
 WHERE delivery.tenant_id = $2::uuid
   AND delivery.message_id IN ($1, '<' || $1 || '>')
 ORDER BY delivery.created_at DESC
 LIMIT 1`, messageID, tenantID).Scan(&campaign, &subscriber)
	if err != nil {
		return "", "", false
	}
	return campaign, subscriber, true
}
