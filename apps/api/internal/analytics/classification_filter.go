// SPDX-License-Identifier: AGPL-3.0-only
//
// classification_filter.go — PRD F01 read side for the engagement analytics
// endpoints.
//
// F01 built the classifier, the append-only decision ledger, the shadow
// projection and a three-bucket summary endpoint. What it did not do is give
// the numbers customers actually read — the campaign engagement panel, the
// grouped time series, geography, devices, the link report, the campaign
// comparison — any way to ask the question the classifier exists to answer.
// Those endpoints still return one blended figure in which a person reading a
// message and a security gateway prefetching it are the same event.
//
// This file is the one place the "which band did the caller ask for" rule
// lives. It deliberately produces SQL rather than a Go predicate: filtering
// after a full scan would mean loading every machine open into the API process
// to throw it away, and on the largest tenants that is the difference between
// a report and an outage.
//
// THREE RULES ENCODED HERE, each of which is easy to get quietly wrong:
//
//  1. UNSET IS NOT A BAND. An absent `classification` returns the empty
//     expression, so the generated SQL is byte-identical to what shipped
//     before this file existed. Every historical number a customer has ever
//     exported keeps its meaning. A default of "human" would have silently
//     rewritten every dashboard in the product overnight and looked like a
//     traffic collapse rather than a definition change.
//
//  2. UNCLASSIFIED IS UNKNOWN, NEVER HUMAN. Rows that predate the classifier,
//     rows the cascade could not settle, and rows whose classification has not
//     been written yet are all `unknown`. That is why the unknown band is
//     expressed as NOT EXISTS(human OR machine) rather than EXISTS(= 'unknown'):
//     it cannot be defeated by a missing row, and it makes "we do not know"
//     impossible to launder into "a person did this".
//
//  3. CLASSIFICATION CONSTRAINS INTERACTIONS, NOT DENOMINATORS. The F01
//     classifier only ever classifies opened / clicked / replied. Deliveries,
//     bounces, complaints and unsubscribes carry no classification, so
//     filtering them would silently zero the denominator of every rate on the
//     page and report a 0% human open rate as though nobody read the message.
//     interactionOnly() is what keeps that from happening.
package analytics

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/replies"
)

// ClassificationFilter is the closed vocabulary of the `classification` query
// parameter. The zero value is the unset filter, which is also the value every
// existing caller sends, so a struct that forgets to set it keeps today's
// behaviour instead of inventing a band.
type ClassificationFilter string

const (
	// ClassificationAll is unset: no classification predicate is emitted and
	// the blended human+machine+unknown figure is returned, exactly as before.
	ClassificationAll ClassificationFilter = ""
	// ClassificationHuman counts only interactions an explicit human decision
	// was written for.
	ClassificationHuman ClassificationFilter = "human"
	// ClassificationMachine counts only interactions an explicit machine
	// decision was written for.
	ClassificationMachine ClassificationFilter = "machine"
	// ClassificationUnknown counts interactions with neither — including every
	// row that predates the classifier.
	ClassificationUnknown ClassificationFilter = "unknown"
)

// ErrUnsupportedClassification is returned for a value outside the closed set.
// Rejected rather than ignored: a caller who typed `classification=humans` and
// silently received the blend would publish a machine-inflated number believing
// it was filtered, which is worse than the state this feature replaces.
var ErrUnsupportedClassification = errors.New("analytics: unsupported classification filter")

// ParseClassificationFilter validates the raw query-parameter value.
func ParseClassificationFilter(raw string) (ClassificationFilter, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return ClassificationAll, nil
	case string(ClassificationHuman):
		return ClassificationHuman, nil
	case string(ClassificationMachine):
		return ClassificationMachine, nil
	case string(ClassificationUnknown):
		return ClassificationUnknown, nil
	}
	return ClassificationAll, fmt.Errorf("%w: %q", ErrUnsupportedClassification, raw)
}

// Active reports whether the caller asked for a single band.
func (f ClassificationFilter) Active() bool { return f != ClassificationAll }

// Wire is the value echoed back in responses that can carry it. "all" rather
// than "" so a reader can never mistake an unfiltered payload for a filtered
// one because a key happened to be blank.
func (f ClassificationFilter) Wire() string {
	if !f.Active() {
		return "all"
	}
	return string(f)
}

// classificationShadowView owns the definition of "which classification is
// current" (latest decision per event, with unclassified projected as
// unknown). Reading it instead of event_classifications means this package
// never reimplements classification recency — the failure mode where an
// analytics endpoint and the F01 summary disagree about the same event because
// one of them picked the superseded row.
const classificationShadowView = "subscriber_event_classification_shadow_v1"

// classifiedInteractionTypes is the exact set F01 classifies. Stated once here
// because every "do not filter the denominator" decision in this package
// depends on it.
const classifiedInteractionTypes = "('opened','clicked','replied')"

// sqlAliasPattern guards the only interpolated part of these fragments.
var sqlAliasPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,29}$`)

// mustSQLAlias panics on anything that is not a plain lower-case identifier.
//
// Every caller in this package passes a compile-time literal, so the panic is
// unreachable in production; it exists so that "could a request body ever
// reach this concatenation" is answerable by reading five lines instead of
// auditing every call site forever.
func mustSQLAlias(alias string) string {
	if !sqlAliasPattern.MatchString(alias) {
		panic("analytics: classification filter alias must be a literal SQL identifier, got " + alias)
	}
	return alias
}

// subscriberEventExpr returns a boolean SQL expression selecting rows of the
// canonical subscriber_events ledger that belong to the requested band, or ""
// when the filter is unset.
//
// alias must name a subscriber_events row in the enclosing query. The
// correlation is on the ledger's real composite identity (tenant, id, at) —
// `at` is part of the partitioned primary key and is never optional.
func (f ClassificationFilter) subscriberEventExpr(alias string) string {
	if !f.Active() {
		return ""
	}
	a := mustSQLAlias(alias)
	inner := fmt.Sprintf(`SELECT 1 FROM %s pw_cls
             WHERE pw_cls.tenant_id = %s.tenant_id
               AND pw_cls.subscriber_event_id = %s.id
               AND pw_cls.subscriber_event_at = %s.at`,
		classificationShadowView, a, a, a)
	return f.bandTest(inner)
}

// campaignReportEventExpr is the same question asked of campaign_report_events,
// the compatibility read model.
//
// campaign_report_events carries no foreign key to the canonical ledger, so the
// bridge is the event identity both writers derive from the same canonical
// event at ingest: tenant, campaign, recipient, event type and timestamp. The
// correlation is a semi-join (EXISTS), never a join, because a join would
// multiply a report row by however many ledger rows share that identity and
// inflate the very counts this filter exists to make honest.
//
// A report row with no ledger twin has no classification and is therefore
// UNKNOWN — it is counted by the unknown band and by neither of the others.
// That is the same rule as an unclassified ledger row, and it is the reason
// the unknown band is written as a negation.
func (f ClassificationFilter) campaignReportEventExpr(alias string) string {
	if !f.Active() {
		return ""
	}
	a := mustSQLAlias(alias)
	inner := fmt.Sprintf(`SELECT 1
               FROM subscriber_events pw_se
               JOIN %s pw_cls
                 ON pw_cls.tenant_id = pw_se.tenant_id
                AND pw_cls.subscriber_event_id = pw_se.id
                AND pw_cls.subscriber_event_at = pw_se.at
              WHERE pw_se.tenant_id = %s.tenant_id
                AND pw_se.campaign_id = %s.campaign_id
                AND pw_se.subscriber_email = %s.subscriber_email
                AND pw_se.event_type = %s.event_type
                AND pw_se.at = %s.at`,
		classificationShadowView, a, a, a, a, a)
	return f.bandTest(inner)
}

// bandTest turns a correlated row-locator into the band predicate.
//
// The band literal is never interpolated: each arm writes its own constant, so
// no value that arrived over HTTP can reach the generated SQL even if
// ParseClassificationFilter is one day bypassed.
func (f ClassificationFilter) bandTest(inner string) string {
	switch f {
	case ClassificationHuman:
		return "EXISTS (" + inner + "\n                AND pw_cls.classification = 'human')"
	case ClassificationMachine:
		return "EXISTS (" + inner + "\n                AND pw_cls.classification = 'machine')"
	case ClassificationUnknown:
		// Negation, not EXISTS(= 'unknown'): an event with no decision row at
		// all must land here too. Counting "no evidence" as human is the exact
		// dishonesty F01 exists to remove.
		return "NOT EXISTS (" + inner + "\n                AND pw_cls.classification IN ('human','machine'))"
	}
	return ""
}

// interactionOnly narrows expr so it constrains only the event types F01
// actually classifies.
//
// Without this, `classification=human` applied to a query that also counts
// deliveries would drop every delivery row, and every rate on the engagement
// panel would be computed over a zero denominator. The page would report a
// perfectly confident 0%, which reads as "the campaign failed" rather than
// "you asked a question about opens".
func interactionOnly(alias, expr string) string {
	if expr == "" {
		return ""
	}
	a := mustSQLAlias(alias)
	return a + ".event_type NOT IN " + classifiedInteractionTypes + " OR (" + expr + ")"
}

// andWhere renders expr as a WHERE-clause continuation, or "" when there is
// nothing to add. Returning the empty string for the unset filter is what makes
// "unset produces the original query text" true by construction rather than by
// review.
func andWhere(expr string) string {
	if expr == "" {
		return ""
	}
	return "\n   AND (" + expr + ")"
}

// repliesPredicate maps the F01 band onto campaign_replies.
//
// Replies are classified by a DIFFERENT, older classifier with its own six-member
// vocabulary, and its SQL rules already exist as shared constants in
// internal/replies. They are reused verbatim rather than restated, because this
// repository's dominant defect is one rule maintained in N places, and a fifth
// hand-written copy of "which reply counts as engagement" is a fifth chance to
// write it four times correctly.
//
// The mapping, stated exactly:
//
//   - UNSET EMITS THE EMPTY STRING. Rule 1 above is not weakened for replies:
//     the campaign_replies query the engagement panel shipped with had no
//     classification predicate and counted every persisted row, so the default
//     must keep counting every persisted row. A human-only default would drop
//     every reply written before the reply classifier existed — their
//     classification is NULL, so HumanEngagementPredicate excludes them — and
//     every historical reply count in the product would fall, silently, in a
//     way that reads as an audience that stopped replying. Shipping a narrower
//     definition is fine; shipping it as the default without saying so is the
//     thing this file exists to prevent.
//   - human uses HumanEngagementPredicate: the SHARED rule, so asking for the
//     human band here means exactly what it means to A/B winner selection and
//     the reply-analytics endpoints.
//   - machine uses ExcludedPredicate: every reply class the reply classifier
//     refuses to count as engagement. That set is dominated by auto-replies,
//     out-of-office notices, DSNs and challenge-responses; it also contains
//     unsubscribe requests, which a person wrote. Reporting those under
//     `machine` rather than `human` is the conservative direction — it can
//     understate the machine bucket but can never inflate the human one.
//   - unknown uses UnclassifiedPredicate: replies stored before the reply
//     classifier existed. NULL is unknown here for the same reason it is
//     unknown for opens.
//
// The three active bands therefore partition campaign_replies exactly, and
// their counts sum to the unfiltered count — which is the arithmetic
// TestUnsetReplyCountReproducesTheHistoricalQueryDB pins.
func (f ClassificationFilter) repliesPredicate() string {
	switch f {
	case ClassificationHuman:
		return replies.HumanEngagementPredicate
	case ClassificationMachine:
		return replies.ExcludedPredicate
	case ClassificationUnknown:
		return replies.UnclassifiedPredicate
	}
	// UNSET excludes KNOWN auto-replies and retains unclassified ones.
	//
	// Not the empty string, and not HumanEngagementPredicate. The panel shows one
	// reply number, so an empty predicate counts out-of-office notices as
	// engagement (inflating AISurfacingScore, where ReplyRate is weighted 0.5),
	// while a human-only predicate drops every pre-classifier reply and reads as
	// an audience that stopped replying. See replies.NotKnownMachinePredicate.
	return replies.NotKnownMachinePredicate
}
