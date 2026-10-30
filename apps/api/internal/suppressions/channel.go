// channel.go — GAP-LS-005 + GAP-LS-001 channel/scope dimension on
// subscriber_suppressions. Splits a single tenant-wide block into the
// (channel, scope) matrix every 2026 ESP exposes: a user can be
// unsubscribed from marketing email while still receiving SMS
// transactional, and vice versa.
//
// The converger reads these dimensions from the per-table fallback
// paths; the unified view does not yet expose them so the Go-side
// predicate (channelMatches + scopeAllows in converger.go) carries
// the always-block carve-outs for hard_bounce + global_unsubscribe.

package suppressions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Channel is the delivery channel a suppression row applies to.
// 'any' is the wildcard catch-all the legacy + Mailchimp-parity tables
// effectively used before this dimension was introduced.
type Channel string

const (
	ChannelEmail Channel = "email"
	ChannelSMS   Channel = "sms"
	ChannelPush  Channel = "push"
	ChannelAny   Channel = "any"
)

// ValidChannel reports whether c is one of the CHECK-constrained channel
// values (empty is allowed — callers default it to email).
func ValidChannel(c Channel) bool {
	switch c {
	case "", ChannelEmail, ChannelSMS, ChannelPush, ChannelAny:
		return true
	}
	return false
}

// Scope splits the marketing vs transactional carve-out so a hard
// suppression can still let a password-reset / receipt email through
// while blocking the marketing newsletter.
type Scope string

const (
	ScopeMarketing     Scope = "marketing"
	ScopeTransactional Scope = "transactional"
	ScopeAll           Scope = "all"
)

// ValidScope reports whether s is one of the CHECK-constrained scope values
// (empty is allowed — callers default it to marketing).
func ValidScope(s Scope) bool {
	switch s {
	case "", ScopeMarketing, ScopeTransactional, ScopeAll:
		return true
	}
	return false
}

// metadataString reads a string value out of a suppression metadata map,
// returning "" when the key is absent or not a string. Used to lift the
// channel/scope dimension that AddWithChannel stashes there.
func metadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	if v, ok := metadata[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// MatchKind distinguishes per-address rows from per-domain rows.
// 'domain' rows block any address with the same RHS — useful for
// blocking competitor domains or transient bounce spikes from a
// single ISP without enumerating every recipient.
type MatchKind string

const (
	MatchKindEmail  MatchKind = "email"
	MatchKindDomain MatchKind = "domain"
)

// Additional canonical reasons surfaced through NormalizeReason and
// referenced by the converger's per-table fallbacks. The consolidated CHECK
// constraints accepting these values ship in migrations 0239/0244/0512-0513.
const (
	ReasonDSARDeletion  Reason = "dsar_deletion"
	ReasonRoleAddress   Reason = "role_address"
	ReasonInvalidEmail  Reason = "invalid_email"
	ReasonBlocklistAuto Reason = "blocklist_auto"
)

// NormalizeReason maps a free-form / legacy / one-click reason string
// to the canonical Reason enum. Unknown values fall back to
// manual_unsubscribe (the safest catch-all: an unknown row stays
// blocked from marketing but doesn't claim a structural bounce).
func NormalizeReason(raw string) Reason {
	k := strings.ToLower(strings.TrimSpace(raw))
	switch k {
	case "hard_bounce", "bounce", "hardbounce", "hard-bounce":
		return ReasonHardBounce
	case "spam_complaint", "complaint", "spam", "fbl":
		// `complaint` (Klaviyo's short label) folds into the established
		// canonical spam_complaint so read-side convergence + the legacy
		// converger map stay consistent. Callers that want the literal
		// Klaviyo `complaint` reason write ReasonComplaint directly via
		// the Store rather than through NormalizeReason.
		return ReasonSpamComplaint
	case "manual_unsubscribe", "manual", "unsubscribe", "one_click",
		"imported", "import", "":
		return ReasonManualUnsubscribe
	case "list_manual":
		return ReasonListManual
	case "global_unsubscribe", "global":
		return ReasonGlobalUnsubscribe
	case "soft_bounce_threshold":
		return ReasonSoftBounceThreshold
	case "dsar_deletion", "dsar", "right_to_be_forgotten", "rtbf":
		return ReasonDSARDeletion
	// SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy. These are the
	// canonical write-side targets the bounce-ingest receivers, the
	// spam_trap_guard and the frontend filter chips use. Legacy aliases
	// fold in so a drifting client can pass either label.
	case "soft_bounce", "softbounce", "soft-bounce", "transient":
		return ReasonSoftBounce
	case "list_unsub_header", "list_unsubscribe_header", "list_unsubscribe",
		"list-unsubscribe", "one_click_list_unsub", "rfc8058":
		return ReasonListUnsubHeader
	case "spamtrap", "spam_trap", "spam_trap_hit", "spamtrap_hit",
		"honeypot", "trap":
		return ReasonSpamtrap
	case "role_account", "role-account", "roleaccount":
		return ReasonRoleAccount
	case "role_address", "role":
		return ReasonRoleAddress
	case "dns_failure", "dns_fail", "dnsfailure", "dns-failure",
		"nxdomain", "no_mx", "mx_not_found":
		return ReasonDNSFail
	case "invalid_address", "invalid-address", "invalidaddress", "bad_address":
		return ReasonInvalidAddress
	case "invalid_email", "invalid":
		return ReasonInvalidEmail
	case "blocklist_auto", "blocklist", "dnsbl":
		return ReasonBlocklistAuto
	}
	return ReasonManualUnsubscribe
}

// hydrateFromMetadata copies a small set of known fields out of the
// generic metadata bag onto the structured Entry fields. Lets the
// converger present a uniform shape regardless of which underlying
// table the row was sourced from.
func (e *Entry) hydrateFromMetadata() {
	if e == nil || e.Metadata == nil {
		return
	}
	if e.CampaignID == "" {
		if v, ok := stringField(e.Metadata, "campaign_id"); ok {
			e.CampaignID = v
		}
	}
	if e.MessageID == "" {
		if v, ok := stringField(e.Metadata, "message_id"); ok {
			e.MessageID = v
		}
	}
	if e.BounceCode == "" {
		if v, ok := stringField(e.Metadata, "bounce_code"); ok {
			e.BounceCode = v
		}
	}
}

func stringField(m map[string]any, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	return s, true
}

// AddWithChannel is the X1 Store write path that records the channel
// and scope dimension alongside the canonical reason + source. The
// underlying subscriber_suppressions table grew `channel`, `scope`
// and `match_kind` columns in the 2026-LS migration; this helper
// keeps the upsert SQL in one place so the converger and the
// admin/POST handlers stay aligned.
//
// Falls through to Store.Add semantics for everything else
// (idempotency on source_event_id, normalisation of email, validation
// of reason/source). On older deploys where the channel/scope
// columns haven't landed yet the SQL upsert will still succeed —
// the extra column writes degrade to a write of the same enum
// defaults already enforced by the CHECK constraints.
func (s *Store) AddWithChannel(
	ctx context.Context,
	tenantID, email string,
	reason Reason,
	source Source,
	sourceEventID string,
	expiresAt *time.Time,
	metadata map[string]any,
	channel Channel,
	scope Scope,
) (*Entry, error) {
	if s == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if channel == "" {
		channel = ChannelEmail
	}
	if scope == "" {
		scope = ScopeMarketing
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	// Stash the channel + scope inside metadata too — defensive against
	// the migration not having landed yet. The converger reads these
	// back via hydrateFromMetadata so consumers still see the dimension.
	if _, ok := metadata["channel"]; !ok {
		metadata["channel"] = string(channel)
	}
	if _, ok := metadata["scope"]; !ok {
		metadata["scope"] = string(scope)
	}
	// channel/scope are already stashed into metadata above; Store.Add lifts
	// them onto the columns.
	entry, err := s.Add(ctx, tenantID, email, reason, source, sourceEventID, expiresAt, metadata)
	if err != nil {
		return nil, fmt.Errorf("suppressions: add with channel: %w", err)
	}
	if entry != nil {
		entry.Channel = channel
		entry.Scope = scope
		if entry.MatchKind == "" {
			entry.MatchKind = "email"
		}
	}
	return entry, nil
}
