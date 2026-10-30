// SPDX-License-Identifier: AGPL-3.0-only
package bounceclass

import (
	"regexp"
	"strings"
)

// BounceClass is the canonical enum. Stored in DB as the string value
// so SQL inspection (`WHERE class = 'hard'`) reads naturally.
type BounceClass string

const (
	ClassHard          BounceClass = "hard"
	ClassSoftMailbox   BounceClass = "soft_mailbox"
	ClassSoftDNS       BounceClass = "soft_dns"
	ClassPolicyReject  BounceClass = "policy_reject"
	ClassContentReject BounceClass = "content_reject"
	ClassReputation    BounceClass = "reputation"
	ClassChallenge     BounceClass = "challenge"
	ClassUnsubscribe   BounceClass = "unsubscribe"
	ClassUnknown       BounceClass = "unknown"
)

// AllClasses is the canonical iteration order. Stable for the
// dashboard's "bounce by class" chart legend.
var AllClasses = []BounceClass{
	ClassHard,
	ClassSoftMailbox,
	ClassSoftDNS,
	ClassPolicyReject,
	ClassContentReject,
	ClassReputation,
	ClassChallenge,
	ClassUnsubscribe,
	ClassUnknown,
}

// ShouldSuppress reports whether a recipient should be added to the
// suppression list on this single bounce. Hard bounces and unsubscribes
// go straight to suppression; everything else is "soft" and only
// suppresses on a streak (callers compute the streak themselves).
func (c BounceClass) ShouldSuppress() bool {
	return c == ClassHard || c == ClassUnsubscribe
}

// IsRetryable reports whether the dispatcher should retry the message
// with backoff. Soft bounces (mailbox or DNS) are retryable; reputation
// bounces are retryable but with a tenant-level slowdown rather than a
// per-message retry. Content / policy / challenge / unsubscribe are not.
func (c BounceClass) IsRetryable() bool {
	switch c {
	case ClassSoftMailbox, ClassSoftDNS, ClassReputation:
		return true
	}
	return false
}

// Input is the bag of fields a bounce notification carries. Different
// ESPs surface different subsets; the classifier degrades gracefully
// when fields are missing (the diagnostic-code regex match is what
// drives most classifications anyway).
type Input struct {
	// SMTPCode is the 3-digit SMTP reply ("550", "421", "452"). The
	// leading digit alone is a useful signal (4xx = transient, 5xx =
	// permanent) but the full code is needed for the canonical map.
	SMTPCode string
	// EnhancedStatusCode is the RFC 3463 X.Y.Z triple ("5.1.1", "4.4.7").
	// When present, this is the authoritative signal.
	EnhancedStatusCode string
	// DiagnosticCode is the human-readable text that follows the codes.
	// We match against a curated set of ESP-specific phrases for the
	// codes that aren't 1:1 with RFC 3463 (e.g. "554 5.7.1 spam content"
	// vs "554 5.7.1 IP reputation").
	DiagnosticCode string
	// ESP names the upstream that produced this bounce ("ses", "mailgun",
	// "postmark", "sendgrid", "smtp"). Used to pick between competing
	// ESP-specific mappings when a code is ambiguous. Empty is fine.
	ESP string
}

// Classify returns the canonical class for an Input. Order of operations:
//
//  1. Enhanced status code (X.Y.Z) lookup — the most reliable signal.
//  2. SMTP-only code lookup for inputs without an enhanced code.
//  3. Diagnostic-text regex pass for ESP-specific overrides that the
//     bare code can't disambiguate (5.7.1 is the canonical example).
//  4. Final fallback: 4xx → SoftDNS, 5xx → Hard, else Unknown.
func Classify(in Input) BounceClass {
	enhanced := strings.TrimSpace(in.EnhancedStatusCode)
	smtp := strings.TrimSpace(in.SMTPCode)
	diag := strings.ToLower(strings.TrimSpace(in.DiagnosticCode))

	// 1. Enhanced status code.
	if enhanced != "" {
		if class, ok := enhancedMap[enhanced]; ok {
			// Some enhanced codes (5.7.1) need diagnostic-text
			// disambiguation. The base mapping returns the "most
			// common" class; we refine with text if available.
			if refine, ok := refineWithText(enhanced, diag); ok {
				return refine
			}
			return class
		}
		// Unknown enhanced code — fall back on the X class digit.
		if class, ok := enhancedClassFallback(enhanced); ok {
			return class
		}
	}

	// 2. SMTP code on its own.
	if smtp != "" {
		if class, ok := smtpMap[smtp]; ok {
			return class
		}
	}

	// 3. Diagnostic regex pass (catches no-code bounces from older MTAs).
	for _, rule := range diagRules {
		if rule.pattern.MatchString(diag) {
			return rule.class
		}
	}

	// 4. Fallback by SMTP leading digit.
	if len(smtp) > 0 {
		switch smtp[0] {
		case '4':
			return ClassSoftDNS
		case '5':
			return ClassHard
		}
	}
	return ClassUnknown
}

// enhancedMap is the RFC 3463 canonical mapping. Notes:
//   - 4.x.x codes are "persistent transient" — retry.
//   - 5.1.x is "Address status" — usually permanent invalid.
//   - 5.2.x is "Mailbox status" — typically full/disabled (often soft).
//   - 5.3.x is "Mail system status" — receiver-side issue (often soft).
//   - 5.4.x is "Network/routing" — DNS / connectivity (soft).
//   - 5.5.x is "Mail delivery protocol" — protocol error.
//   - 5.6.x is "Message content / media" — content reject.
//   - 5.7.x is "Security/policy" — disambiguated via diagnostic text.
var enhancedMap = map[string]BounceClass{
	// Hard — mailbox / domain doesn't exist
	"5.1.1":  ClassHard, // Bad destination mailbox
	"5.1.2":  ClassHard, // Bad destination system (domain)
	"5.1.3":  ClassHard, // Bad destination mailbox syntax
	"5.1.10": ClassHard, // Recipient address has null MX (RFC 7505)

	// Soft mailbox
	"4.2.1": ClassSoftMailbox, // Mailbox disabled, not accepting messages
	"4.2.2": ClassSoftMailbox, // Mailbox full
	"5.2.1": ClassSoftMailbox, // Mailbox disabled (often soft despite 5.x)
	"5.2.2": ClassSoftMailbox, // Mailbox full
	"5.2.3": ClassSoftMailbox, // Message length exceeds quota

	// Soft DNS / routing
	"4.4.1": ClassSoftDNS,    // No answer from host
	"4.4.2": ClassSoftDNS,    // Bad connection
	"4.4.3": ClassSoftDNS,    // Directory server failure
	"4.4.4": ClassSoftDNS,    // Unable to route
	"4.4.7": ClassSoftDNS,    // Message expired (queue lifetime)
	"4.7.0": ClassReputation, // Other or undefined security status (rate limit)
	"5.4.1": ClassSoftDNS,    // No answer from host
	"5.4.4": ClassSoftDNS,    // Unable to route

	// Policy reject (corporate firewall, sender allowlist)
	"5.7.1": ClassPolicyReject, // Delivery not authorized — but text refines
	"5.7.7": ClassPolicyReject, // Message integrity failure
	"5.7.8": ClassPolicyReject, // Authentication credentials invalid

	// Content reject
	"5.6.0": ClassContentReject, // Other or undefined media error
	"5.6.1": ClassContentReject, // Media not supported
	"5.6.2": ClassContentReject, // Conversion required and prohibited
	"5.6.3": ClassContentReject, // Conversion required but not supported
	"5.7.5": ClassContentReject, // Cryptographic failure (or "message contains malware")

	// Reputation
	"4.7.1": ClassReputation, // Delivery not authorized (rate-limited)
	"5.7.6": ClassReputation, // Cryptographic algorithm not supported (rare)
}

// smtpMap is the SMTP-code-only fallback for bounces without an
// enhanced status code (older MTAs, some self-hosted Exim/Postfix).
var smtpMap = map[string]BounceClass{
	"421": ClassSoftDNS,
	"450": ClassSoftMailbox, // Mailbox unavailable (temporary)
	"451": ClassSoftDNS,
	"452": ClassSoftMailbox, // Insufficient storage
	"500": ClassHard,        // Syntax error
	"501": ClassHard,
	"502": ClassHard,
	"503": ClassHard,
	"504": ClassHard,
	"521": ClassHard, // Server does not accept mail
	"541": ClassPolicyReject,
	"550": ClassHard,
	"551": ClassHard,
	"552": ClassSoftMailbox, // Storage allocation exceeded
	"553": ClassHard,
	"554": ClassHard, // Transaction failed (often content/policy too)
}

// enhancedClassFallback handles enhanced codes we don't have an exact
// match for by reading the second digit (the class). Returns false when
// the input isn't a parseable X.Y.Z.
func enhancedClassFallback(s string) (BounceClass, bool) {
	parts := strings.Split(s, ".")
	if len(parts) != 3 || len(parts[0]) != 1 {
		return "", false
	}
	switch parts[0] {
	case "4":
		return ClassSoftDNS, true
	case "5":
		// Look at the subject (second component) for the right bucket.
		switch parts[1] {
		case "1":
			return ClassHard, true
		case "2":
			return ClassSoftMailbox, true
		case "4":
			return ClassSoftDNS, true
		case "6":
			return ClassContentReject, true
		case "7":
			return ClassPolicyReject, true
		}
		return ClassHard, true
	}
	return "", false
}

// refineWithText handles the codes where the same enhanced status
// maps to multiple classes depending on the diagnostic text. The
// canonical case is 5.7.1, which various ESPs return for:
//
//   - Recipient denied (policy → ClassPolicyReject — the default)
//   - "blocked using <RBL>" (reputation → ClassReputation)
//   - "Message rejected as spam" (content → ClassContentReject)
//   - "IP address rejected" (reputation)
//
// We return ok=true only when we want to override the base map.
func refineWithText(enhanced, diag string) (BounceClass, bool) {
	if diag == "" {
		return "", false
	}
	switch enhanced {
	case "5.7.1":
		if matchesAny(diag, reputationPhrases) {
			return ClassReputation, true
		}
		if matchesAny(diag, contentPhrases) {
			return ClassContentReject, true
		}
		if matchesAny(diag, unsubscribePhrases) {
			return ClassUnsubscribe, true
		}
		// Otherwise the policy-reject default stands.
	case "5.7.0", "5.7.27":
		// Some ESPs use these for content too.
		if matchesAny(diag, contentPhrases) {
			return ClassContentReject, true
		}
	case "5.1.1":
		// SES / Mailgun sometimes report 5.1.1 with "user unknown"
		// AND with "challenge response not configured." The latter
		// is a challenge-response system, not a real hard bounce.
		if matchesAny(diag, challengePhrases) {
			return ClassChallenge, true
		}
	}
	return "", false
}

func matchesAny(s string, phrases []string) bool {
	for _, p := range phrases {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

// reputationPhrases — substrings that, when present in a 5.7.1
// diagnostic, mean the recipient blocked us for sender-reputation
// reasons. Lowercase; the caller normalises diag to lowercase first.
var reputationPhrases = []string{
	"blocked using",
	"ip address rejected",
	"ip blacklisted",
	"poor reputation",
	"low reputation",            // Mailgun "very low reputation of the sending IP"
	"reputation of the sending", // same Mailgun variant, different anchor
	"sender ip",
	"rate limit",
	"throttling",
	"blocked due to",
	"on a block list",
	"on a blocklist",
}

var contentPhrases = []string{
	"spam content",
	"spam-like",
	"message rejected as spam",
	"message contains",
	"content rejected",
	"resembling spam",
	"high probability of spam",
}

var challengePhrases = []string{
	"challenge response",
	"challenge-response",
	"verify you are human",
	"please confirm your message",
}

var unsubscribePhrases = []string{
	"user has unsubscribed",
	"recipient unsubscribed",
	"opt-out",
	"opted out",
	"do not contact",
}

// diagRules is the no-code fallback path. Some bounces arrive as
// plain text DSNs with no numeric code at all (forwarded MAILER-
// DAEMON, custom Postfix transports). The patterns here are
// intentionally cautious — we'd rather return Unknown than misclassify.
type diagRule struct {
	pattern *regexp.Regexp
	class   BounceClass
}

var diagRules = []diagRule{
	{regexp.MustCompile(`(?i)no such user`), ClassHard},
	{regexp.MustCompile(`(?i)user unknown`), ClassHard},
	{regexp.MustCompile(`(?i)user not found`), ClassHard},
	{regexp.MustCompile(`(?i)recipient (address )?rejected:? user unknown`), ClassHard},
	{regexp.MustCompile(`(?i)mailbox not found`), ClassHard},
	{regexp.MustCompile(`(?i)account (has been )?disabled`), ClassHard},
	{regexp.MustCompile(`(?i)mailbox is full`), ClassSoftMailbox},
	{regexp.MustCompile(`(?i)quota exceeded`), ClassSoftMailbox},
	{regexp.MustCompile(`(?i)over quota`), ClassSoftMailbox},
	{regexp.MustCompile(`(?i)greylist`), ClassSoftDNS},
	{regexp.MustCompile(`(?i)dns (lookup )?failed`), ClassSoftDNS},
	{regexp.MustCompile(`(?i)try again later`), ClassSoftDNS},
	{regexp.MustCompile(`(?i)message (was )?(rejected )?as spam`), ClassContentReject},
	{regexp.MustCompile(`(?i)content (rejected|filtered)`), ClassContentReject},
	{regexp.MustCompile(`(?i)spamhaus`), ClassReputation},
	{regexp.MustCompile(`(?i)sender reputation`), ClassReputation},
}
