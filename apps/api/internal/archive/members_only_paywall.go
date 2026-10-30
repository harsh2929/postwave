// SPDX-License-Identifier: AGPL-3.0-only
//
// members_only_paywall.go — implements the per-issue members-only gate
// for the public archive (gap feature `archive-paywall-integration`,
// P1).
//
// What this gives operators
// -------------------------
//
//   * Per-campaign toggle: `archive_members_only=true` flips a single
//     issue into "paid members only". The publish slideover surfaces a
//     checkbox; the public archive renderer enforces the gate.
//
//   * Per-tier targeting: `archive_paywall_tier_id` binds the gate to
//     one of the tenant's named paywall_tiers. Visitors must be in
//     THAT tier (resolved via paid_members.tier) to see the body.
//     NULL tier id means "any active paid member passes" — the legacy
//     all-or-nothing gate.
//
//   * Resolution via subscribe-wall cookie OR paid-member email cookie
//     (whichever the tenant has wired). Today we read the subscribe-
//     wall cookie's bound email and dispatch to paywall.AllowedForTier;
//     a future iteration can add a dedicated paid-member auth surface
//     without changing the wire shape.
//
//   * Renderer: when the gate fires, the issue HTMLBody is replaced
//     with the excerpt + a tagged CTA card (`data-pw-paywall="cta"`)
//     so operator stylesheets can theme it and analytics can
//     distinguish a "paywall impression" from a regular article view.
//
// Composition with the existing gates
// -----------------------------------
//
// The public read path now applies, in order:
//
//   1. Subscribe-wall (free email signup gate, marker-based per-issue).
//   2. Metered paywall (NYT-style N-free-reads-per-period).
//   3. Members-only paywall (THIS file — per-issue paid-tier gate).
//
// (1) and (3) are orthogonal: a publisher running a "subscribe to read"
// CTA on issue A and a "Founders tier only" gate on issue B can ship
// both without conflict. (2) and (3) compose: an issue can be both
// metered AND members-only; the visitor must be a paid member of the
// right tier to bypass either gate.
//
// Inspired by 2026 SOTA: beehiiv per-post premium toggle + tier
// targeting, Substack Founders-tier per-post gating, Ghost post
// visibility=tier:<slug>, Buttondown paid-email gate.

package archive

import (
	"context"
	"net/http"
	"strings"
)

// MembersOnlyDecision is the result of a members-only gate evaluation.
// `Active` is true when the issue carries `archive_members_only=true`;
// `Allowed` is true when the visitor passes the tier check. When
// `Active && !Allowed` the handler swaps the body for the teaser +
// CTA card.
type MembersOnlyDecision struct {
	Active   bool
	Allowed  bool
	TierID   string
	TierName string
}

// MembersOnlyResolver is the per-(tenant, email, tierID) tier check.
// Wired from the archive Deps so the archive package doesn't take a
// package-level dep on paywall (sibling features). Returns (allowed,
// err); fail-closed on any error.
type MembersOnlyResolver func(ctx context.Context, tenantID, email, tierID string) (bool, error)

// MembersOnlyTierResolver resolves a tier id → display name so the CTA
// card can say "Subscribe to the Founders tier" without leaking the
// tier id over the wire. Returns "" when unresolvable.
type MembersOnlyTierResolver func(ctx context.Context, tenantID, tierID string) (string, error)

// MembersOnlyPaywallCard is the wire shape echoed under
// IssueDetail.MembersOnlyPaywall when the gate is active. Mirrors
// MeteredPaywallCard so the desktop can render either card with the
// same component.
type MembersOnlyPaywallCard struct {
	Title    string `json:"title,omitempty"`
	Body     string `json:"body,omitempty"`
	CTALabel string `json:"ctaLabel,omitempty"`
	CTAHref  string `json:"ctaHref,omitempty"`
}

// BuildMembersOnlyPaywallHTML returns the teaser + paywall CTA the
// renderer drops in place of the issue body for non-members. Operators
// who want a custom layout can override via a future MembersOnlyConfig
// row (out-of-scope for the P1 integration); this snippet is the
// fallback for non-Moosewave consumers of the JSON (RSS readers,
// integrations) and clients that don't know to render the card.
//
// Tagged with `data-pw-paywall="cta"` so it's grep-able from operator
// stylesheets and analytics dashboards (matches MeteredPaywall +
// SubscribeWall conventions).
func BuildMembersOnlyPaywallHTML(excerpt, tierName string) string {
	tier := strings.TrimSpace(tierName)
	tierLine := ""
	if tier != "" {
		tierLine = `<p>Subscribe to the <strong>` + htmlEscapeForPaywall(tier) +
			`</strong> tier to keep reading.</p>`
	} else {
		tierLine = `<p>Subscribe to a paid plan to keep reading.</p>`
	}
	excerptLine := ""
	if strings.TrimSpace(excerpt) != "" {
		excerptLine = `<p class="pw-archive-paywall-excerpt">` +
			htmlEscapeForPaywall(strings.TrimSpace(excerpt)) +
			`</p>`
	}
	return excerptLine +
		`<aside data-pw-paywall="cta" class="pw-archive-members-only-paywall">` +
		`<p><strong>This post is for paid members.</strong></p>` +
		tierLine +
		`</aside>`
}

// htmlEscapeForPaywall is a minimal HTML escaper for operator-supplied
// tier names + excerpts injected into the paywall card. We deliberately
// don't use html/template here because the caller controls the
// surrounding markup and a full template would force an allocation per
// render on a hot path.
func htmlEscapeForPaywall(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return r.Replace(s)
}

// ApplyMembersOnlyPaywall is the renderer-side helper. Returns the
// rewritten HTML body + decision so the handler can hydrate the JSON
// response fields. Idempotent + pure (no DB): the resolver callback
// owns the DB round-trip so unit tests can stub it.
//
// Inputs:
//
//	body      — full campaign HTML (post subscribe-wall + metered passes).
//	excerpt   — fallback teaser for the CTA card.
//	tenantID  — owning tenant.
//	email     — visitor email from the subscribe-wall cookie (may be "").
//	tierID    — campaign's archive_paywall_tier_id (may be "").
//	tierName  — pre-resolved display name (caller did the lookup).
//	resolver  — tier membership check; nil → fail-closed.
//
// Decision rules:
//
//   - Empty email: not authenticated, treat as non-member, gate fires.
//   - resolver returns true: full body, decision Allowed=true.
//   - resolver returns false or errors: replace body with teaser +
//     CTA card, decision Allowed=false.
//
// `Active=true` is set on every call (gate is "active" iff the caller
// invoked us — they only do so when archive_members_only=true).
func ApplyMembersOnlyPaywall(
	ctx context.Context,
	body, excerpt, tenantID, email, tierID, tierName string,
	resolver MembersOnlyResolver,
) (string, MembersOnlyDecision) {
	dec := MembersOnlyDecision{
		Active:   true,
		TierID:   tierID,
		TierName: tierName,
	}
	if resolver == nil {
		dec.Allowed = false
		return BuildMembersOnlyPaywallHTML(excerpt, tierName), dec
	}
	allowed, err := resolver(ctx, tenantID, email, tierID)
	if err != nil {
		// Fail-closed: a DB error should NEVER unlock gated content.
		dec.Allowed = false
		return BuildMembersOnlyPaywallHTML(excerpt, tierName), dec
	}
	dec.Allowed = allowed
	if !allowed {
		return BuildMembersOnlyPaywallHTML(excerpt, tierName), dec
	}
	return body, dec
}

// applyMembersOnlyPaywallToIssue is the public-path integration hook
// PublicGet calls AFTER the metered-paywall pass. Decoupled here
// (rather than inlined in archive.go) so the gate logic stays
// unit-testable in isolation and so a future audit can grep
// "members-only" in one place.
//
// Returns the (possibly rewritten) body + decision so the handler can
// hydrate the JSON response fields `membersOnly`, `paywallLocked`,
// `paywallTierName`.
//
// `email` is the verified subscribe-wall cookie email (or "" when the
// visitor hasn't unlocked). Tenants running a Stripe-backed flow with
// a dedicated paid-member auth cookie can extend this helper to read
// that surface; today the subscribe-wall cookie is the only source of
// truth for visitor identity on the public archive.
func (d *Deps) applyMembersOnlyPaywallToIssue(
	r *http.Request,
	tenantID, body, excerpt, email, tierID, tierName string,
) (string, MembersOnlyDecision) {
	if d == nil || d.MembersOnlyResolver == nil {
		return ApplyMembersOnlyPaywall(r.Context(), body, excerpt, tenantID,
			email, tierID, tierName, nil)
	}
	return ApplyMembersOnlyPaywall(r.Context(), body, excerpt, tenantID,
		email, tierID, tierName, d.MembersOnlyResolver)
}
