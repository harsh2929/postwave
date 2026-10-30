// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"regexp"
	"strings"
)

// Reply classification (PRD F05 §7.3).
//
// The PRD gives this one an unusually blunt warning: "Auto-replies must never
// count as engagement. This is the single most common way reply metrics get
// corrupted." It is worth understanding why it is the MOST common rather than
// merely a possible failure.
//
// Replies are the hardest engagement signal for an agent to fake, which is
// exactly why they rise in value as clicks decay — and out-of-office replies
// arrive in bulk, from real mailboxes, with real addresses, in response to real
// campaigns. Every property that makes a reply trustworthy is present. A reply
// metric that counts them looks BETTER the more people are on holiday, and it
// looks best precisely when a send lands in a holiday period, which is when
// somebody is most likely to be reading the report to decide whether the send
// worked.
//
// Classification is by HEADER first and heuristic second. Headers are what the
// standards define (RFC 3834 for Auto-Submitted); body patterns are guesses that
// vary by language and provider. A body-only classifier is why "I am out of the
// office" is caught in English and counted as engagement in every other language
// the customer's recipients speak.

// ReplyClass is the six-member closed vocabulary from the PRD.
type ReplyClass string

const (
	// ClassHumanReply is the default AFTER exclusions, never before. Ordering
	// matters: a classifier that defaults to human and then looks for reasons to
	// demote will count anything it has no rule for, and the unknown case is
	// exactly where a new auto-responder format arrives.
	ClassHumanReply ReplyClass = "human_reply"
	ClassAutoReply  ReplyClass = "auto_reply"
	// ClassOutOfOffice is separate from auto_reply because they mean different
	// things to a sender: an OOO says the person exists and will be back, a
	// generic auto-reply often means the address is a robot.
	ClassOutOfOffice        ReplyClass = "out_of_office"
	ClassBounce             ReplyClass = "bounce"
	ClassUnsubscribeRequest ReplyClass = "unsubscribe_request"
	ClassChallengeResponse  ReplyClass = "challenge_response"
)

// CountsAsEngagement reports whether a class may be counted as a human reply.
//
// A method on the class rather than a check at each call site. There are five
// readers of this table — A/B winner selection, the engagement score that feeds
// AI-surfacing, the Mailchimp compat surface, and two reply-analytics endpoints
// — and a rule written once at each of them is a rule that will be written four
// times correctly and once not.
func (c ReplyClass) CountsAsEngagement() bool {
	return c == ClassHumanReply
}

// Valid reports whether a class is a member of the closed set.
func (c ReplyClass) Valid() bool {
	switch c {
	case ClassHumanReply, ClassAutoReply, ClassOutOfOffice, ClassBounce,
		ClassUnsubscribeRequest, ClassChallengeResponse:
		return true
	}
	return false
}

// Headers is a case-insensitive view of an inbound message's headers.
type Headers map[string]string

// Get returns a header value regardless of the case it arrived in.
func (h Headers) Get(name string) string {
	if v, ok := h[name]; ok {
		return v
	}
	lowered := strings.ToLower(name)
	for key, value := range h {
		if strings.ToLower(key) == lowered {
			return value
		}
	}
	return ""
}

var (
	// oooSubjectPattern matches the subject conventions auto-responders use
	// across the languages this product's recipients most commonly write.
	//
	// Multilingual deliberately: an English-only body classifier counts every
	// German and French out-of-office as human engagement, and the customer
	// whose list is not American is the one whose numbers are most wrong.
	// No trailing word boundary on the German terms: German compounds them, so
	// "Abwesenheitsnotiz" contains "abwesenheit" and does not END there. A
	// trailing \b silently excluded the most common German OOO subject line —
	// caught by the multilingual test, which is the reason it exists.
	oooSubjectPattern = regexp.MustCompile(`(?i)(\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|r[ée]ponse automatique|absence du bureau|fuori sede|risposta automatica|respuesta autom[áa]tica|ausente de la oficina|automatisch antwoord|afwezig)\b|\b(abwesenheit|abwesend)\w*)`)

	// oooBodyPattern is a fallback for messages whose subject was rewritten by an
	// intermediary. Weaker evidence, so it only fires when a header already said
	// the message was automatic.
	oooBodyPattern = regexp.MustCompile(`(?i)\b(out of (the )?office|on (annual |parental |sick )?leave|on holiday|on vacation|back (on|in the office)|currently away|returning on)\b`)

	// unsubscribePattern matches an intent expressed as prose. A person who
	// replies "please take me off this list" has unsubscribed in every sense that
	// matters, and treating it as engagement is both wrong and rude.
	unsubscribePattern = regexp.MustCompile(`(?i)\b(unsubscribe|remove me|take me off|opt[- ]?out|stop (sending|emailing)|no longer wish to receive|do not (email|contact) me)\b`)

	// challengePattern matches challenge-response systems.
	challengePattern = regexp.MustCompile(`(?i)\b(challenge[- ]response|verify (your|this) (email|address) to (deliver|send)|confirm you are (a )?human|spamarrest|boxbe|earthlink.*challenge)\b`)

	// dsnPattern matches delivery status notifications that arrived on the reply
	// path rather than the bounce path.
	dsnPattern = regexp.MustCompile(`(?i)\b(delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|delivery has failed|550 5\.|user unknown)\b`)
)

// ReplyClassifierVersion names the deterministic header-first methodology
// stored with every reply classification receipt. Changing any rule ordering or
// meaning requires a new version; historical campaign_replies remain immutable
// evidence of the version that ran at ingest.
const ReplyClassifierVersion = "postwave.reply-classifier.v1"

// ClassificationDecision is the privacy-safe result of the one canonical
// reply classifier. Evidence contains stable rule identifiers only—never body
// text, addresses, or raw header values—so it can safely be copied into the F01
// observation provenance.
type ClassificationDecision struct {
	Class        ReplyClass
	Version      string
	StableReason string
	Evidence     []string
}

// ClassifyReply assigns one of the six classes.
//
// Order is the design. Each check runs before the ones that would otherwise
// swallow it:
//
//	bounce               — a DSN is not a reply at all, and its body often
//	                       quotes the original, which trips every other pattern
//	challenge_response   — asks the SENDER to act; counting it as a human reply
//	                       would credit engagement to a robot demanding proof
//	                       that the sender is not one
//	out_of_office        — before auto_reply, because it IS an auto-reply and the
//	                       more specific class is the more useful one
//	auto_reply           — anything else the headers declare automatic
//	unsubscribe_request  — a human wrote it, but counting it as engagement
//	                       reports a departure as interest
//	human_reply          — DEFAULT AFTER EXCLUSIONS, never before
func ClassifyReply(headers Headers, subject, body string) ReplyClass {
	return ClassifyReplyWithEvidence(headers, subject, body).Class
}

// ClassifyReplyWithEvidence evaluates the same classifier as ClassifyReply and
// additionally returns its versioned, content-free decision receipt.
func ClassifyReplyWithEvidence(headers Headers, subject, body string) ClassificationDecision {
	contentType := strings.ToLower(headers.Get("Content-Type"))
	returnPath := strings.ToLower(headers.Get("Return-Path"))
	autoSubmitted := strings.ToLower(strings.TrimSpace(headers.Get("Auto-Submitted")))
	precedence := strings.ToLower(strings.TrimSpace(headers.Get("Precedence")))
	xAutoreply := strings.TrimSpace(headers.Get("X-Autoreply"))
	xAutorespond := strings.TrimSpace(headers.Get("X-Autorespond"))
	autoResponseSuppress := strings.TrimSpace(headers.Get("X-Auto-Response-Suppress"))

	haystack := subject + "\n" + body

	// 1. Bounces. A DSN carries a machine-readable content type; the empty
	// Return-Path is the null reverse-path RFC 5321 mandates for notifications,
	// and it is the single most reliable signal here.
	// Grouped explicitly rather than relying on && binding tighter than ||. A
	// precedence-dependent boolean chain is readable exactly once, by the person
	// who wrote it.
	reportContentType := strings.Contains(contentType, "multipart/report") ||
		strings.Contains(contentType, "message/delivery-status")
	nullReversePath := returnPath == "<>"
	dsnSubject := dsnPattern.MatchString(subject)
	if reportContentType || nullReversePath || dsnSubject {
		evidence := make([]string, 0, 3)
		reason := "R_REPLY_DSN_SUBJECT"
		if reportContentType {
			evidence = append(evidence, "R_REPLY_DSN_CONTENT_TYPE")
			reason = "R_REPLY_DSN_CONTENT_TYPE"
		}
		if nullReversePath {
			evidence = append(evidence, "R_REPLY_NULL_RETURN_PATH")
			if !reportContentType {
				reason = "R_REPLY_NULL_RETURN_PATH"
			}
		}
		if dsnSubject {
			evidence = append(evidence, "R_REPLY_DSN_SUBJECT")
		}
		return replyDecision(ClassBounce, reason, evidence...)
	}

	// 2. Challenge-response, before the auto-reply checks: these are automatic,
	// and calling them auto_reply would lose the fact that the message is asking
	// the sender to do something.
	if challengePattern.MatchString(haystack) {
		return replyDecision(ClassChallengeResponse, "R_REPLY_CHALLENGE_CONTENT")
	}

	// Header evidence that the message was generated rather than typed.
	// `Auto-Submitted: no` explicitly asserts the opposite, so it is checked as
	// an inequality rather than for presence — RFC 3834 defines the header
	// precisely so a real reply can say "this is not automatic".
	automatic := (autoSubmitted != "" && autoSubmitted != "no") ||
		xAutoreply != "" || xAutorespond != "" || autoResponseSuppress != "" ||
		precedence == "auto_reply" || precedence == "bulk" || precedence == "junk"

	// 3. Out of office, before generic auto_reply — the more specific class is
	// the more useful one to a sender deciding whether to follow up.
	if oooSubjectPattern.MatchString(subject) ||
		(automatic && oooBodyPattern.MatchString(haystack)) {
		evidence := automaticHeaderEvidence(
			autoSubmitted, precedence, xAutoreply, xAutorespond, autoResponseSuppress,
		)
		reason := "R_REPLY_OOO_SUBJECT"
		if oooSubjectPattern.MatchString(subject) {
			evidence = append(evidence, "R_REPLY_OOO_SUBJECT")
		} else {
			reason = "R_REPLY_OOO_AUTOMATIC_BODY"
		}
		if automatic && oooBodyPattern.MatchString(haystack) {
			evidence = append(evidence, "R_REPLY_OOO_AUTOMATIC_BODY")
		}
		return replyDecision(ClassOutOfOffice, reason, evidence...)
	}

	// 4. Anything else the headers declare automatic.
	if automatic {
		evidence := automaticHeaderEvidence(
			autoSubmitted, precedence, xAutoreply, xAutorespond, autoResponseSuppress,
		)
		return replyDecision(ClassAutoReply, evidence[0], evidence...)
	}

	// 5. An unsubscribe intent. A person wrote it, so it is not automatic — but
	// counting it as engagement reports a departure as interest.
	if unsubscribePattern.MatchString(haystack) {
		return replyDecision(ClassUnsubscribeRequest, "R_REPLY_UNSUBSCRIBE_CONTENT")
	}

	// 6. Default, reached only after every exclusion.
	return replyDecision(ClassHumanReply, "R_REPLY_HUMAN_AFTER_EXCLUSIONS")
}

func replyDecision(class ReplyClass, reason string, evidence ...string) ClassificationDecision {
	if len(evidence) == 0 {
		evidence = []string{reason}
	}
	return ClassificationDecision{
		Class: class, Version: ReplyClassifierVersion,
		StableReason: reason, Evidence: append([]string(nil), evidence...),
	}
}

func automaticHeaderEvidence(
	autoSubmitted, precedence, xAutoreply, xAutorespond, autoResponseSuppress string,
) []string {
	evidence := make([]string, 0, 5)
	if autoSubmitted != "" && autoSubmitted != "no" {
		evidence = append(evidence, "R_REPLY_AUTO_SUBMITTED")
	}
	if xAutoreply != "" {
		evidence = append(evidence, "R_REPLY_X_AUTOREPLY")
	}
	if xAutorespond != "" {
		evidence = append(evidence, "R_REPLY_X_AUTORESPOND")
	}
	if autoResponseSuppress != "" {
		evidence = append(evidence, "R_REPLY_AUTO_RESPONSE_SUPPRESS")
	}
	if precedence == "auto_reply" || precedence == "bulk" || precedence == "junk" {
		evidence = append(evidence, "R_REPLY_AUTOMATIC_PRECEDENCE")
	}
	return evidence
}

// SQL predicates for reading replies as engagement.
//
// Exported as fragments and used by every reader, because there are five of them
// — A/B winner selection, the engagement score that feeds AI-surfacing, the
// Mailchimp compat surface, and two reply-analytics endpoints — and this
// repository's dominant defect is one rule with N hand-maintained copies. Five
// copies of a filter is five chances to write it four times correctly.
const (
	// HumanEngagementPredicate restricts a count to replies that may be called
	// engagement.
	//
	// NULL is EXCLUDED, and that is a deliberate behaviour change: a NULL
	// classification is a row that predates the classifier, so its class is
	// unknown — and counting unknown as human is exactly the assumption the
	// column exists to stop being made silently. The historical rows do not
	// disappear from the product; they move to the unclassified count below,
	// which is the same treatment F01 gives its unknown bucket.
	// HumanReplyCondition is the bare SQL condition, with no leading conjunction.
	//
	// TWO SPELLINGS, ONE SOURCE. `HumanEngagementPredicate` below is this
	// condition as a WHERE-clause fragment; this constant is the same condition
	// for the places where a leading ` AND ` does not fit — notably
	// `count(*) FILTER (WHERE …)` breakdowns, which is exactly where a reader
	// was previously forced to inline the rule because the only exported form
	// could not be used there.
	//
	// Deriving one from the other is the point: an exported constant nobody can
	// use in half its call sites produces hand-written copies, which is the
	// defect this whole file exists to prevent.
	HumanReplyCondition = `classification = 'human_reply'`

	HumanEngagementPredicate = ` AND ` + HumanReplyCondition

	// UnclassifiedPredicate counts the rows whose class is unknown.
	//
	// Reported rather than allocated. A reply metric that dropped when
	// classification landed, with no way to see where the difference went, would
	// look like a bug in the send rather than a correction to the measurement.
	UnclassifiedPredicate = ` AND classification IS NULL`

	// ExcludedPredicate counts replies deliberately not counted: auto-replies,
	// out-of-office, bounces, unsubscribe requests and challenge-responses.
	ExcludedPredicate = ` AND classification IS NOT NULL AND classification <> 'human_reply'`

	// NotKnownMachinePredicate is the default for a surface that reports ONE
	// blended reply figure and has nowhere to put an unclassified bucket.
	//
	// It exists because the other two defaults are each wrong in an opposite
	// direction, and the engagement panel sits exactly between them:
	//
	//   - HumanEngagementPredicate excludes NULL by design, and that design
	//     depends on the surface REPORTING the unclassified count beside it.
	//     The engagement panel has a single reply number, so there is nowhere
	//     for those rows to go: every reply written before the classifier
	//     existed would silently disappear and the panel would read as an
	//     audience that stopped replying. A number that falls for a reason the
	//     product never states is worse than a number that is slightly wide.
	//   - No predicate at all counts out-of-office notices as engagement, which
	//     is the corruption this whole file exists to prevent — and it lands
	//     precisely on AISurfacingScore, where ReplyRate carries weight 0.5, so
	//     a holiday period raises the score that decides what gets surfaced.
	//
	// So: exclude what is KNOWN to be machine, retain what was never
	// classified. It never claims an unclassified row is human — it declines to
	// delete history it cannot re-derive, which is a different and much smaller
	// claim than counting it as engagement.
	//
	// Shipping a narrower definition is fine; shipping it as a silent default is
	// not. Surfaces that can show both numbers should keep using
	// HumanEngagementPredicate with UnclassifiedPredicate beside it.
	NotKnownMachinePredicate = ` AND (classification IS NULL OR classification = 'human_reply')`
)
