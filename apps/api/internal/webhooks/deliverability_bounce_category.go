// SUB-048 — spamtrap / role-account / dns-failure / invalid-address
// categorisation for the bounce-ingest loop.
//
// The coarse hard/soft split (classifyOutcome.BounceClass) is enough to
// decide WHETHER to suppress, but not WHY. Klaviyo and every 2026 ESP
// surface a richer taxonomy on the suppression list so operators can
// distinguish "this address never existed" (invalid_address) from "this
// is a honeypot we should never have mailed" (spamtrap) from "this
// whole domain has no MX" (dns_failure). This file derives that
// fine-grained category from the free-text provider diagnostic + the
// recipient localpart, with no provider-specific coupling: every
// receiver already collapses its payload into a Reason diagnostic
// string, so one heuristic serves them all.
//
// The category, when detected, is persisted on subscriber_suppressions
// via suppressions.Store.AddWithCategory (migration 0514's
// bounce_category column) AND promotes the suppression `reason` to the
// matching Klaviyo-parity reason so the send-time filter and the
// dashboard reason chips show the precise signal.

package webhooks

import (
	"strings"

	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// classifyHardBounceReason maps a detected bounce category to the
// (reason, category) pair the suppression write should use. When no
// fine-grained category was detected it falls back to the generic
// hard_bounce reason with no stored category (NULL bounce_category).
func classifyHardBounceReason(cat suppressions.BounceCategory) (suppressions.Reason, suppressions.BounceCategory) {
	switch cat {
	case suppressions.CategorySpamtrap:
		return suppressions.ReasonSpamtrap, suppressions.CategorySpamtrap
	case suppressions.CategoryRoleAccount:
		return suppressions.ReasonRoleAccount, suppressions.CategoryRoleAccount
	case suppressions.CategoryDNSFailure:
		return suppressions.ReasonDNSFail, suppressions.CategoryDNSFailure
	case suppressions.CategoryInvalidAddress:
		return suppressions.ReasonInvalidAddress, suppressions.CategoryInvalidAddress
	default:
		// Generic hard bounce: record bounce_category=hard_bounce so the
		// dashboard can still break out "plain hard bounce" vs the
		// fine-grained buckets.
		return suppressions.ReasonHardBounce, suppressions.CategoryHardBounce
	}
}

// roleLocalparts is the conventional set of role addresses (RFC 2142 +
// common operational mailboxes). A bounce to one of these is downgraded
// to role_account rather than a structural hard bounce so the operator
// can decide whether to keep mailing the team alias.
var roleLocalparts = map[string]bool{
	"abuse": true, "admin": true, "administrator": true, "billing": true,
	"contact": true, "info": true, "help": true, "hostmaster": true,
	"marketing": true, "noc": true, "no-reply": true, "noreply": true,
	"postmaster": true, "root": true, "sales": true, "security": true,
	"support": true, "sysadmin": true, "webmaster": true, "office": true,
	"team": true, "hello": true, "enquiries": true, "inquiries": true,
}

// detectBounceCategory inspects the provider diagnostic text and the
// recipient address and returns the fine-grained category, or "" when
// the bounce is just a generic hard bounce. Detection precedence:
//
//	spamtrap > dns_failure > invalid_address > role_account
//
// because the worst hygiene signal should win when a diagnostic carries
// more than one hint.
//
// diagnostic is the provider's free-text reason (classifyOutcome.Reason);
// email is the recipient. Both are matched case-insensitively.
func detectBounceCategory(diagnostic, email string) suppressions.BounceCategory {
	d := strings.ToLower(diagnostic)

	// 1. Spamtrap / honeypot — highest-severity hygiene signal.
	if containsAny(d, "spamtrap", "spam trap", "spam-trap", "honeypot",
		"honey pot", "known trap", "trap hit", "spamcop trap") {
		return suppressions.CategorySpamtrap
	}

	// 2. DNS failure — the recipient domain itself is undeliverable.
	if containsAny(d,
		"no mx", "no such domain", "nxdomain", "domain not found",
		"unrouteable address", "unrouteable domain", "dns error",
		"name service error", "mx record", "host or domain name not found",
		"unable to resolve", "could not resolve") {
		return suppressions.CategoryDNSFailure
	}

	// 3. Invalid address — the mailbox doesn't exist / is malformed.
	if containsAny(d,
		"invalid address", "invalid recipient", "no such user",
		"user unknown", "user not found", "mailbox not found",
		"mailbox unavailable", "does not exist", "recipient rejected",
		"address rejected", "unknown user", "5.1.1", "550 5.1.1",
		"recipient address rejected") {
		return suppressions.CategoryInvalidAddress
	}

	// 4. Role account — only when the localpart is a conventional role
	//    alias. Lowest precedence: a real hard bounce to info@ is still a
	//    role-account signal but a spamtrap/dns/invalid hint above wins.
	if lp := localpart(email); lp != "" && roleLocalparts[lp] {
		return suppressions.CategoryRoleAccount
	}

	return ""
}

// localpart returns the lowercased localpart of an email, or "" when the
// address has no '@'.
func localpart(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return ""
	}
	return email[:at]
}

// containsAny reports whether s contains any of the substrings.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if sub != "" && strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
